import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli.js";
import { runWrappedTool } from "../../src/adapters/codex-run.js";
import { saveConfig } from "../../src/core/config.js";
import { runGit } from "../../src/core/git.js";
import { findJournalBySession, readJournal } from "../../src/core/journal.js";
import { makeFakeCodex } from "../fixtures/codex-shim.js";
import { makeBareRemote } from "../helpers.js";

const HOST = "WIN-TEST";
const SLUG = "checkout-service";

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
  root: string;
  memsyncHome: string;
  codexHome: string;
  cwd: string;
  command: string;
  repoPath: string;
  projectDir: string;
  workspace: string;
  envLog: string;
  env: NodeJS.ProcessEnv;
}

async function makeSetup(): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "memsync-codex-run-"));
  const memsyncHome = join(root, "memsync-home");
  const codexHome = join(root, "codex-home");
  const cwd = join(root, "cwd");
  await mkdir(memsyncHome, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const fake = await makeFakeCodex();
  const envLog = join(root, "wrapped-env.json");

  const env = {
    ...process.env,
    MEMSYNC_HOME: memsyncHome,
    CODEX_HOME: codexHome,
    MEMSYNC_CODEX_PATH: fake.command,
    MEMSYS_HOST: HOST,
    MEMSYS_TOOL: "",
    MEMSYS_SESSION: "",
    FAKE_CODEX_ENV_LOG: envLog,
    FAKE_CODEX_EXIT_CODE: "7",
  } as NodeJS.ProcessEnv;

  const repoPath = join(memsyncHome, "repo");
  await mkdir(repoPath, { recursive: true });
  await runGit(["init"], { cwd: repoPath });
  await runGit(["config", "user.name", "Test User"], { cwd: repoPath });
  await runGit(["config", "user.email", "test@example.com"], { cwd: repoPath });
  await runGit(["config", "core.autocrlf", "false"], { cwd: repoPath });

  await saveConfig(env, {
    version: 1,
    repoPath,
    remoteUrl: "git@git.corp.com:shop/memory.git",
    identity: { name: "Alice", email: "alice@corp.com" },
    defaultBudgetChars: 12_000,
  });

  const projectDir = join(repoPath, "projects", SLUG);
  await mkdir(join(projectDir, "journal"), { recursive: true });
  await mkdir(join(projectDir, "decisions"), { recursive: true });
  await mkdir(join(projectDir, "versions"), { recursive: true });
  await writeFile(join(projectDir, "meta.yaml"), META, "utf8");

  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, ".memsync.json"),
    `{"project":"${SLUG}"}\n`,
    "utf8",
  );

  return {
    root,
    memsyncHome,
    codexHome,
    cwd: workspace,
    command: fake.command,
    repoPath,
    projectDir,
    workspace,
    envLog,
    env,
  };
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

interface WrappedLog {
  args: string[];
  MEMSYS_SESSION?: string;
  MEMSYS_TOOL?: string;
  MEMSYS_HOST?: string;
  MEMSYS_WRAPPER?: string;
  wrapperMarker?: boolean;
  cwd: string;
}

async function readWrappedLog(path: string): Promise<WrappedLog> {
  return JSON.parse(await readFile(path, "utf8")) as WrappedLog;
}

