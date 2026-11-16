import { randomBytes } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Identity } from "../types.js";
import { writeFileAtomic } from "./atomic.js";
import {
  applyConstraintChange,
  parseConstraintSections,
  sectionHash,
  type ConstraintChange,
} from "./constraints.js";
import { runGit } from "./git.js";
import { repoRootFromProject } from "./project.js";
import { redactSecrets } from "./redact.js";
import { commitPaths, pushWithRetry } from "./repo.js";
import {
  parseFrontMatter,
  readProjectMeta,
  serializeFrontMatter,
  SchemaError,
} from "./schema.js";

const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";
const APPROVAL_HEADING = "批准记录";
const CHANGE_HEADING = "变更";

export type ProposalKind = "constraint" | "decision";
export type ProposalStatus = "proposed" | "approved" | "rejected" | "superseded";

export interface CreateProposalInput {
  kind: ProposalKind;
  title: string;
  rationale: string;
  change?: ConstraintChange;
  author: string;
  tool: string;
  host: string;
  now?: Date;
}

export interface CreatedProposal {
  id: string;
  path: string;
}

export interface ApproveProposalOptions {
  force?: boolean;
  repoPath?: string;
}

export interface ApproveProposalResult {
  applied: boolean;
  reason?: string;
}

interface ProposalFrontMatter {
  id: string;
  kind: ProposalKind;
  title: string;
  project: string;
  author: string;
  tool: string;
  host: string;
  status: ProposalStatus | string;
  created: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function singleLine(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} is required`);
  if (/[\r\n]/.test(trimmed)) throw new Error(`${label} must be a single line`);
  return trimmed;
}

function redact(text: string): string {
  return redactSecrets(text).text;
}

function redactChange(change: ConstraintChange): ConstraintChange {
  return {
    ...change,
    items: change.items.map((item) => {
      if (typeof item === "string") return redact(item);
      return {
        ...item,
        text: redact(item.text),
        ...(item.appliesWhen !== undefined ? { appliesWhen: redact(item.appliesWhen) } : {}),
        ...(item.doNotApplyWhen !== undefined
          ? { doNotApplyWhen: redact(item.doNotApplyWhen) }
          : {}),
      };
    }),
  };
}

/** Resolves the constraint file a change targets, rejecting anything outside the memory layout. */
function targetPathFor(repoRoot: string, projectDir: string, file: string): string {
  if (file === "constraints.md") return join(projectDir, "constraints.md");
  if (file === "org/conventions.md") return join(repoRoot, "org", "conventions.md");
  throw new Error(
    `unsupported constraint file "${file}"; expected constraints.md or org/conventions.md`,
  );
}

async function hashForFile(path: string, section: string): Promise<string> {
  const text = await readFile(path, "utf8");
  const body = parseConstraintSections(text).get(section);
  if (body === undefined) {
    throw new Error(`constraint section "${section}" not found in ${path}`);
  }
  return sectionHash(body);
}

function proposalBody(input: CreateProposalInput, change?: ConstraintChange): string {
  const parts: string[] = [
    "## 提案内容",
    "",
    redact(input.title.trim()),
  ];

  if (input.kind === "constraint" && change !== undefined) {
    parts.push(
      "",
      `## ${CHANGE_HEADING}`,
      "",
      "```yaml",
      stringifyYaml({ change }, { lineWidth: 0 }).trimEnd(),
      "```",
    );
  }

  parts.push(
    "",
    "## 理由",
    "",
    redact(input.rationale.trim()) || "（未提供）",
    "",
    "## 影响面",
    "",
    "（待补充）",
    "",
    `## ${APPROVAL_HEADING}`,
    "",
    "（待批准）",
  );

  return `${parts.join("\n")}\n`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function repoRelative(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).replace(/\\/g, "/");
}

/**
 * Creates a proposal file, commits it with the standard trailer, and pushes
 * best-effort. A supplied `section_hash` is preserved so callers can model a
 * stale proposal; an empty one is computed from the current constraints file.
 */
