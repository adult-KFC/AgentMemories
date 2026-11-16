import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cliCommand } from "../adapters/claude.js";
import { writeFileAtomic } from "./atomic.js";
import { compactJournalsDetailed } from "./compact.js";
import { runGit } from "./git.js";
import { withLock } from "./lock.js";
import { lockPath, statePath } from "./paths.js";
import { memoryRepoForEnv, repoRootFromProject, resolveProject } from "./project.js";
import { commitPaths, pushWithRetry } from "./repo.js";
import {
  readProjectMeta,
  type MaintenancePolicy,
  type ProjectConfig,
} from "./schema.js";
import { refreshStateSnapshot } from "./versions.js";

export type { MaintenancePolicy } from "./schema.js";
export { compactJournals, compactJournalsDetailed } from "./compact.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const ARCHIVE_AFTER_DAYS = 90;
const GIT_TIMEOUT_MS = 5_000;
const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";
const MAINTENANCE_COMMIT = `maintain: refresh state\n\n${TRAILER}`;

/** Persisted per-project maintenance bookkeeping. */
export interface MaintenanceState {
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  baselineHead?: string;
}

export interface EvaluateMaintenanceInput {
  now: Date;
  mainlineHead: string;
  baselineHead: string;
  lastSuccessAt?: Date;
  lastAttemptAt?: Date;
  policy: MaintenancePolicy;
}

export interface MaintenanceEvaluation {
  due: boolean;
  reason: string;
}

function hoursToMs(hours: number): number {
  return Math.max(0, hours) * HOUR_MS;
}

/**
 * The Three maintenance conditions: a new mainline commit, the interval since
 * the last success, and the cooldown after the last attempt. An unknown
 * mainline head is never treated as due.
 */
export function evaluateMaintenance(input: EvaluateMaintenanceInput): MaintenanceEvaluation {
  const { now, mainlineHead, baselineHead, lastSuccessAt, lastAttemptAt, policy } = input;

  if (!Number.isFinite(now.getTime())) {
    return { due: false, reason: "invalid clock" };
  }
  if (mainlineHead.trim().length === 0) {
    return { due: false, reason: "mainline head unavailable" };
  }
  if (mainlineHead === baselineHead) {
    return { due: false, reason: "no new mainline commit" };
  }

  const nowMs = now.getTime();
  if (lastSuccessAt !== undefined && Number.isFinite(lastSuccessAt.getTime())) {
    const elapsed = nowMs - lastSuccessAt.getTime();
    if (elapsed < hoursToMs(policy.interval_hours)) {
      return { due: false, reason: "maintenance interval not elapsed" };
    }
  }

  if (lastAttemptAt !== undefined && Number.isFinite(lastAttemptAt.getTime())) {
    const elapsed = nowMs - lastAttemptAt.getTime();
    if (elapsed < hoursToMs(policy.cooldown_hours)) {
      return { due: false, reason: "maintenance cooldown active" };
    }
  }

  return { due: true, reason: "new mainline commit" };
}

type MaintenanceFile = Record<string, Record<string, unknown>>;

function maintenancePath(env: NodeJS.ProcessEnv): string {
  return statePath(env, "maintenance.json");
}

async function readMaintenanceFile(env: NodeJS.ProcessEnv): Promise<MaintenanceFile> {
  let raw: string;
  try {
    raw = await readFile(maintenancePath(env), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const file: MaintenanceFile = {};
  for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      file[slug] = value as Record<string, unknown>;
    }
  }
  return file;
}

