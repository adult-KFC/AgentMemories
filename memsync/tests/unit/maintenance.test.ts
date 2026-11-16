import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../../src/core/config.js";
import { runGit } from "../../src/core/git.js";
import { createJournal } from "../../src/core/journal.js";
import {
  compactJournals,
  evaluateMaintenance,
  scheduleMaintenance,
  type MaintenancePolicy,
} from "../../src/core/maintenance.js";

const HOUR_MS = 60 * 60 * 1_000;
const SLUG = "checkout-service";
const HOST = "WIN-TEST";

const POLICY: MaintenancePolicy = {
  interval_hours: 72,
  cooldown_hours: 6,
  mainline_only: true,
};

const META = [
  "slug: checkout-service",
  "repos:",
  "  - git@git.corp.com:shop/checkout-service.git",
  "owners:",
  "  - alice@corp.com",
  "current_version: 0.4.0",
  "version_status: active",
  "context_budget_chars: 12000",
  "maintenance:",
  "  interval_hours: 72",
  "  cooldown_hours: 6",
  "  mainline_only: true",
  "",
].join("\n");

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  temporaryRoots.length = 0;
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(dir);
  return dir;
}

async function configureGit(repoPath: string): Promise<void> {
  await runGit(["config", "user.name", "Test User"], { cwd: repoPath });
  await runGit(["config", "user.email", "test@example.com"], { cwd: repoPath });
  await runGit(["config", "core.autocrlf", "false"], { cwd: repoPath });
}

async function makeGitRepo(): Promise<string> {
  const repoPath = await tempDir("memsync-maint-repo-");
  await runGit(["init"], { cwd: repoPath });
  await configureGit(repoPath);
  await mkdir(join(repoPath, "projects", SLUG), { recursive: true });
  await writeFile(join(repoPath, "projects", SLUG, "meta.yaml"), META, "utf8");
  return repoPath;
}

async function commitAll(repoPath: string, message = "chore: seed"): Promise<string> {
  await runGit(["add", "-A"], { cwd: repoPath });
  await runGit(["commit", "-m", message], { cwd: repoPath });
  const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
  return head.stdout.trim();
}

async function makeWorkspace(slug: string): Promise<string> {
  const workspace = await tempDir("memsync-maint-ws-");
  await writeFile(join(workspace, ".memsync.json"), `{"project":"${slug}"}\n`, "utf8");
  return workspace;
}

describe("evaluateMaintenance", () => {
  const now = new Date("2026-11-14T12:00:00.000Z");
  const hoursAgo = (hours: number): Date => new Date(now.getTime() - hours * HOUR_MS);

  const base = {
    now,
    mainlineHead: "b",
    baselineHead: "a",
    lastSuccessAt: hoursAgo(73),
    lastAttemptAt: hoursAgo(7),
    policy: POLICY,
  };

  it("is due only on a new mainline commit after 72h and outside cooldown", () => {
    expect(evaluateMaintenance(base).due).toBe(true);
    expect(evaluateMaintenance({ ...base, lastSuccessAt: hoursAgo(71) }).due).toBe(false);
    expect(evaluateMaintenance({ ...base, lastAttemptAt: hoursAgo(2) }).due).toBe(false);
  });

  it("is not due when the mainline head has not moved", () => {
    expect(evaluateMaintenance({ ...base, baselineHead: "b" }).due).toBe(false);
  });

  it("is not due when the mainline head is unknown", () => {
    expect(evaluateMaintenance({ ...base, mainlineHead: "" }).due).toBe(false);
  });

  it("is due on a fresh project that has never been maintained", () => {
    const result = evaluateMaintenance({
      now,
      mainlineHead: "b",
      baselineHead: "",
      policy: POLICY,
    });
    expect(result.due).toBe(true);
  });

  it("respects the exact interval and cooldown boundaries", () => {
    expect(
      evaluateMaintenance({ ...base, lastSuccessAt: hoursAgo(72) }).due,
    ).toBe(true);
    expect(
      evaluateMaintenance({ ...base, lastAttemptAt: hoursAgo(6) }).due,
    ).toBe(true);
  });
});

