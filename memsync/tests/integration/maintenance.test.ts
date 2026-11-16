import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli, type CliIo } from "../../src/cli.js";
import { saveConfig } from "../../src/core/config.js";
import { runGit } from "../../src/core/git.js";
import { createJournal } from "../../src/core/journal.js";
import {
  evaluateProjectMaintenance,
  runMaintenance,
} from "../../src/core/maintenance.js";
import { cloneOrUpdateRepo } from "../../src/core/repo.js";
import { getStatus } from "../../src/core/status.js";
import { syncProject } from "../../src/core/sync.js";
import { makeBareRemote } from "../helpers.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const SLUG = "checkout-service";
const HOST = "WIN-TEST";
const EMAIL = "alice@corp.com";
const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";

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

interface Setup {
  home: string;
  repoPath: string;
  projectDir: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

async function configureGit(repoPath: string): Promise<void> {
  await runGit(["config", "user.name", "Test User"], { cwd: repoPath });
  await runGit(["config", "user.email", "test@example.com"], { cwd: repoPath });
  await runGit(["config", "core.autocrlf", "false"], { cwd: repoPath });
}

async function makeLocalSetup(): Promise<Setup> {
  const home = await mkdtemp(join(tmpdir(), "memsync-maint-it-home-"));
  const repoPath = join(home, "repo");
  await mkdir(repoPath, { recursive: true });
  await runGit(["init"], { cwd: repoPath });
  await configureGit(repoPath);

  const env = { ...process.env, MEMSYNC_HOME: home, MEMSYS_HOST: HOST } as NodeJS.ProcessEnv;
  await saveConfig(env, {
    version: 1,
    repoPath,
    remoteUrl: "git@git.corp.com:shop/memory.git",
    identity: { name: "Alice", email: EMAIL },
    defaultBudgetChars: 12_000,
  });

  const projectDir = join(repoPath, "projects", SLUG);
  await mkdir(join(projectDir, "journal"), { recursive: true });
  await writeFile(join(projectDir, "meta.yaml"), META, "utf8");

  const workspace = await mkdtemp(join(tmpdir(), "memsync-maint-it-ws-"));
  await writeFile(join(workspace, ".memsync.json"), `{"project":"${SLUG}"}\n`, "utf8");

  return { home, repoPath, projectDir, workspace, env };
}

async function commitAll(repoPath: string, message = "chore: seed"): Promise<string> {
  await runGit(["add", "-A"], { cwd: repoPath });
  await runGit(["commit", "-m", message], { cwd: repoPath });
  const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
  return head.stdout.trim();
}

async function writeMaintenanceState(
  home: string,
  entry: Record<string, string>,
): Promise<void> {
  await mkdir(join(home, "state"), { recursive: true });
  await writeFile(
    join(home, "state", "maintenance.json"),
    `${JSON.stringify({ [SLUG]: entry }, null, 2)}\n`,
    "utf8",
  );
}

async function addOldJournal(setup: Setup, now: Date): Promise<string> {
  const journal = await createJournal({
    projectDir: setup.projectDir,
    project: SLUG,
    user: "alice",
    email: EMAIL,
    host: HOST,
    tool: "claude-code",
    session: "old-session",
    workspace: setup.workspace,
    baseCommit: "unknown",
    now,
  });
  return journal.path;
}

interface TestIo extends CliIo {
  out: string[];
  err: string[];
}

function makeIo(cwd: string, env: NodeJS.ProcessEnv): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    env,
    stdin: async () => "",
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    out,
    err,
  };
}

