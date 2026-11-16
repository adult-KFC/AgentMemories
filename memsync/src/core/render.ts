import type { VersionStatus } from "./schema.js";
import type { ComputedState, OpenItem } from "./state.js";

const DEFAULT_BUDGET_CHARS = 12_000;
const HARD_CAP_CHARS = 24_000;
const POINTER_ALLOWANCE = 200;
const ARCHITECTURE_MAX_CHARS = 1_200;

/** Per-section caps; the global budget trims from the index section upward. */
const SECTION_MAX_CHARS = {
  conventions: 1_600,
  constraints: 5_000,
  state: 2_600,
  changes: 2_600,
  todos: 1_600,
  decisions: 1_000,
  writeback: 700,
  index: 900,
} as const;

const VERSION_STATUS_LABELS: Record<VersionStatus, string> = {
  planning: "规划中",
  active: "开发中",
  frozen: "冻结",
};

const SECTION_TITLES = {
  conventions: "团队规范（摘要）",
  constraints: "项目核心约束（必须遵守）",
  state: "当前进度",
  changes: "自你上次会话以来",
  todos: "你的未完成事项",
  decisions: "最近决策",
  writeback: "写回方式",
  index: "参考索引",
} as const;

const WRITE_BACK_LINES = [
  "- 完成一项：`memsync note progress \"...\"`",
  "- 关键决策：`memsync note decision \"...\"`",
  "- 改约束：`memsync propose constraint --title \"...\" --section \"...\" --op add --item \"...\"`",
  "- 查细节：`memsync recall \"关键词\"`",
];

export type SectionKey =
  | "identity"
  | "conventions"
  | "constraints"
  | "state"
  | "changes"
  | "todos"
  | "decisions"
  | "writeback"
  | "index";

export interface ConstraintEntry {
  text: string;
  /** Raw sub-items such as `适用：...`, `例外：...`, `状态：active`. */
  details: string[];
  status: string;
}

export interface ConstraintDoc {
  must: ConstraintEntry[];
  mustNot: ConstraintEntry[];
  architecture: string[];
  commands: string[];
}

export interface RenderProject {
  slug: string;
  name?: string;
  version: string;
  versionStatus?: VersionStatus;
}

export interface ChangeItem {
  /** `MM-DD` display date. */
  date: string;
  user: string;
  summary: string;
}

export interface AdrItem {
  title: string;
  conclusion?: string;
}

export interface RenderInput {
  project: RenderProject;
  syncedAt: string;
  budgetChars?: number;
  /** Raw `org/conventions.md` markdown. */
  orgConventions?: string;
  /** Raw `projects/<slug>/constraints.md` markdown. */
  constraints?: string;
  state: ComputedState;
  changesSinceSeen?: ChangeItem[];
  ownItems?: OpenItem[];
  recentAdrs?: AdrItem[];
  indexPaths?: string[];
}

export interface RenderOutput {
  text: string;
  sections: SectionKey[];
  truncated: boolean;
}

interface RawSection {
  key: Exclude<SectionKey, "identity">;
  lines: string[];
  keyword: string;
  capped: boolean;
}

const MUST_PATTERN = /^MUST(\s+NOT)?\b/i;

function withMustPrefix(text: string, kind: "must" | "mustNot"): string {
  const trimmed = text.trim();
  if (MUST_PATTERN.test(trimmed)) return trimmed;
  return kind === "must" ? `MUST ${trimmed}` : `MUST NOT ${trimmed}`;
}

function isSuperseded(entry: ConstraintEntry): boolean {
  return entry.status.trim().toLowerCase() === "superseded";
}

/**
 * Parses the authoritative constraint/convention markdown into MUST, MUST NOT,
 * architecture, and command sections. Indented bullets are attached to the
 * entry above them so applicability/status sub-items render with their parent.
 */
export function parseConstraintMarkdown(markdown: string): ConstraintDoc {
  const doc: ConstraintDoc = { must: [], mustNot: [], architecture: [], commands: [] };
  let section: "must" | "mustNot" | "architecture" | "commands" | undefined;
  let current: ConstraintEntry | undefined;

  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const name = heading[1];
      if (name.includes("必须")) {
        section = "must";
      } else if (name.includes("禁止")) {
        section = "mustNot";
      } else if (name.includes("架构")) {
        section = "architecture";
      } else if (name.includes("常用命令") || name.includes("命令")) {
        section = "commands";
      } else {
        section = undefined;
      }
      current = undefined;
      continue;
    }

    if (section === undefined) continue;

    const topLevel = /^-\s+(.*)$/.exec(line);
    if (topLevel !== null) {
      const text = topLevel[1].trim();
      if (text.length === 0) continue;
      if (section === "must" || section === "mustNot") {
        current = { text, details: [], status: "active" };
        (section === "must" ? doc.must : doc.mustNot).push(current);
      } else {
        doc[section].push(text);
        current = undefined;
      }
      continue;
    }

    const subItem = /^\s+-\s+(.*)$/.exec(line) ?? /^\s+(适用[:：].*|例外[:：].*|状态[:：].*)$/.exec(line);
    if (subItem !== null && current !== undefined) {
      const detail = subItem[1].trim();
      current.details.push(detail);
      const status = /^状态[:：]\s*(.*)$/.exec(detail);
      if (status !== null && status[1].trim().length > 0) {
        current.status = status[1].trim().toLowerCase();
      }
    }
  }

  return doc;
}

