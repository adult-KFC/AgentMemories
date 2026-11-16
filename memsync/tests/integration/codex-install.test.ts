import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCliIo, runCli, type CliIo } from "../../src/cli.js";
import {
  handleCodexHook,
  installCodex,
  readCachedCodexCapabilities,
  type CodexHookInput,
} from "../../src/adapters/codex-install.js";
import { writeCachedPack } from "../../src/core/cache.js";
import { saveConfig } from "../../src/core/config.js";
import { runGit } from "../../src/core/git.js";
import { findJournalBySession, readJournal } from "../../src/core/journal.js";
import { beginSession } from "../../src/core/session.js";
import { makeFakeCodex } from "../fixtures/codex-shim.js";

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

const CONSTRAINTS = `# 核心约束（权威）

## 必须

- MUST 所有对外接口使用 internal/contract 中的 IDL
  - 适用：所有对外 HTTP/RPC 接口
  - 状态：active
`;

const CONVENTIONS = `# 团队通用规范

## 必须

- MUST 所有代码变更走 MR
`;

interface SetupBase {
  root: string;
  memsyncHome: string;
  codexHome: string;
  cwd: string;
  command: string;
  logPath: string;
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
}

/** Workspace plus an isolated MEMSYNC_HOME / CODEX_HOME and the fake Codex. */
async function makeBaseSetup(
  mode: string,
  extra: NodeJS.ProcessEnv = {},
): Promise<SetupBase> {
  const root = await mkdtemp(join(tmpdir(), "memsync-codex-install-"));
  const memsyncHome = join(root, "memsync-home");
  const codexHome = join(root, "codex-home");
  const cwd = join(root, "project");
  await mkdir(memsyncHome, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const fake = await makeFakeCodex();
  const logPath = join(root, "fake-codex.log");

  return {
    root,
    memsyncHome,
    codexHome,
    cwd,
    command: fake.command,
    logPath,
    pluginRoot: join(memsyncHome, "codex"),
    env: {
      ...process.env,
      MEMSYNC_HOME: memsyncHome,
      CODEX_HOME: codexHome,
      MEMSYNC_CODEX_PATH: fake.command,
      MEMSYNC_CLI_PATH: join(root, "fake", "memsync.mjs"),
      FAKE_CODEX_MODE: mode,
      FAKE_CODEX_LOG: logPath,
      FAKE_CODEX_HOOK_PLUGIN: "memsync-codex-adapter",
      FAKE_CODEX_HOOK_KEY: "memsync-codex-adapter@SessionStart",
      ...extra,
    } as NodeJS.ProcessEnv,
  };
}

interface LinkedSetup extends SetupBase {
  repoPath: string;
  projectDir: string;
  workspace: string;
}

/** Base setup plus a configured memory repo and a linked workspace. */
async function makeLinkedSetup(
  mode = "inject-ok",
  extra: NodeJS.ProcessEnv = {},
): Promise<LinkedSetup> {
  const base = await makeBaseSetup(mode, {
    MEMSYS_HOST: HOST,
    MEMSYS_TOOL: "",
    ...extra,
  });

  const repoPath = join(base.memsyncHome, "repo");
  await mkdir(repoPath, { recursive: true });
  await runGit(["init"], { cwd: repoPath });
  await runGit(["config", "user.name", "Test User"], { cwd: repoPath });
  await runGit(["config", "user.email", "test@example.com"], { cwd: repoPath });
  await runGit(["config", "core.autocrlf", "false"], { cwd: repoPath });

  await saveConfig(base.env, {
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

  const workspace = join(base.root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, ".memsync.json"),
    `{"project":"${SLUG}"}\n`,
    "utf8",
  );

  return { ...base, repoPath, projectDir, workspace };
}

async function readLog(path: string): Promise<Record<string, any>[]> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function cliCalls(entries: Record<string, any>[]): string[] {
  return entries
    .filter((entry) => entry.kind === "cli")
    .map((entry) => (entry.args as string[]).join(" "));
}

interface TestIo extends CliIo {
  out: string[];
  err: string[];
}

function makeIo(
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin = "",
  readLine?: () => Promise<string | undefined>,
): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    env,
    stdin: async () => stdin,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    ...(readLine !== undefined ? { readLine } : {}),
    out,
    err,
  };
}