describe("compactJournals", () => {
  async function makeProject(): Promise<{
    projectDir: string;
    workspace: string;
    oldPaths: string[];
    keptPath: string;
  }> {
    const projectDir = await tempDir("memsync-compact-project-");
    await mkdir(join(projectDir, "journal"), { recursive: true });
    await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
    const workspace = await tempDir("memsync-compact-ws-");

    const oldA = await createJournal({
      projectDir,
      project: SLUG,
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: "claude-code",
      session: "old-session-a",
      workspace,
      baseCommit: "unknown",
      now: new Date("2026-07-15T10:00:00.000Z"),
    });
    const oldB = await createJournal({
      projectDir,
      project: SLUG,
      user: "bob",
      email: "bob@corp.com",
      host: HOST,
      tool: "codex",
      session: "old-session-b",
      workspace,
      baseCommit: "unknown",
      now: new Date("2026-08-02T10:00:00.000Z"),
    });
    const kept = await createJournal({
      projectDir,
      project: SLUG,
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: "claude-code",
      session: "new-session-c",
      workspace,
      baseCommit: "unknown",
      now: new Date("2026-10-10T10:00:00.000Z"),
    });

    return { projectDir, workspace, oldPaths: [oldA.path, oldB.path], keptPath: kept.path };
  }

  it("compacts old journals by moving, not deleting", async () => {
    const project = await makeProject();
    const before = new Date("2026-09-01T00:00:00.000Z");
    const originals = await Promise.all(
      project.oldPaths.map((path) => readFile(path, "utf8")),
    );

    const moved = await compactJournals(project.projectDir, before);

    expect(moved).toBe(2);
    expect(existsSync(join(project.projectDir, "archive"))).toBe(true);
    for (const path of project.oldPaths) {
      expect(existsSync(path)).toBe(false);
    }
    expect(existsSync(project.keptPath)).toBe(true);

    const archived = (
      await Promise.all(
        ["2026-07", "2026-08"].map((month) =>
          readdir(join(project.projectDir, "archive", month), { recursive: true }),
        ),
      )
    ).flat();
    expect(archived.some((name) => name.endsWith(".md") && name !== "index.md")).toBe(true);

    const archivedFiles = await readdir(join(project.projectDir, "archive"), {
      recursive: true,
    });
    const markdown = archivedFiles.filter(
      (name) => name.endsWith(".md") && !name.endsWith("index.md"),
    );
    expect(markdown).toHaveLength(2);

    const contents = await Promise.all(
      archivedFiles
        .filter((name) => name.endsWith(".md") && !name.endsWith("index.md"))
        .map((name) => readFile(join(project.projectDir, "archive", name), "utf8")),
    );
    expect(contents.sort()).toEqual([...originals].sort());
  });

  it("updates archive/<month>/index.md with session, user, date, and path", async () => {
    const project = await makeProject();

    await compactJournals(project.projectDir, new Date("2026-09-01T00:00:00.000Z"));

    const julyIndex = await readFile(
      join(project.projectDir, "archive", "2026-07", "index.md"),
      "utf8",
    );
    expect(julyIndex).toContain("old-session-a");
    expect(julyIndex).toContain("alice");
    expect(julyIndex).toMatch(/2026-07-1[45]/);
    expect(julyIndex).toContain("archive/2026-07/");

    const augustIndex = await readFile(
      join(project.projectDir, "archive", "2026-08", "index.md"),
      "utf8",
    );
    expect(augustIndex).toContain("old-session-b");
    expect(augustIndex).toContain("bob");
  });

  it("is idempotent and never touches newer journals", async () => {
    const project = await makeProject();

    expect(await compactJournals(project.projectDir, new Date("2026-09-01T00:00:00.000Z"))).toBe(2);
    const indexBefore = await readFile(
      join(project.projectDir, "archive", "2026-07", "index.md"),
      "utf8",
    );

    expect(await compactJournals(project.projectDir, new Date("2026-09-01T00:00:00.000Z"))).toBe(0);
    expect(
      await readFile(join(project.projectDir, "archive", "2026-07", "index.md"), "utf8"),
    ).toBe(indexBefore);
    expect(existsSync(project.keptPath)).toBe(true);
  });

  it("leaves both files in place when an archive destination already exists", async () => {
    const project = await makeProject();
    const [julySource] = project.oldPaths;
    const relativePath = relative(join(project.projectDir, "journal"), julySource);
    const destination = join(
      project.projectDir,
      "archive",
      ...relativePath.split(/[\\/]/),
    );
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "PRESERVED ARCHIVE CONTENT", "utf8");

    const moved = await compactJournals(
      project.projectDir,
      new Date("2026-09-01T00:00:00.000Z"),
    );

    // July collides and is skipped; August still moves.
    expect(moved).toBe(1);
    expect(existsSync(julySource)).toBe(true);
    expect(await readFile(destination, "utf8")).toBe("PRESERVED ARCHIVE CONTENT");
  });

  it("rebuilds an index for an existing archive month that lacks one", async () => {
    const project = await makeProject();
    const julySource = project.oldPaths[0];
    const relativePath = relative(join(project.projectDir, "journal"), julySource);
    const archived = join(
      project.projectDir,
      "archive",
      ...relativePath.split(/[\\/]/),
    );
    await mkdir(dirname(archived), { recursive: true });
    await rename(julySource, archived);
    expect(
      existsSync(join(project.projectDir, "archive", "2026-07", "index.md")),
    ).toBe(false);

    const moved = await compactJournals(
      project.projectDir,
      new Date("2026-09-01T00:00:00.000Z"),
    );

    expect(moved).toBe(1);
    const index = await readFile(
      join(project.projectDir, "archive", "2026-07", "index.md"),
      "utf8",
    );
    expect(index).toContain("old-session-a");
    expect(index).toContain("archive/2026-07/");
  });
});

