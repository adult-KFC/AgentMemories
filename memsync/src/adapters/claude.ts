import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliIo } from "../cli.js";
import { writeFileAtomic } from "../core/atomic.js";
import { findJournalBySession } from "../core/journal.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import { checkpointSession, endSession, resolveSession } from "../core/session.js";
import { syncProject } from "../core/sync.js";
import { mergeManagedBlock } from "./managed-block.js";

export type ClaudeHookEvent = "session-start" | "session-end" | "pre-compact";
export type ClaudeEventName = "SessionStart" | "SessionEnd" | "PreCompact";

/** The subset of the Claude Code hook stdin payload this adapter reads. */
export interface ClaudeHookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
  prompt_id?: string;
  transcript_path?: string;
}

export interface ClaudeHookResult {
  stdout: string;
  code: number;
}

export type InstallScope = "user" | "project";

export interface InstallClaudeInput {
  env: NodeJS.ProcessEnv;
  scope: InstallScope;
  cwd: string;
}

export interface InstallReport {
  installed: boolean;
  settingsPath: string;
  managedBlockPath: string;
  slashCommandPath: string;
  command: string;
}

const HOOK_EVENTS: readonly ClaudeHookEvent[] = [
  "session-start",
  "session-end",
  "pre-compact",
];

const EVENT_NAMES: Record<ClaudeHookEvent, ClaudeEventName> = {
  "session-start": "SessionStart",
  "session-end": "SessionEnd",
  "pre-compact": "PreCompact",
};

const MANAGED_BLOCK_CONTENT = [
  "## 项目记忆库（必须执行）",
  "",
  "1. 会话开始时先阅读 MemorySync 注入的上下文，并遵循其中的约束与进度。",
  '2. 完成一项工作、做出关键决策或遇到阻塞时，用 `memsync note <kind> "..."` 写回',
  "   （kind = progress | decision | blocker | todo | handoff）。",
  "3. 不要直接编辑 `constraints.md`；需要修改约束时使用 `memsync propose`。",
  '4. 需要项目细节时使用 `memsync recall "<关键词>"` 查询。',
  "5. 记忆是方向性提示，不是当前代码事实；以当前代码、测试和最新提交为准。",
  "6. 当用户询问项目进度、记忆是否最新或同步状态时，先执行 `memsync sync --strict`；",
  "   如果失败，明确报告缓存时间和失败原因，再回答。",
  "7. 每次会话的第一条回复开头，先用一行报告 MemorySync 同步状态：",
  "   - 上下文以 `[MemorySync]` 开头：输出 `记忆已同步（synced 时间）`；",
  "   - 上下文以 `[memsync] 离线` 开头：输出 `记忆未同步，使用 <缓存时间> 的缓存（原因）`；",
  "   然后再回答用户问题。",
].join("\n");

const SLASH_COMMAND_CONTENT = [
  "---",
  "description: 强制拉取团队记忆并反馈成功/失败",
  "---",
  "",
  "在当前项目目录执行 `memsync sync --strict`。",
  "",
  "- 如果退出码为 0：说明已从远端拉取最新记忆；引用输出的第一行和当前进度，然后继续回答。",
  "- 如果退出码非 0：把 stderr 的错误原样告诉用户；运行 `memsync status`，报告 last sync/缓存时间与 pending push；明确说明当前记忆可能不是最新，不要声称已同步。",
  "- 不要编辑 `constraints.md`。",
  "",
].join("\n");

/**
 * Absolute Node executable plus the CLI script for the current install.
 * `MEMSYNC_CLI_PATH` overrides the script (tests use it for determinism).
 */
export function cliCommand(
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const override = env.MEMSYNC_CLI_PATH?.trim();
  const cliPath =
    override !== undefined && override.length > 0
      ? override
      : fileURLToPath(import.meta.url);
  return { command: process.execPath, args: [cliPath] };
}

function quote(value: string): string {
  return `"${value}"`;
}

/** Quoted absolute command registered in settings.json for one hook event. */
export function hookCommand(
  event: ClaudeHookEvent,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { command, args } = cliCommand(env);
  return `${quote(command)} ${quote(args[0])} hook ${event} --tool claude-code`;
}

