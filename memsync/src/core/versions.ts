import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { stringify } from "yaml";
import { writeFileAtomic } from "./atomic.js";
import { runGit } from "./git.js";
import {
  SECTION_AI,
  SECTION_HANDOFF,
  SECTION_SUMMARY,
  formatTimestamp,
  getSectionContent,
  listArchivedJournals,
  listJournals,
  readJournalDocument,
  type SessionRecord,
} from "./journal.js";
import { repoRootFromProject } from "./project.js";
import { commitPaths, isGitRepo, pushWithRetry } from "./repo.js";
import { readProjectMeta, type VersionStatus } from "./schema.js";
import { computeState } from "./state.js";

const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";
const DERIVED_BEGIN = "<!-- memsync:derived:begin -->";
const DERIVED_END = "<!-- memsync:derived:end -->";

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const VERSION_STATUSES: readonly VersionStatus[] = ["planning", "active", "frozen"];

const VERSION_STATUS_LABELS: Record<VersionStatus, string> = {
  planning: "规划中",
  active: "开发中",
  frozen: "冻结",
};

const AI_NOTE_PATTERN = /^-\s+(\d{2}):(\d{2})\s+\[(progress|blocker)\]\s+(.*)$/;
const PENDING_NOTE_PATTERN = /^-\s+\[ \]\s+(.*)$/;
const STARTED_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})T/;
const OFFSET_PATTERN = /([+-]\d{2}:\d{2})$/;

export interface AggregateFilter {
  version?: string;
  since?: Date;
}

/**
 * One person's contribution to a version or reporting window. Every list is
 * stable: entries keep journal (chronological) order and people are sorted by
 * lowercased email.
 */
export interface AggregatedWork {
  user: string;
  email: string;
  completed: string[];
  active: string[];
  blocked: string[];
  commits: string[];
  remaining: string[];
}

export interface ReleaseOptions {
  codeRepo?: string;
  sinceTag?: string;
  toTag?: string;
}

export interface ReleaseResult {
  path: string;
  contributors: Record<string, number>;
}

interface ParsedNote {
  kind: "progress" | "blocker" | "todo";
  text: string;
  at: number;
}

interface JournalSnapshot {
  record: SessionRecord;
  body: string;
  at: number;
  notes: ParsedNote[];
}

interface WorkGroup {
  user: string;
  email: string;
  completed: string[];
  active: string[];
  blocked: string[];
  commits: string[];
  remaining: string[];
}

function requireVersion(version: string): string {
  const trimmed = typeof version === "string" ? version.trim() : "";
  if (!VERSION_PATTERN.test(trimmed)) {
    throw new Error(
      `invalid version "${String(version)}"; use a value such as 0.5.0`,
    );
  }
  return trimmed;
}

function requireStatus(status: VersionStatus): VersionStatus {
  if (!VERSION_STATUSES.includes(status)) {
    throw new Error(
      `invalid version status "${String(status)}"; expected one of ${VERSION_STATUSES.join(", ")}`,
    );
  }
  return status;
}

function identityKey(email: string): string {
  return email.trim().toLowerCase();
}

function startedDate(started: string): string {
  const match = STARTED_DATE_PATTERN.exec(started);
  if (match) return match[1];
  const parsed = new Date(started);
  return Number.isNaN(parsed.getTime())
    ? "1970-01-01"
    : parsed.toISOString().slice(0, 10);
}

function noteTime(record: SessionRecord, hours: string, minutes: string): number {
  const offset = OFFSET_PATTERN.exec(record.started.trim());
  const zone = offset !== null ? offset[1] : "";
  const parsed = Date.parse(`${startedDate(record.started)}T${hours}:${minutes}:00${zone}`);
  if (Number.isFinite(parsed)) return parsed;
  const started = Date.parse(record.started);
  return Number.isFinite(started) ? started : 0;
}