export async function createProposal(
  projectDir: string,
  input: CreateProposalInput,
): Promise<CreatedProposal> {
  const meta = await readProjectMeta(projectDir);
  const now = input.now ?? new Date();
  const repoRoot = repoRootFromProject(projectDir);
  const title = singleLine(input.title, "title");
  const author = singleLine(input.author, "author");
  const tool = singleLine(input.tool, "tool");
  const host = singleLine(input.host, "host");

  let change = input.change;
  if (input.kind === "constraint") {
    if (change === undefined) {
      throw new Error("constraint proposals require a change");
    }
    const target = targetPathFor(repoRoot, projectDir, change.file);
    const sectionHashValue = change.section_hash?.trim() ?? "";
    change = {
      ...redactChange(change),
      section_hash:
        sectionHashValue.length > 0
          ? sectionHashValue
          : await hashForFile(target, change.section),
    };
  } else if (change !== undefined) {
    throw new Error("decision proposals do not carry a structured change");
  }

  const date = now.toISOString().slice(0, 10);
  const proposalDir = join(projectDir, "proposals");
  let id = "";
  let path = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    id = `${date}-${randomBytes(4).toString("hex")}`;
    path = join(proposalDir, `${id}.md`);
    if (!(await fileExists(path))) break;
    path = "";
  }
  if (path.length === 0) {
    throw new Error("could not allocate a unique proposal id");
  }

  const frontMatter: ProposalFrontMatter = {
    id,
    kind: input.kind,
    title: redact(title),
    project: meta.slug,
    author,
    tool,
    host,
    status: "proposed",
    created: now.toISOString(),
  };

  const document = serializeFrontMatter(frontMatter, proposalBody(input, change));
  await writeFileAtomic(path, document);
  await commitPaths(repoRoot, [repoRelative(repoRoot, path)], `docs: add proposal ${id}\n\n${TRAILER}`);
  await pushWithRetry(repoRoot);

  return { id, path };
}

function isSafeProposalId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function extractChange(body: string): ConstraintChange {
  const section = parseConstraintSections(body).get(CHANGE_HEADING);
  if (section === undefined) {
    throw new Error("proposal is missing the 变更 section");
  }

  const fence = /```yaml\s*\n([\s\S]*?)```/.exec(section);
  if (!fence) throw new Error("proposal 变更 section has no fenced yaml block");

  let parsed: unknown;
  try {
    parsed = parseYaml(fence[1]);
  } catch (err) {
    throw new Error(`invalid yaml in proposal change block: ${errorMessage(err)}`, { cause: err });
  }

  const change = (parsed as { change?: unknown } | null)?.change;
  if (typeof change !== "object" || change === null || Array.isArray(change)) {
    throw new Error("proposal change block must contain a change mapping");
  }

  const candidate = change as Record<string, unknown>;
  if (typeof candidate.file !== "string" || typeof candidate.section !== "string") {
    throw new Error("proposal change block is missing file or section");
  }
  if (typeof candidate.op !== "string") {
    throw new Error("proposal change block is missing op");
  }
  if (typeof candidate.section_hash !== "string") {
    throw new Error("proposal change block is missing section_hash");
  }
  if (!Array.isArray(candidate.items)) {
    throw new Error("proposal change block is missing items");
  }

  return change as ConstraintChange;
}

async function readGovernanceOwners(repoRoot: string): Promise<string[]> {
  const path = join(repoRoot, "org", "governance.yaml");
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new SchemaError(`Invalid YAML in ${path}`, { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SchemaError(`${path} must be a YAML mapping`);
  }
  const owners = (parsed as Record<string, unknown>).owners;
  if (owners === undefined) return [];
  if (!Array.isArray(owners) || owners.some((owner) => typeof owner !== "string")) {
    throw new SchemaError(`${path} "owners" must be an array of emails`);
  }
  return owners.map((owner) => (owner as string).trim()).filter((owner) => owner.length > 0);
}

function isOwner(owners: string[], email: string): boolean {
  const wanted = email.trim().toLowerCase();
  return owners.some((owner) => owner.trim().toLowerCase() === wanted);
}

function approvalRecord(
  lines: string[],
  email: string,
  forced: boolean,
  now: Date,
  commit?: string,
): string {
  const record = [
    `- 批准人：${email}`,
    `- 时间：${now.toISOString()}`,
    `- 提交：${commit ?? "（待记录）"}`,
    `- 强制：${forced ? "是" : "否"}`,
  ].join("\n");
  return replaceMarkdownSection(lines.join("\n"), APPROVAL_HEADING, record);
}

function replaceMarkdownSection(text: string, heading: string, content: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const index = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (index === -1) {
    return `${lines.join("\n").trimEnd()}\n\n## ${heading}\n\n${content}\n`;
  }

  let end = lines.length;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (/^##\s/.test(lines[cursor])) {
      end = cursor;
      break;
    }
  }

  const next = [...lines.slice(0, index + 1), "", ...content.split("\n"), "", ...lines.slice(end)];
  return `${next.join("\n").trimEnd()}\n`;
}

