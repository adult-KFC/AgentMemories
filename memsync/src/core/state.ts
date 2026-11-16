import {
  SECTION_AI,
  SECTION_HANDOFF,
  SECTION_SUMMARY,
  getSectionContent,
  listJournals,
  readJournalDocument,
  type SessionRecord,
} from "./journal.js";
import { readProjectMeta, type VersionStatus } from "./schema.js";

const DEFAULT_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** A `progress` note whose author has no later completed session. */
export interface ProgressItem {
  user: string;
  email: string;
  /** `YYYY-MM-DD` of the journal that recorded the note. */
  date: string;
  text: string;
  sessionId: string;
}

export interface BlockerItem {
  user: string;
  email: string;
  date: string;
  text: string;
  sessionId: string;
}

export interface DoneItem {
  user: string;
  email: string;
  date: string;
  summary: string;
  sessionId: string;
}

export interface OpenItem {
  kind: "todo" | "handoff";
  text: string;
  date: string;
  user: string;
  email: string;
  sessionId: string;
}

/**
 * Current project state derived from journals and `meta.yaml`. The shape is
 * deterministic: every list is sorted newest first with text/id tie-breakers.
 */
export interface ComputedState {
  version: string;
  versionStatus: VersionStatus;
  inProgress: ProgressItem[];
  blockers: BlockerItem[];
  recentlyDone: DoneItem[];
  openItems: OpenItem[];
}

interface NoteEvent {
  kind: "progress" | "blocker" | "todo" | "handoff";
  text: string;
  at: number;
  date: string;
  user: string;
  email: string;
  sessionId: string;
}

interface CompletionEvent {
  key: string;
  at: number;
}

interface JournalSnapshot {
  record: SessionRecord;
  body: string;
  at: number;
  notes: NoteEvent[];
}

const AI_NOTE_PATTERN = /^-\s+(\d{2}):(\d{2})\s+\[(progress|blocker)\]\s+(.*)$/;
// Only unchecked items are unfinished; `[x]`/`[X]` lines are done.
const PENDING_NOTE_PATTERN = /^-\s+\[ \]\s+(.*)$/;
const STARTED_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})T/;
const OFFSET_PATTERN = /([+-]\d{2}:\d{2})$/;

function identityKey(record: Pick<SessionRecord, "email" | "user">): string {
  const email = record.email.trim().toLowerCase();
  return email.length > 0 ? email : record.user.trim().toLowerCase();
}

function startedDate(started: string): string {
  const match = STARTED_DATE_PATTERN.exec(started);
  if (match) return match[1];
  const parsed = new Date(started);
  return Number.isNaN(parsed.getTime())
    ? "1970-01-01"
    : parsed.toISOString().slice(0, 10);
}

/**
 * Combines the journal date with a note's `HH:MM` and the journal's UTC offset,
 * so notes compare correctly against `ended` timestamps from other hosts.
 */
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

/** First non-empty line of `## 工作摘要`, else a deterministic outcome label. */
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

function parseNotes(record: SessionRecord, body: string): NoteEvent[] {
  const notes: NoteEvent[] = [];
  const base = {
    user: record.user,
    email: record.email,
    sessionId: record.session,
  };

  for (const line of getSectionContent(body, SECTION_AI).split("\n")) {
    const match = AI_NOTE_PATTERN.exec(line.trim());
    if (match === null) continue;
    notes.push({
      kind: match[3] as "progress" | "blocker",
      text: match[4].trim(),
      at: noteTime(record, match[1], match[2]),
      date: startedDate(record.started),
      ...base,
    });
  }

  for (const line of getSectionContent(body, SECTION_HANDOFF).split("\n")) {
    const match = PENDING_NOTE_PATTERN.exec(line.trim());
    if (match === null) continue;
    notes.push({
      kind: "todo",
      text: match[1].trim(),
      at: Date.parse(record.started) || 0,
      date: startedDate(record.started),
      ...base,
    });
  }

  return notes;
}

