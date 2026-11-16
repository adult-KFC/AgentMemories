import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic.js";

/** One authoritative constraint with optional applicability and lifecycle metadata. */
export interface ConstraintItem {
  text: string;
  appliesWhen?: string;
  doNotApplyWhen?: string;
  status?: "active" | "superseded";
}

export type ConstraintOp = "add" | "replace" | "remove" | "supersede";

/**
 * Structured, deterministic change to one section of a constraint file.
 * `section_hash` pins the section content the proposal was based on; `match`
 * identifies the single existing top-level item for replace/remove/supersede.
 */
export interface ConstraintChange {
  file: string;
  section: string;
  op: ConstraintOp;
  section_hash: string;
  match?: string;
  items: (string | ConstraintItem)[];
}

interface SectionRange {
  headingIndex: number;
  start: number;
  end: number;
}

interface ItemRange {
  start: number;
  end: number;
  text: string;
}

const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const TOP_LEVEL_ITEM = /^-\s+(.*)$/;
const SUB_BULLET = /^\s+-\s+/;

/** Normalizes line endings and strips content-free differences before hashing. */
export function normalizeSectionText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/** First 12 hex characters of sha256 over the normalized section text. */
export function sectionHash(sectionText: string): string {
  return createHash("sha256")
    .update(normalizeSectionText(sectionText), "utf8")
    .digest("hex")
    .slice(0, 12);
}

/**
 * Splits a constraint document into `## <section>` bodies. Rendering metadata
 * such as the title and comments stays outside every section.
 */
export function parseConstraintSections(text: string): Map<string, string> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const heading = SECTION_HEADING.exec(lines[index]);
    if (!heading) continue;

    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (SECTION_HEADING.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    sections.set(heading[1], lines.slice(index + 1, end).join("\n"));
    index = end - 1;
  }

  return sections;
}

function findSection(lines: string[], name: string): SectionRange | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const heading = SECTION_HEADING.exec(lines[index]);
    if (heading?.[1] !== name) continue;

    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (SECTION_HEADING.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    return { headingIndex: index, start: index + 1, end };
  }
  return undefined;
}

function findItems(body: string[]): ItemRange[] {
  const items: ItemRange[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const match = TOP_LEVEL_ITEM.exec(body[index]);
    if (!match) continue;

    let end = index + 1;
    while (
      end < body.length &&
      body[end].trim().length > 0 &&
      SUB_BULLET.test(body[end])
    ) {
      end += 1;
    }
    items.push({ start: index, end, text: match[1].trim() });
  }
  return items;
}