function sanitizeTitle(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "decision";
}

async function nextAdrNumber(decisionsDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(decisionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 1;
    throw err;
  }

  let max = 0;
  for (const entry of entries) {
    const match = /^ADR-(\d+)-/.exec(entry);
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > max) max = parsed;
  }
  return max + 1;
}

async function createAdr(input: {
  projectDir: string;
  title: string;
  rationale: string;
  proposalId: string;
  approver: Identity;
  now: Date;
}): Promise<string> {
  const decisionsDir = join(input.projectDir, "decisions");
  const number = await nextAdrNumber(decisionsDir);
  const label = `ADR-${String(number).padStart(4, "0")}`;
  const path = join(decisionsDir, `${label}-${sanitizeTitle(input.title)}.md`);

  const date = input.now.toISOString().slice(0, 10);
  const content = `# ${label}: ${input.title.trim()}

- 状态：accepted
- 日期：${date}
- 提案：${input.proposalId}
- 批准人：${input.approver.email}

## 背景

${input.rationale.trim() || "（未提供）"}

## 决策

${input.title.trim()}

## 影响

（待补充）
`;

  await writeFileAtomic(path, content);
  return path;
}

function approvalMessage(id: string, identity: Identity, forced: boolean): string {
  const lines = [
    `feat: approve proposal ${id}`,
    "",
    `Memsync-Approved-By: ${identity.email}`,
  ];
  if (forced) lines.push(`Memsync-Forced-By: ${identity.email}`);
  lines.push("", TRAILER);
  return lines.join("\n");
}

/**
 * Approves a proposal: verifies ownership, re-validates the pinned section
 * hash and match, applies the change, records the approval, commits with the
 * approval trailers, and pushes best-effort. Structural failures are returned
 * as `{ applied: false, reason }`; unexpected I/O errors are thrown.
 */
