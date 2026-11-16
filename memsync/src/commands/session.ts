import { CommanderError } from "commander";
import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import type { CliIo } from "../cli.js";
import { loadConfig } from "../core/config.js";
import { runGit } from "../core/git.js";
import type { SessionOutcome } from "../core/journal.js";
import {
  SUPPORTED_TOOLS,
  beginSession,
  endSession,
  resolveSession,
  writeSessionSummary,
  type ResolvedSession,
} from "../core/session.js";
import {
  memoryRepoForEnv,
  resolveProject,
  type ProjectResolution,
} from "../core/project.js";
import type { Tool } from "../types.js";
import type { CommandModule } from "./index.js";

const GIT_TIMEOUT_MS = 5_000;
const SUMMARY_OUTCOMES: readonly SessionOutcome[] = [
  "completed",
  "partial",
  "blocked",
  "abandoned",
];

type ResolvedProject = Extract<ProjectResolution, { ok: true }>;

interface BeginOptions {
  tool: string;
  session?: string;
}

interface SessionOption {
  session?: string;
}

interface SummaryOptions extends SessionOption {
  outcome?: string;
  summary?: string;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync session: ${message}\n`);
  throw new CommanderError(1, "memsync.session.failed", message);
}

function failFrom(io: CliIo, err: unknown): never {
  if (err instanceof CommanderError) throw err;
  return fail(io, err instanceof Error ? err.message : String(err));
}

function resolutionMessage(reason: "unlinked" | "missing_meta" | "ambiguous"): string {
  switch (reason) {
    case "ambiguous":
      return "multiple projects match this workspace; run memsync link <slug> to choose one";
    case "missing_meta":
      return "the workspace points at a project whose meta.yaml is missing; run memsync project add <slug>";
    case "unlinked":
      return "workspace is not linked to a project; run memsync link <slug>";
  }
}

async function requireProject(io: CliIo): Promise<ResolvedProject> {
  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    return fail(io, resolutionMessage(resolution.reason));
  }
  return resolution;
}

function parseTool(io: CliIo, value: string | undefined): Tool {
  if (value === undefined || value.trim().length === 0) {
    return fail(io, "--tool is required (claude-code or codex)");
  }
  if (!SUPPORTED_TOOLS.includes(value as Tool)) {
    return fail(
      io,
      `invalid tool "${value}"; expected one of ${SUPPORTED_TOOLS.join(", ")}`,
    );
  }
  return value as Tool;
}

export function defaultHost(io: CliIo): string {
  const configured = io.env.MEMSYS_HOST?.trim();
  return configured && configured.length > 0 ? configured : hostname();
}

export function preferredTool(io: CliIo): Tool | undefined {
  const value = io.env.MEMSYS_TOOL?.trim();
  return value !== undefined && SUPPORTED_TOOLS.includes(value as Tool)
    ? (value as Tool)
    : undefined;
}

async function gitConfigValue(
  io: CliIo,
  workspace: string,
  key: string,
): Promise<string | undefined> {
  const result = await runGit(["config", "--get", key], {
    cwd: workspace,
    timeoutMs: GIT_TIMEOUT_MS,
    env: io.env,
  });
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

export async function resolveIdentity(
  io: CliIo,
  workspace: string,
): Promise<{ user: string; email: string }> {
  const config = await loadConfig(io.env);
  const configured = config?.identity;
  const fallbackName = (() => {
    try {
      return userInfo().username;
    } catch {
      return "unknown";
    }
  })();

  const user =
    configured?.name?.trim() ||
    (await gitConfigValue(io, workspace, "user.name")) ||
    fallbackName;
  const email =
    configured?.email?.trim() ||
    (await gitConfigValue(io, workspace, "user.email")) ||
    `${user}@localhost`;

  return { user, email };
}

/**
 * Without an explicit/env session the tool is not known, so each supported
 * tool's pointer is tried before falling back to an implicit session.
 */
async function resolveActiveSession(
  io: CliIo,
  project: ResolvedProject,
  explicit: string | undefined,
): Promise<ResolvedSession> {
  const host = defaultHost(io);
  const preferred = preferredTool(io) ?? "claude-code";
  const explicitId = explicit?.trim();
  const envId = io.env.MEMSYS_SESSION?.trim();

  if (
    (explicitId !== undefined && explicitId.length > 0) ||
    (envId !== undefined && envId.length > 0)
  ) {
    return resolveSession({
      ...(explicitId !== undefined && explicitId.length > 0
        ? { explicit: explicitId }
        : {}),
      env: io.env,
      workspace: project.workspaceRoot,
      tool: preferred,
      host,
      projectDir: project.projectDir,
    });
  }

  // Probe the tool selected by MEMSYS_TOOL first so two concurrent pointers
  // cannot make end/summary finalize the other tool's session.
  const probeOrder: Tool[] = [
    preferred,
    ...SUPPORTED_TOOLS.filter((tool) => tool !== preferred),
  ];

  let fallback: ResolvedSession | undefined;
  for (const tool of probeOrder) {
    const resolved = await resolveSession({
      env: io.env,
      workspace: project.workspaceRoot,
      tool,
      host,
      projectDir: project.projectDir,
    });
    if (resolved.source === "pointer") return resolved;
    if (tool === preferred) fallback = resolved;
  }

  return (
    fallback ??
    (await resolveSession({
      env: io.env,
      workspace: project.workspaceRoot,
      tool: preferred,
      host,
      projectDir: project.projectDir,
    }))
  );
}

function assertUnambiguous(io: CliIo, resolved: ResolvedSession): void {
  if (resolved.ambiguous && resolved.source !== "explicit" && resolved.source !== "env") {
    fail(io, "multiple active sessions in this workspace; pass --session <id>");
  }
}

async function runBegin(io: CliIo, options: BeginOptions): Promise<void> {
  const project = await requireProject(io);
  const tool = parseTool(io, options.tool);

  const explicit = options.session?.trim();
  const envSession = io.env.MEMSYS_SESSION?.trim();
  const session =
    explicit !== undefined && explicit.length > 0
      ? explicit
      : envSession !== undefined && envSession.length > 0
        ? envSession
        : randomUUID();

  const { user, email } = await resolveIdentity(io, project.workspaceRoot);
  const record = await beginSession({
    projectDir: project.projectDir,
    project: project.slug,
    user,
    email,
    host: defaultHost(io),
    tool,
    session,
    workspace: project.workspaceRoot,
  });

  io.stdout(`Session ${record.session} started (${record.tool})\n`);
}

async function runEnd(io: CliIo, options: SessionOption): Promise<void> {
  const project = await requireProject(io);
  const resolved = await resolveActiveSession(io, project, options.session);
  assertUnambiguous(io, resolved);

  const result = await endSession({
    projectDir: project.projectDir,
    sessionId: resolved.id,
    env: io.env,
  });

  const commits = `${result.commits.length} commit${result.commits.length === 1 ? "" : "s"}`;
  const stats =
    `${result.stats.filesChanged} file${result.stats.filesChanged === 1 ? "" : "s"} changed, ` +
    `+${result.stats.insertions}/-${result.stats.deletions}`;
  io.stdout(
    `Session ${resolved.id} ended: ${result.outcome}, ${commits}, ${stats}\n`,
  );

  if (result.pendingPush) {
    const detail = result.pushError?.replace(/\s+/g, " ").trim() || "unknown error";
    io.stderr(
      `memsync session: warning: journal saved but push failed; queued pending push: ${detail}\n`,
    );
  }
}

async function runSummary(io: CliIo, options: SummaryOptions): Promise<void> {
  const rawOutcome = options.outcome?.trim();
  if (rawOutcome === undefined || rawOutcome.length === 0) {
    fail(io, "--outcome <outcome> is required");
  }
  if (!SUMMARY_OUTCOMES.includes(rawOutcome as SessionOutcome)) {
    fail(
      io,
      `invalid outcome "${rawOutcome}"; expected one of ${SUMMARY_OUTCOMES.join(", ")}`,
    );
  }

  const outcome = rawOutcome as SessionOutcome;
  const summary = options.summary;

  const project = await requireProject(io);
  const resolved = await resolveActiveSession(io, project, options.session);
  assertUnambiguous(io, resolved);

  await writeSessionSummary(project.projectDir, resolved.id, {
    outcome,
    ...(summary !== undefined ? { summary } : {}),
  });

  io.stdout(`Session ${resolved.id}: summary recorded (${outcome})\n`);
}

export const sessionCommand: CommandModule = {
  name: "session",
  register(program, io) {
    const session = program
      .command("session")
      .description("Begin, summarize, and end a memory session");

    session
      .command("begin")
      .description("Create or reuse a session journal and write the workspace pointer")
      .requiredOption("--tool <tool>", "tool name (claude-code or codex)")
      .option("--session <id>", "explicit session id")
      .action(async (options: BeginOptions) => {
        try {
          await runBegin(io, options);
        } catch (err) {
          failFrom(io, err);
        }
      });

    session
      .command("end")
      .description("Record session statistics and outcome, then commit and push")
      .option("--session <id>", "session id; resolved from env or the workspace pointer otherwise")
      .action(async (options: SessionOption) => {
        try {
          await runEnd(io, options);
        } catch (err) {
          failFrom(io, err);
        }
      });

    session
      .command("summary")
      .description("Write the AI-provided outcome and work summary")
      .option("--outcome <outcome>", "completed, partial, blocked, or abandoned")
      .option("--summary <text>", "one-line work summary")
      .option("--session <id>", "session id; resolved from env or the workspace pointer otherwise")
      .action(async (options: SummaryOptions) => {
        try {
          await runSummary(io, options);
        } catch (err) {
          failFrom(io, err);
        }
      });
  },
};