function singleLine(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} must be a single line`);
  }
  return value.trim();
}

function renderItem(item: string | ConstraintItem): string[] {
  if (typeof item === "string") return [`- ${singleLine(item, "constraint item")}`];

  if (typeof item !== "object" || item === null) {
    throw new Error("constraint item must be a string or an object");
  }

  const lines = [`- ${singleLine(item.text, "constraint item text")}`];
  if (item.appliesWhen !== undefined) {
    lines.push(`  - 适用：${singleLine(item.appliesWhen, "appliesWhen")}`);
  }
  if (item.doNotApplyWhen !== undefined) {
    lines.push(`  - 例外：${singleLine(item.doNotApplyWhen, "doNotApplyWhen")}`);
  }
  if (item.status !== undefined) {
    if (item.status !== "active" && item.status !== "superseded") {
      throw new Error('constraint item status must be "active" or "superseded"');
    }
    lines.push(`  - 状态：${item.status}`);
  }
  return lines;
}

function renderItems(items: (string | ConstraintItem)[]): string[] {
  return items.flatMap(renderItem);
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim().length === 0) start += 1;
  while (end > start && lines[end - 1].trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

/**
 * Renders the updated section body. Existing content is kept verbatim (minus
 * outer blank lines) and a blank line separates it from the next heading.
 */
function renderSection(body: string[], items: string[][]): string[] {
  const blocks: string[][] = [];
  const existing = trimBlankEdges(body);
  if (existing.length > 0) blocks.push(existing);
  blocks.push(...items);

  const rendered: string[] = [];
  for (const block of blocks) {
    if (rendered.length > 0) rendered.push("");
    rendered.push(...block);
  }
  rendered.push("");

  // Keep a single blank line between items; removing an item must not leave
  // a growing run of blank lines behind.
  return rendered.filter(
    (line, index) => line.trim().length > 0 || index === rendered.length - 1 || rendered[index - 1]?.trim().length !== 0,
  );
}

function itemBlock(lines: string[]): string[] {
  return trimBlankEdges(lines);
}

/**
 * Applies a structured change in memory and returns the full updated document.
 * Every validation happens before the caller writes, so failures never leave a
 * partially modified file.
 */
export async function planConstraintChange(
  constraintsPath: string,
  change: ConstraintChange,
): Promise<string> {
  const original = await readFile(constraintsPath, "utf8");
  const normalized = original.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const section = findSection(lines, change.section);
  if (!section) {
    throw new Error(`constraint section "${change.section}" not found in ${constraintsPath}`);
  }

  const body = lines.slice(section.start, section.end);
  const actualHash = sectionHash(body.join("\n"));
  if (actualHash !== change.section_hash) {
    throw new Error(
      `section hash mismatch for "${change.section}": expected ${change.section_hash}, ` +
        `found ${actualHash}; the proposal is stale, re-create it from current content`,
    );
  }

  const items = Array.isArray(change.items) ? change.items : [];
  let replacement: string[];
  let newBody: string[];

  switch (change.op) {
    case "add": {
      if (items.length === 0) throw new Error("add requires at least one item");
      newBody = renderSection(body, [renderItems(items)]);
      break;
    }
    case "replace":
    case "remove":
    case "supersede": {
      const rawMatch = change.match?.trim();
      // Accept both the bare item text and the rendered "- text" form.
      const match = rawMatch?.startsWith("- ")
        ? rawMatch.slice(2).trim()
        : rawMatch;
      if (match === undefined || match.length === 0) {
        throw new Error(`op "${change.op}" requires a match`);
      }
      const matches = findItems(body).filter((item) => item.text === match);
      if (matches.length !== 1) {
        throw new Error(
          `match "${match}" must identify exactly one top-level item in ` +
            `section "${change.section}" (found ${matches.length})`,
        );
      }

      const [target] = matches;
      if (change.op === "remove") {
        replacement = [...body.slice(0, target.start), ...body.slice(target.end)];
        newBody = renderSection(replacement, []);
      } else if (change.op === "replace") {
        if (items.length === 0) throw new Error("replace requires at least one item");
        replacement = [
          ...body.slice(0, target.start),
          ...renderItems(items),
          ...body.slice(target.end),
        ];
        newBody = renderSection(replacement, []);
      } else {
        if (items.length === 0) throw new Error("supersede requires at least one new item");
        const block = body.slice(target.start, target.end);
        const marked = markSuperseded(block);
        replacement = [...body.slice(0, target.start), ...marked, ...body.slice(target.end)];
        newBody = renderSection(replacement, [renderItems(items)]);
      }
      break;
    }
    default:
      throw new Error(`unsupported constraint op "${String(change.op)}"`);
  }

  const updated = [
    ...lines.slice(0, section.start),
    ...newBody,
    ...lines.slice(section.end),
  ].join("\n");

  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

function markSuperseded(block: string[]): string[] {
  const lines = itemBlock(block);
  const statusIndex = lines.findIndex((line) => /^\s+-\s+状态：/.test(line));
  if (statusIndex === -1) return [...lines, "  - 状态：superseded"];
  return lines.map((line, index) =>
    index === statusIndex ? "  - 状态：superseded" : line,
  );
}

/**
 * Validates and atomically applies a change. `proposalId` and `approver` are
 * accepted so callers share one audit-oriented signature.
 */
export async function applyConstraintChange(
  constraintsPath: string,
  change: ConstraintChange,
  _proposalId: string,
  _approver: string,
): Promise<void> {
  const updated = await planConstraintChange(constraintsPath, change);
  await writeFileAtomic(constraintsPath, updated);
}