function stringField(entry: Record<string, unknown>, key: string): string | undefined {
  const value = entry[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads one project's maintenance state; missing or corrupt data is empty. */
export async function readMaintenanceState(
  env: NodeJS.ProcessEnv,
  slug: string,
): Promise<MaintenanceState> {
  const entry = (await readMaintenanceFile(env))[slug] ?? {};
  const lastSuccessAt = stringField(entry, "lastSuccessAt");
  const lastAttemptAt = stringField(entry, "lastAttemptAt");
  const baselineHead = stringField(entry, "baselineHead");
  return {
    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
    ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
    ...(baselineHead !== undefined ? { baselineHead } : {}),
  };
}

/** Merges one project's entry and rewrites the whole file atomically. */
export async function writeMaintenanceState(
  env: NodeJS.ProcessEnv,
  slug: string,
  update: MaintenanceState,
): Promise<void> {
  const file = await readMaintenanceFile(env);
  const merged: Record<string, unknown> = { ...(file[slug] ?? {}) };
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) merged[key] = value;
  }
  file[slug] = merged;

  const sorted: MaintenanceFile = {};
  for (const key of Object.keys(file).sort()) sorted[key] = file[key];
  await writeFileAtomic(
    maintenancePath(env),
    `${JSON.stringify(sorted, null, 2)}\n`,
  );
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function defaultBranch(meta: ProjectConfig): string {
  return meta.default_branch?.trim() || "main";
}

/**
 * The memory repo's `origin/<default_branch>` when it resolves, otherwise local
 * HEAD for a repo with no origin remote. If origin exists but the branch cannot
 * be resolved, the answer is unknown and maintenance must not run.
 */
async function resolveMainlineHead(
  projectDir: string,
  meta: ProjectConfig,
): Promise<string | undefined> {
  const repoPath = repoRootFromProject(projectDir);

  const origin = await runGit(
    ["rev-parse", "--verify", `origin/${defaultBranch(meta)}`],
    { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (origin.code === 0) {
    const head = origin.stdout.trim();
    if (head.length > 0) return head;
  }

  const remotes = await runGit(["remote"], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
  const names =
    remotes.code === 0
      ? remotes.stdout.split(/\r?\n/).map((name) => name.trim())
      : [];
  if (names.includes("origin")) return undefined;

  const local = await runGit(["rev-parse", "--verify", "HEAD"], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (local.code !== 0) return undefined;
  const head = local.stdout.trim();
  return head.length > 0 ? head : undefined;
}

export interface ProjectMaintenanceEvaluation extends MaintenanceEvaluation {
  slug: string;
  meta: ProjectConfig;
  state: MaintenanceState;
  mainlineHead?: string;
}

/** Evaluates the policy for a resolved project directory. */
export async function evaluateProjectMaintenance(
  projectDir: string,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<ProjectMaintenanceEvaluation> {
  const meta = await readProjectMeta(projectDir);
  const state = await readMaintenanceState(env, meta.slug);
  const mainlineHead = await resolveMainlineHead(projectDir, meta);

  if (mainlineHead === undefined) {
    return {
      due: false,
      reason: "mainline head unavailable",
      slug: meta.slug,
      meta,
      state,
    };
  }

  const result = evaluateMaintenance({
    now,
    mainlineHead,
    baselineHead: state.baselineHead ?? "",
    lastSuccessAt: parseDate(state.lastSuccessAt),
    lastAttemptAt: parseDate(state.lastAttemptAt),
    policy: meta.maintenance,
  });

  return { ...result, slug: meta.slug, meta, state, mainlineHead };
}

export interface RunMaintenanceOptions {
  env?: NodeJS.ProcessEnv;
  /** Lock wait before giving up; tests use a short value. Defaults to 5s. */
  lockTimeoutMs?: number;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface RunMaintenanceResult {
  stateRefreshed: boolean;
  archived: number;
}

/**
 * Applies the maintenance policy. Not due is a genuine no-op: nothing is
 * written, not even an attempt timestamp. When due, the attempt is recorded
 * first so a later failure starts the cooldown, then the state snapshot is
 * refreshed, journals older than 90 days are archived, the changed paths are
 * committed once, the success head/time are recorded, and the push is
 * best-effort.
 */
export async function runMaintenance(
  projectDir: string,
  now: Date,
  opts: RunMaintenanceOptions = {},
): Promise<RunMaintenanceResult> {
  const env = opts.env ?? process.env;
  const evaluation = await evaluateProjectMaintenance(projectDir, env, now);
  if (!evaluation.due || evaluation.mainlineHead === undefined) {
    return { stateRefreshed: false, archived: 0 };
  }

  const slug = evaluation.slug;
  const attemptAt = now.toISOString();
  const repoPath = repoRootFromProject(projectDir);
  let archived = 0;

  // Serialize against session commits, pushes, and sync pulls. The lock is
  // released before returning, so maintenance never holds up an unrelated run.
  await withLock(
    lockPath(env),
    { timeoutMs: opts.lockTimeoutMs ?? 5_000 },
    async () => {
      // Recorded first so a failure below still starts the cooldown.
      await writeMaintenanceState(env, slug, { lastAttemptAt: attemptAt });

      await refreshStateSnapshot(projectDir, now);
      const before = new Date(now.getTime() - ARCHIVE_AFTER_DAYS * DAY_MS);
      const compacted = await compactJournalsDetailed(projectDir, before);
      archived = compacted.count;

      // Stage whole directories with `git add -A` so archived moves record
      // both the new archive file and the journal deletion. Missing paths are
      // omitted: `git add` rejects a pathspec that does not match.
      const paths = [`projects/${slug}/state.md`];
      const journalDir = join(repoPath, "projects", slug, "journal");
      if (await pathExists(journalDir)) paths.push(`projects/${slug}/journal`);
      const archiveDir = join(repoPath, "projects", slug, "archive");
      if (await pathExists(archiveDir)) paths.push(`projects/${slug}/archive`);

      await commitPaths(repoPath, paths, MAINTENANCE_COMMIT, { all: true });

      try {
        await pushWithRetry(repoPath);
      } catch {
        // Maintenance is local-first; a failed push is retried by the next sync.
      }

      // Baseline is the post-maintenance local head. If the push succeeded this
      // equals origin/<branch>; if it failed, the next sync pushes it. Recording
      // the pre-commit head would make maintenance retrigger on its own commit.
      const head = await runGit(["rev-parse", "HEAD"], {
        cwd: repoPath,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      const baselineHead =
        head.code === 0 && head.stdout.trim().length > 0
          ? head.stdout.trim()
          : evaluation.mainlineHead;

      await writeMaintenanceState(env, slug, {
        lastSuccessAt: attemptAt,
        baselineHead,
      });
    },
  );

  return { stateRefreshed: true, archived };
}

export interface ScheduleMaintenanceDeps {
  spawn?: typeof import("node:child_process").spawn;
  cliPath?: string;
  now?: Date;
}

/**
 * Starts a detached `memsync maintain --quiet` when the current project is due.
 * Never throws and never waits for the child; returns whether it was spawned.
 * Testing hooks: inject `spawn`/`cliPath`/`now`, or set MEMSYNC_NO_MAINTENANCE=1.
 */
export async function scheduleMaintenance(
  env: NodeJS.ProcessEnv,
  cwd: string,
  deps: ScheduleMaintenanceDeps = {},
): Promise<boolean> {
  try {
    if (env.MEMSYNC_NO_MAINTENANCE === "1") return false;

    const repoPath = await memoryRepoForEnv(env);
    const resolution = await resolveProject(cwd, repoPath, env);
    if (!resolution.ok) return false;

    const now = deps.now ?? new Date();
    const evaluation = await evaluateProjectMaintenance(resolution.projectDir, env, now);
    if (!evaluation.due) return false;

    const cliPath = deps.cliPath ?? cliCommand(env).args[0];
    if (cliPath === undefined || cliPath.length === 0) return false;

    const spawnFn = deps.spawn ?? spawn;
    const child = spawnFn(process.execPath, [cliPath, "maintain", "--quiet"], {
      detached: true,
      stdio: "ignore",
      env,
      cwd,
      windowsHide: true,
    });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