function journalTimestamp(record: SessionRecord): number {
  const ended = record.ended !== undefined ? Date.parse(record.ended) : Number.NaN;
  const started = Date.parse(record.started);
  const values = [ended, started].filter((value) => Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : 0;
}

function parseNotes(record: SessionRecord, body: string): ParsedNote[] {
  const notes: ParsedNote[] = [];

  for (const line of getSectionContent(body, SECTION_AI).split("\n")) {
    const match = AI_NOTE_PATTERN.exec(line.trim());
    if (match === null) continue;
    notes.push({
      kind: match[3] as "progress" | "blocker",
      text: match[4].trim(),
      at: noteTime(record, match[1], match[2]),
    });
  }

  for (const line of getSectionContent(body, SECTION_HANDOFF).split("\n")) {
    const match = PENDING_NOTE_PATTERN.exec(line.trim());
    if (match === null) continue;
    notes.push({
      kind: "todo",
      text: match[1].trim(),
      at: Date.parse(record.started) || 0,
    });
  }

  return notes;
}

function sessionSummary(record: SessionRecord, body: string): string {
  const summary = getSectionContent(body, SECTION_SUMMARY)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (summary !== undefined) return summary;

  switch (record.outcome) {
    case "completed":
      return "本次会话已完成";
    case "blocked":
      return "本次会话受阻";
    case "partial":
      return "本次会话部分完成";
    case "abandoned":
      return "本次会话已放弃";
    default:
      return "本次会话记录更新";
  }
}

function oneLine(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

function mmdd(date: string): string {
  return /^\d{4}-(\d{2})-(\d{2})/.test(date) ? date.slice(5) : date;
}

async function commitProjectFiles(
  projectDir: string,
  paths: string[],
  message: string,
): Promise<string | undefined> {
  const repo = repoRootFromProject(projectDir);
  if (!(await isGitRepo(repo))) return undefined;

  const relativePaths = paths.map((path) =>
    relative(repo, join(projectDir, path)).split(sep).join("/"),
  );
  return commitPaths(repo, relativePaths, `${message}\n\n${TRAILER}`);
}

async function pushBestEffort(projectDir: string): Promise<void> {
  const repo = repoRootFromProject(projectDir);
  if (!(await isGitRepo(repo))) return;
  try {
    await pushWithRetry(repo);
  } catch {
    // The release is already committed locally; push failures are retried by
    // the next sync, which probes for pending pushes.
  }
}

/** Updates `meta.yaml` atomically and commits that file when inside a repo. */
export async function setVersion(
  projectDir: string,
  version: string,
  status: VersionStatus,
): Promise<void> {
  const normalizedVersion = requireVersion(version);
  const normalizedStatus = requireStatus(status);
  const meta = await readProjectMeta(projectDir);

  const updated = {
    ...meta,
    current_version: normalizedVersion,
    version_status: normalizedStatus,
  };
  await writeFileAtomic(
    join(projectDir, "meta.yaml"),
    stringify(updated, { lineWidth: 0 }),
  );
  await commitProjectFiles(
    projectDir,
    ["meta.yaml"],
    `version: set ${normalizedVersion} (${normalizedStatus})`,
  );
}

/**
 * Reads all journals (active and archived) and aggregates work by lowercased
 * email. With a version filter only journals whose `version_hint` matches are
 * included; `since` compares against the journal's `started` timestamp. A
 * progress note is active only while its author has no later completed
 * session.
 */
export async function aggregateJournals(
  projectDir: string,
  filter: AggregateFilter,
): Promise<AggregatedWork[]> {
  const since = filter.since !== undefined ? filter.since.getTime() : Number.NaN;
  const snapshots: JournalSnapshot[] = [];
  const paths = [
    ...(await listJournals(projectDir)),
    ...(await listArchivedJournals(projectDir)),
  ].sort();

  for (const path of paths) {
    let document;
    try {
      document = await readJournalDocument(path);
    } catch {
      // One corrupt journal must not hide the rest of the project.
      continue;
    }

    const record = document.record;
    if (filter.version !== undefined && record.version_hint !== filter.version) {
      continue;
    }
    if (Number.isFinite(since)) {
      const started = Date.parse(record.started);
      if (!Number.isFinite(started) || started < since) continue;
    }

    snapshots.push({
      record,
      body: document.body,
      at: journalTimestamp(record),
      notes: parseNotes(record, document.body),
    });
  }

  const completions = snapshots
    .filter(
      (snapshot) =>
        snapshot.record.outcome === "completed" && snapshot.record.ended !== undefined,
    )
    .map((snapshot) => ({
      key: identityKey(snapshot.record.email),
      at: snapshot.at,
    }));

  const wasCompletedLater = (snapshot: JournalSnapshot, note: ParsedNote): boolean => {
    const key = identityKey(snapshot.record.email);
    return completions.some((completion) => completion.key === key && completion.at >= note.at);
  };

  const groups = new Map<string, WorkGroup>();
  const groupFor = (record: SessionRecord): WorkGroup => {
    const key = identityKey(record.email);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        user: record.user.trim(),
        email: key,
        completed: [],
        active: [],
        blocked: [],
        commits: [],
        remaining: [],
      };
      groups.set(key, group);
    }
    return group;
  };

  for (const snapshot of snapshots) {
    const group = groupFor(snapshot.record);
    if (snapshot.record.outcome === "completed") {
      group.completed.push(sessionSummary(snapshot.record, snapshot.body));
    }
    group.commits.push(...snapshot.record.commits);

    for (const note of snapshot.notes) {
      if (note.kind === "progress") {
        if (!wasCompletedLater(snapshot, note)) group.active.push(note.text);
      } else if (note.kind === "blocker") {
        group.blocked.push(note.text);
      } else {
        group.remaining.push(note.text);
      }
    }
  }

  return [...groups.values()].sort((a, b) => a.email.localeCompare(b.email));
}

