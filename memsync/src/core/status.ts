import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, memsyncHome } from "./config.js";
import { evaluateProjectMaintenance } from "./maintenance.js";
import { configPath, lockPath } from "./paths.js";
import { defaultBranchResolvable, resolveProject } from "./project.js";
import { hasPendingPush } from "./repo.js";
import { readPendingPush } from "./session.js";

export interface StatusReport {
  configPath?: string;
  repoPath?: string;
  lastSyncAt?: string;
  pendingPush: boolean;
  /** Session and time recorded by a failed session-end push. */
  pendingPushSession?: string;
  pendingPushAt?: string;
  locked: boolean;
  repoBytes: number;
  maintenanceDue: boolean;
  /** Set when the project's configured default branch does not resolve. */
  defaultBranchWarning?: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Recursive byte size; a missing path is zero. */
export async function directoryBytes(path: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let total = 0;
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(full);
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        // A file removed between readdir and stat contributes nothing.
      }
    }
  }
  return total;
}

/** Newest `cache/packs/*.meta.json` syncedAt, if any sidecar exists. */
export async function newestSyncAt(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const directory = join(memsyncHome(env), "cache", "packs");
  let entries;
  try {
    entries = await readdir(directory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  let newest: { value: string; at: number } | undefined;
  for (const name of entries) {
    if (!name.endsWith(".meta.json")) continue;
    let syncedAt: unknown;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(directory, name), "utf8"),
      );
      if (typeof parsed !== "object" || parsed === null) continue;
      syncedAt = (parsed as Record<string, unknown>).syncedAt;
    } catch {
      continue;
    }
    if (typeof syncedAt !== "string" || syncedAt.length === 0) continue;

    const parsedAt = Date.parse(syncedAt);
    const at = Number.isFinite(parsedAt) ? parsedAt : 0;
    if (newest === undefined || at > newest.at || (at === newest.at && syncedAt > newest.value)) {
      newest = { value: syncedAt, at };
    }
  }
  return newest?.value;
}

/**
 * Best-effort operational snapshot. Missing config or repo data degrades to
 * false/zero/undefined rather than failing: status must always be printable.
 */
export async function getStatus(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<StatusReport> {
  let config;
  try {
    config = await loadConfig(env);
  } catch {
    config = undefined;
  }

  const report: StatusReport = {
    pendingPush: false,
    locked: await pathExists(lockPath(env)),
    repoBytes: 0,
    maintenanceDue: false,
    ...(config !== undefined
      ? { configPath: configPath(env), repoPath: config.repoPath }
      : {}),
  };

  const lastSyncAt = await newestSyncAt(env).catch(() => undefined);
  if (lastSyncAt !== undefined) report.lastSyncAt = lastSyncAt;

  if (config === undefined) return report;

  report.repoBytes = await directoryBytes(config.repoPath).catch(() => 0);
  const marker = await readPendingPush(env).catch(() => undefined);
  const repoPending = await hasPendingPush(config.repoPath).catch(() => false);
  report.pendingPush = repoPending || marker !== undefined;
  if (marker !== undefined) {
    report.pendingPushSession = marker.session;
    report.pendingPushAt = marker.at;
  }

  try {
    const resolution = await resolveProject(cwd, config.repoPath, env);
    if (resolution.ok) {
      const evaluation = await evaluateProjectMaintenance(
        resolution.projectDir,
        env,
        new Date(),
      );
      report.maintenanceDue = evaluation.due;

      const branch = resolution.meta.default_branch?.trim() || "main";
      if (!(await defaultBranchResolvable(config.repoPath, branch))) {
        report.defaultBranchWarning =
          `default_branch "${branch}" cannot be resolved; maintenance will not run`;
      }
    }
  } catch {
    report.maintenanceDue = false;
  }

  return report;
}
