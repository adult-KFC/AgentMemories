import { aggregateJournals, type AggregatedWork } from "./versions.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DURATION_PATTERN = /^(\d+)d$/i;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses `--since` values: a duration such as `7d`/`30d`, or an ISO date.
 * A bare `YYYY-MM-DD` is interpreted as local midnight so a daily report does
 * not shift by the host timezone.
 */
export function parseSince(value: string, now: Date = new Date()): Date {
  if (typeof value !== "string") {
    throw new Error("--since is required; use a duration like 7d/30d or an ISO date");
  }
  const trimmed = value.trim();

  const duration = DURATION_PATTERN.exec(trimmed);
  if (duration !== null) {
    const days = Number.parseInt(duration[1], 10);
    if (Number.isFinite(days) && days > 0) {
      return new Date(now.getTime() - days * DAY_MS);
    }
  }

  if (DATE_ONLY_PATTERN.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  throw new Error(
    `invalid --since "${value}"; use a duration like 7d/30d or an ISO date`,
  );
}

function row(person: AggregatedWork): string {
  return [
    person.email,
    person.completed.length,
    person.active.length,
    person.blocked.length,
    person.commits.length,
  ].join(" | ");
}

/**
 * Standup text table, fully derived from journals: one row per lowercased
 * email with completed sessions, active progress, blockers, and commits.
 */
export async function reportByPerson(projectDir: string, since: Date): Promise<string> {
  if (Number.isNaN(since.getTime())) {
    throw new Error("report since date is invalid");
  }

  const work = await aggregateJournals(projectDir, { since });
  const lines = ["用户 | 完成 | 进行中 | 阻塞 | 提交数"];
  for (const person of work) lines.push(row(person));
  return `${lines.join("\n")}\n`;
}