/** Stable pointer left wherever content was omitted from the startup pack. */
export function recallPointer(keyword: string, omitted: number): string {
  return `… 已省略 ${omitted} 条，执行 memsync recall "${keyword}"`;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

function fitLines(lines: string[], maxChars: number): string[] {
  const fitted: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (fitted.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    fitted.push(line);
    used += cost;
  }
  return fitted;
}

function capLines(
  lines: string[],
  maxChars: number,
  keyword: string,
): { lines: string[]; truncated: boolean } {
  if (lines.join("\n").length <= maxChars) return { lines, truncated: false };

  const pointer = recallPointer(keyword, lines.length);
  const contentBudget = Math.max(0, maxChars - pointer.length - 1);
  const fitted = fitLines(lines, contentBudget);
  if (fitted.length === 0) {
    return {
      lines: [truncate(lines[0], contentBudget), recallPointer(keyword, lines.length)],
      truncated: true,
    };
  }
  return {
    lines: [...fitted, recallPointer(keyword, lines.length - fitted.length)],
    truncated: true,
  };
}

function oneLine(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

function conventionLines(markdown: string | undefined): string[] {
  const doc = parseConstraintMarkdown(markdown ?? "");
  const lines: string[] = [];

  const renderEntries = (entries: ConstraintEntry[], kind: "must" | "mustNot"): void => {
    for (const entry of entries) {
      if (isSuperseded(entry)) continue;
      // Org conventions use the same 适用/例外 sub-item shape as constraints.
      lines.push(`- ${withMustPrefix(entry.text, kind)}`);
      for (const detail of entry.details) lines.push(`  - ${detail}`);
    }
  };

  renderEntries(doc.must, "must");
  renderEntries(doc.mustNot, "mustNot");
  return lines.length > 0 ? lines : ["- （未配置团队规范）"];
}

function constraintLines(markdown: string | undefined): string[] {
  const doc = parseConstraintMarkdown(markdown ?? "");
  const lines: string[] = [];

  const renderEntries = (entries: ConstraintEntry[], kind: "must" | "mustNot"): void => {
    for (const entry of entries) {
      if (isSuperseded(entry)) continue;
      lines.push(`- ${withMustPrefix(entry.text, kind)}`);
      for (const detail of entry.details) lines.push(`  - ${detail}`);
    }
  };

  renderEntries(doc.must, "must");
  renderEntries(doc.mustNot, "mustNot");

  const architecture = doc.architecture.map((item) => `- ${item}`);
  if (architecture.length > 0) {
    const fitted = fitLines(architecture, ARCHITECTURE_MAX_CHARS);
    lines.push(...fitted);
    if (fitted.length < architecture.length) {
      lines.push(recallPointer("架构", architecture.length - fitted.length));
    }
  }

  return lines.length > 0 ? lines : ["- （未配置项目约束）"];
}

function stateLines(state: ComputedState): string[] {
  const label = VERSION_STATUS_LABELS[state.versionStatus] ?? state.versionStatus;
  const lines = [`- 版本 ${state.version}（${label}）`];
  for (const item of state.inProgress) {
    lines.push(`- 进行中：${item.user} — ${oneLine(item.text)}（${item.date.slice(5)}）`);
  }
  for (const item of state.blockers) {
    lines.push(`- 阻塞：${oneLine(item.text)}（${item.user}，${item.date.slice(5)}）`);
  }
  for (const item of state.recentlyDone) {
    lines.push(
      `- 最近完成：${item.date.slice(5)} ${item.user} — ${oneLine(item.summary)}`,
    );
  }
  return lines;
}

function changeLines(changes: ChangeItem[] | undefined): string[] {
  const lines = (changes ?? [])
    .slice(0, 8)
    .map((item) =>
      truncate(
        `- ${oneLine(item.date)} ${oneLine(item.user)} ${oneLine(item.summary)}`,
        300,
      ),
    );
  return lines.length > 0 ? lines : ["- 暂无新变化"];
}

function todoLines(items: OpenItem[] | undefined): string[] {
  const lines = (items ?? [])
    .slice(0, 5)
    .map((item) =>
      truncate(`- [ ] ${oneLine(item.text)}（${item.date.slice(5)}）`, 300),
    );
  return lines.length > 0 ? lines : ["- 暂无"];
}

function decisionLines(items: AdrItem[] | undefined): string[] {
  const lines = (items ?? []).slice(0, 3).map((item) => {
    const conclusion = item.conclusion !== undefined ? oneLine(item.conclusion) : "";
    const line = conclusion.length > 0
      ? `- ${oneLine(item.title)}：${conclusion}`
      : `- ${oneLine(item.title)}`;
    return truncate(line, 300);
  });
  return lines.length > 0 ? lines : ["- 暂无"];
}

function indexLines(paths: string[] | undefined): string[] {
  const lines = (paths ?? []).map((path) => `- ${path}`);
  return lines.length > 0 ? lines : ["- （无）"];
}

function buildSections(input: RenderInput): RawSection[] {
  const sections: RawSection[] = [];
  const add = (
    key: Exclude<SectionKey, "identity">,
    lines: string[],
    keyword: string,
  ): void => {
    const capped = capLines(lines, SECTION_MAX_CHARS[key], keyword);
    sections.push({ key, lines: capped.lines, keyword, capped: capped.truncated });
  };

  add("conventions", conventionLines(input.orgConventions), "团队规范");
  add("constraints", constraintLines(input.constraints), "约束");
  add("state", stateLines(input.state), "当前进度");
  add("changes", changeLines(input.changesSinceSeen), "变化");
  add("todos", todoLines(input.ownItems), "未完成");
  add("decisions", decisionLines(input.recentAdrs), "决策");
  add("writeback", WRITE_BACK_LINES, "写回方式");
  add("index", indexLines(input.indexPaths), "索引");

  return sections;
}

function identityLine(input: RenderInput): string {
  const name =
    input.project.name !== undefined && input.project.name.trim().length > 0
      ? ` name=${input.project.name.trim()}`
      : "";
  return `[MemorySync] project=${input.project.slug}${name} version=${input.project.version} synced=${input.syncedAt}`;
}

/**
 * Renders the bounded startup context pack in the spec §9 priority order.
 * Sections are injected top-down; once one does not fit, the remaining
 * lower-priority sections are replaced by `memsync recall` pointers. The final
 * text never exceeds the budget plus the 200-character pointer allowance.
 */
export function renderContextPack(input: RenderInput): RenderOutput {
  const requested = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const budget = Math.max(1, Math.min(HARD_CAP_CHARS, Math.floor(requested)));
  // Even a pathological project name must not push the pack past the hard bound.
  const identity = truncate(identityLine(input), budget + POINTER_ALLOWANCE);

  const parts = [identity];
  const sections: SectionKey[] = ["identity"];
  let used = identity.length;
  let truncated = false;
  let stopped = false;
  const dropped: RawSection[] = [];

  for (const section of buildSections(input)) {
    if (stopped) {
      dropped.push(section);
      continue;
    }

    const header = `## ${SECTION_TITLES[section.key]}`;
    const full = [header, ...section.lines].join("\n");
    if (used + 1 + full.length <= budget) {
      parts.push(full);
      used += 1 + full.length;
      sections.push(section.key);
      if (section.capped) truncated = true;
      continue;
    }

    const pointer = recallPointer(section.keyword, section.lines.length);
    const pointerCost = 1 + pointer.length;
    const available = budget - used - 1 - header.length - 1 - pointerCost;
    const fitted = available > 0 ? fitLines(section.lines, available) : [];

    if (fitted.length > 0) {
      const text = [
        header,
        ...fitted,
        recallPointer(section.keyword, section.lines.length - fitted.length),
      ].join("\n");
      if (used + 1 + text.length <= budget + POINTER_ALLOWANCE) {
        parts.push(text);
        used += 1 + text.length;
        sections.push(section.key);
        truncated = true;
      } else {
        dropped.push(section);
      }
    } else {
      dropped.push(section);
    }

    stopped = true;
  }

  if (dropped.length > 0) truncated = true;

  for (const section of dropped) {
    const pointer = recallPointer(section.keyword, section.lines.length);
    if (used + 1 + pointer.length > budget + POINTER_ALLOWANCE) break;
    parts.push(pointer);
    used += 1 + pointer.length;
  }

  return { text: parts.join("\n"), sections, truncated };
}