async function countCodeCommits(
  codeRepo: string,
  sinceTag: string,
  toTag: string,
): Promise<Record<string, number>> {
  const repository = await runGit(["rev-parse", "--git-dir"], { cwd: codeRepo });
  if (repository.code !== 0) {
    throw new Error(`code repo ${codeRepo} is not a git repository`);
  }

  for (const tag of [sinceTag, toTag]) {
    const result = await runGit(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`], {
      cwd: codeRepo,
    });
    if (result.code !== 0) {
      throw new Error(`unknown tag "${tag}" in code repo ${codeRepo}`);
    }
  }

  const log = await runGit(["log", "--format=%ae", `${sinceTag}..${toTag}`], {
    cwd: codeRepo,
  });
  if (log.code !== 0) {
    const detail = log.stderr.trim() || log.stdout.trim() || "no output";
    throw new Error(`git log ${sinceTag}..${toTag} failed: ${detail}`);
  }

  const counts: Record<string, number> = {};
  for (const line of log.stdout.split(/\r?\n/)) {
    const email = line.trim().toLowerCase();
    if (email.length === 0) continue;
    counts[email] = (counts[email] ?? 0) + 1;
  }
  return counts;
}

function renderVersionFile(
  meta: { slug: string },
  version: string,
  work: AggregatedWork[],
  contributors: Record<string, number>,
  options: ReleaseOptions,
  now: Date,
): string {
  const lines: string[] = [`# 版本 ${version}`, ""];
  lines.push(`- 项目：${meta.slug}`);
  lines.push(`- 发布日期：${formatTimestamp(now).slice(0, 10)}`);
  if (options.sinceTag !== undefined && options.toTag !== undefined) {
    lines.push(`- 代码范围：${options.sinceTag}..${options.toTag}`);
  }

  const byEmail = new Map(work.map((person) => [person.email, person]));
  const emails = [...new Set([...byEmail.keys(), ...Object.keys(contributors)])].sort();

  lines.push("", "## 按人汇总", "", "| 用户 | 提交数 |", "|---|---|");
  if (emails.length === 0) {
    lines.push("| （无） | 0 |");
  } else {
    for (const email of emails) {
      const person = byEmail.get(email);
      const label = person !== undefined ? `${person.user} <${email}>` : email;
      lines.push(`| ${label} | ${contributors[email] ?? 0} |`);
    }
  }

  lines.push("", "## 交付明细");
  if (work.length === 0) {
    lines.push("", "（本版本没有匹配的日志记录）");
  }
  for (const person of work) {
    const commitCount = contributors[person.email] ?? person.commits.length;
    lines.push("", `### ${person.user} <${person.email}>`, "");
    lines.push(`- 提交数：${commitCount}`);

    lines.push("- 已完成：");
    if (person.completed.length === 0) lines.push("  - （无）");
    for (const item of person.completed) lines.push(`  - ${oneLine(item)}`);

    if (person.active.length > 0) {
      lines.push("- 进行中：");
      for (const item of person.active) lines.push(`  - ${oneLine(item)}`);
    }
    if (person.blocked.length > 0) {
      lines.push("- 阻塞：");
      for (const item of person.blocked) lines.push(`  - ${oneLine(item)}`);
    }

    lines.push("- 遗留未完成：");
    if (person.remaining.length === 0) lines.push("  - （无）");
    for (const item of person.remaining) lines.push(`  - ${oneLine(item)}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Builds `versions/<version>.md` from journals and (optionally) the code
 * repository's tag range, freezes the version, refreshes the state snapshot,
 * then commits and pushes best-effort. No code tag is created.
 */
export async function release(
  projectDir: string,
  version: string,
  options: ReleaseOptions = {},
): Promise<ReleaseResult> {
  const normalizedVersion = requireVersion(version);
  const meta = await readProjectMeta(projectDir);

  const hasCodeRepo = options.codeRepo !== undefined;
  const hasTags = options.sinceTag !== undefined || options.toTag !== undefined;
  if (hasCodeRepo !== hasTags || (hasCodeRepo && (options.sinceTag === undefined || options.toTag === undefined))) {
    throw new Error(
      "--code-repo, --since-tag, and --to-tag must be provided together",
    );
  }

  let codeContributors: Record<string, number> | undefined;
  if (options.codeRepo !== undefined && options.sinceTag !== undefined && options.toTag !== undefined) {
    codeContributors = await countCodeCommits(
      options.codeRepo,
      options.sinceTag,
      options.toTag,
    );
  }

  const work = await aggregateJournals(projectDir, { version: normalizedVersion });

  const contributors: Record<string, number> = {};
  if (codeContributors !== undefined) {
    // The tag range is authoritative for people it covers; a journal-only
    // contributor (work outside that code repo) still keeps their count.
    for (const person of work) {
      if (
        codeContributors[person.email] === undefined &&
        person.commits.length > 0
      ) {
        contributors[person.email] = person.commits.length;
      }
    }
    Object.assign(contributors, codeContributors);
  } else {
    for (const person of work) {
      if (person.commits.length > 0) contributors[person.email] = person.commits.length;
    }
  }

  const now = new Date();
  const path = join(projectDir, "versions", `${normalizedVersion}.md`);
  await writeFileAtomic(
    path,
    renderVersionFile(meta, normalizedVersion, work, contributors, options, now),
  );

  await writeFileAtomic(
    join(projectDir, "meta.yaml"),
    stringify({ ...meta, version_status: "frozen" }, { lineWidth: 0 }),
  );
  await refreshStateSnapshot(projectDir, now);

  await commitProjectFiles(
    projectDir,
    ["meta.yaml", `versions/${normalizedVersion}.md`, "state.md"],
    `release: ${normalizedVersion}`,
  );
  await pushBestEffort(projectDir);

  return { path, contributors };
}

function derivedBlock(
  state: Awaited<ReturnType<typeof computeState>>,
  now: Date,
): string {
  const label = VERSION_STATUS_LABELS[state.versionStatus] ?? state.versionStatus;
  const lines = [`- 当前版本：${state.version}（${label}）`];

  for (const item of state.inProgress) {
    lines.push(`- 进行中：${item.user} — ${oneLine(item.text)}（${mmdd(item.date)}）`);
  }
  for (const item of state.recentlyDone) {
    lines.push(
      `- 最近完成：${mmdd(item.date)} ${item.user} — ${oneLine(item.summary)}`,
    );
  }
  for (const item of state.blockers) {
    lines.push(
      `- 已知阻塞：${oneLine(item.text)}（${item.user}，${mmdd(item.date)}）`,
    );
  }
  lines.push(`- 最近同步：${formatTimestamp(now).slice(0, 16)}`);

  return [DERIVED_BEGIN, ...lines, DERIVED_END].join("\n");
}

function markerKind(line: string): "begin" | "end" | undefined {
  const trimmed = line.trim();
  if (trimmed === DERIVED_BEGIN) return "begin";
  if (trimmed === DERIVED_END) return "end";
  return undefined;
}

/**
 * Normalizes a state document to exactly one derived block. Markers only count
 * when they are a whole (trimmed) line. Every existing marker line and every
 * content region between a complete pair is removed; the fresh block is
 * inserted where the first complete pair started, or prepended when no
 * complete pair exists. Lone markers therefore cannot survive as duplicates,
 * and human content outside the blocks is kept.
 */
function normalizeDerivedRegion(existing: string, block: string): string {
  const lines = existing.replace(/\r\n?/g, "\n").split("\n");

  const markerLines = new Set<number>();
  const derivedLines = new Set<number>();
  const pairs: Array<{ begin: number; end: number }> = [];
  let open = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const kind = markerKind(lines[index]);
    if (kind === "begin") {
      markerLines.add(index);
      // A begin while one is already open leaves the earlier one as an
      // orphan; it is still a marker line and will be dropped.
      open = index;
    } else if (kind === "end") {
      markerLines.add(index);
      if (open !== -1) {
        pairs.push({ begin: open, end: index });
        for (let inner = open + 1; inner < index; inner += 1) {
          derivedLines.add(inner);
        }
        open = -1;
      }
    }
  }

  const first = pairs[0];
  const kept: string[] = [];
  let insertAt = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (first !== undefined && index === first.begin) insertAt = kept.length;
    if (markerLines.has(index) || derivedLines.has(index)) continue;
    kept.push(lines[index]);
  }

  const blockLines = block.split("\n");
  const following = insertAt < kept.length ? kept[insertAt] : undefined;
  const inserted =
    following !== undefined && following !== ""
      ? [...blockLines, ""]
      : blockLines;
  kept.splice(insertAt, 0, ...inserted);
  return kept.join("\n");
}

/**
 * Rewrites the derived region of `state.md` to exactly one block. Human notes
 * outside the block are preserved (line endings normalized to LF). Without a
 * complete marker pair the derived block is prepended to the existing file.
 */
export async function refreshStateSnapshot(
  projectDir: string,
  now: Date = new Date(),
): Promise<void> {
  const state = await computeState(projectDir, now);
  const block = derivedBlock(state, now);
  const path = join(projectDir, "state.md");

  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const updated = normalizeDerivedRegion(existing, block);
  await writeFileAtomic(path, updated.endsWith("\n") ? updated : `${updated}\n`);
}
