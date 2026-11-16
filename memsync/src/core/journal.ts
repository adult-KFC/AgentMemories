import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { NoteKind, Tool } from "../types.js";
import { writeFileAtomic } from "./atomic.js";
import { runGit } from "./git.js";
import { withLock } from "./lock.js";
import { lockPath } from "./paths.js";
import { repoRootFromProject } from "./project.js";
import { redactSecrets } from "./redact.js";
import { commitPaths, isGitRepo } from "./repo.js";
import { SchemaError, parseFrontMatter, serializeFrontMatter } from "./schema.js";

const MAX_NOTE_BYTES = 8_192;
const CHECKPOINT_EVERY = 5;
const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";

export const SECTION_SUMMARY = "## 工作摘要";
export const SECTION_AI = "## AI 记录";
export const SECTION_HANDOFF = "## 未完成 / 交接";

const JOURNAL_BODY = `${SECTION_SUMMARY}\n\n${SECTION_AI}\n\n${SECTION_HANDOFF}\n`;

export type SessionOutcome = "completed" | "partial" | "blocked" | "abandoned" | "unknown";
export type SummarySource = "ai" | "derived";

export const NOTE_KINDS: readonly NoteKind[] = [
  "progress",
  "decision",
  "blocker",
  "todo",
  "handoff",
];

const TOOLS: readonly Tool[] = ["claude-code", "codex"];
const OUTCOMES: readonly SessionOutcome[] = [
  "completed",
  "partial",
  "blocked",
  "abandoned",
  "unknown",
];
const SUMMARY_SOURCES: readonly SummarySource[] = ["ai", "derived"];

/** Front matter of one session journal, matching spec §7.2. */
export interface SessionRecord {
  id: string;
  project: string;
  user: string;
  email: string;
  host: string;
  tool: Tool;
  session: string;
  started: string;
  ended?: string;
  branch?: string;
  workspace: string;
  base_commit: string;
  version_hint?: string;
  commits: string[];
  files_changed: number;
  insertions: number;
  deletions: number;
  outcome: SessionOutcome;
  summary_source: SummarySource;
  /** True for a session created as a fallback (spec §8.3 rule 4). */
  implicit?: boolean;
}

export interface CreateJournalInput {
  projectDir: string;
  project: string;
  user: string;
  email: string;
  host: string;
  tool: Tool;
  session: string;
  workspace: string;
  baseCommit: string;
  versionHint?: string;
  branch?: string;
  /** Marks a fallback session created because no binding was available. */
  implicit?: boolean;
  now?: Date;
}

export type NoteRejection = "duplicate" | "too_large" | "secret";

export interface AppendNoteResult {
  added: boolean;
  reason?: NoteRejection;
  noteCount: number;
  /** True only when this note triggered a checkpoint that actually committed. */
  checkpoint: boolean;
  /** Set when the checkpoint was due but the commit failed; the note is saved. */
  checkpointError?: string;
}

export interface AppendNoteInput {
  projectDir: string;
  sessionId: string;
  kind: NoteKind;
  text: string;
  version?: string;
  now?: Date;
  /** Environment holding the shared lock; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Local ISO-8601 timestamp with an explicit offset, e.g. 2026-11-13T14:32:05+08:00. */
export function formatTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new SchemaError("Cannot format an invalid date");
  }
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

const STARTED_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

/**
 * The journal filename uses the wall-clock part of `started`, not a parsed
 * Date, so the file lands on the date the session recorded regardless of the
 * reader's timezone.
 */
function startedParts(started: string): { month: string; day: string; time: string } {
  const match = STARTED_PATTERN.exec(started);
  if (match) {
    const [, year, month, day, hours, minutes, seconds] = match;
    return {
      month: `${year}-${month}`,
      day: `${year}-${month}-${day}`,
      time: `${hours}${minutes}${seconds}`,
    };
  }

  const parsed = new Date(started);
  if (Number.isNaN(parsed.getTime())) {
    throw new SchemaError(`Invalid journal started timestamp "${started}"`);
  }
  return {
    month: `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}`,
    day: `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`,
    time: `${pad(parsed.getHours())}${pad(parsed.getMinutes())}${pad(parsed.getSeconds())}`,
  };
}

