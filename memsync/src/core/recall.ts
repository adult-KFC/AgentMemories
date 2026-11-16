import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseFrontMatter } from "./schema.js";

export type RecallType =
  | "constraint"
  | "decision"
  | "journal"
  | "version"
  | "proposal"
  | "archive";

export interface RecallHit {
  path: string;
  type: RecallType;
  snippet: string;
  score: number;
  date?: string;
}

export interface RecallOptions {
  limit?: number;
  maxChars?: number;
  totalChars?: number;
  all?: boolean;
}

const WEIGHTS: Record<RecallType, number> = {
  constraint: 3,
  decision: 2,
  version: 2,
  proposal: 1,
  journal: 1,
  archive: 1,
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const DEFAULT_MAX_CHARS = 800;
const DEFAULT_TOTAL_CHARS = 4_000;
const CONTEXT_RADIUS = 400;
const RECENCY_WEIGHT = 1;
const RECENCY_WINDOW_MS = 365 * 24 * 60 * 60 * 1_000;

/** A file discovered under the project and the category it belongs to. */
interface Candidate {
  absolutePath: string;
  relativePath: string;
  type: RecallType;
}

interface ScoredHit extends RecallHit {
  dateMs: number;
}

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function collectMarkdown(
  directory: string,
  type: RecallType,
  projectDir: string,
  files: Candidate[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return;
    throw err;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdown(absolutePath, type, projectDir, files);
    } else if (entry.isFile() && isMarkdown(entry.name)) {
      files.push({
        absolutePath,
        relativePath: toPosixPath(relative(projectDir, absolutePath)),
        type,
      });
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/** Discovers every searchable Markdown file in deterministic order. */
async function collectCandidates(projectDir: string): Promise<Candidate[]> {
  const files: Candidate[] = [];

  const constraints = join(projectDir, "constraints.md");
  if (await fileExists(constraints)) {
    files.push({
      absolutePath: constraints,
      relativePath: "constraints.md",
      type: "constraint",
    });
  }

  // Team-wide conventions live beside `projects/`, not inside the project,
  // but they are authoritative memory and must be recallable.
  const orgConventions = join(dirname(dirname(projectDir)), "org", "conventions.md");
  if (await fileExists(orgConventions)) {
    files.push({
      absolutePath: orgConventions,
      relativePath: "org/conventions.md",
      type: "constraint",
    });
  }

  await collectMarkdown(join(projectDir, "decisions"), "decision", projectDir, files);
  await collectMarkdown(join(projectDir, "versions"), "version", projectDir, files);
  await collectMarkdown(join(projectDir, "proposals"), "proposal", projectDir, files);
  await collectMarkdown(join(projectDir, "journal"), "journal", projectDir, files);
  await collectMarkdown(join(projectDir, "archive"), "archive", projectDir, files);

  return files;
}

/** Splits a document into front matter and body; malformed headers degrade to body-only. */
function splitDocument(raw: string): { data: Record<string, unknown>; body: string } {
  try {
    const { data, body } = parseFrontMatter<Record<string, unknown>>(raw);
    return { data, body };
  } catch {
    const normalized = raw.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
    return { data: {}, body: normalized };
  }
}

function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/u).filter((token) => token.length > 0))];
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    count += 1;
    from = index + needle.length;
  }
  return count;
}

function isAsciiWord(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/u.test(character);
}

/** Moves a start offset forward when it would split an ASCII word. */
function trimStart(text: string, start: number): number {
  if (start <= 0) return 0;
  if (!isAsciiWord(text[start - 1]) || !isAsciiWord(text[start])) return start;
  let index = start;
  while (index < text.length && isAsciiWord(text[index])) index += 1;
  return index;
}

/** Moves an end offset backward when it would split an ASCII word. */
function trimEnd(text: string, end: number): number {
  if (end >= text.length) return text.length;
  let index = end;
  if (!isAsciiWord(text[index - 1]) || !isAsciiWord(text[index])) return index;
  while (index > 0 && isAsciiWord(text[index - 1])) index -= 1;
  return index;
}

