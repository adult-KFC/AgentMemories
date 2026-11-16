import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join, relative, sep } from "node:path";
import type { Tool } from "../types.js";
import { writeFileAtomic } from "./atomic.js";
import { runGit } from "./git.js";
import {
  SECTION_SUMMARY,
  createJournal,
  findJournalBySession,
  formatTimestamp,
  getSectionContent,
  listJournals,
  readJournalDocument,
  setSectionContent,
  type SessionOutcome,
  type SessionRecord,
  type SummarySource,
} from "./journal.js";
import { withLock } from "./lock.js";
import { lockPath, statePath } from "./paths.js";
import { repoRootFromProject } from "./project.js";
import { redactSecrets } from "./redact.js";
import { commitPaths, hasPendingPush, isGitRepo, pushWithRetry } from "./repo.js";
import { readProjectMeta, serializeFrontMatter } from "./schema.js";

const GIT_TIMEOUT_MS = 5_000;
const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";
const DEFAULT_STALE_MS = 12 * 60 * 60 * 1_000;
/** Same bound as a note: summaries are one-line AI text, not a transcript. */
export const MAX_SUMMARY_BYTES = 8_192;

export const SUPPORTED_TOOLS: readonly Tool[] = ["claude-code", "codex"];

const OUTCOMES: readonly SessionOutcome[] = [
  "completed",
  "partial",
  "blocked",
  "abandoned",
  "unknown",
];

/** Aggregated line changes for one session, from base and working tree. */
export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export type SessionSource = "explicit" | "env" | "pointer" | "implicit";

export interface ResolveSessionInput {
  explicit?: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
  tool: Tool;
  host: string;
  /**
   * Optional memory project directory. When supplied, open journals are
   * scanned to detect concurrent sessions for the same workspace and tool.
   * The brief's four-field signature works without it.
   */
  projectDir?: string;
}

export interface ResolvedSession {
  id: string;
  source: SessionSource;
  ambiguous: boolean;
}

export interface SessionPointerDetails {
  host?: string;
  startedAt?: string;
  baseCommit?: string;
}

export interface BeginSessionInput {
  projectDir: string;
  project: string;
  user: string;
  email: string;
  host: string;
  tool: Tool;
  session: string;
  workspace: string;
  baseCommit?: string;
  versionHint?: string;
  /** Marks a fallback session created because no binding was available. */
  implicit?: boolean;
  now?: Date;
}

export interface SessionSummaryInput {
  outcome?: SessionOutcome;
  summary?: string;
}

export interface EndSessionInput {
  projectDir: string;
  sessionId: string;
  now?: Date;
  /** Environment used for the pending-push marker; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface EndSessionResult {
  commits: string[];
  stats: DiffStats;
  outcome: SessionOutcome;
  summarySource: SummarySource;
  /** Extra fields beyond the brief's contract, used by the CLI for warnings. */
  pendingPush?: boolean;
  pushError?: string;
}

function ensureTrailingSlashFree(value: string): string {
  return value.replace(/[\\/]+$/g, "");
}

