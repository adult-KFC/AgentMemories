import { lstat, mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { listJournals, readJournalDocument, type SessionRecord } from "./journal.js";

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const INDEX_NAME = "index.md";

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function recursiveFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await recursiveFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function journalTimestamp(record: SessionRecord): number | undefined {
  for (const value of [record.ended, record.started]) {
    if (value === undefined) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

async function fileTimestamp(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

function archivedDate(record: SessionRecord | undefined, fallback: string): string {
  const value = record?.ended ?? record?.started;
  if (value !== undefined && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return fallback;
}

/** Metadata needed to rebuild one archived month's index. */
interface IndexEntry {
  session: string;
  user: string;
  date: string;
  path: string;
}

async function indexEntriesFor(monthDir: string, projectDir: string): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = [];
  for (const file of await recursiveFiles(monthDir)) {
    if (!isJournalFile(file)) continue;

    let session = "";
    let user = "unknown";
    let date = "";
    try {
      const { record } = await readJournalDocument(file);
      session = record.session;
      user = record.user;
      date = archivedDate(record, "");
    } catch {
      // A malformed archived journal is still listed; its filename is the id.
      session = file.slice(file.lastIndexOf(sep) + 1).replace(/\.md$/i, "");
    }
    if (date.length === 0) {
      const match = /(\d{4}-\d{2}-\d{2})/.exec(toPosix(relative(projectDir, file)));
      date = match?.[1] ?? "unknown";
    }

    entries.push({
      session: session.length > 0 ? session : "unknown",
      user,
      date,
      path: toPosix(relative(projectDir, file)),
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function renderIndex(month: string, entries: IndexEntry[]): string {
  const lines = [`# 归档日志 ${month}`, ""];
  for (const entry of entries) {
    lines.push(
      `- session: ${entry.session} | user: ${entry.user} | date: ${entry.date} | path: ${entry.path}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function isIndexFile(path: string): boolean {
  return path.endsWith(`${sep}${INDEX_NAME}`) || path.endsWith(`/${INDEX_NAME}`);
}

function isJournalFile(path: string): boolean {
  return path.endsWith(".md") && !isIndexFile(path);
}

/** Existing `archive/YYYY-MM` directories, sorted. */
async function archiveMonths(projectDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(projectDir, "archive"), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory() && MONTH_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function destinationExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Any other failure is uncertainty: keep the source in place.
    return true;
  }
}

export interface CompactedJournal {
  from: string;
  to: string;
}

export interface CompactResult {
  count: number;
  moved: CompactedJournal[];
  /** Absolute paths of every archive month index written. */
  indexes: string[];
}

/**
 * Moves journals started before `before` from `journal/YYYY-MM/**` to
 * `archive/YYYY-MM/`, preserving the relative path, then rebuilds an index per
 * touched month. Content is only ever moved, never deleted: a file whose date
 * cannot be parsed, or whose destination already exists, is left in place.
 */
export async function compactJournalsDetailed(
  projectDir: string,
  before: Date,
): Promise<CompactResult> {
  const journalRoot = join(projectDir, "journal");
  const cutoff = before.getTime();
  if (!Number.isFinite(cutoff)) return { count: 0, moved: [], indexes: [] };

  const moved: CompactedJournal[] = [];

  for (const path of await listJournals(projectDir)) {
    const relativePath = toPosix(relative(journalRoot, path));
    const [month] = relativePath.split("/");
    if (month === undefined || !MONTH_PATTERN.test(month)) continue;

    let timestamp: number | undefined;
    try {
      const { record } = await readJournalDocument(path);
      timestamp = journalTimestamp(record);
    } catch {
      // Unreadable front matter is uncertain; fall back to the file mtime.
    }
    timestamp ??= await fileTimestamp(path);
    if (timestamp === undefined || timestamp >= cutoff) continue;

    const destination = join(projectDir, "archive", ...relativePath.split("/"));
    if (await destinationExists(destination)) {
      // Never overwrite or delete: an existing archive entry wins.
      continue;
    }

    try {
      await mkdir(dirname(destination), { recursive: true });
      await rename(path, destination);
    } catch {
      // Never overwrite or delete: leave the source where it is.
      continue;
    }

    moved.push({ from: path, to: destination });
  }

  // Rebuild every month that has archived journals, not just the months
  // touched now, so an index that failed to write is repaired on the next run.
  const indexes: string[] = [];
  for (const month of await archiveMonths(projectDir)) {
    const monthDir = join(projectDir, "archive", month);
    const files = await recursiveFiles(monthDir);
    if (!files.some(isJournalFile)) continue;

    const entries = await indexEntriesFor(monthDir, projectDir);
    const indexPath = join(monthDir, INDEX_NAME);
    await writeFileAtomic(indexPath, renderIndex(month, entries));
    indexes.push(indexPath);
  }

  return { count: moved.length, moved, indexes };
}

/** Compacts old journals and returns how many files were archived. */
export async function compactJournals(projectDir: string, before: Date): Promise<number> {
  return (await compactJournalsDetailed(projectDir, before)).count;
}