function compareNewestFirst(
  a: { at: number; user: string; text?: string; sessionId: string },
  b: { at: number; user: string; text?: string; sessionId: string },
): number {
  if (a.at !== b.at) return b.at - a.at;
  const byUser = a.user.localeCompare(b.user);
  if (byUser !== 0) return byUser;
  const byText = (a.text ?? "").localeCompare(b.text ?? "");
  if (byText !== 0) return byText;
  return a.sessionId.localeCompare(b.sessionId);
}

/**
 * Reads the last `windowDays` of journals and derives the current state.
 * A progress note stays "in progress" only while its author has no later
 * session that ended with `outcome: completed`. Version data comes from meta.
 */
export async function computeState(
  projectDir: string,
  now: Date,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<ComputedState> {
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : DEFAULT_WINDOW_DAYS;
  const cutoff = now.getTime() - days * DAY_MS;

  const meta = await readProjectMeta(projectDir);
  const snapshots: JournalSnapshot[] = [];

  for (const path of await listJournals(projectDir)) {
    let document;
    try {
      document = await readJournalDocument(path);
    } catch {
      // One corrupt journal must not hide the rest of the project state.
      continue;
    }
    const at = journalTimestamp(document.record);
    if (at < cutoff) continue;
    snapshots.push({
      record: document.record,
      body: document.body,
      at,
      notes: parseNotes(document.record, document.body),
    });
  }

  const completions: CompletionEvent[] = snapshots
    .filter(
      (snapshot) =>
        snapshot.record.ended !== undefined && snapshot.record.outcome === "completed",
    )
    .map((snapshot) => {
      const parsed = Date.parse(snapshot.record.ended as string);
      return {
        key: identityKey(snapshot.record),
        at: Number.isFinite(parsed) ? parsed : snapshot.at,
      };
    });

  const wasCompletedLater = (note: NoteEvent): boolean =>
    completions.some(
      (completion) =>
        completion.key === identityKey(note) && completion.at >= note.at,
    );

  const progress: Array<ProgressItem & { at: number }> = [];
  const blockers: Array<BlockerItem & { at: number }> = [];
  const openItems: Array<OpenItem & { at: number }> = [];

  for (const snapshot of snapshots) {
    for (const note of snapshot.notes) {
      const base = {
        user: note.user,
        email: note.email,
        date: note.date,
        text: note.text,
        sessionId: note.sessionId,
        at: note.at,
      };
      if (note.kind === "progress") {
        if (!wasCompletedLater(note)) progress.push({ ...base });
      } else if (note.kind === "blocker") {
        blockers.push({ ...base });
      } else if (note.kind === "todo" || note.kind === "handoff") {
        openItems.push({ ...base, kind: note.kind });
      }
    }
  }

  const recentlyDone: Array<DoneItem & { at: number }> = snapshots
    .filter(
      (snapshot) =>
        snapshot.record.ended !== undefined && snapshot.record.outcome === "completed",
    )
    .map((snapshot) => {
      const parsed = Date.parse(snapshot.record.ended as string);
      return {
        user: snapshot.record.user,
        email: snapshot.record.email,
        date: startedDate(snapshot.record.ended as string),
        summary: sessionSummary(snapshot.record, snapshot.body),
        sessionId: snapshot.record.session,
        at: Number.isFinite(parsed) ? parsed : snapshot.at,
      };
    });

  const strip = <T extends { at: number }>(item: T): Omit<T, "at"> => {
    const { at: _at, ...rest } = item;
    return rest;
  };

  return {
    version: meta.current_version,
    versionStatus: meta.version_status,
    inProgress: progress.sort(compareNewestFirst).map(strip),
    blockers: blockers.sort(compareNewestFirst).map(strip),
    recentlyDone: recentlyDone.sort(compareNewestFirst).map(strip),
    openItems: openItems.sort(compareNewestFirst).map(strip),
  };
}