function payload(
  setup: LinkedSetup,
  overrides: Partial<CodexHookInput> = {},
): CodexHookInput {
  return {
    session_id: "c1",
    cwd: setup.workspace,
    source: "startup",
    ...overrides,
  };
}

/** Seeds the Task 11 capabilities cache so the hook knows injection works. */
async function seedCapabilities(
  setup: SetupBase,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const key = `9.9.9|${setup.env.MEMSYNC_CODEX_PATH}`;
  const entry = {
    plugin: true,
    hooks: true,
    hookTrust: "supported",
    injectSessionStart: true,
    injectUserPrompt: true,
    envFile: null,
    path: "A",
    probedAt: new Date().toISOString(),
    ...overrides,
  };
  await mkdir(join(setup.memsyncHome, "state"), { recursive: true });
  await writeFile(
    join(setup.memsyncHome, "state", "capabilities.json"),
    `${JSON.stringify({ [key]: entry }, null, 2)}\n`,
    "utf8",
  );
}

describe("installCodex", () => {
  it("installs the plugin with marketplace add and plugin add --json", async () => {
    const setup = await makeBaseSetup("inject-ok");

    const report = await installCodex({
      env: setup.env,
      cwd: setup.cwd,
      yes: true,
    });

    expect(report.path).toBe("A");
    expect(report.hooks?.length).toBeGreaterThan(0);
    expect(report.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("plugin marketplace add"),
        expect.stringContaining("plugin add"),
      ]),
    );

    const calls = cliCalls(await readLog(setup.logPath));
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("plugin marketplace add"),
        expect.stringContaining("--json"),
      ]),
    );
    expect(calls.some((call) => /^plugin add memsync-codex-adapter --json$/.test(call))).toBe(
      true,
    );

    const marketplace = JSON.parse(
      await readFile(join(setup.pluginRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
    );
    expect(marketplace.plugins[0]).toMatchObject({ id: "memsync-codex-adapter" });
    // The entry must be absolute and point at the real plugin directory.
    const target = marketplace.plugins[0].path as string;
    expect(isAbsolute(target)).toBe(true);
    const entryPlugin = JSON.parse(
      await readFile(join(target, ".codex-plugin", "plugin.json"), "utf8"),
    );
    expect(entryPlugin.name).toBe("memsync-codex-adapter");

    // Path A must not add the fallback instructions.
    await expect(stat(join(setup.cwd, "AGENTS.md"))).rejects.toThrow();
  }, 30_000);

  it("writes SessionStart/UserPromptSubmit/Stop hooks with absolute CLI path", async () => {
    const setup = await makeBaseSetup("inject-ok");

    await installCodex({ env: setup.env, cwd: setup.cwd, yes: true });

    const plugin = JSON.parse(
      await readFile(join(setup.pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
    );
    expect(plugin).toMatchObject({
      name: "memsync-codex-adapter",
      version: "0.1.0",
      hooks: "./hooks/hooks.json",
    });

    const hooks = JSON.parse(
      await readFile(join(setup.pluginRoot, "hooks", "hooks.json"), "utf8"),
    );
    expect(Object.keys(hooks.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
    ]);
    expect(hooks.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");

    const start = hooks.hooks.SessionStart[0].hooks[0];
    expect(start.command).toContain(setup.env.MEMSYNC_CLI_PATH as string);
    expect(start.command).toContain("hook session-start --tool codex");
    expect(start.commandWindows).toBe(start.command);
    expect(start.timeout).toBe(30);

    const prompt = hooks.hooks.UserPromptSubmit[0].hooks[0];
    expect(prompt.command).toContain("hook user-prompt-submit --tool codex");
    const stop = hooks.hooks.Stop[0].hooks[0];
    expect(stop.command).toContain("hook stop --tool codex");
    expect(stop.timeout).toBe(30);

    const readme = await readFile(
      join(setup.pluginRoot, "hooks", "README.md"),
      "utf8",
    );
    expect(readme.length).toBeGreaterThan(0);
  }, 30_000);

  it("falls back to user-level AGENTS.md when forced to path B", async () => {
    const setup = await makeBaseSetup("inject-ok");

    const report = await installCodex({
      env: setup.env,
      cwd: setup.cwd,
      forcePath: "B",
    });

    expect(report.path).toBe("B");
    expect(report.commands).toEqual([]);
    expect(report.managedBlockPath).toBe(join(setup.codexHome, "AGENTS.md"));

    const text = await readFile(join(setup.codexHome, "AGENTS.md"), "utf8");
    expect(text).toContain("memsync:begin");
    expect(text).toContain("memsync sync --tool codex");
    expect(text).toContain("memsync note");
    expect(text).toContain("memsync session end");
    expect(text).toContain("MEMSYS_WRAPPER=1");
    expect(text).toContain(".memsync/wrapper-active");
    expect(text).toContain("沙箱网络限制");
    expect(text).toContain("constraints.md");
    expect(text).toContain("memsync recall");
    await expect(stat(join(setup.cwd, "AGENTS.md"))).rejects.toThrow();

    // Nothing is registered when the caller forces path B.
    expect(cliCalls(await readLog(setup.logPath))).toEqual([]);
    await expect(stat(join(setup.pluginRoot, "hooks", "hooks.json"))).rejects.toThrow();
  });

  it("writes the fallback inside the workspace at project scope", async () => {
    const setup = await makeBaseSetup("inject-ok");

    const report = await installCodex({
      env: setup.env,
      cwd: setup.cwd,
      forcePath: "B",
      scope: "project",
    });

    expect(report.path).toBe("B");
    expect(report.managedBlockPath).toBe(join(setup.cwd, "AGENTS.md"));
    expect(await readFile(join(setup.cwd, "AGENTS.md"), "utf8")).toContain(
      "memsync:begin",
    );
    await expect(stat(join(setup.codexHome, "AGENTS.md"))).rejects.toThrow();
  });

  it("honours --force-path A even when injection probing would degrade", async () => {
    const setup = await makeBaseSetup("inject-missing");

    const report = await installCodex({
      env: setup.env,
      cwd: setup.cwd,
      yes: true,
      forcePath: "A",
    });

    expect(report.path).toBe("A");
    expect(cliCalls(await readLog(setup.logPath))).toEqual(
      expect.arrayContaining([expect.stringContaining("plugin marketplace add")]),
    );
    await expect(stat(join(setup.codexHome, "AGENTS.md"))).rejects.toThrow();
  }, 30_000);

  it("errors instead of silently degrading when --force-path A cannot be established", async () => {
    const setup = await makeBaseSetup("inject-ok", {
      FAKE_CODEX_REGISTRATION_FAIL: "1",
    });

    await expect(
      installCodex({ env: setup.env, cwd: setup.cwd, yes: true, forcePath: "A" }),
    ).rejects.toThrow(/path A/i);

    const io = makeIo(setup.cwd, setup.env);
    const code = await runCli(
      ["install", "--tool", "codex", "--force-path", "A"],
      io,
    );
    expect(code).toBe(1);
    expect(io.err.join("")).toMatch(/path A/i);
  }, 30_000);

  it("falls back to path B when the probe cannot inject", async () => {
    const setup = await makeBaseSetup("inject-missing");

    const report = await installCodex({ env: setup.env, cwd: setup.cwd, yes: true });

    expect(report.path).toBe("B");
    expect(report.commands).toEqual(
      expect.arrayContaining([expect.stringContaining("plugin marketplace add")]),
    );
    expect(await readFile(join(setup.codexHome, "AGENTS.md"), "utf8")).toContain(
      "memsync:begin",
    );
  }, 30_000);

  it("returns a report instead of throwing when registration fails", async () => {
    const setup = await makeBaseSetup("inject-ok", {
      FAKE_CODEX_REGISTRATION_FAIL: "1",
    });

    const report = await installCodex({ env: setup.env, cwd: setup.cwd, yes: true });

    expect(report.path).toBe("B");
    expect(report.warning).toMatch(/plugin/i);
    expect(report.managedBlockPath).toBe(join(setup.codexHome, "AGENTS.md"));
  }, 30_000);

  it("falls back when hook trust cannot be verified", async () => {
    // Without `yes` the probe itself does not write trust; the installer is
    // explicitly confirmed here, but the fake rejects every trust write.
    const setup = await makeBaseSetup("inject-ok", {
      FAKE_CODEX_TRUST_REJECT: "1",
    });

    const report = await installCodex({
      env: setup.env,
      cwd: setup.cwd,
      confirmTrust: async () => true,
    });

    expect(report.path).toBe("B");
    expect(report.warning).toMatch(/trust/i);
    expect(await readFile(join(setup.codexHome, "AGENTS.md"), "utf8")).toContain(
      "memsync:begin",
    );
  }, 30_000);

  it("requires explicit confirmation before trusting hooks", async () => {
    const setup = await makeBaseSetup("inject-ok");

    const report = await installCodex({ env: setup.env, cwd: setup.cwd });

    expect(report.path).toBe("B");
    expect(report.warning).toMatch(/confirm/i);
    expect(JSON.stringify(await readLog(setup.logPath))).not.toContain(
      "trusted_hash",
    );
    expect(await readFile(join(setup.codexHome, "AGENTS.md"), "utf8")).toContain(
      "memsync:begin",
    );
  }, 30_000);

  it("trusts hooks when confirmTrust approves them", async () => {
    const setup = await makeBaseSetup("inject-ok");
    let seen: string[] = [];

    const report = await installCodex({
      env: setup.env,
      cwd: setup.cwd,
      confirmTrust: async (hooks) => {
        seen = hooks.map((hook) => `${hook.key} ${hook.eventName} ${hook.command}`);
        return true;
      },
    });

    expect(report.path).toBe("A");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("memsync-codex-adapter@SessionStart");
    expect(JSON.stringify(await readLog(setup.logPath))).toContain("trusted_hash");
  }, 30_000);

  it("does not trust hooks when confirmTrust declines", async () => {
    const setup = await makeBaseSetup("inject-ok");

    const report = await installCodex({
      env: setup.env,
      cwd: setup.cwd,
      confirmTrust: async () => false,
    });

    expect(report.path).toBe("B");
    expect(report.warning).toMatch(/confirm/i);
    expect(JSON.stringify(await readLog(setup.logPath))).not.toContain(
      "trusted_hash",
    );
  }, 30_000);

  it("stays on path A and does not duplicate entries when reinstall reports already installed", async () => {
    // The fake returns a non-zero "already installed"/"already added" error on
    // the second registration, like a real Codex CLI.
    const setup = await makeBaseSetup("inject-ok", {
      FAKE_CODEX_IDEMPOTENT_ERRORS: "1",
    });

    const first = await installCodex({ env: setup.env, cwd: setup.cwd, yes: true });
    const second = await installCodex({ env: setup.env, cwd: setup.cwd, yes: true });

    expect(first.path).toBe("A");
    expect(second.path).toBe("A");
    expect(second.warning).toBeUndefined();

    const registry = JSON.parse(
      await readFile(join(setup.codexHome, ".fake-codex-registry.json"), "utf8"),
    );
    expect(registry.plugins).toEqual(["memsync-codex-adapter"]);
    expect(registry.marketplaces).toEqual([setup.pluginRoot]);

    const marketplace = JSON.parse(
      await readFile(join(setup.pluginRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
    );
    expect(marketplace.plugins).toHaveLength(1);

    const hooks = JSON.parse(
      await readFile(join(setup.pluginRoot, "hooks", "hooks.json"), "utf8"),
    );
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.hooks.Stop).toHaveLength(1);

    // A successful reinstall must not leave fallback instructions behind.
    await expect(stat(join(setup.cwd, "AGENTS.md"))).rejects.toThrow();
    await expect(stat(join(setup.codexHome, "AGENTS.md"))).rejects.toThrow();
  }, 45_000);

  it("prints each hook and trusts after the CLI prompt is confirmed", async () => {
    const setup = await makeBaseSetup("inject-ok");
    const io = makeIo(setup.cwd, setup.env, "y\n");

    const code = await runCli(
      ["install", "--tool", "codex", "--scope", "project"],
      io,
    );

    expect(code).toBe(0);
    const out = io.out.join("");
    expect(out).toContain("hook: memsync-codex-adapter@SessionStart SessionStart");
    expect(out).toContain("hook session-start --tool codex");
    expect(out).toMatch(/trust these Codex hooks/i);
    expect(out).toMatch(/path A/);
    expect(JSON.stringify(await readLog(setup.logPath))).toContain("trusted_hash");
  }, 30_000);

  it("falls back from the CLI when the prompt is declined", async () => {
    const setup = await makeBaseSetup("inject-ok");
    const io = makeIo(setup.cwd, setup.env, "\n");

    const code = await runCli(
      ["install", "--tool", "codex", "--scope", "project"],
      io,
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toContain("hook: memsync-codex-adapter@SessionStart");
    expect(io.out.join("")).toMatch(/fallback/i);
    expect(await readFile(join(setup.cwd, "AGENTS.md"), "utf8")).toContain(
      "memsync:begin",
    );
    expect(JSON.stringify(await readLog(setup.logPath))).not.toContain(
      "trusted_hash",
    );
  }, 30_000);

  it("reads the trust answer from an interactive line reader", async () => {
    const setup = await makeBaseSetup("inject-ok");
    // `stdin()` is left empty: only the line reader may approve the prompt.
    const io = makeIo(setup.cwd, setup.env, "", async () => "y");

    const code = await runCli(
      ["install", "--tool", "codex", "--scope", "project"],
      io,
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toMatch(/path A/);
    expect(JSON.stringify(await readLog(setup.logPath))).toContain("trusted_hash");
  }, 30_000);

  it("declines an interactive n from the line reader", async () => {
    const setup = await makeBaseSetup("inject-ok");
    const io = makeIo(setup.cwd, setup.env, "", async () => "n");

    const code = await runCli(
      ["install", "--tool", "codex", "--scope", "project"],
      io,
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toMatch(/fallback/i);
    expect(await readFile(join(setup.cwd, "AGENTS.md"), "utf8")).toContain(
      "memsync:begin",
    );
    expect(JSON.stringify(await readLog(setup.logPath))).not.toContain(
      "trusted_hash",
    );
  }, 30_000);

  it("treats a non-TTY (undefined line) as declined without hanging", async () => {
    const setup = await makeBaseSetup("inject-ok");
    const io = makeIo(setup.cwd, setup.env, "", async () => undefined);

    const code = await runCli(
      ["install", "--tool", "codex", "--scope", "project"],
      io,
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toMatch(/fallback/i);
    expect(await readFile(join(setup.cwd, "AGENTS.md"), "utf8")).toContain(
      "memsync:begin",
    );
  }, 30_000);

  it("default IO reports no interactive line on a non-TTY", async () => {
    if (process.stdin.isTTY) return;
    await expect(defaultCliIo().readLine?.()).resolves.toBeUndefined();
  });
});

describe("readCachedCodexCapabilities", () => {
  it("ignores another Codex command and picks the newest probe of this command", async () => {
    const setup = await makeBaseSetup("inject-ok");
    const command = setup.env.MEMSYNC_CODEX_PATH as string;
    const base = {
      plugin: true,
      hooks: true,
      hookTrust: "supported" as const,
      injectSessionStart: false,
      injectUserPrompt: true,
      envFile: null,
      path: "A2" as const,
    };
    const stateDir = join(setup.memsyncHome, "state");
    await mkdir(stateDir, { recursive: true });
    const cachePath = join(stateDir, "capabilities.json");

    await writeFile(
      cachePath,
      `${JSON.stringify(
        {
          [`9.9.9|${join(setup.root, "other-codex.exe")}`]: {
            ...base,
            path: "A",
            probedAt: "2026-06-01T00:00:00.000Z",
          },
          [`8.0.0|${command}`]: {
            ...base,
            path: "B",
            probedAt: "2026-01-01T00:00:00.000Z",
          },
          [`9.9.9|${command}`]: {
            ...base,
            path: "A2",
            probedAt: "2026-02-01T00:00:00.000Z",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const cached = await readCachedCodexCapabilities(setup.env);
    expect(cached?.path).toBe("A2");
    expect(cached?.codexVersion).toBeUndefined();

    // A cache that only covers a different command is not usable at all.
    await writeFile(
      cachePath,
      `${JSON.stringify({
        [`9.9.9|${join(setup.root, "other-codex.exe")}`]: {
          ...base,
          path: "A",
          probedAt: "2026-06-01T00:00:00.000Z",
        },
      })}\n`,
      "utf8",
    );
    expect(await readCachedCodexCapabilities(setup.env)).toBeUndefined();
  });
});

describe("handleCodexHook", () => {
  it("injects additionalContext when cached capabilities allow it", async () => {
    const setup = await makeLinkedSetup();
    await seedCapabilities(setup);
    const io = makeIo(setup.workspace, setup.env);

    const result = await handleCodexHook("session-start", payload(setup), io);

    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("项目核心约束");
    expect(io.err.join("")).toBe("");

    const journal = await findJournalBySession(setup.projectDir, "c1");
    expect(journal).toBeDefined();
    const pointer = JSON.parse(
      await readFile(
        join(setup.workspace, ".memsync", "sessions", "current-codex.json"),
        "utf8",
      ),
    );
    expect(pointer.session).toBe("c1");
    expect(pointer.tool).toBe("codex");
  });

  it("outputs {} without cached capabilities but still binds the session", async () => {
    const setup = await makeLinkedSetup();
    const io = makeIo(setup.workspace, setup.env);

    const result = await handleCodexHook(
      "session-start",
      JSON.stringify(payload(setup)),
      io,
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    expect(await findJournalBySession(setup.projectDir, "c1")).toBeDefined();
  });

  it("ends the session on Stop and outputs {}", async () => {
    const setup = await makeLinkedSetup();
    const io = makeIo(setup.workspace, setup.env);
    await beginSession({
      projectDir: setup.projectDir,
      project: SLUG,
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: "codex",
      session: "c1",
      workspace: setup.workspace,
    });

    const result = await handleCodexHook("stop", payload(setup), io);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    const path = (await findJournalBySession(setup.projectDir, "c1"))!;
    expect((await readJournal(path)).ended).toBeDefined();
  });

  it("outputs {} for UserPromptSubmit when there is no A2 capability cache", async () => {
    const setup = await makeLinkedSetup();
    const io = makeIo(setup.workspace, setup.env);

    const result = await handleCodexHook("user-prompt-submit", payload(setup), io);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
  });

  it("injects the context on the first UserPromptSubmit in path A2", async () => {
    const setup = await makeLinkedSetup();
    await seedCapabilities(setup, {
      path: "A2",
      injectSessionStart: false,
      injectUserPrompt: true,
    });
    const io = makeIo(setup.workspace, setup.env);

    // SessionStart cannot inject in A2; it only syncs and binds.
    const started = await handleCodexHook("session-start", payload(setup), io);
    expect(started.stdout.trim()).toBe("{}");

    const first = await handleCodexHook("user-prompt-submit", payload(setup), io);
    const out = JSON.parse(first.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("项目核心约束");

    // Only the first prompt of the session carries the pack.
    const second = await handleCodexHook("user-prompt-submit", payload(setup), io);
    expect(second.stdout.trim()).toBe("{}");
  });

  it("warns about offline mode on SessionStart without and with a cache", async () => {
    const setup = await makeLinkedSetup();
    await seedCapabilities(setup, { path: "A", injectSessionStart: true });
    // The linked setup repo has no remote: every pull fails.
    const noCache = await handleCodexHook(
      "session-start",
      payload(setup),
      makeIo(setup.workspace, setup.env),
    );
    const noCacheContext = JSON.parse(noCache.stdout).hookSpecificOutput
      .additionalContext as string;
    expect(noCacheContext).toContain("[memsync] 离线");
    expect(noCacheContext).toContain("项目核心约束");

    await writeCachedPack(
      setup.env,
      SLUG,
      "缓存中的团队记忆",
      "2026-11-13T10:00:00.000Z",
    );
    const cached = await handleCodexHook(
      "session-start",
      payload(setup),
      makeIo(setup.workspace, setup.env),
    );
    const cachedContext = JSON.parse(cached.stdout).hookSpecificOutput
      .additionalContext as string;
    expect(cachedContext).toContain("[memsync] 离线");
    expect(cachedContext).toContain("缓存中的团队记忆");
  });

  it("starts a new implicit session when a note follows a Codex Stop", async () => {
    const setup = await makeLinkedSetup();
    await beginSession({
      projectDir: setup.projectDir,
      project: SLUG,
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: "codex",
      session: "c1",
      workspace: setup.workspace,
    });
    const io = makeIo(setup.workspace, setup.env);

    await handleCodexHook("stop", payload(setup), io);
    expect(
      (await readJournal((await findJournalBySession(setup.projectDir, "c1"))!)).ended,
    ).toBeDefined();

    // Codex Stop is treated as session end; a later note must not append to it.
    const noteIo = makeIo(setup.workspace, { ...setup.env, MEMSYS_TOOL: "codex" });
    const code = await runCli(
      ["note", "progress", "--text", "after stop, new turn"],
      noteIo,
    );
    expect(code, noteIo.err.join("")).toBe(0);

    const pointer = JSON.parse(
      await readFile(
        join(setup.workspace, ".memsync", "sessions", "current-codex.json"),
        "utf8",
      ),
    ) as { session: string };
    expect(pointer.session).not.toBe("c1");
    const fresh = (await findJournalBySession(setup.projectDir, pointer.session))!;
    const freshRecord = await readJournal(fresh);
    expect(freshRecord.tool).toBe("codex");
    expect(freshRecord.implicit).toBe(true);
    expect(await readFile(fresh, "utf8")).toContain("after stop, new turn");

    // A second Stop finalizes the new turn's implicit session.
    await handleCodexHook(
      "stop",
      payload(setup, { session_id: undefined }),
      io,
    );
    expect((await readJournal(fresh)).ended).toBeDefined();
  });

  it("isolates failures to one stderr line and exit 0", async () => {
    const setup = await makeLinkedSetup();
    await writeFile(join(setup.memsyncHome, "config.json"), "{ not json", "utf8");
    const io = makeIo(setup.workspace, setup.env);

    const result = await handleCodexHook("session-start", payload(setup), io);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    const lines = io.err.join("").split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/^\s+at\s/);
  });

  it("routes memsync hook --tool codex to the Codex adapter", async () => {
    const setup = await makeLinkedSetup();
    await seedCapabilities(setup);
    const io = makeIo(
      setup.workspace,
      setup.env,
      JSON.stringify(payload(setup)),
    );

    const code = await runCli(["hook", "session-start", "--tool", "codex"], io);

    expect(code).toBe(0);
    const out = JSON.parse(io.out.join(""));
    expect(out.hookSpecificOutput.additionalContext).toContain("项目核心约束");
  });

  it("keeps the Claude hook route working", async () => {
    const setup = await makeLinkedSetup();
    const io = makeIo(
      setup.workspace,
      setup.env,
      JSON.stringify({ session_id: "cl1", cwd: setup.workspace }),
    );

    const code = await runCli(["hook", "session-start", "--tool", "claude-code"], io);

    expect(code).toBe(0);
    const out = JSON.parse(io.out.join(""));
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });
});