function hostFor(env: NodeJS.ProcessEnv): string {
  const configured = env.MEMSYS_HOST?.trim();
  return configured !== undefined && configured.length > 0 ? configured : hostname();
}

function parseInput(input: ClaudeHookInput | string): ClaudeHookInput {
  if (typeof input !== "string") return input ?? {};
  const text = input.trim();
  if (text.length === 0) return {};

  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("hook input must be a JSON object");
  }
  return parsed as ClaudeHookInput;
}

function resolveCwd(input: ClaudeHookInput, io: CliIo): string {
  const cwd = input.cwd?.trim();
  return cwd !== undefined && cwd.length > 0 ? cwd : io.cwd;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Appends the session exports so later Bash tool calls inherit the session id. */
async function appendEnvExports(
  path: string,
  sessionId: string,
  host: string,
): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const lines = [
    `export MEMSYS_SESSION=${shellQuote(sessionId)}`,
    `export MEMSYS_TOOL=${shellQuote("claude-code")}`,
    `export MEMSYS_HOST=${shellQuote(host)}`,
  ];
  await writeFileAtomic(path, `${existing}${separator}${lines.join("\n")}\n`);
}

function result(value: Record<string, unknown>): ClaudeHookResult {
  return { stdout: `${JSON.stringify(value)}\n`, code: 0 };
}

function oneLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const flattened = raw.replace(/\s+/g, " ").trim();
  return flattened.length > 300 ? `${flattened.slice(0, 299)}…` : flattened;
}

async function onSessionStart(
  input: ClaudeHookInput,
  io: CliIo,
): Promise<ClaudeHookResult> {
  const cwd = resolveCwd(input, io);
  const sessionId = input.session_id?.trim();

  const sync = await syncProject({
    cwd,
    env: io.env,
    tool: "claude-code",
    ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
  });

  const effectiveId = sync.sessionId;
  if (effectiveId !== undefined && effectiveId.length > 0) {
    const envFile = io.env.CLAUDE_ENV_FILE?.trim();
    if (envFile !== undefined && envFile.length > 0) {
      try {
        await appendEnvExports(envFile, effectiveId, hostFor(io.env));
      } catch (err) {
        // The context pack is the primary SessionStart value; an unwritable
        // env file must not discard it.
        io.stderr(`memsync hook: ${oneLine(err)}\n`);
      }
    }
  }

  const context = sync.context;
  if (context !== undefined && context.trim().length > 0) {
    return result({
      hookSpecificOutput: {
        hookEventName: EVENT_NAMES["session-start"],
        additionalContext: context,
      },
    });
  }
  return result({});
}

async function resolveSessionId(
  input: ClaudeHookInput,
  project: { projectDir: string; workspaceRoot: string },
  io: CliIo,
): Promise<string> {
  const explicit = input.session_id?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const resolved = await resolveSession({
    env: io.env,
    workspace: project.workspaceRoot,
    tool: "claude-code",
    host: hostFor(io.env),
    projectDir: project.projectDir,
  });
  return resolved.id;
}

async function resolveProjectDir(
  input: ClaudeHookInput,
  io: CliIo,
): Promise<{ projectDir: string; workspaceRoot: string } | undefined> {
  const cwd = resolveCwd(input, io);
  const memoryRepo = await memoryRepoForEnv(io.env);
  const project = await resolveProject(cwd, memoryRepo, io.env);
  return project.ok
    ? { projectDir: project.projectDir, workspaceRoot: project.workspaceRoot }
    : undefined;
}

async function onSessionEnd(input: ClaudeHookInput, io: CliIo): Promise<void> {
  const project = await resolveProjectDir(input, io);
  if (project === undefined) return;

  const sessionId = await resolveSessionId(input, project, io);
  // A hook firing for a session memsync never saw (or already cleaned up) is
  // not an error; there is simply nothing to finalize.
  if ((await findJournalBySession(project.projectDir, sessionId)) === undefined) return;

  await endSession({
    projectDir: project.projectDir,
    sessionId,
    env: io.env,
  });
}