describe("scheduleMaintenance", () => {
  interface SpawnCall {
    command: string;
    args: string[];
    options: Record<string, unknown>;
    unrefCalled: boolean;
  }

  function fakeSpawn(call: SpawnCall | undefined): {
    spawn: typeof import("node:child_process").spawn;
    calls: SpawnCall[];
  } {
    const calls: SpawnCall[] = [];
    const spawn = ((
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      const record: SpawnCall = { command, args, options, unrefCalled: false };
      calls.push(record);
      return {
        unref: () => {
          record.unrefCalled = true;
        },
      };
    }) as unknown as typeof import("node:child_process").spawn;
    return { spawn, calls };
  }

  async function makeDueSetup(): Promise<{
    env: NodeJS.ProcessEnv;
    workspace: string;
    head: string;
    now: Date;
  }> {
    const repoPath = await makeGitRepo();
    const head = await commitAll(repoPath);
    const home = await tempDir("memsync-maint-home-");
    const env = {
      ...process.env,
      MEMSYNC_HOME: home,
      MEMSYS_HOST: HOST,
    } as NodeJS.ProcessEnv;
    await saveConfig(env, {
      version: 1,
      repoPath,
      remoteUrl: "git@git.corp.com:shop/memory.git",
      identity: { name: "Alice", email: "alice@corp.com" },
      defaultBudgetChars: 12_000,
    });
    const workspace = await makeWorkspace(SLUG);
    const now = new Date("2026-11-14T12:00:00.000Z");
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(
      join(home, "state", "maintenance.json"),
      `${JSON.stringify(
        {
          [SLUG]: {
            baselineHead: "stale-head",
            lastSuccessAt: new Date(now.getTime() - 100 * HOUR_MS).toISOString(),
            lastAttemptAt: new Date(now.getTime() - 10 * HOUR_MS).toISOString(),
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { env, workspace, head, now };
  }

  it("spawns a detached maintain process with the CLI path when due", async () => {
    const setup = await makeDueSetup();
    const fake = fakeSpawn(undefined);

    const scheduled = await scheduleMaintenance(setup.env, setup.workspace, {
      spawn: fake.spawn,
      cliPath: "C:\\fake\\memsync.mjs",
      now: setup.now,
    });

    expect(scheduled).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.command).toBe(process.execPath);
    expect(call.args).toEqual(["C:\\fake\\memsync.mjs", "maintain", "--quiet"]);
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toBe("ignore");
    expect(call.options.env).toBe(setup.env);
    expect(call.options.cwd).toBe(setup.workspace);
    expect(call.unrefCalled).toBe(true);
  });

  it("does not spawn when the baseline matches the mainline head", async () => {
    const setup = await makeDueSetup();
    const statePath = join(setup.env.MEMSYNC_HOME as string, "state", "maintenance.json");
    await writeFile(
      statePath,
      `${JSON.stringify({
        [SLUG]: { baselineHead: setup.head, lastSuccessAt: setup.now.toISOString() },
      })}\n`,
      "utf8",
    );
    const fake = fakeSpawn(undefined);

    const scheduled = await scheduleMaintenance(setup.env, setup.workspace, {
      spawn: fake.spawn,
      cliPath: "C:\\fake\\memsync.mjs",
      now: setup.now,
    });

    expect(scheduled).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("honors MEMSYNC_NO_MAINTENANCE=1", async () => {
    const setup = await makeDueSetup();
    const fake = fakeSpawn(undefined);
    const env = { ...setup.env, MEMSYNC_NO_MAINTENANCE: "1" };

    const scheduled = await scheduleMaintenance(env, setup.workspace, {
      spawn: fake.spawn,
      cliPath: "C:\\fake\\memsync.mjs",
      now: setup.now,
    });

    expect(scheduled).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("swallows scheduling failures", async () => {
    const setup = await makeDueSetup();
    const spawn = (() => {
      throw new Error("spawn failed");
    }) as unknown as typeof import("node:child_process").spawn;

    await expect(
      scheduleMaintenance(setup.env, setup.workspace, {
        spawn,
        cliPath: "C:\\fake\\memsync.mjs",
        now: setup.now,
      }),
    ).resolves.toBe(false);
  });
});
