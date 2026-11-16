import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { CliIo } from "../cli.js";
import { writeFileAtomic } from "../core/atomic.js";
import { findJournalBySession } from "../core/journal.js";
import { memsyncHome, statePath } from "../core/paths.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import {
  endSession,
  resolveSession,
  writeSessionPointer,
} from "../core/session.js";
import { syncProject } from "../core/sync.js";
import { cliCommand } from "./claude.js";
import {
  codexHomeFromEnv,
  codexSpawnTarget,
} from "./codex-app-server.js";
import {
  listHooks,
  readConfigVersion,
  trustHooks,
  withCodexAppServer,
  type CodexHook,
} from "./codex-app-server.js";
import { probeCodex, type CodexCapabilities } from "./codex-probe.js";
import { mergeManagedBlock } from "./managed-block.js";

export const CODEX_PLUGIN_ID = "memsync-codex-adapter";
export const CODEX_PLUGIN_VERSION = "0.1.0";

/** Timeout for the CLI registration commands (`plugin marketplace add` etc.). */
const REGISTRATION_TIMEOUT_MS = 20_000;

export type CodexHookEvent = "session-start" | "user-prompt-submit" | "stop";

export type InstallScope = "user" | "project";

export interface InstallCodexInput {
  env: NodeJS.ProcessEnv;
  cwd: string;
  yes?: boolean;
  forcePath?: "A" | "B";
  /** Where the fallback `AGENTS.md` is written; defaults to the user scope. */
  scope?: InstallScope;
  /**
   * Interactive gate for trusting Codex hooks. Called only when `yes` is not
   * true; the CLI prints each hook and prompts from here.
   */
  confirmTrust?: (hooks: CodexHook[]) => Promise<boolean>;
}

export interface InstallReport {
  path: "A" | "A2" | "B";
  commands: string[];
  hooks?: CodexHook[];
  settingsPath?: string;
  managedBlockPath?: string;
  /** Diagnostic added when the install degraded to path B. */
  warning?: string;
}

/** The subset of the Codex hook stdin payload this adapter reads. */
export interface CodexHookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
}

export interface CodexHookResult {
  stdout: string;
  code: number;
}

interface CommandSpec {
  event: "SessionStart" | "UserPromptSubmit" | "Stop";
  hookEvent: CodexHookEvent;
  matcher?: string;
  timeout: number;
}

const HOOK_SPECS: readonly CommandSpec[] = [
  {
    event: "SessionStart",
    hookEvent: "session-start",
    matcher: "startup|resume|clear|compact",
    timeout: 30,
  },
  { event: "UserPromptSubmit", hookEvent: "user-prompt-submit", timeout: 30 },
  { event: "Stop", hookEvent: "stop", timeout: 30 },
];

const CODEX_MANAGED_BLOCK = [
  "## 项目记忆库（必须执行）",
  "",
  "1. 如果 `.memsync/wrapper-active` 文件存在（或 `MEMSYS_WRAPPER=1`，由 `memsync run codex` 启动），",
  "   不要运行 sync；wrapper 已完成同步。否则先运行 `memsync sync --tool codex`。",
  "   然后遵循其输出中的约束与进度。",
  '2. 完成一项工作、做出关键决策或遇到阻塞时，用 `memsync note <kind> "..."` 写回',
  "   （kind = progress | decision | blocker | todo | handoff）。",
  "3. 不要直接编辑 `constraints.md`；需要修改约束时使用 `memsync propose`。",
  '4. 需要项目细节时使用 `memsync recall "<关键词>"` 查询。',
  "5. 记忆是方向性提示，不是当前代码事实；以当前代码、测试和最新提交为准。",
  "6. 会话结束前运行 `memsync session end`；或使用 `memsync run codex` 启动，让 wrapper 自动收尾。",
  "7. 如果 `memsync sync --tool codex` 因 Codex 沙箱网络限制超时，不要反复重试；",
  "   继续基于本地记忆工作，结束前用 `memsync note` 写回；由 `memsync run codex` 启动时 wrapper 会推送。",
  "8. PowerShell 若因执行策略阻止 `memsync.ps1`，改用 `memsync.cmd` 或 `cmd /d /s /c \"memsync ...\"`。",
].join("\n");

