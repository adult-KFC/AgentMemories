import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../../src/cli.js";
import { writeCachedPack } from "../../src/core/cache.js";
import { saveConfig } from "../../src/core/config.js";
import { runGit } from "../../src/core/git.js";
import {
  findJournalBySession,
  readJournal,
} from "../../src/core/journal.js";
import { beginSession } from "../../src/core/session.js";
import {
  handleClaudeHook,
  type ClaudeHookEvent,
  type ClaudeHookInput,
} from "../../src/adapters/claude.js";

const HOST = "WIN-TEST";
const SLUG = "checkout-service";
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

const CONSTRAINTS = `# 核心约束（权威）

## 必须

- MUST 所有对外接口使用 internal/contract 中的 IDL
  - 适用：所有对外 HTTP/RPC 接口
  - 状态：active

## 禁止

- MUST NOT 在 domain 层直接调用第三方 HTTP API
`;

const CONVENTIONS = `# 团队通用规范

## 必须

- MUST 所有代码变更走 MR
`;

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

async function makeSetup(): Promise<Setup> {
  const home = await mkdtemp(join(tmpdir(), "memsync-hook-home-"));
  const repoPath = join(home, "repo");
  await mkdir(repoPath, { recursive: true });
  await runGit(["init"], { cwd: repoPath });
  await configureGit(repoPath);

  const env = {
    ...process.env,
    MEMSYNC_HOME: home,
    MEMSYS_HOST: HOST,
    MEMSYS_TOOL: "",
  } as NodeJS.ProcessEnv;

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
  await mkdir(join(repoPath, "org"), { recursive: true });
  await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
  await writeFile(join(projectDir, "constraints.md"), CONSTRAINTS, "utf8");
  await writeFile(join(repoPath, "org", "conventions.md"), CONVENTIONS, "utf8");

  const workspace = await mkdtemp(join(tmpdir(), "memsync-hook-ws-"));
  await writeFile(
    join(workspace, ".memsync.json"),
    `{"project":"${SLUG}"}\n`,
    "utf8",
  );

  return { home, repoPath, projectDir, workspace, env };
}

interface TestIo extends CliIo {
  out: string[];
  err: string[];
}

function makeIo(
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin = "",
): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    env,
    stdin: async () => stdin,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    out,
    err,
  };
}

function payload(
  setup: Setup,
  overrides: Partial<ClaudeHookInput> = {},
): ClaudeHookInput {
  return {
    session_id: "s1",
    cwd: setup.workspace,
    source: "startup",
    ...overrides,
  };
}

function hook(
  event: ClaudeHookEvent,
  input: ClaudeHookInput | string,
  io: CliIo,
) {
  return handleClaudeHook(event, input, io);
}

describe("handleClaudeHook SessionStart", () => {
  it("returns additionalContext JSON and begins a session", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.workspace, setup.env);

    const result = await hook("session-start", payload(setup), io);

    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("项目核心约束");
    expect(await findJournalBySession(setup.projectDir, "s1")).toBeDefined();
    expect(io.err.join("")).toBe("");
  });

  it("injects the offline warning without a cache and still renders local memory", async () => {
    const setup = await makeSetup();
    // This repo has no remote, so the pull fails.
    const io = makeIo(setup.workspace, setup.env);

    const result = await hook("session-start", payload(setup), io);

    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext as string;
    expect(context).toContain("[memsync] 离线");
    expect(context).toContain("项目核心约束");
  });

  it("injects the offline warning and cached pack when the pull fails", async () => {
    const setup = await makeSetup();
    await writeCachedPack(
      setup.env,
      SLUG,
      "缓存中的团队记忆",
      "2026-11-13T10:00:00.000Z",
    );
    const io = makeIo(setup.workspace, setup.env);

    const result = await hook("session-start", payload(setup), io);

    const context = JSON.parse(result.stdout).hookSpecificOutput
      .additionalContext as string;
    expect(context).toContain("[memsync] 离线");
    expect(context).toContain("缓存中的团队记忆");
  });

  it("writes MEMSYS_SESSION, MEMSYS_TOOL, and MEMSYS_HOST to CLAUDE_ENV_FILE", async () => {
    const setup = await makeSetup();
    const envFile = join(setup.home, "env.sh");
    const env = { ...setup.env, CLAUDE_ENV_FILE: envFile };
    const io = makeIo(setup.workspace, env);

    await hook("session-start", payload(setup), io);

    const text = await readFile(envFile, "utf8");
    expect(text).toContain("export MEMSYS_SESSION='s1'");
    expect(text).toContain("export MEMSYS_TOOL='claude-code'");
    expect(text).toContain(`export MEMSYS_HOST='${HOST}'`);
  });

  it("single-quote-escapes env values", async () => {
    const setup = await makeSetup();
    const envFile = join(setup.home, "env.sh");
    const env = { ...setup.env, CLAUDE_ENV_FILE: envFile };
    const io = makeIo(setup.workspace, env);

    await hook(
      "session-start",
      payload(setup, { session_id: "a'b" }),
      io,
    );

    const text = await readFile(envFile, "utf8");
    expect(text).toContain("export MEMSYS_SESSION='a'\\''b'");
  });

  it("writes the env file even when the context is empty", async () => {
    const setup = await makeSetup();
    // Remove constraints so the pack still renders; the env file is independent.
    const envFile = join(setup.home, "env.sh");
    const env = { ...setup.env, CLAUDE_ENV_FILE: envFile };
    const io = makeIo(setup.workspace, env);

    const result = await hook("session-start", payload(setup), io);

    expect(JSON.parse(result.stdout).hookSpecificOutput).toBeDefined();
    expect(await readFile(envFile, "utf8")).toContain("MEMSYS_SESSION");
  });

  it("outputs {} and writes no env file for an unlinked workspace", async () => {
    const setup = await makeSetup();
    const unlinked = await mkdtemp(join(tmpdir(), "memsync-hook-unlinked-"));
    const envFile = join(setup.home, "env.sh");
    const env = { ...setup.env, CLAUDE_ENV_FILE: envFile };
    const io = makeIo(unlinked, env);

    const result = await hook("session-start", payload(setup, { cwd: unlinked }), io);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    await expect(stat(envFile)).rejects.toThrow();
  });

  it("outputs {} when no config exists", async () => {
    const setup = await makeSetup();
    const emptyHome = await mkdtemp(join(tmpdir(), "memsync-hook-noconfig-"));
    const env = { ...setup.env, MEMSYNC_HOME: emptyHome };
    const io = makeIo(setup.workspace, env);

    const result = await hook("session-start", payload(setup), io);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
  });

  it("accepts raw stdin JSON", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.workspace, setup.env);

    const result = await hook(
      "session-start",
      JSON.stringify(payload(setup)),
      io,
    );

    expect(JSON.parse(result.stdout).hookSpecificOutput).toBeDefined();
  });
});