export async function approveProposal(
  projectDir: string,
  id: string,
  identity: Identity,
  options: ApproveProposalOptions = {},
): Promise<ApproveProposalResult> {
  if (!isSafeProposalId(id)) {
    return { applied: false, reason: `unknown proposal "${id}"` };
  }

  const proposalPath = join(projectDir, "proposals", `${id}.md`);
  const raw = await readOptional(proposalPath);
  if (raw === undefined) {
    return { applied: false, reason: `unknown proposal "${id}"` };
  }

  const { data, body } = parseFrontMatter<ProposalFrontMatter>(raw);
  if (data.status === "approved") {
    return { applied: false, reason: `proposal ${id} is already approved` };
  }
  if (data.status !== "proposed") {
    return { applied: false, reason: `proposal ${id} is ${String(data.status)}` };
  }
  if (data.kind !== "constraint" && data.kind !== "decision") {
    return { applied: false, reason: `proposal ${id} has an invalid kind` };
  }

  const meta = await readProjectMeta(projectDir);
  const repoRoot = options.repoPath ?? repoRootFromProject(projectDir);

  let change: ConstraintChange | undefined;
  let targetPath: string | undefined;
  let owners: string[];

  if (data.kind === "constraint") {
    try {
      change = extractChange(body);
      targetPath = targetPathFor(repoRoot, projectDir, change.file);
    } catch (err) {
      return { applied: false, reason: errorMessage(err) };
    }
    owners =
      change.file === "org/conventions.md"
        ? await readGovernanceOwners(repoRoot)
        : meta.owners;
  } else {
    owners = meta.owners;
  }

  if (!options.force && !isOwner(owners, identity.email)) {
    return {
      applied: false,
      reason:
        `only project owners can approve: ${identity.email} is not listed in ` +
        `the governing owners (use --force to override)`,
    };
  }

  const proposalRelative = repoRelative(repoRoot, proposalPath);
  const commitTargets: string[] = [proposalRelative];
  const bodyLines = body.replace(/\r\n?/g, "\n").split("\n");
  const forced = options.force === true;
  let originalConstraints: string | undefined;
  let adrPath: string | undefined;
  let updated = "";

  if (data.kind === "constraint" && change !== undefined && targetPath !== undefined) {
    originalConstraints = await readFile(targetPath, "utf8");
    try {
      await applyConstraintChange(targetPath, change, id, identity.email);
    } catch (err) {
      return { applied: false, reason: errorMessage(err) };
    }
    commitTargets.push(repoRelative(repoRoot, targetPath));
  }

  const rollback = async (): Promise<void> => {
    if (originalConstraints !== undefined && targetPath !== undefined) {
      await writeFileAtomic(targetPath, originalConstraints);
    }
    await writeFileAtomic(proposalPath, raw);
    if (adrPath !== undefined) await rm(adrPath, { force: true });
    // A failed `git commit` can leave the approval staged; reset the index so
    // a later commit cannot land the change without the approval trailer.
    await runGit(["reset", "--", ...commitTargets], { cwd: repoRoot });
  };

  let approvalCommit: string | undefined;
  try {
    if (data.kind === "decision") {
      adrPath = await createAdr({
        projectDir,
        title: data.title,
        rationale: inputRationale(body),
        proposalId: id,
        approver: identity,
        now: new Date(),
      });
      commitTargets.push(repoRelative(repoRoot, adrPath));
    }

    updated = serializeFrontMatter(
      { ...data, status: "approved" },
      approvalRecord(bodyLines, identity.email, forced, new Date()),
    );
    await writeFileAtomic(proposalPath, updated);

    approvalCommit = await commitPaths(
      repoRoot,
      commitTargets,
      approvalMessage(id, identity, forced),
    );
  } catch (err) {
    // Never leave a fully applied but uncommitted approval behind.
    await rollback().catch(() => undefined);
    throw err;
  }

  approvalCommit ??= await shortHead(repoRoot);

  const recorded = serializeFrontMatter(
    { ...data, status: "approved" },
    approvalRecord(bodyLines, identity.email, forced, new Date(), approvalCommit),
  );
  await writeFileAtomic(proposalPath, recorded);
  try {
    await commitPaths(
      repoRoot,
      [proposalRelative],
      `docs: record approval ${approvalCommit}\n\n${TRAILER}`,
    );
  } catch (err) {
    // The approval commit itself is safe; keep the tree clean for a retry.
    await writeFileAtomic(proposalPath, updated);
    await runGit(["reset", "--", proposalRelative], { cwd: repoRoot });
    throw err;
  }

  await pushWithRetry(repoRoot);

  return { applied: true };
}

async function shortHead(repoRoot: string): Promise<string> {
  const result = await runGit(["rev-parse", "--short", "HEAD"], { cwd: repoRoot });
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(`could not resolve the approval commit in ${repoRoot}`);
  }
  return result.stdout.trim();
}

function inputRationale(body: string): string {
  const section = parseConstraintSections(body).get("理由");
  return section?.trim() ?? "";
}

/**
 * Reports commits that changed a project's authoritative files without the
 * `Memsync-Approved-By:` trailer. The commit that first introduces each file
 * is the scaffold commit and is ignored.
 */
export async function verifyConstraintHistory(
  repoPath: string,
  projectSlug: string,
): Promise<{ commit: string; file: string }[]> {
  const files = [`projects/${projectSlug}/constraints.md`, "org/conventions.md"];
  const issues: { commit: string; file: string }[] = [];

  for (const file of files) {
    const log = await runGit(["log", "--format=%H", "--", file], { cwd: repoPath });
    if (log.code !== 0) {
      const detail = log.stderr.trim() || log.stdout.trim() || "no output";
      throw new Error(`git log failed for ${file}: ${detail}`);
    }

    const commits = log.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Oldest entry is the commit that introduced the file.
    for (const commit of commits.slice(0, -1)) {
      const message = await runGit(["show", "-s", "--format=%B", commit], { cwd: repoPath });
      if (message.code !== 0) {
        const detail = message.stderr.trim() || message.stdout.trim() || "no output";
        throw new Error(`git show failed for ${commit}: ${detail}`);
      }
      if (!message.stdout.includes("Memsync-Approved-By:")) {
        issues.push({ commit, file });
      }
    }
  }

  return issues;
}
