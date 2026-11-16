import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Raised when memory files do not match the expected schema. */
export class SchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SchemaError";
  }
}

/** Raised when `projects/<slug>/meta.yaml` does not exist. */
export class ProjectMetaNotFoundError extends SchemaError {
  constructor(path: string) {
    super(`Project meta not found at ${path}`);
    this.name = "ProjectMetaNotFoundError";
  }
}

export type VersionStatus = "planning" | "active" | "frozen";

export interface MaintenancePolicy {
  interval_hours: number;
  cooldown_hours: number;
  mainline_only: boolean;
}

export interface ProjectConfig {
  slug: string;
  name?: string;
  repos: string[];
  owners: string[];
  default_branch?: string;
  current_version: string;
  version_status: VersionStatus;
  context_budget_chars: number;
  maintenance: MaintenancePolicy;
  created?: string;
}

export const DEFAULT_CONTEXT_BUDGET_CHARS = 12_000;

export const DEFAULT_MAINTENANCE: MaintenancePolicy = {
  interval_hours: 72,
  cooldown_hours: 6,
  mainline_only: true,
};

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const VERSION_STATUSES: readonly VersionStatus[] = ["planning", "active", "frozen"];

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

/** Normalizes CRLF and a UTF-8 BOM before parsing text memory files. */
function normalizeText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, "\n");
}

/**
 * Parses `---\n<yaml>\n---\n<body>` front matter. Text without front matter
 * is returned unchanged with empty data; malformed or unclosed front matter
 * raises SchemaError so corrupt memory files do not pass silently.
 */
export function parseFrontMatter<T>(text: string): { data: T; body: string } {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n");

  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { data: {} as T, body: normalized };
  }

  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      closing = index;
      break;
    }
  }

  if (closing === -1) {
    throw new SchemaError("Front matter is missing its closing --- delimiter");
  }

  const yamlText = lines.slice(1, closing).join("\n");
  let body = lines.slice(closing + 1).join("\n");
  // Serialization inserts one blank line after the closing delimiter.
  if (body.startsWith("\n")) body = body.slice(1);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    throw new SchemaError("Invalid YAML in front matter", { cause: err });
  }

  if (parsed === null || parsed === undefined) {
    return { data: {} as T, body };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SchemaError("Front matter must be a YAML mapping");
  }

  return { data: parsed as T, body };
}

/** Serializes data as YAML front matter followed by the body. */
export function serializeFrontMatter(data: unknown, body: string): string {
  const yamlText = stringifyYaml(data, { lineWidth: 0 }).replace(/\r\n/g, "\n").trimEnd();
  const normalizedBody = body.replace(/\r\n?/g, "\n");
  const header = `---\n${yamlText.length > 0 ? `${yamlText}\n` : ""}---\n`;
  return normalizedBody.length === 0 ? header : `${header}\n${normalizedBody}`;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SchemaError("Project meta must be a YAML mapping");
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SchemaError(`Project meta field "${key}" must be a non-empty string`);
  }
  return value.trim();
}

function stringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new SchemaError(`Project meta field "${key}" must be a non-empty array`);
  }

  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new SchemaError(`Project meta field "${key}[${index}]" must be a non-empty string`);
    }
    return item.trim();
  });
}

function positiveNumber(value: unknown, key: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new SchemaError(
      `Project meta field "maintenance.${key}" must be a ${allowZero ? "non-negative" : "positive"} number`,
    );
  }
  return value;
}

/**
 * Validates and normalizes `meta.yaml`. The five required fields come from the
 * plan; version_status, context_budget_chars, and the maintenance policy get
 * documented defaults so older meta files stay usable.
 */
export function validateProjectMeta(input: unknown): ProjectConfig {
  const record = requireRecord(input);

  const rawSlug = record.slug;
  if (typeof rawSlug !== "string" || rawSlug.trim().length === 0) {
    throw new SchemaError('Project meta field "slug" must be a non-empty string');
  }
  if (!isValidSlug(rawSlug)) {
    throw new SchemaError(
      `Project meta field "slug" must match ${SLUG_PATTERN.source} (got "${rawSlug}")`,
    );
  }
  const slug = rawSlug;

  const repos = stringList(record, "repos");
  const owners = stringList(record, "owners");
  owners.forEach((owner, index) => {
    if (!isValidEmail(owner)) {
      throw new SchemaError(`Project meta field "owners[${index}]" must be an email address`);
    }
  });

  const currentVersion = requireString(record, "current_version");

  const rawMaintenance = record.maintenance;
  if (typeof rawMaintenance !== "object" || rawMaintenance === null || Array.isArray(rawMaintenance)) {
    throw new SchemaError('Project meta field "maintenance" must be a mapping');
  }
  const maintenance = rawMaintenance as Record<string, unknown>;
  if (typeof maintenance.interval_hours !== "number") {
    throw new SchemaError('Project meta field "maintenance.interval_hours" is required');
  }
  if (typeof maintenance.cooldown_hours !== "number") {
    throw new SchemaError('Project meta field "maintenance.cooldown_hours" is required');
  }
  if (typeof maintenance.mainline_only !== "boolean") {
    throw new SchemaError('Project meta field "maintenance.mainline_only" must be a boolean');
  }

  let versionStatus: VersionStatus = "active";
  if (record.version_status !== undefined) {
    if (
      typeof record.version_status !== "string" ||
      !VERSION_STATUSES.includes(record.version_status as VersionStatus)
    ) {
      throw new SchemaError(
        `Project meta field "version_status" must be one of ${VERSION_STATUSES.join("|")}`,
      );
    }
    versionStatus = record.version_status as VersionStatus;
  }

  let budget = DEFAULT_CONTEXT_BUDGET_CHARS;
  if (record.context_budget_chars !== undefined) {
    if (
      typeof record.context_budget_chars !== "number" ||
      !Number.isInteger(record.context_budget_chars) ||
      record.context_budget_chars <= 0
    ) {
      throw new SchemaError(
        'Project meta field "context_budget_chars" must be a positive integer',
      );
    }
    budget = record.context_budget_chars;
  }

  const meta: ProjectConfig = {
    slug,
    repos,
    owners,
    current_version: currentVersion,
    version_status: versionStatus,
    context_budget_chars: budget,
    maintenance: {
      interval_hours: positiveNumber(maintenance.interval_hours, "interval_hours"),
      cooldown_hours: positiveNumber(maintenance.cooldown_hours, "cooldown_hours", true),
      mainline_only: maintenance.mainline_only,
    },
  };

  if (record.name !== undefined) {
    if (typeof record.name !== "string") {
      throw new SchemaError('Project meta field "name" must be a string');
    }
    meta.name = record.name;
  }
  if (record.default_branch !== undefined) {
    if (typeof record.default_branch !== "string" || record.default_branch.trim().length === 0) {
      throw new SchemaError('Project meta field "default_branch" must be a non-empty string');
    }
    meta.default_branch = record.default_branch.trim();
  }
  if (record.created !== undefined) {
    if (typeof record.created !== "string") {
      throw new SchemaError('Project meta field "created" must be a string');
    }
    meta.created = record.created;
  }

  return meta;
}

/** Reads and validates `projects/<slug>/meta.yaml` from a project directory. */
export async function readProjectMeta(projectDir: string): Promise<ProjectConfig> {
  const path = join(projectDir, "meta.yaml");

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectMetaNotFoundError(path);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new SchemaError(`Invalid YAML in ${path}`, { cause: err });
  }

  return validateProjectMeta(parsed);
}