/** Stable key for comparing workspaces, case-insensitive on Windows. */
function workspaceKey(workspace: string): string {
  const normalized = ensureTrailingSlashFree(workspace.replace(/\\/g, "/"));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function cwdHash(workspace: string): string {
  return createHash("sha256").update(workspaceKey(workspace), "utf8").digest("hex");
}

function pointerPath(workspace: string, tool: Tool): string {
  return join(workspace, ".memsync", "sessions", `current-${tool}.json`);
}

async function headCommit(workspace: string): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--short", "HEAD"], {
    cwd: workspace,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

async function currentBranch(workspace: string): Promise<string | undefined> {
  const result = await runGit(["branch", "--show-current"], {
    cwd: workspace,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

interface SessionPointer {
  session: string;
  tool: Tool;
  host: string;
  cwdHash: string;
  startedAt: string;
  baseCommit: string;
}

/** Writes the per-tool workspace pointer; mismatched pointers are ignored on read. */
export async function writeSessionPointer(
  workspace: string,
  tool: Tool,
  session: string,
  details: SessionPointerDetails = {},
): Promise<void> {
  const pointer: SessionPointer = {
    session,
    tool,
    host: details.host?.trim() || hostname(),
    cwdHash: cwdHash(workspace),
    startedAt: details.startedAt ?? formatTimestamp(new Date()),
    baseCommit: details.baseCommit?.trim() || (await headCommit(workspace)) || "unknown",
  };
  await writeFileAtomic(
    pointerPath(workspace, tool),
    `${JSON.stringify(pointer, null, 2)}\n`,
  );
}

async function readSessionPointer(
  workspace: string,
  tool: Tool,
  host: string,
): Promise<SessionPointer | undefined> {
  let raw: string;
  try {
    raw = await readFile(pointerPath(workspace, tool), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const pointer = parsed as Record<string, unknown>;
  if (typeof pointer.session !== "string" || pointer.session.trim().length === 0) {
    return undefined;
  }
  if (pointer.tool !== tool) return undefined;
  if (
    typeof pointer.host !== "string" ||
    pointer.host.toLowerCase() !== host.toLowerCase()
  ) {
    return undefined;
  }

  return {
    session: pointer.session,
    tool,
    host: pointer.host,
    cwdHash: typeof pointer.cwdHash === "string" ? pointer.cwdHash : cwdHash(workspace),
    startedAt: typeof pointer.startedAt === "string" ? pointer.startedAt : "",
    baseCommit: typeof pointer.baseCommit === "string" ? pointer.baseCommit : "",
  };
}

async function openJournalCount(
  projectDir: string,
  workspace: string,
  tool: Tool,
): Promise<number> {
  const wanted = workspaceKey(workspace);
  let count = 0;

  for (const path of await listJournals(projectDir)) {
    let document;
    try {
      document = await readJournalDocument(path);
    } catch {
      continue;
    }
    const record = document.record;
    if (record.ended !== undefined) continue;
    if (record.tool !== tool) continue;
    if (workspaceKey(record.workspace) !== wanted) continue;
    count += 1;
  }
  return count;
}

/**
 * A pointer whose journal already ended is stale: notes written through it
 * would mutate a closed record. Treat it as absent (spec §8.3 / Codex Stop).
 * An unreadable journal is treated the same way so a corrupt file does not
 * trap every later note.
 */
async function pointerIsEnded(projectDir: string, sessionId: string): Promise<boolean> {
  const path = await findJournalBySession(projectDir, sessionId);
  if (path === undefined) return false;
  try {
    return (await readJournalDocument(path)).record.ended !== undefined;
  } catch {
    return true;
  }
}

/**
 * Resolves the current session in spec §8.3 order: explicit `--session`, then
 * `MEMSYS_SESSION`, then the workspace pointer, then a fresh implicit id.
 * With `projectDir` supplied, several open journals for the same workspace and
 * tool set `ambiguous`; callers that cannot disambiguate must ask for
 * `--session` rather than silently picking the newest. A pointer whose journal
 * has already ended is ignored, so a later note starts an implicit session.
 */
export async function resolveSession(
  input: ResolveSessionInput,
): Promise<ResolvedSession> {
  const explicit = input.explicit?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return { id: explicit, source: "explicit", ambiguous: false };
  }

  const envSession = input.env.MEMSYS_SESSION?.trim();
  if (envSession !== undefined && envSession.length > 0) {
    return { id: envSession, source: "env", ambiguous: false };
  }

  const ambiguous =
    input.projectDir !== undefined
      ? (await openJournalCount(input.projectDir, input.workspace, input.tool)) > 1
      : false;

  const pointer = await readSessionPointer(input.workspace, input.tool, input.host);
  if (pointer !== undefined) {
    const ended =
      input.projectDir !== undefined
        ? await pointerIsEnded(input.projectDir, pointer.session)
        : false;
    if (!ended) return { id: pointer.session, source: "pointer", ambiguous };
  }

  return { id: randomUUID(), source: "implicit", ambiguous };
}

/**
 * Creates (or reuses) the journal for a session, resolving `base_commit` from
 * HEAD and `version_hint` from `meta.current_version` when they are omitted,
 * then binds the workspace pointer to the session.
 */
export async function beginSession(input: BeginSessionInput): Promise<SessionRecord> {
  if (!SUPPORTED_TOOLS.includes(input.tool)) {
    throw new Error(
      `invalid tool "${String(input.tool)}"; expected one of ${SUPPORTED_TOOLS.join(", ")}`,
    );
  }

  const now = input.now ?? new Date();
  const baseCommit =
    input.baseCommit?.trim() || (await headCommit(input.workspace)) || "unknown";

  let versionHint = input.versionHint?.trim();
  if (versionHint === undefined || versionHint.length === 0) {
    try {
      versionHint = (await readProjectMeta(input.projectDir)).current_version;
    } catch {
      versionHint = undefined;
    }
  }

  const { record } = await createJournal({
    projectDir: input.projectDir,
    project: input.project,
    user: input.user,
    email: input.email,
    host: input.host,
    tool: input.tool,
    session: input.session,
    workspace: input.workspace,
    baseCommit,
    ...(versionHint !== undefined ? { versionHint } : {}),
    ...(input.implicit === true ? { implicit: true } : {}),
    now,
  });

  await writeSessionPointer(input.workspace, input.tool, input.session, {
    host: input.host,
    startedAt: record.started,
    baseCommit: record.base_commit,
  });

  return record;
}

/**
 * Writes the AI-provided outcome and optional summary. An outcome is always
 * required: without it, marking the source as AI would stop `endSession` from
 * deriving blocked/partial/completed from the notes. The summary may be empty.
 * Like a note, a summary is refused before any write when it exceeds 8,192
 * bytes or matches a secret pattern; only the summary section and
 * `outcome`/`summary_source` change, and every other field is preserved.
 */
export async function writeSessionSummary(
  projectDir: string,
  sessionId: string,
  input: SessionSummaryInput,
): Promise<void> {
  if (input.outcome === undefined) {
    throw new Error(
      `session summary requires an outcome (${OUTCOMES.join("|")})`,
    );
  }
  if (!OUTCOMES.includes(input.outcome)) {
    throw new Error(
      `invalid outcome "${String(input.outcome)}"; expected one of ${OUTCOMES.join(", ")}`,
    );
  }

  const summary = input.summary?.replace(/\r\n?/g, "\n").trim();

  if (summary !== undefined && Buffer.byteLength(summary, "utf8") > MAX_SUMMARY_BYTES) {
    throw new Error(
      `session summary exceeds ${MAX_SUMMARY_BYTES} bytes; summarize it in one short sentence`,
    );
  }
  if (summary !== undefined && redactSecrets(summary).redacted) {
    throw new Error(
      "session summary appears to contain a secret; remove credentials before writing",
    );
  }

  const path = await findJournalBySession(projectDir, sessionId);
  if (path === undefined) {
    throw new Error(`no journal found for session ${sessionId} in ${projectDir}`);
  }

  const document = await readJournalDocument(path);
  const body =
    summary !== undefined
      ? setSectionContent(document.body, SECTION_SUMMARY, summary)
      : document.body;
  const record: SessionRecord = {
    ...document.record,
    outcome: input.outcome,
    summary_source: "ai",
  };

  await writeFileAtomic(
    path,
    serializeFrontMatter({ ...record, ...document.extras }, body),
  );
}

function hasBlocker(body: string): boolean {
  return /^-\s+\d{2}:\d{2}\s+\[blocker\]/m.test(body.replace(/\r\n?/g, "\n"));
}

function hasPendingItem(body: string): boolean {
  return /^-\s+\[ \]/m.test(body.replace(/\r\n?/g, "\n"));
}

function deriveOutcome(body: string): SessionOutcome {
  if (hasBlocker(body)) return "blocked";
  if (hasPendingItem(body)) return "partial";
  return "completed";
}

function derivedSummary(outcome: SessionOutcome): string {
  switch (outcome) {
    case "blocked":
      return "本次会话存在阻塞，未完成（自动推导）。";
    case "partial":
      return "本次会话部分完成，仍有未完成事项（自动推导）。";
    case "completed":
      return "本次会话已完成（自动推导）。";
    case "abandoned":
      return "本次会话已放弃（自动推导）。";
    case "unknown":
      return "本次会话状态未知（自动推导）。";
  }
}

async function sessionCommits(workspace: string, base: string): Promise<string[]> {
  if (base.trim().length === 0 || base === "unknown") return [];
  const result = await runGit(["log", "--format=%h", `${base}..HEAD`], {
    cwd: workspace,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface NumstatEntry {
  insertions: number;
  deletions: number;
  file: string;
}

function parseNumstat(stdout: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const insertions = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10);
    const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10);
    entries.push({
      insertions: Number.isFinite(insertions) ? insertions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      file: parts.slice(2).join("\t"),
    });
  }
  return entries;
}

/**
 * Diff stats for the session. When the base commit exists,
 * `git diff --numstat <base>` already compares the working tree against base
 * (committed and uncommitted changes), so it is used alone; adding the
 * working-tree diff would double-count unstaged edits. Without a base commit,
 * only the working-tree diff is available.
 */
async function diffStats(workspace: string, base: string): Promise<DiffStats> {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;

  const hasBase = base.trim().length > 0 && base !== "unknown";
  const args = hasBase ? ["diff", "--numstat", base] : ["diff", "--numstat"];
  const result = await runGit(args, { cwd: workspace, timeoutMs: GIT_TIMEOUT_MS });
  if (result.code === 0) {
    for (const entry of parseNumstat(result.stdout)) {
      files.add(entry.file);
      insertions += entry.insertions;
      deletions += entry.deletions;
    }
  }

  return { filesChanged: files.size, insertions, deletions };
}

async function writePendingPush(
  env: NodeJS.ProcessEnv,
  repoPath: string,
  session: string,
  at: string,
): Promise<void> {
  await writeFileAtomic(
    statePath(env, "pending-push.json"),
    `${JSON.stringify({ repoPath, at, session }, null, 2)}\n`,
  );
}

export interface PendingPushMarker {
  repoPath: string;
  at: string;
  session: string;
}

/**
 * Reads the pending-push marker written when a session-end push fails. Status
 * reports it and sync consumes it by retrying the push before reading.
 */
export async function readPendingPush(
  env: NodeJS.ProcessEnv,
): Promise<PendingPushMarker | undefined> {
  let raw: string;
  try {
    raw = await readFile(statePath(env, "pending-push.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.repoPath !== "string" ||
    typeof record.at !== "string" ||
    typeof record.session !== "string"
  ) {
    return undefined;
  }
  return { repoPath: record.repoPath, at: record.at, session: record.session };
}

/** Removes the pending-push marker after a successful retry. */
export async function clearPendingPush(env: NodeJS.ProcessEnv): Promise<void> {
  await rm(statePath(env, "pending-push.json"), { force: true });
}

/**
 * Commits just the journal and pushes best-effort. Safe to call again after a
 * previous end: `commitPaths` is a no-op when the journal is already committed,
 * and a commit that failed on an earlier attempt is retried here.
 */
async function commitAndPush(
  repoPath: string,
  journalPath: string,
  session: string,
  at: string,
  env: NodeJS.ProcessEnv,
): Promise<{ pendingPush: boolean; pushError?: string }> {
  if (!(await isGitRepo(repoPath))) return { pendingPush: false };

  // Serialize with maintenance and sync pulls on the same git index.
  return withLock(lockPath(env), {}, async () => {
    const relativePath = relative(repoPath, journalPath).split(sep).join("/");
    const message = `journal: ${session} end\n\n${TRAILER}`;
    await commitPaths(repoPath, [relativePath], message);

    const marker = await readPendingPush(env);
    const markerForRepo = marker?.repoPath === repoPath;
    if (!(await hasPendingPush(repoPath))) {
      // A marker with nothing left to push is stale (e.g. a manual push).
      if (markerForRepo) await clearPendingPush(env);
      return { pendingPush: false };
    }

    const push = await pushWithRetry(repoPath);
    if (push.ok) {
      if (markerForRepo) await clearPendingPush(env);
      return { pendingPush: false };
    }

    await writePendingPush(env, repoPath, session, at);
    return {
      pendingPush: true,
      ...(push.reason !== undefined ? { pushError: push.reason } : {}),
    };
  });
}

/**
 * Finalizes one session: records `ended`, branch, commits, diff stats, and the
 * AI outcome when present (otherwise a deterministic outcome from the notes),
 * then commits only the journal and pushes best-effort. A failed push writes
 * `$MEMSYNC_HOME/state/pending-push.json` and still succeeds.
 */
export async function endSession(input: EndSessionInput): Promise<EndSessionResult> {
  const path = await findJournalBySession(input.projectDir, input.sessionId);
  if (path === undefined) {
    throw new Error(
      `no journal found for session ${input.sessionId} in ${input.projectDir}`,
    );
  }

  const document = await readJournalDocument(path);
  const { record } = document;
  const env = input.env ?? process.env;
  const repoPath = repoRootFromProject(input.projectDir);

  // A repeated end (hook retry, wrapper shutdown) must not rewrite history,
  // but it must still retry a commit/push that failed the first time.
  if (record.ended !== undefined) {
    const retry = await commitAndPush(
      repoPath,
      path,
      record.session,
      record.ended,
      env,
    );
    return {
      commits: record.commits,
      stats: {
        filesChanged: record.files_changed,
        insertions: record.insertions,
        deletions: record.deletions,
      },
      outcome: record.outcome,
      summarySource: record.summary_source,
      ...(retry.pendingPush ? { pendingPush: true } : {}),
      ...(retry.pushError !== undefined ? { pushError: retry.pushError } : {}),
    };
  }

  const now = input.now ?? new Date();
  const ended = formatTimestamp(now);
  const summarySource: SummarySource = record.summary_source === "ai" ? "ai" : "derived";
  const outcome =
    summarySource === "ai" ? record.outcome : deriveOutcome(document.body);

  const commits = await sessionCommits(record.workspace, record.base_commit);
  const stats = await diffStats(record.workspace, record.base_commit);
  const branch = await currentBranch(record.workspace);

  let body = document.body;
  if (summarySource === "derived" && getSectionContent(body, SECTION_SUMMARY).length === 0) {
    body = setSectionContent(body, SECTION_SUMMARY, derivedSummary(outcome));
  }

  const updated: SessionRecord = {
    ...record,
    ended,
    ...(branch !== undefined ? { branch } : {}),
    commits,
    files_changed: stats.filesChanged,
    insertions: stats.insertions,
    deletions: stats.deletions,
    outcome,
    summary_source: summarySource,
  };

  await writeFileAtomic(
    path,
    serializeFrontMatter({ ...updated, ...document.extras }, body),
  );

  const { pendingPush, pushError } = await commitAndPush(
    repoPath,
    path,
    record.session,
    ended,
    env,
  );

  return {
    commits,
    stats,
    outcome,
    summarySource,
    ...(pendingPush ? { pendingPush } : {}),
    ...(pushError !== undefined ? { pushError } : {}),
  };
}

/**
 * Commits only the current session journal, e.g. before the client compacts its
 * context. Returns whether a commit was actually created: a missing journal,
 * a non-Git memory repo, or an unchanged journal yields false.
 */
export async function checkpointSession(
  projectDir: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const path = await findJournalBySession(projectDir, sessionId);
  if (path === undefined) return false;

  const repoPath = repoRootFromProject(projectDir);
  if (!(await isGitRepo(repoPath))) return false;

  return withLock(lockPath(env), {}, async () => {
    const relativePath = relative(repoPath, path).split(sep).join("/");
    const message = `journal: ${sessionId} checkpoint\n\n${TRAILER}`;
    const committed = await commitPaths(repoPath, [relativePath], message);
    return committed !== undefined;
  });
}

export interface CompleteStaleOptions {
  /** Environment holding the shared lock; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Commit the completed journals (with the standard trailer) when true. */
  commit?: boolean;
}

/**
 * Completes journals that never ended and started more than `maxAgeMs` ago.
 * `ended` is the file mtime, the outcome is `unknown`, and the source is
 * `derived`; stats/commits are also filled best-effort. With `commit`, the
 * rewritten journals are committed under the shared lock so a crashed session
 * becomes visible to teammates instead of lingering forever.
 */
async function completeStaleUnlocked(
  projectDir: string,
  now: Date,
  maxAgeMs: number,
): Promise<{ count: number; paths: string[] }> {
  let completed = 0;
  const completedPaths: string[] = [];

  for (const path of await listJournals(projectDir)) {
    let document;
    try {
      document = await readJournalDocument(path);
    } catch {
      continue;
    }
    if (document.record.ended !== undefined) continue;

    const started = Date.parse(document.record.started);
    if (!Number.isFinite(started) || now.getTime() - started <= maxAgeMs) continue;

    let mtime: Date;
    try {
      mtime = (await stat(path)).mtime;
    } catch {
      continue;
    }

    const record = document.record;
    const commits = await sessionCommits(record.workspace, record.base_commit);
    const stats = await diffStats(record.workspace, record.base_commit);
    const updated: SessionRecord = {
      ...record,
      ended: formatTimestamp(mtime),
      commits,
      files_changed: stats.filesChanged,
      insertions: stats.insertions,
      deletions: stats.deletions,
      outcome: "unknown",
      summary_source: "derived",
    };

    await writeFileAtomic(
      path,
      serializeFrontMatter({ ...updated, ...document.extras }, document.body),
    );
    completedPaths.push(path);
    completed += 1;
  }

  return { count: completed, paths: completedPaths };
}

export async function completeStaleSessions(
  projectDir: string,
  now: Date,
  maxAgeMs: number = DEFAULT_STALE_MS,
  opts: CompleteStaleOptions = {},
): Promise<number> {
  if (opts.commit !== true) {
    return (await completeStaleUnlocked(projectDir, now, maxAgeMs)).count;
  }

  const env = opts.env ?? process.env;
  let completed = 0;

  // The whole read-modify-write runs under the shared lock so stale repair
  // cannot race a note append, session end, pull, or maintenance commit.
  await withLock(lockPath(env), {}, async () => {
    const result = await completeStaleUnlocked(projectDir, now, maxAgeMs);
    completed = result.count;
    if (result.paths.length === 0) return;

    const repoPath = repoRootFromProject(projectDir);
    if (!(await isGitRepo(repoPath))) return;

    const relativePaths = result.paths.map((path) =>
      relative(repoPath, path).split(sep).join("/"),
    );
    await commitPaths(
      repoPath,
      relativePaths,
      `journal: complete stale sessions\n\n${TRAILER}`,
    );
  });

  return completed;
}