describe("runMaintenance", () => {
  it("does nothing and writes no state when not due", async () => {
    const setup = await makeLocalSetup();
    const head = await commitAll(setup.repoPath);
    const now = new Date("2026-11-14T12:00:00.000Z");
    await writeMaintenanceState(setup.home, {
      baselineHead: head,
      lastSuccessAt: new Date(now.getTime() - HOUR_MS).toISOString(),
    });

    const result = await runMaintenance(setup.projectDir, now, { env: setup.env });

    expect(result).toEqual({ stateRefreshed: false, archived: 0 });
    expect(existsSync(join(setup.projectDir, "state.md"))).toBe(false);
  });

  it("refreshes state, archives old journals, updates state, and commits once", async () => {
    const setup = await makeLocalSetup();
    const now = new Date("2026-11-14T12:00:00.000Z");
    const oldJournal = await addOldJournal(
      setup,
      new Date(now.getTime() - 120 * DAY_MS),
    );
    const head = await commitAll(setup.repoPath);
    await writeMaintenanceState(setup.home, {
      baselineHead: "stale-head",
      lastSuccessAt: new Date(now.getTime() - 100 * HOUR_MS).toISOString(),
      lastAttemptAt: new Date(now.getTime() - 10 * HOUR_MS).toISOString(),
    });

    const result = await runMaintenance(setup.projectDir, now, { env: setup.env });

    expect(result.stateRefreshed).toBe(true);
    expect(result.archived).toBe(1);
    expect(existsSync(oldJournal)).toBe(false);
    expect(existsSync(join(setup.projectDir, "state.md"))).toBe(true);
    expect(existsSync(join(setup.projectDir, "archive"))).toBe(true);

    const log = await runGit(["log", "-1", "--format=%B"], { cwd: setup.repoPath });
    expect(log.stdout).toContain("maintain: refresh state");
    expect(log.stdout).toContain(TRAILER);

    const state = JSON.parse(
      await readFile(join(setup.home, "state", "maintenance.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    const postMaintenanceHead = (
      await runGit(["rev-parse", "HEAD"], { cwd: setup.repoPath })
    ).stdout.trim();
    expect(postMaintenanceHead).not.toBe(head);
    expect(state[SLUG].baselineHead).toBe(postMaintenanceHead);
    expect(state[SLUG].lastSuccessAt).toBe(now.toISOString());
    expect(state[SLUG].lastAttemptAt).toBe(now.toISOString());

    // The maintenance commit itself must not make the next evaluation due.
    const again = await runMaintenance(
      setup.projectDir,
      new Date(now.getTime() + HOUR_MS),
      { env: setup.env },
    );
    expect(again).toEqual({ stateRefreshed: false, archived: 0 });
  });

  it("commits a move when the journal was never tracked by git", async () => {
    const setup = await makeLocalSetup();
    const now = new Date("2026-11-14T12:00:00.000Z");
    await commitAll(setup.repoPath);
    // Created after the seed commit, so the journal is untracked.
    const oldJournal = await addOldJournal(
      setup,
      new Date(now.getTime() - 120 * DAY_MS),
    );
    await writeMaintenanceState(setup.home, {
      baselineHead: "stale-head",
      lastSuccessAt: new Date(now.getTime() - 100 * HOUR_MS).toISOString(),
    });

    const result = await runMaintenance(setup.projectDir, now, { env: setup.env });

    expect(result.archived).toBe(1);
    expect(existsSync(oldJournal)).toBe(false);
    const status = await runGit(["status", "--porcelain"], { cwd: setup.repoPath });
    expect(status.stdout.trim()).toBe("");
    const tracked = await runGit(["ls-files", `projects/${SLUG}/archive`], {
      cwd: setup.repoPath,
    });
    expect(tracked.stdout).toContain(".md");
  });

  it("refuses to run while another process holds the memory lock", async () => {
    const setup = await makeLocalSetup();
    const now = new Date("2026-11-14T12:00:00.000Z");
    await commitAll(setup.repoPath);
    await writeMaintenanceState(setup.home, {
      baselineHead: "stale-head",
      lastSuccessAt: new Date(now.getTime() - 100 * HOUR_MS).toISOString(),
    });
    await writeFile(
      join(setup.home, "lock"),
      `${JSON.stringify({
        pid: 999_999,
        startedAt: now.toISOString(),
        token: "held-by-another-process",
      })}\n`,
      "utf8",
    );

    await expect(
      runMaintenance(setup.projectDir, now, {
        env: setup.env,
        lockTimeoutMs: 100,
      }),
    ).rejects.toThrow(/lock/i);
    expect(existsSync(join(setup.projectDir, "state.md"))).toBe(false);
  });

  it("records an attempt so a failed run enters cooldown", async () => {
    const setup = await makeLocalSetup();
    const now = new Date("2026-11-14T12:00:00.000Z");
    await commitAll(setup.repoPath);
    await writeMaintenanceState(setup.home, {
      baselineHead: "stale-head",
      lastSuccessAt: new Date(now.getTime() - 100 * HOUR_MS).toISOString(),
    });
    // A directory where state.md should be makes the refresh fail after the
    // attempt has been recorded.
    await mkdir(join(setup.projectDir, "state.md"), { recursive: true });

    await expect(runMaintenance(setup.projectDir, now, { env: setup.env })).rejects.toThrow();

    const state = JSON.parse(
      await readFile(join(setup.home, "state", "maintenance.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    expect(state[SLUG].lastAttemptAt).toBe(now.toISOString());
    expect(state[SLUG].lastSuccessAt).toBe(
      new Date(now.getTime() - 100 * HOUR_MS).toISOString(),
    );
  });
});

describe("maintain and compact commands", () => {
  it("reports due status with maintain --check", async () => {
    const setup = await makeLocalSetup();
    await commitAll(setup.repoPath);
    const io = makeIo(setup.workspace, setup.env);

    const code = await runCli(["maintain", "--check"], io);

    expect(code).toBe(0);
    expect(io.out.join("")).toContain("due");
  });

  it("runs maintenance and stays quiet with --quiet", async () => {
    const setup = await makeLocalSetup();
    await addOldJournal(setup, new Date(Date.now() - 120 * DAY_MS));
    await commitAll(setup.repoPath);
    const io = makeIo(setup.workspace, setup.env);

    const code = await runCli(["maintain", "--quiet"], io);

    expect(code).toBe(0);
    expect(io.out.join("")).toBe("");
    expect(existsSync(join(setup.projectDir, "archive"))).toBe(true);
  });

  it("archives journals older than --before", async () => {
    const setup = await makeLocalSetup();
    const oldJournal = await addOldJournal(setup, new Date("2026-07-15T10:00:00.000Z"));
    await commitAll(setup.repoPath);
    const io = makeIo(setup.workspace, setup.env);

    const code = await runCli(["compact", "--before", "2026-09-01"], io);

    expect(code).toBe(0);
    expect(io.out.join("")).toContain("1");
    expect(existsSync(oldJournal)).toBe(false);
    const archived = await readdir(join(setup.projectDir, "archive"), { recursive: true });
    expect(archived.some((name) => name.endsWith(".md"))).toBe(true);
  });
});

describe("getStatus", () => {
  it("reports config, repo, last sync, pending push, lock, size, and maintenance due", async () => {
    const remote = await makeBareRemote();
    const home = await mkdtemp(join(tmpdir(), "memsync-status-home-"));
    const repoPath = join(home, "repo");
    await cloneOrUpdateRepo({ remoteUrl: remote.remote, repoPath });
    await configureGit(repoPath);
    // The bare seed may use master; normalize to the project's main branch so
    // origin/main resolves like a production memory repo.
    await runGit(["checkout", "-B", "main"], { cwd: repoPath });
    await runGit(["push", "-u", "origin", "main"], { cwd: repoPath });

    const env = { ...process.env, MEMSYNC_HOME: home, MEMSYS_HOST: HOST } as NodeJS.ProcessEnv;
    await saveConfig(env, {
      version: 1,
      repoPath,
      remoteUrl: remote.remote,
      identity: { name: "Alice", email: EMAIL },
      defaultBudgetChars: 12_000,
    });

    const projectDir = join(repoPath, "projects", SLUG);
    await mkdir(join(projectDir, "journal"), { recursive: true });
    await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
    await writeFile(join(projectDir, "state.md"), "# state\n", "utf8");

    // A local commit that is not pushed leaves a pending push.
    await commitAll(repoPath, "chore: local memory change");

    // Newest cached pack sidecar wins.
    const packs = join(home, "cache", "packs");
    await mkdir(packs, { recursive: true });
    await writeFile(
      join(packs, "checkout-service.meta.json"),
      `${JSON.stringify({ syncedAt: "2026-11-13T10:00:00.000Z" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(packs, "other.meta.json"),
      `${JSON.stringify({ syncedAt: "2026-11-12T10:00:00.000Z" }, null, 2)}\n`,
      "utf8",
    );

    await writeFile(join(home, "lock"), "{}\n", "utf8");
    const workspace = await mkdtemp(join(tmpdir(), "memsync-status-ws-"));
    await writeFile(join(workspace, ".memsync.json"), `{"project":"${SLUG}"}\n`, "utf8");

    const report = await getStatus(env, workspace);

    expect(report.configPath).toBe(join(home, "config.json"));
    expect(report.repoPath).toBe(repoPath);
    expect(report.lastSyncAt).toBe("2026-11-13T10:00:00.000Z");
    expect(report.pendingPush).toBe(true);
    expect(report.locked).toBe(true);
    expect(report.repoBytes).toBeGreaterThan(0);
    expect(report.maintenanceDue).toBe(true);
  });

  it("returns safe defaults without a config", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-status-empty-"));
    const env = { ...process.env, MEMSYNC_HOME: home } as NodeJS.ProcessEnv;
    const workspace = await mkdtemp(join(tmpdir(), "memsync-status-unlinked-"));

    const report = await getStatus(env, workspace);

    expect(report.configPath).toBeUndefined();
    expect(report.repoPath).toBeUndefined();
    expect(report.pendingPush).toBe(false);
    expect(report.locked).toBe(false);
    expect(report.repoBytes).toBe(0);
    expect(report.maintenanceDue).toBe(false);
  });
});

describe("syncProject maintenance scheduling", () => {
  it("schedules maintenance without blocking the sync result", async () => {
    const remote = await makeBareRemote();
    const home = await mkdtemp(join(tmpdir(), "memsync-sync-maint-home-"));
    const repoPath = join(home, "repo");
    await cloneOrUpdateRepo({ remoteUrl: remote.remote, repoPath });
    await configureGit(repoPath);
    await runGit(["checkout", "-B", "main"], { cwd: repoPath });
    await runGit(["push", "-u", "origin", "main"], { cwd: repoPath });

    const env = {
      ...process.env,
      MEMSYNC_HOME: home,
      MEMSYS_HOST: HOST,
      MEMSYS_TOOL: "",
    } as NodeJS.ProcessEnv;
    await saveConfig(env, {
      version: 1,
      repoPath,
      remoteUrl: remote.remote,
      identity: { name: "Alice", email: EMAIL },
      defaultBudgetChars: 12_000,
    });

    const projectDir = join(repoPath, "projects", SLUG);
    await mkdir(join(projectDir, "journal"), { recursive: true });
    await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
    const head = await commitAll(repoPath, "chore: add project");
    await runGit(["push"], { cwd: repoPath });

    const now = new Date("2026-11-14T12:00:00.000Z");
    await writeMaintenanceState(home, {
      baselineHead: "stale-head",
      lastSuccessAt: new Date(now.getTime() - 100 * HOUR_MS).toISOString(),
      lastAttemptAt: new Date(now.getTime() - 10 * HOUR_MS).toISOString(),
    });

    const workspace = await mkdtemp(join(tmpdir(), "memsync-sync-maint-ws-"));
    await writeFile(join(workspace, ".memsync.json"), `{"project":"${SLUG}"}\n`, "utf8");

    const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const spawn = ((
      _command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      calls.push({ args, options });
      return { unref: () => undefined };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await syncProject({
      cwd: workspace,
      env,
      noPull: false,
      maintenanceDeps: { spawn, cliPath: "C:\\fake\\memsync.mjs", now },
    });

    expect(result.code).toBe(0);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].args).toEqual(["C:\\fake\\memsync.mjs", "maintain", "--quiet"]);
    expect(head).not.toBe("");

    const evaluation = await evaluateProjectMaintenance(projectDir, env, now);
    expect(evaluation.due).toBe(true);
  });

  it("skips scheduling when noMaintenance is set", async () => {
    const setup = await makeLocalSetup();
    await commitAll(setup.repoPath);
    const calls: unknown[] = [];
    const spawn = ((...args: unknown[]) => {
      calls.push(args);
      return { unref: () => undefined };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await syncProject({
      cwd: setup.workspace,
      env: setup.env,
      noPull: true,
      noMaintenance: true,
      maintenanceDeps: { spawn, cliPath: "C:\\fake\\memsync.mjs" },
    });

    expect(result.code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(0);
  });
});