const HOOKS_README = [
  "# memsync Codex hooks",
  "",
  "These hooks call the memsync CLI directly; there is no runtime wrapper.",
  "",
  "- `SessionStart` -> `memsync hook session-start --tool codex`",
  "- `UserPromptSubmit` -> `memsync hook user-prompt-submit --tool codex`",
  "- `Stop` -> `memsync hook stop --tool codex`",
  "",
].join("\n");

function quote(value: string): string {
  return `"${value}"`;
}

function hookCommandFor(
  cli: { command: string; args: string[] },
  event: CodexHookEvent,
): string {
  return `${[cli.command, ...cli.args].map(quote).join(" ")} hook ${event} --tool codex`;
}

/**
 * Writes the Codex plugin layout into `root` and returns that root. The plugin
 * has no runtime wrapper layer: every hook invokes the CLI directly through an
 * absolute Node + script path.
 */
export async function writeCodexPlugin(
  root: string,
  cli: { command: string; args: string[] },
): Promise<string> {
  const hooks: Record<string, unknown> = {};
  for (const spec of HOOK_SPECS) {
    const command = hookCommandFor(cli, spec.hookEvent);
    hooks[spec.event] = [
      {
        ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
        hooks: [
          {
            type: "command",
            command,
            commandWindows: command,
            timeout: spec.timeout,
          },
        ],
      },
    ];
  }

  await writeFileAtomic(
    join(root, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: CODEX_PLUGIN_ID,
        version: CODEX_PLUGIN_VERSION,
        hooks: "./hooks/hooks.json",
      },
      null,
      2,
    )}\n`,
  );
  await writeFileAtomic(
    join(root, "hooks", "hooks.json"),
    `${JSON.stringify({ hooks }, null, 2)}\n`,
  );
  await writeFileAtomic(join(root, "hooks", "README.md"), HOOKS_README);
  return root;
}

/**
 * Creates `<root>/.agents/plugins/marketplace.json` with a single local plugin
 * entry. The entry uses the absolute plugin path, mirroring the known-good
 * marketplace written by the Task 11 probe.
 */
export async function writeCodexMarketplace(
  root: string,
  pluginId: string,
): Promise<string> {
  const path = join(root, ".agents", "plugins", "marketplace.json");
  const marketplace = {
    name: "memsync-marketplace",
    plugins: [{ id: pluginId, name: pluginId, path: resolve(root) }],
  };
  await writeFileAtomic(path, `${JSON.stringify(marketplace, null, 2)}\n`);
  return path;
}

export function codexCommandFor(env: NodeJS.ProcessEnv): string {
  const configured = env.MEMSYNC_CODEX_PATH?.trim();
  return configured !== undefined && configured.length > 0 ? configured : "codex";
}

interface RunResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Cap retained child output; registration errors are short one-liners. */
const MAX_CAPTURED_OUTPUT = 64 * 1024;

function capture(chunk: string, existing: string): string {
  const combined = existing + chunk;
  return combined.length > MAX_CAPTURED_OUTPUT
    ? combined.slice(combined.length - MAX_CAPTURED_OUTPUT)
    : combined;
}

/** Runs one registration command, capturing output and enforcing a timeout. */
function runCodexCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<RunResult> {
  const target = codexSpawnTarget(command, args);

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(target.file, target.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(target.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(guard);
      resolve({ code, timedOut, stdout, stderr });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }, REGISTRATION_TIMEOUT_MS);
    timer.unref?.();

    const guard = setTimeout(() => finish(null), REGISTRATION_TIMEOUT_MS + 2_000);
    guard.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = capture(chunk, stdout);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = capture(chunk, stderr);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/**
 * A registration command that failed because the plugin/marketplace is already
 * present is a no-op, not a reason to degrade to path B.
 */
function alreadyRegistered(result: RunResult): boolean {
  return /already\s+(installed|added|exists|exist|registered)/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function registrationFailed(result: RunResult): boolean {
  return result.timedOut || (result.code !== 0 && !alreadyRegistered(result));
}

function displayCommand(command: string, args: string[]): string {
  const rendered = args.map((arg) => (/\s/.test(arg) ? quote(arg) : arg));
  return [command, ...rendered].join(" ");
}

function oneLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const flattened = raw.replace(/\s+/g, " ").trim();
  return flattened.length > 300 ? `${flattened.slice(0, 299)}…` : flattened;
}

function isOurHook(hook: CodexHook): boolean {
  return (
    hook.pluginId === CODEX_PLUGIN_ID ||
    hook.key.startsWith(`${CODEX_PLUGIN_ID}@`)
  );
}

/**
 * User scope targets the Codex home (honoring CODEX_HOME); project scope keeps
 * the instructions inside the workspace.
 */
function managedAgentsPath(input: InstallCodexInput): string {
  return input.scope === "project"
    ? join(input.cwd, "AGENTS.md")
    : join(codexHomeFromEnv(input.env), "AGENTS.md");
}

async function writeFallback(
  input: InstallCodexInput,
  commands: string[],
  warning: string,
): Promise<InstallReport> {
  const managedBlockPath = managedAgentsPath(input);
  try {
    await mergeManagedBlock(managedBlockPath, CODEX_MANAGED_BLOCK);
    return { path: "B", commands, managedBlockPath, warning };
  } catch (err) {
    return {
      path: "B",
      commands,
      warning: `${warning}; AGENTS.md could not be written: ${oneLine(err)}`,
    };
  }
}

/**
 * Installs the Codex integration. Path A/A2 registers a plugin whose hooks call
 * the CLI and trusts the listed hooks; path B writes the managed `AGENTS.md`
 * block and relies on `memsync run codex`. Any registration, probe, or trust
 * failure degrades to path B and is reported; with `forcePath: "A"` the same
 * failure is thrown instead of silently degrading.
 */
export async function installCodex(
  input: InstallCodexInput,
): Promise<InstallReport> {
  if (input.forcePath === "B") {
    return await writeFallback(
      input,
      [],
      "Codex hooks were not installed (path B forced)",
    );
  }

  // Forcing path A is an explicit promise: degrade is not acceptable, so
  // every failure below becomes an error instead of a silent path B.
  const unable = async (
    commands: string[],
    warning: string,
  ): Promise<InstallReport> => {
    if (input.forcePath === "A") {
      throw new Error(`cannot establish path A: ${warning}`);
    }
    return writeFallback(input, commands, warning);
  };

  const root = join(memsyncHome(input.env), "codex");
  const cli = cliCommand(input.env);
  try {
    await writeCodexPlugin(root, cli);
    await writeCodexMarketplace(root, CODEX_PLUGIN_ID);
  } catch (err) {
    return await unable(
      [],
      `Codex plugin files could not be written: ${oneLine(err)}`,
    );
  }

  const command = codexCommandFor(input.env);
  const commands: string[] = [];
  const marketplaceArgs = ["plugin", "marketplace", "add", root, "--json"];
  const pluginArgs = ["plugin", "add", CODEX_PLUGIN_ID, "--json"];

  const marketplaceAdd = await runCodexCommand(
    command,
    marketplaceArgs,
    input.env,
    input.cwd,
  );
  commands.push(displayCommand(command, marketplaceArgs));
  if (registrationFailed(marketplaceAdd)) {
    return await unable(
      commands,
      "codex plugin marketplace add failed; using AGENTS.md fallback",
    );
  }

  const pluginAdd = await runCodexCommand(command, pluginArgs, input.env, input.cwd);
  commands.push(displayCommand(command, pluginArgs));
  if (registrationFailed(pluginAdd)) {
    return await unable(
      commands,
      "codex plugin add failed; using AGENTS.md fallback",
    );
  }

  let capabilities: CodexCapabilities;
  try {
    capabilities = await probeCodex(input.env, input.cwd, {
      command,
      force: true,
      ...(input.yes !== undefined ? { yes: input.yes } : {}),
      ...(input.forcePath !== undefined ? { forcePath: input.forcePath } : {}),
    });
  } catch (err) {
    return await unable(
      commands,
      `Codex capability probe failed (${oneLine(err)}); using AGENTS.md fallback`,
    );
  }

  if (capabilities.path === "B") {
    return await unable(
      commands,
      "Codex hooks are unavailable; using AGENTS.md fallback",
    );
  }

  try {
    const hooks = await withCodexAppServer(
      command,
      input.cwd,
      input.env,
      async (client) => {
        const listed = await listHooks(client, input.cwd);
        const ours = listed.filter(isOurHook);
        if (ours.length === 0) {
          throw new Error("codex listed no memsync Codex hooks");
        }

        // Trusting a hook is an explicit decision: `--yes` or an interactive
        // confirmation. Never write trust hashes silently.
        const allowed =
          input.yes === true
            ? true
            : input.confirmTrust !== undefined
              ? await input.confirmTrust(ours)
              : false;
        if (!allowed) {
          throw new Error("Codex hook trust was not confirmed");
        }

        const config = await readConfigVersion(client, input.cwd);
        await trustHooks(client, ours, config.filePath, config.version);
        return ours;
      },
    );

    return { path: capabilities.path, commands, hooks };
  } catch (err) {
    return await unable(
      commands,
      `Codex hooks could not be trusted (${oneLine(err)}); using AGENTS.md fallback`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapabilities(value: unknown): value is CodexCapabilities {
  if (!isRecord(value)) return false;
  return (
    typeof value.plugin === "boolean" &&
    typeof value.hooks === "boolean" &&
    (value.hookTrust === "supported" || value.hookTrust === "unknown") &&
    typeof value.injectSessionStart === "boolean" &&
    typeof value.injectUserPrompt === "boolean" &&
    (value.envFile === null || typeof value.envFile === "string") &&
    (value.path === "A" || value.path === "A2" || value.path === "B")
  );
}

/**
 * Reads the cached Codex capabilities written by `probeCodex`. Entries are
 * keyed by `<version>|<command>`. Only entries probed for the *configured
 * command* are eligible (another Codex install must never leak its path into
 * this one), and among versions of that command the newest `probedAt` wins.
 */
export async function readCachedCodexCapabilities(
  env: NodeJS.ProcessEnv,
  command: string = codexCommandFor(env),
): Promise<CodexCapabilities | undefined> {
  let raw: string;
  try {
    raw = await readFile(statePath(env, "capabilities.json"), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  let newest: { capabilities: CodexCapabilities; at: number } | undefined;
  for (const [key, value] of Object.entries(parsed)) {
    if (!isCapabilities(value)) continue;
    if (!key.endsWith(`|${command}`)) continue;

    const probed = value.probedAt !== undefined ? Date.parse(value.probedAt) : Number.NaN;
    const at = Number.isFinite(probed) ? probed : 0;
    if (newest === undefined || at > newest.at) {
      newest = { capabilities: value, at };
    }
  }
  return newest?.capabilities;
}

function hostFor(env: NodeJS.ProcessEnv): string {
  const configured = env.MEMSYS_HOST?.trim();
  return configured !== undefined && configured.length > 0 ? configured : hostname();
}

function parseInput(input: CodexHookInput | string): CodexHookInput {
  if (typeof input !== "string") return input ?? {};
  const text = input.trim();
  if (text.length === 0) return {};

  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("hook input must be a JSON object");
  }
  return parsed as CodexHookInput;
}

function resolveCwd(input: CodexHookInput, io: CliIo): string {
  const cwd = input.cwd?.trim();
  return cwd !== undefined && cwd.length > 0 ? cwd : io.cwd;
}

function result(value: Record<string, unknown>): CodexHookResult {
  return { stdout: `${JSON.stringify(value)}\n`, code: 0 };
}

async function onSessionStart(
  input: CodexHookInput,
  io: CliIo,
): Promise<CodexHookResult> {
  const cwd = resolveCwd(input, io);
  const sessionId = input.session_id?.trim();

  const sync = await syncProject({
    cwd,
    env: io.env,
    tool: "codex",
    ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
  });

  const effectiveId = sync.sessionId ?? sessionId;
  if (effectiveId !== undefined && effectiveId.length > 0) {
    // Codex never receives an env file; the workspace pointer is the only
    // session binding available to later CLI calls.
    const project = await resolveProject(cwd, await memoryRepoForEnv(io.env), io.env);
    if (project.ok) {
      await writeSessionPointer(project.workspaceRoot, "codex", effectiveId, {
        host: hostFor(io.env),
      });
    }
  }

  const context = sync.context;
  if (context !== undefined && context.trim().length > 0) {
    const capabilities = await readCachedCodexCapabilities(io.env);
    if (capabilities?.injectSessionStart === true) {
      return result({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context,
        },
      });
    }
  }
  return result({});
}

/**
 * Path A2 cannot inject on SessionStart, so the context pack is delivered once
 * on the first UserPromptSubmit of the session. The marker keeps later prompts
 * from re-injecting the same pack.
 */
function promptMarkerPath(workspace: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 16);
  return join(workspace, ".memsync", "sessions", `prompt-injected-codex-${key}.json`);
}

async function promptInjectionDone(
  workspace: string,
  sessionId: string,
): Promise<boolean> {
  try {
    await readFile(promptMarkerPath(workspace, sessionId), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function onUserPromptSubmit(
  input: CodexHookInput,
  io: CliIo,
): Promise<CodexHookResult> {
  const cwd = resolveCwd(input, io);
  const capabilities = await readCachedCodexCapabilities(io.env);
  if (capabilities?.path !== "A2" || capabilities.injectUserPrompt !== true) {
    return result({});
  }

  const project = await resolveProject(cwd, await memoryRepoForEnv(io.env), io.env);
  if (!project.ok) return result({});

  const explicit = input.session_id?.trim();
  const sessionId =
    explicit !== undefined && explicit.length > 0
      ? explicit
      : (
          await resolveSession({
            env: io.env,
            workspace: project.workspaceRoot,
            tool: "codex",
            host: hostFor(io.env),
            projectDir: project.projectDir,
          })
        ).id;

  if (await promptInjectionDone(project.workspaceRoot, sessionId)) {
    return result({});
  }

  const sync = await syncProject({
    cwd,
    env: io.env,
    tool: "codex",
    sessionId,
  });

  const context = sync.context;
  if (context === undefined || context.trim().length === 0) return result({});

  const marker = promptMarkerPath(project.workspaceRoot, sessionId);
  await writeFileAtomic(
    marker,
    `${JSON.stringify({ session: sessionId, injectedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  return result({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  });
}

async function onStop(input: CodexHookInput, io: CliIo): Promise<void> {
  const cwd = resolveCwd(input, io);
  const project = await resolveProject(cwd, await memoryRepoForEnv(io.env), io.env);
  if (!project.ok) return;

  const explicit = input.session_id?.trim();
  const sessionId =
    explicit !== undefined && explicit.length > 0
      ? explicit
      : (
          await resolveSession({
            env: io.env,
            workspace: project.workspaceRoot,
            tool: "codex",
            host: hostFor(io.env),
            projectDir: project.projectDir,
          })
        ).id;

  if ((await findJournalBySession(project.projectDir, sessionId)) === undefined) {
    return;
  }
  await endSession({ projectDir: project.projectDir, sessionId, env: io.env });
}

/**
 * Codex hook entry. Failures never block the client: `{}` on stdout, exit 0,
 * and at most one diagnostic line on stderr.
 */
export async function handleCodexHook(
  event: CodexHookEvent,
  input: CodexHookInput | string,
  io: CliIo,
): Promise<CodexHookResult> {
  try {
    const parsed = parseInput(input);
    switch (event) {
      case "session-start":
        return await onSessionStart(parsed, io);
      case "stop":
        await onStop(parsed, io);
        return result({});
      case "user-prompt-submit":
        return await onUserPromptSubmit(parsed, io);
      default:
        throw new Error(`unknown hook event "${String(event)}"`);
    }
  } catch (err) {
    io.stderr(`memsync hook: ${oneLine(err)}\n`);
    return result({});
  }
}