function firstMatch(
  body: string,
  tokens: string[],
): { index: number; length: number } | undefined {
  const lower = body.toLowerCase();
  let best: { index: number; length: number } | undefined;
  for (const token of tokens) {
    const index = lower.indexOf(token);
    if (index === -1) continue;
    if (best === undefined || index < best.index) best = { index, length: token.length };
  }
  return best;
}

/** Builds a bounded (or, with all, unbounded) snippet around the first content match. */
function buildSnippet(body: string, tokens: string[], all: boolean): string {
  if (all) return body;

  const match = firstMatch(body, tokens);
  if (match === undefined) {
    // Filename-only match: show the head of the body.
    return body.slice(0, Math.min(DEFAULT_MAX_CHARS, body.length));
  }

  const start = trimStart(body, Math.max(0, match.index - CONTEXT_RADIUS));
  const end = trimEnd(
    body,
    Math.min(body.length, match.index + CONTEXT_RADIUS + match.length),
  );
  const safeEnd = Math.max(start, end);
  return body.slice(start, Math.min(body.length, safeEnd));
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = trimEnd(text, maxChars);
  if (end <= 0) end = maxChars;
  // Never leave a dangling high surrogate from an emoji or astral character.
  const code = text.charCodeAt(end - 1);
  if (end > 0 && end < text.length && code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

function frontMatterDate(data: Record<string, unknown>): Date | undefined {
  for (const key of ["started", "created"]) {
    const value = data[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function positiveOption(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

/**
 * Searches a project's memory files for the query terms and returns ranked,
 * bounded hits. Scoring is deterministic: occurrence count × type weight plus
 * a relative recency boost for journals and archives, with path as tie-break.
 *
 * Scoring and snippet extraction read only the Markdown body; filenames
 * contribute to the score so renamed or title-like files remain findable.
 */
export async function recall(
  projectDir: string,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallHit[]> {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  const candidates = await collectCandidates(projectDir);
  const scored: ScoredHit[] = [];

  for (const candidate of candidates) {
    let raw: string;
    let fileStat;
    try {
      [raw, fileStat] = await Promise.all([
        readFile(candidate.absolutePath, "utf8"),
        stat(candidate.absolutePath),
      ]);
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }

    const { data, body } = splitDocument(raw);
    const lowerBody = body.toLowerCase();
    const lowerName = basename(candidate.relativePath).toLowerCase();

    let occurrences = 0;
    for (const token of tokens) {
      occurrences += countOccurrences(lowerBody, token);
      occurrences += countOccurrences(lowerName, token);
    }
    if (occurrences === 0) continue;

    const weight = WEIGHTS[candidate.type];
    const parsedDate = frontMatterDate(data);
    const dateMs = parsedDate?.getTime() ?? fileStat.mtime.getTime();

    scored.push({
      path: candidate.relativePath,
      type: candidate.type,
      snippet: buildSnippet(body, tokens, opts.all === true),
      score: occurrences * weight,
      date: new Date(dateMs).toISOString(),
      dateMs,
    });
  }

  const recentMs = scored
    .filter((hit) => hit.type === "journal" || hit.type === "archive")
    .reduce((newest, hit) => Math.max(newest, hit.dateMs), 0);
  if (recentMs > 0) {
    for (const hit of scored) {
      if (hit.type !== "journal" && hit.type !== "archive") continue;
      const age = Math.max(0, recentMs - hit.dateMs);
      const boost = RECENCY_WEIGHT * Math.max(0, 1 - age / RECENCY_WINDOW_MS);
      hit.score += boost;
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const limit = clampLimit(opts.limit);
  const all = opts.all === true;
  const maxChars = positiveOption(opts.maxChars, DEFAULT_MAX_CHARS);
  const totalChars = positiveOption(opts.totalChars, DEFAULT_TOTAL_CHARS);

  const hits: RecallHit[] = [];
  let used = 0;
  for (const hit of scored.slice(0, limit)) {
    let snippet = all ? hit.snippet : truncate(hit.snippet, maxChars);
    if (!all) {
      const remaining = totalChars - used;
      if (remaining <= 0) break;
      if (snippet.length > remaining) snippet = truncate(snippet, remaining);
      used += snippet.length;
    }
    hits.push({
      path: hit.path,
      type: hit.type,
      snippet,
      score: Math.round(hit.score * 1_000) / 1_000,
      date: hit.date,
    });
  }

  return hits;
}