async function onPreCompact(input: ClaudeHookInput, io: CliIo): Promise<void> {
  const project = await resolveProjectDir(input, io);
  if (project === undefined) return;

  const sessionId = await resolveSessionId(input, project, io);
  await checkpointSession(project.projectDir, sessionId, io.env);
}

/**
 * Claude Code hook entry. Returns stdout/code instead of writing stdout so the
 * CLI owns the stream. Every failure is isolated: `{}` on stdout, exit 0, and
 * at most one diagnostic line on stderr.
 */
export async function handleClaudeHook(
  event: ClaudeHookEvent,
  input: ClaudeHookInput | string,
  io: CliIo,
): Promise<ClaudeHookResult> {
  try {
    const parsed = parseInput(input);
    switch (event) {
      case "session-start":
        return await onSessionStart(parsed, io);
      case "session-end":
        await onSessionEnd(parsed, io);
        return result({});
      case "pre-compact":
        await onPreCompact(parsed, io);
        return result({});
      default:
        throw new Error(`unknown hook event "${String(event)}"`);
    }
  } catch (err) {
    io.stderr(`memsync hook: ${oneLine(err)}\n`);
    return result({});
  }
}

function settingsPathFor(input: InstallClaudeInput): string {
  if (input.scope === "project") {
    return join(input.cwd, ".claude", "settings.json");
  }
  const configured = input.env.CLAUDE_CONFIG_DIR?.trim();
  const claudeDir =
    configured !== undefined && configured.length > 0
      ? configured
      : join(homedir(), ".claude");
  return join(claudeDir, "settings.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

/**
 * Our entries are recognized by a memsync `hook` command, including entries
 * created from a different/older CLI path (which quotes the path). Only those
 * are replaced; unrelated hooks and fields are kept as-is.
 */
function isMemsyncHook(
  hook: unknown,
  ourCommands: ReadonlySet<string>,
): boolean {
  if (!isObject(hook) || typeof hook.command !== "string") return false;
  if (ourCommands.has(hook.command)) return true;
  return /memsync[\w.-]*["']?\s+hook\s+/.test(hook.command);
}

function applyHooks(settings: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  const existingHooks = isObject(settings.hooks) ? settings.hooks : {};
  const hooks: Record<string, unknown> = { ...existingHooks };
  const ourCommands = new Set(HOOK_EVENTS.map((event) => hookCommand(event, env)));

  for (const event of HOOK_EVENTS) {
    const key = EVENT_NAMES[event];
    const existing = Array.isArray(hooks[key]) ? (hooks[key] as unknown[]) : [];
    const kept: unknown[] = [];

    for (const entry of existing) {
      if (!isObject(entry)) {
        kept.push(entry);
        continue;
      }

      if (!Array.isArray(entry.hooks)) {
        if (isMemsyncHook(entry, ourCommands)) continue;
        kept.push(entry);
        continue;
      }

      const remaining = entry.hooks.filter((hook) => !isMemsyncHook(hook, ourCommands));
      if (remaining.length === entry.hooks.length) {
        kept.push(entry);
      } else if (remaining.length > 0) {
        kept.push({ ...entry, hooks: remaining });
      }
    }

    kept.push({
      hooks: [{ type: "command", command: hookCommand(event, env), timeout: 30 }],
    });
    hooks[key] = kept;
  }

  settings.hooks = hooks;
}

/**
 * Installs the Claude Code hooks (user or project scope) and writes the
 * managed instructions block into `<cwd>/CLAUDE.md`. Safe to run repeatedly.
 */
export async function installClaude(input: InstallClaudeInput): Promise<InstallReport> {
  const settingsPath = settingsPathFor(input);
  const settings = await readSettings(settingsPath);
  applyHooks(settings, input.env);
  await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const managedBlockPath = join(input.cwd, "CLAUDE.md");
  await mergeManagedBlock(managedBlockPath, MANAGED_BLOCK_CONTENT);

  const slashCommandPath = join(
    input.cwd,
    ".claude",
    "commands",
    "memsync-sync.md",
  );
  await writeFileAtomic(slashCommandPath, SLASH_COMMAND_CONTENT);

  return {
    installed: true,
    settingsPath,
    managedBlockPath,
    slashCommandPath,
    command: hookCommand("session-start", input.env),
  };
}