describe("handleClaudeHook SessionEnd and PreCompact", () => {
  it("ends the session and outputs {}", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.workspace, setup.env);

    await beginSession({
      projectDir: setup.projectDir,
      project: SLUG,
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: "claude-code",
      session: "s1",
      workspace: setup.workspace,
    });

    const result = await hook("session-end", payload(setup), io);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    const path = (await findJournalBySession(setup.projectDir, "s1"))!;
    expect((await readJournal(path)).ended).toBeDefined();
  });

  it("is a silent no-op when the journal is missing", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.workspace, setup.env);

    const result = await hook(
      "session-end",
      payload(setup, { session_id: "missing" }),
      io,
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    expect(io.err.join("")).toBe("");
  });

  it("checkpoints the current journal on PreCompact and commits the trailer", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.workspace, setup.env);

    await beginSession({
      projectDir: setup.projectDir,
      project: SLUG,
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: "claude-code",
      session: "s1",
      workspace: setup.workspace,
    });

    const result = await hook("pre-compact", payload(setup), io);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    const log = await runGit(["log", "-1", "--pretty=%B"], { cwd: setup.repoPath });
    expect(log.stdout).toContain("journal: s1 checkpoint");
    expect(log.stdout).toContain(TRAILER);

    // A second PreCompact with no new changes must not duplicate the commit.
    await hook("pre-compact", payload(setup), io);
    const count = await runGit(["rev-list", "--count", "HEAD"], { cwd: setup.repoPath });
    expect(count.stdout.trim()).toBe("1");
  });
});

describe("handleClaudeHook failure isolation", () => {
  it("exits 0 with one stderr line and {} stdout on errors", async () => {
    const setup = await makeSetup();
    await writeFile(join(setup.home, "config.json"), "{ not json", "utf8");
    const io = makeIo(setup.workspace, setup.env);

    const result = await hook("session-start", payload(setup), io);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    const lines = io.err.join("").split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    // A stack trace would add more lines; a single diagnostic line has none.
    expect(lines[0]).not.toMatch(/^\s+at\s/);
  });
});

describe("memsync hook command", () => {
  it("routes claude-code SessionStart and prints the hook JSON", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.workspace, setup.env, JSON.stringify(payload(setup)));

    const code = await runCli(["hook", "session-start", "--tool", "claude-code"], io);

    expect(code).toBe(0);
    const out = JSON.parse(io.out.join(""));
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("exits 0 and still injects context when CLAUDE_ENV_FILE is unwritable", async () => {
    const setup = await makeSetup();
    // A directory cannot be used as the env file, so the write fails.
    const envDir = join(setup.home, "env-dir");
    await mkdir(envDir, { recursive: true });
    const env = { ...setup.env, CLAUDE_ENV_FILE: envDir };
    const io = makeIo(setup.workspace, env, JSON.stringify(payload(setup)));

    const code = await runCli(["hook", "session-start", "--tool", "claude-code"], io);

    expect(code).toBe(0);
    const out = JSON.parse(io.out.join(""));
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("项目核心约束");
    const lines = io.err.join("").split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^memsync hook:/);
  });

  it("routes codex hooks and outputs {} without cached capabilities", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.workspace, setup.env, "{}");

    const code = await runCli(["hook", "session-start", "--tool", "codex"], io);

    expect(code).toBe(0);
    expect(io.out.join("").trim()).toBe("{}");
  });

  it("rejects an unknown event", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.workspace, setup.env, "{}");

    const code = await runCli(["hook", "nope", "--tool", "claude-code"], io);

    expect(code).toBe(1);
    expect(io.err.join("")).toMatch(/event/i);
  });
});
