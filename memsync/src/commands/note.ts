import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { NOTE_KINDS, appendNote, findJournalBySession } from "../core/journal.js";
import {
  memoryRepoForEnv,
  resolveProject,
  type ProjectResolution,
} from "../core/project.js";
import {
  SUPPORTED_TOOLS,
  beginSession,
  resolveSession,
  type ResolvedSession,
} from "../core/session.js";
import type { NoteKind, Tool } from "../types.js";
import { defaultHost, preferredTool, resolveIdentity } from "./session.js";
import type { CommandModule } from "./index.js";

type ResolvedProject = Extract<ProjectResolution, { ok: true }>;

interface NoteOptions {
  text?: string;
  session?: string;
  version?: string;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync note: ${message}\n`);
  throw new CommanderError(1, "memsync.note.failed", message);
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

async function readNoteText(
  io: CliIo,
  positionalText: string | undefined,
  options: NoteOptions,
): Promise<string> {
  const supplied = options.text ?? positionalText;
  const raw = supplied === undefined ? await io.stdin() : supplied;
  // A trailing newline from stdin is not note content; inner newlines are
  // collapsed by appendNote so the journal stays one line per note.
  return raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** Creates a journal and pointer for a note written outside any session. */
async function beginImplicitSession(
  io: CliIo,
  project: ResolvedProject,
  tool: Tool,
  session: string,
): Promise<string> {
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
    versionHint: project.meta.current_version,
    implicit: true,
  });
  return record.session;
}

/**
 * Session resolution for `note`: explicit `--session`, then `MEMSYS_SESSION`,
 * then the workspace pointer (preferring `MEMSYS_TOOL`, probing the other
 * tool when that pointer is absent). Several open journals for the workspace
 * make the target ambiguous. With nothing to resolve, a fresh implicit
 * session is created and bound so the note remains attributable.
 */
async function resolveNoteSession(
  io: CliIo,
  project: ResolvedProject,
): Promise<string> {
  const envSession = io.env.MEMSYS_SESSION?.trim();
  if (envSession !== undefined && envSession.length > 0) return envSession;

  const preferred = preferredTool(io) ?? "claude-code";
  const probeOrder: Tool[] = [
    preferred,
    ...SUPPORTED_TOOLS.filter((tool) => tool !== preferred),
  ];

  const resolveFor = (tool: Tool): Promise<ResolvedSession> =>
    resolveSession({
      env: io.env,
      workspace: project.workspaceRoot,
      tool,
      host: defaultHost(io),
      projectDir: project.projectDir,
    });

  const preferredSession = await resolveFor(preferred);
  if (preferredSession.ambiguous) {
    fail(io, "multiple active sessions in this workspace; pass --session <id>");
  }
  if (preferredSession.source === "pointer") return preferredSession.id;

  // MEMSYS_TOOL is a preference, not a requirement: without an env file the
  // other tool's pointer is the only way to attribute a non-wrapper note.
  for (const tool of probeOrder.slice(1)) {
    const resolved = await resolveFor(tool);
    if (resolved.ambiguous) {
      fail(io, "multiple active sessions in this workspace; pass --session <id>");
    }
    if (resolved.source === "pointer") return resolved.id;
  }

  return beginImplicitSession(io, project, preferred, preferredSession.id);
}

async function runNote(
  io: CliIo,
  kindArg: string,
  positionalText: string | undefined,
  options: NoteOptions,
): Promise<void> {
  const kind = kindArg as NoteKind;
  if (!NOTE_KINDS.includes(kind)) {
    fail(io, `invalid kind "${kindArg}"; expected one of ${NOTE_KINDS.join(", ")}`);
  }

  const requestedSession = options.session?.trim();

  const text = await readNoteText(io, positionalText, options);
  if (text.trim().length === 0) {
    fail(io, "note text is required; pass --text or pipe it on stdin");
  }

  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    fail(io, resolutionMessage(resolution.reason));
  }

  const sessionId =
    requestedSession !== undefined && requestedSession.length > 0
      ? requestedSession
      : await resolveNoteSession(io, resolution);

  const journal = await findJournalBySession(resolution.projectDir, sessionId);
  if (journal === undefined) {
    fail(
      io,
      `no journal found for session ${sessionId}; start a session first or pass the correct --session`,
    );
  }

  const result = await appendNote({
    projectDir: resolution.projectDir,
    sessionId,
    kind,
    text,
    env: io.env,
    ...(options.version !== undefined ? { version: options.version } : {}),
  });

  if (result.added) {
    const checkpoint = result.checkpoint ? ", checkpoint committed" : "";
    const notes = `${result.noteCount} note${result.noteCount === 1 ? "" : "s"}`;
    io.stdout(`Added ${kind} note (${notes}${checkpoint})\n`);
    if (result.checkpointError !== undefined) {
      const detail = result.checkpointError.replace(/\s+/g, " ").trim();
      io.stderr(
        `memsync note: warning: note saved but checkpoint commit failed: ${detail}\n`,
      );
    }
    return;
  }

  switch (result.reason) {
    case "duplicate":
      io.stdout(`Duplicate ${kind} note ignored (${result.noteCount} notes)\n`);
      return;
    case "too_large":
      fail(io, "note exceeds 8192 bytes; split it into multiple notes");
    case "secret":
      fail(io, "note appears to contain a secret; remove credentials before writing");
    default:
      fail(io, "note was not written");
  }
}

export const noteCommand: CommandModule = {
  name: "note",
  register(program, io) {
    program
      .command("note <kind> [text]")
      .description("Append a structured note to the current session journal")
      .option("--text <text>", "note text; read from stdin when omitted")
      .option(
        "--session <id>",
        "session id; defaults to MEMSYS_SESSION or the workspace pointer",
      )
      .option("--version <version>", "record this note against a specific version")
      .action(
        async (
          kind: string,
          positionalText: string | undefined,
          options: NoteOptions,
        ) => {
          try {
            await runNote(io, kind, positionalText, options);
          } catch (err) {
            if (err instanceof CommanderError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            io.stderr(`memsync note: ${message}\n`);
            throw new CommanderError(1, "memsync.note.failed", message);
          }
        },
      );
  },
};