describe("runWrappedTool", () => {
  it("sets MEMSYS_SESSION and finalizes the session", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.cwd, setup.env);

    const code = await runWrappedTool({ tool: "codex", args: ["-p", "hi"], io });

    expect(code).toBe(7);
    const log = await readWrappedLog(setup.envLog);
    expect(log.args).toEqual(["-p", "hi"]);
    expect(log.MEMSYS_SESSION).toBeTruthy();
    expect(log.MEMSYS_TOOL).toBe("codex");
    expect(log.MEMSYS_HOST).toBe(HOST);
    expect(log.MEMSYS_WRAPPER).toBe("1");
    expect(log.wrapperMarker).toBe(true);
    expect(existsSync(join(setup.cwd, ".memsync", "wrapper-active"))).toBe(false);

    const path = await findJournalBySession(setup.projectDir, log.MEMSYS_SESSION!);
    expect(path).toBeDefined();
    expect((await readJournal(path!)).ended).toBeDefined();
  });

  it("returns the child exit code even when endSession fails", async () => {
    const setup = await makeSetup();
    // The wrapped process removes the journal directory before exiting, so the
    // wrapper's endSession cannot find the journal.
    setup.env.FAKE_CODEX_RM_DIR = join(setup.projectDir, "journal");
    const io = makeIo(setup.cwd, setup.env);

    const code = await runWrappedTool({ tool: "codex", args: ["-p", "hi"], io });

    expect(code).toBe(7);
    expect(io.err.join("")).toMatch(/memsync run/);
  });

  it("pulls and refreshes memory before launching the wrapped tool", async () => {
    const remote = await makeBareRemote();
    const root = await mkdtemp(join(tmpdir(), "memsync-codex-run-remote-"));
    const memsyncHome = join(root, "memsync-home");
    await mkdir(memsyncHome, { recursive: true });
    const repoPath = join(memsyncHome, "repo");
    await runGit(["clone", "-c", "core.autocrlf=false", remote.remote, repoPath], {
      cwd: root,
    });
    await runGit(["config", "user.name", "Test User"], { cwd: repoPath });
    await runGit(["config", "user.email", "test@example.com"], { cwd: repoPath });
    await runGit(["config", "core.autocrlf", "false"], { cwd: repoPath });

    const projectDir = join(repoPath, "projects", SLUG);
    await mkdir(join(projectDir, "journal"), { recursive: true });
    await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
    await runGit(["add", "-A"], { cwd: repoPath });
    await runGit(["commit", "-m", "chore: seed project"], { cwd: repoPath });
    await runGit(["push"], { cwd: repoPath });

    // Another machine pushes fresh memory before this wrapper starts.
    const updater = join(root, "updater");
    await runGit(["clone", "-c", "core.autocrlf=false", remote.remote, updater], {
      cwd: root,
    });
    await runGit(["config", "user.name", "Test User"], { cwd: updater });
    await runGit(["config", "user.email", "test@example.com"], { cwd: updater });
    await mkdir(join(updater, "org"), { recursive: true });
    await writeFile(join(updater, "org", "fresh.md"), "fresh memory\n", "utf8");
    await runGit(["add", "-A"], { cwd: updater });
    await runGit(["commit", "-m", "docs: fresh memory"], { cwd: updater });
    await runGit(["push"], { cwd: updater });

    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, ".memsync.json"),
      `{"project":"${SLUG}"}\n`,
      "utf8",
    );

    const envLog = join(root, "wrapped-env.json");
    const fake = await makeFakeCodex();
    const env = {
      ...process.env,
      MEMSYNC_HOME: memsyncHome,
      CODEX_HOME: join(root, "codex-home"),
      MEMSYNC_CODEX_PATH: fake.command,
      MEMSYS_HOST: HOST,
      MEMSYS_TOOL: "",
      MEMSYS_SESSION: "",
      MEMSYNC_NO_MAINTENANCE: "1",
      FAKE_CODEX_ENV_LOG: envLog,
      FAKE_CODEX_EXIT_CODE: "5",
    } as NodeJS.ProcessEnv;
    await saveConfig(env, {
      version: 1,
      repoPath,
      remoteUrl: remote.remote,
      identity: { name: "Alice", email: "alice@corp.com" },
      defaultBudgetChars: 12_000,
    });

    const io = makeIo(workspace, env);
    const code = await runWrappedTool({ tool: "codex", args: ["-p", "hi"], io });

    expect(code).toBe(5);
    expect(await readFile(join(repoPath, "org", "fresh.md"), "utf8")).toBe(
      "fresh memory\n",
    );
    const log = await readWrappedLog(envLog);
    expect(log.MEMSYS_SESSION).toBeTruthy();
    expect(
      await findJournalBySession(projectDir, log.MEMSYS_SESSION as string),
    ).toBeDefined();
  }, 30_000);

  it("still spawns the tool when no project is linked", async () => {
    const root = await mkdtemp(join(tmpdir(), "memsync-codex-run-unlinked-"));
    const fake = await makeFakeCodex();
    const envLog = join(root, "wrapped-env.json");
    const env = {
      ...process.env,
      MEMSYNC_HOME: join(root, "home"),
      CODEX_HOME: join(root, "codex-home"),
      MEMSYNC_CODEX_PATH: fake.command,
      MEMSYS_SESSION: "",
      FAKE_CODEX_ENV_LOG: envLog,
      FAKE_CODEX_EXIT_CODE: "3",
    } as NodeJS.ProcessEnv;
    const io = makeIo(root, env);

    const code = await runWrappedTool({ tool: "codex", args: ["-p", "hi"], io });

    expect(code).toBe(3);
    const log = await readWrappedLog(envLog);
    expect(log.MEMSYS_SESSION).toBeTruthy();
    expect(log.MEMSYS_TOOL).toBe("codex");
  });
});

describe("memsync run codex", () => {
  it("passes arguments after -- to the wrapped tool", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.cwd, setup.env);

    const code = await runCli(["run", "codex", "--", "-p", "hi"], io);

    expect(code).toBe(7);
    expect((await readWrappedLog(setup.envLog)).args).toEqual(["-p", "hi"]);
  });

  it("rejects an unsupported tool", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.cwd, setup.env);

    const code = await runCli(["run", "claude-code"], io);

    expect(code).toBe(1);
    expect(io.err.join("")).toMatch(/codex/i);
  });
});