/** Lowercase, hyphen-separated, filesystem-safe component. */
export function journalSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "unknown";
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function shortSessionId(session: string): string {
  const alphanumeric = session.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return alphanumeric.slice(0, 6).padEnd(6, "0");
}

/**
 * §8.8: the user segment is the email local part, lowercased and reduced to
 * `[a-z0-9-]`; a missing email falls back to the display name.
 */
function userSegment(record: Pick<SessionRecord, "user" | "email">): string {
  const email = typeof record.email === "string" ? record.email : "";
  const local = email.split("@")[0] ?? "";
  const slug = local
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : journalSlug(record.user);
}

/**
 * `journal/YYYY-MM/YYYY-MM-DD/HHMMSS_<user>_<host>_<tool>_<sessionShort>.md`.
 * Separators are normalized to `/` so the documented name is stable on Windows.
 */
export function journalPath(projectDir: string, record: SessionRecord): string {
  const { month, day, time } = startedParts(record.started);
  const filename =
    `${time}_${userSegment(record)}_${journalSlug(record.host)}` +
    `_${journalSlug(record.tool)}_${journalSlug(record.id)}.md`;
  return toPosixPath(join(projectDir, "journal", month, day, filename));
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SchemaError(`Journal ${context} field "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SchemaError(`Journal ${context} field "${key}" must be a string`);
  }
  return value;
}

function nonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SchemaError(
      `Journal ${context} field "${key}" must be a non-negative integer`,
    );
  }
  return value;
}

/** Validates journal front matter; used on read and before the first write. */
export function validateSessionRecord(input: unknown, context = "record"): SessionRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SchemaError(`Journal ${context} must be a front matter mapping`);
  }
  const record = input as Record<string, unknown>;

  const id = requireString(record, "id", context);
  const project = requireString(record, "project", context);
  const user = requireString(record, "user", context);
  const email = requireString(record, "email", context);
  const host = requireString(record, "host", context);
  const tool = requireString(record, "tool", context) as Tool;
  if (!TOOLS.includes(tool)) {
    throw new SchemaError(
      `Journal ${context} field "tool" must be one of ${TOOLS.join("|")}`,
    );
  }
  const session = requireString(record, "session", context);
  const started = requireString(record, "started", context);
  const ended = optionalString(record, "ended", context);
  const branch = optionalString(record, "branch", context);
  const workspace = requireString(record, "workspace", context);
  const baseCommit = requireString(record, "base_commit", context);
  const versionHint = optionalString(record, "version_hint", context);
  const implicit = record.implicit;
  if (implicit !== undefined && typeof implicit !== "boolean") {
    throw new SchemaError(`Journal ${context} field "implicit" must be a boolean`);
  }

  const commits = record.commits;
  if (!Array.isArray(commits) || commits.some((commit) => typeof commit !== "string")) {
    throw new SchemaError(`Journal ${context} field "commits" must be an array of strings`);
  }

  const outcome = requireString(record, "outcome", context) as SessionOutcome;
  if (!OUTCOMES.includes(outcome)) {
    throw new SchemaError(
      `Journal ${context} field "outcome" must be one of ${OUTCOMES.join("|")}`,
    );
  }
  const summarySource = requireString(record, "summary_source", context) as SummarySource;
  if (!SUMMARY_SOURCES.includes(summarySource)) {
    throw new SchemaError(
      `Journal ${context} field "summary_source" must be one of ${SUMMARY_SOURCES.join("|")}`,
    );
  }

  return {
    id,
    project,
    user,
    email,
    host,
    tool,
    session,
    started,
    ...(ended !== undefined ? { ended } : {}),
    ...(branch !== undefined ? { branch } : {}),
    workspace,
    base_commit: baseCommit,
    ...(versionHint !== undefined ? { version_hint: versionHint } : {}),
    commits: commits.map((commit) => commit as string),
    files_changed: nonNegativeInteger(record, "files_changed", context),
    insertions: nonNegativeInteger(record, "insertions", context),
    deletions: nonNegativeInteger(record, "deletions", context),
    outcome,
    summary_source: summarySource,
    ...(implicit === true ? { implicit: true } : {}),
  };
}

/**
 * Best-effort branch for the journal header. A detached HEAD or a workspace
 * that is not a git repository simply leaves the field out.
 */
async function currentBranch(workspace: string): Promise<string | undefined> {
  // symbolic-ref works on a freshly initialized repository whose HEAD is unborn.
  for (const args of [
    ["symbolic-ref", "--short", "HEAD"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
  ]) {
    const result = await runGit(args, { cwd: workspace, timeoutMs: 5_000 });
    if (result.code !== 0) continue;
    const branch = result.stdout.trim();
    if (branch.length > 0 && branch !== "HEAD") return branch;
  }
  return undefined;
}

/**
 * Creates a session journal with the spec front matter and empty sections.
 * An existing file for the same session is returned unchanged, so a retried
 * session begin never clobbers notes.
 */
export async function createJournal(
  input: CreateJournalInput,
): Promise<{ path: string; record: SessionRecord }> {
  const now = input.now ?? new Date();
  const branch = input.branch?.trim() || (await currentBranch(input.workspace));
  const record: SessionRecord = {
    id: shortSessionId(input.session),
    project: input.project,
    user: input.user,
    email: input.email,
    host: input.host,
    tool: input.tool,
    session: input.session,
    started: formatTimestamp(now),
    ...(branch !== undefined ? { branch } : {}),
    workspace: input.workspace,
    base_commit: input.baseCommit,
    ...(input.versionHint !== undefined ? { version_hint: input.versionHint } : {}),
    commits: [],
    files_changed: 0,
    insertions: 0,
    deletions: 0,
    outcome: "unknown",
    summary_source: "derived",
    ...(input.implicit === true ? { implicit: true } : {}),
  };
  const validated = validateSessionRecord(record, "create input");

  // Look up by session, not by the timestamp-derived path: a retry starting a
  // second later must still find the journal created by the first attempt.
  const existing = await findJournalBySession(input.projectDir, input.session);
  if (existing !== undefined) {
    return { path: existing, record: await readJournal(existing) };
  }

  const path = journalPath(input.projectDir, validated);
  await writeFileAtomic(path, serializeFrontMatter(validated, JOURNAL_BODY));
  return { path, record: validated };
}

const RECORD_FIELDS = new Set([
  "id",
  "project",
  "user",
  "email",
  "host",
  "tool",
  "session",
  "started",
  "ended",
  "branch",
  "workspace",
  "base_commit",
  "version_hint",
  "commits",
  "files_changed",
  "insertions",
  "deletions",
  "outcome",
  "summary_source",
  "implicit",
]);

/**
 * §7.2 fields we do not model (or future additions such as pending_push) are
 * carried through appendNote untouched instead of being dropped on rewrite.
 */
function unknownFields(data: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!RECORD_FIELDS.has(key)) extras[key] = value;
  }
  return extras;
}

export interface JournalDocument {
  record: SessionRecord;
  body: string;
  extras: Record<string, unknown>;
}

/**
 * Reads one journal with its body and unmodelled front-matter fields intact.
 * Callers that rewrite a journal must merge `extras` back so fields written by
 * other tools (or future spec revisions) are never dropped.
 */
export async function readJournalDocument(path: string): Promise<JournalDocument> {
  const text = await readFile(path, "utf8");
  const { data, body } = parseFrontMatter<unknown>(text);
  const record = validateSessionRecord(data, path);
  const extras =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? unknownFields(data as Record<string, unknown>)
      : {};
  return { record, body, extras };
}

/** Reads and validates one journal, returning its front matter. */
export async function readJournal(path: string): Promise<SessionRecord> {
  return (await readJournalDocument(path)).record;
}

async function walkJournals(directory: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkJournals(full, files);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(toPosixPath(full));
    }
  }
}

/** All journal files under `projectDir/journal`, sorted for stable output. */
export async function listJournals(projectDir: string): Promise<string[]> {
  const files: string[] = [];
  await walkJournals(join(projectDir, "journal"), files);
  return files.sort();
}

/**
 * Archived journals under `archive/`, sorted. Reports and releases must
 * include them: compacting moves content, it never removes history. Index
 * files are not journals and are excluded by the caller's parser.
 */
export async function listArchivedJournals(projectDir: string): Promise<string[]> {
  const files: string[] = [];
  await walkJournals(join(projectDir, "archive"), files);
  return files.sort();
}

/**
 * Finds the journal whose front matter `session` matches. Malformed files are
 * skipped so one corrupt journal cannot hide every other session.
 */
export async function findJournalBySession(
  projectDir: string,
  sessionId: string,
): Promise<string | undefined> {
  for (const path of await listJournals(projectDir)) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }

    let data: { session?: unknown };
    try {
      data = parseFrontMatter<{ session?: unknown }>(text).data;
    } catch {
      continue;
    }

    if (typeof data.session === "string" && data.session === sessionId) {
      return path;
    }
  }
  return undefined;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, "\n");
}

/** Notes are one line so appended text cannot break the section structure. */
function singleLine(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, " ");
}

function noteHash(kind: NoteKind, text: string): string {
  return createHash("sha256")
    .update(`${kind}\u0000${singleLine(text)}`, "utf8")
    .digest("hex");
}

const AI_NOTE_PATTERN = /^- \d{2}:\d{2} \[(progress|decision|blocker)\] (.*)$/;
const PENDING_NOTE_PATTERN = /^- \[[ xX]\] (.*)$/;

/**
 * Hashes of every note already in the body. Pending-section lines do not encode
 * whether they were written as `todo` or `handoff`, so both hashes are added;
 * this keeps a repeated item out of the handoff list under either kind.
 */
function noteHashes(body: string): Set<string> {
  const hashes = new Set<string>();
  for (const line of normalizeBody(body).split("\n")) {
    const ai = AI_NOTE_PATTERN.exec(line);
    if (ai) {
      hashes.add(noteHash(ai[1] as NoteKind, ai[2]));
      continue;
    }
    const pending = PENDING_NOTE_PATTERN.exec(line);
    if (pending) {
      hashes.add(noteHash("todo", pending[1]));
      hashes.add(noteHash("handoff", pending[1]));
    }
  }
  return hashes;
}

function countNotes(body: string): number {
  let count = 0;
  for (const line of normalizeBody(body).split("\n")) {
    if (AI_NOTE_PATTERN.test(line) || PENDING_NOTE_PATTERN.test(line)) count += 1;
  }
  return count;
}

function isAiKind(kind: NoteKind): boolean {
  return kind === "progress" || kind === "decision" || kind === "blocker";
}

function noteLine(kind: NoteKind, text: string, now: Date): string {
  const content = singleLine(text);
  if (isAiKind(kind)) {
    return `- ${pad(now.getHours())}:${pad(now.getMinutes())} [${kind}] ${content}`;
  }
  return `- [ ] ${content}`;
}

function sectionBounds(
  lines: string[],
  header: string,
): { start: number; end: number } | undefined {
  const start = lines.findIndex((entry) => entry.trim() === header);
  if (start === -1) return undefined;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

/** Trimmed body of one `##` section; empty when the section is absent. */
export function getSectionContent(body: string, header: string): string {
  const lines = normalizeBody(body).split("\n");
  const bounds = sectionBounds(lines, header);
  if (bounds === undefined) return "";
  return lines.slice(bounds.start + 1, bounds.end).join("\n").trim();
}

/**
 * Replaces only the body of one `##` section, preserving every other line.
 * A missing section is appended at the end of the document.
 */
export function setSectionContent(body: string, header: string, content: string): string {
  const normalized = normalizeBody(body);
  const lines = normalized.split("\n");
  const contentLines = content.replace(/\r\n?/g, "\n").split("\n");
  while (contentLines.length > 0 && contentLines[0].trim() === "") contentLines.shift();
  while (contentLines.length > 0 && contentLines[contentLines.length - 1].trim() === "") {
    contentLines.pop();
  }

  const bounds = sectionBounds(lines, header);
  if (bounds === undefined) {
    const prefix = normalized.trimEnd();
    const head = prefix.length > 0 ? `${prefix}\n\n${header}` : header;
    return contentLines.length > 0
      ? `${head}\n\n${contentLines.join("\n")}\n`
      : `${head}\n`;
  }

  const before = lines.slice(0, bounds.start + 1);
  const after = lines.slice(bounds.end);
  const middle = contentLines.length > 0 ? ["", ...contentLines] : [];
  const result = [...before, ...middle];
  if (after.length > 0) result.push("", ...after);
  else result.push("");
  return result.join("\n");
}

/** Inserts a line at the end of a `##` section without touching other text. */
function appendToSection(body: string, header: string, line: string): string {
  const normalized = normalizeBody(body);
  const lines = normalized.split("\n");
  const start = lines.findIndex((entry) => entry.trim() === header);

  if (start === -1) {
    const prefix = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
    return `${prefix}\n${header}\n\n${line}\n`;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const content = lines.slice(start + 1, end);
  while (content.length > 0 && content[content.length - 1].trim() === "") {
    content.pop();
  }
  content.push(line);

  return [...lines.slice(0, start + 1), ...content, "", ...lines.slice(end)].join("\n");
}

/** Returns true only when a commit was actually created. */
async function commitJournal(
  projectDir: string,
  journalFile: string,
  sessionId: string,
  kind: NoteKind,
): Promise<boolean> {
  const repoPath = repoRootFromProject(projectDir);
  if (!(await isGitRepo(repoPath))) return false;

  const relativePath = relative(repoPath, journalFile).split(sep).join("/");
  const message = `journal: ${sessionId} note ${kind}\n\n${TRAILER}`;
  const committed = await commitPaths(repoPath, [relativePath], message);
  return committed !== undefined;
}

async function appendNoteLocked(input: AppendNoteInput): Promise<AppendNoteResult> {
  const path = await findJournalBySession(input.projectDir, input.sessionId);
  if (path === undefined) {
    throw new Error(
      `no journal found for session ${input.sessionId} in ${input.projectDir}`,
    );
  }

  const { record, body, extras } = await readJournalDocument(path);
  const noteCount = countNotes(body);

  if (noteHashes(body).has(noteHash(input.kind, input.text))) {
    return { added: false, reason: "duplicate", noteCount, checkpoint: false };
  }

  if (Buffer.byteLength(input.text, "utf8") > MAX_NOTE_BYTES) {
    return { added: false, reason: "too_large", noteCount, checkpoint: false };
  }

  if (redactSecrets(input.text).redacted) {
    return { added: false, reason: "secret", noteCount, checkpoint: false };
  }

  const now = input.now ?? new Date();
  const line = noteLine(input.kind, input.text, now);
  const section = isAiKind(input.kind) ? SECTION_AI : SECTION_HANDOFF;
  const updatedBody = appendToSection(body, section, line);
  const version = input.version?.trim();
  const updatedRecord: SessionRecord =
    version !== undefined && version.length > 0 && version !== record.version_hint
      ? { ...record, version_hint: version }
      : record;

  await writeFileAtomic(
    path,
    serializeFrontMatter({ ...updatedRecord, ...extras }, updatedBody),
  );

  const updatedCount = noteCount + 1;
  let checkpoint = false;
  let checkpointError: string | undefined;
  if (updatedCount % CHECKPOINT_EVERY === 0) {
    try {
      checkpoint = await commitJournal(input.projectDir, path, record.session, input.kind);
    } catch (err) {
      // The note is already durable; a failed checkpoint must not turn a
      // successful append into an error.
      checkpointError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    added: true,
    noteCount: updatedCount,
    checkpoint,
    ...(checkpointError !== undefined ? { checkpointError } : {}),
  };
}

/**
 * Appends one structured note under the shared `$MEMSYNC_HOME/lock`, so the
 * read-modify-write of the journal and the every-fifth-note checkpoint commit
 * cannot race another note, session end, sync pull, or maintenance run.
 * Identical notes (same kind and text) are ignored; oversized and
 * secret-shaped text is refused without writing.
 */
export async function appendNote(input: AppendNoteInput): Promise<AppendNoteResult> {
  if (!NOTE_KINDS.includes(input.kind)) {
    throw new Error(
      `invalid note kind "${String(input.kind)}"; expected one of ${NOTE_KINDS.join(", ")}`,
    );
  }

  const env = input.env ?? process.env;
  return withLock(lockPath(env), {}, () => appendNoteLocked(input));
}
