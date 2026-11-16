import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Tool } from "../types.js";
import {
  readCachedPack,
  readSeen,
  saveSeen,
  seenKey,
  writeCachedPack,
} from "./cache.js";
import { loadConfig } from "./config.js";
import { runGit } from "./git.js";
import {
  SECTION_AI,
  SECTION_SUMMARY,
  getSectionContent,
  listJournals,
  readJournalDocument,
} from "./journal.js";
import { withLock } from "./lock.js";
import {
  scheduleMaintenance,
  type ScheduleMaintenanceDeps,
} from "./maintenance.js";
import { lockPath } from "./paths.js";
import { resolveProject } from "./project.js";
import {
  hasPendingPush,
  pullRebase,
  pushWithRetry,
  type PullFailure,
} from "./repo.js";
import { renderContextPack, type AdrItem, type ChangeItem } from "./render.js";
import { parseFrontMatter } from "./schema.js";
import {
  SUPPORTED_TOOLS,
  beginSession,
  clearPendingPush,
  completeStaleSessions,
  readPendingPush,
  resolveSession,
} from "./session.js";
import { computeState } from "./state.js";
import { refreshStateSnapshot } from "./versions.js";

const DEFAULT_PULL_TIMEOUT_MS = 15_000;

function pullTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.MEMSYNC_PULL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1_000 && raw <= 60_000
    ? raw
    : DEFAULT_PULL_TIMEOUT_MS;
}
// Spec §8.1: wait at most 3s for the local lock, then fall back to local data.
const SYNC_LOCK_TIMEOUT_MS = 3_000;
const MAX_CHANGES = 8;
const MAX_ADRS = 3;

export interface SyncProjectInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  tool?: Tool;
  sessionId?: string;
  noPull?: boolean;
  /** Fail instead of falling back to cache when the pull fails. */
  strict?: boolean;
  /** Disables maintenance scheduling for this call (tests, deterministic runs). */
  noMaintenance?: boolean;
  /** Injection point for deterministic scheduling tests. */
  maintenanceDeps?: ScheduleMaintenanceDeps;
}

export interface SyncProjectResult {
  code: number;
  context?: string;
  sessionId?: string;
  reason?: string;
}

function hostFor(env: NodeJS.ProcessEnv): string {
  const configured = env.MEMSYS_HOST?.trim();
  return configured !== undefined && configured.length > 0 ? configured : hostname();
}

function identityFor(config: {
  identity?: { name?: string; email?: string };
}): { user: string; email: string } {
  const user = config.identity?.name?.trim() || "unknown";
  const email = config.identity?.email?.trim() || `${user}@localhost`;
  return { user, email };
}

/** Cursor tool: explicit flag, then MEMSYS_TOOL, then the primary adapter. */
function cursorToolFor(input: SyncProjectInput): string {
  if (input.tool !== undefined) return input.tool;
  const fromEnv = input.env.MEMSYS_TOOL?.trim();
  if (fromEnv !== undefined && SUPPORTED_TOOLS.includes(fromEnv as Tool)) return fromEnv;
  return "claude-code";
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function mmdd(timestamp: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(timestamp);
  if (match !== null) return `${match[1]}-${match[2]}`;
  return timestamp.length >= 10 ? timestamp.slice(5, 10) : timestamp;
}

function changeSummary(record: {
  outcome: string;
  body: string;
}): string {
  const summary = getSectionContent(record.body, SECTION_SUMMARY)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (summary !== undefined) return summary;

  const aiLines = getSectionContent(record.body, SECTION_AI)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-\s+\d{2}:\d{2}\s+\[(progress|decision|blocker)\]/.test(line));
  const last = aiLines[aiLines.length - 1];
  if (last !== undefined) {
    return last.replace(/^-\s+\d{2}:\d{2}\s+\[(?:progress|decision|blocker)\]\s*/, "");
  }

  switch (record.outcome) {
    case "completed":
      return "本会话已完成";
    case "blocked":
      return "本会话受阻";
    case "partial":
      return "本会话部分完成";
    case "abandoned":
      return "本会话已放弃";
    default:
      return "本会话记录更新";
  }
}

/**
 * Journals touched after the seen cursor, newest first. Only a headline per
 * journal is returned; full bodies stay behind `memsync recall`.
 */
async function changesSinceSeen(
  projectDir: string,
  cursor: string | undefined,
  currentSession: string | undefined,
): Promise<ChangeItem[]> {
  const cursorMs = cursor !== undefined ? Date.parse(cursor) : Number.NaN;
  const since = Number.isFinite(cursorMs) ? cursorMs : 0;
  const items: Array<ChangeItem & { at: number }> = [];

  for (const path of await listJournals(projectDir)) {
    let document;
    try {
      document = await readJournalDocument(path);
    } catch {
      continue;
    }

    const { record, body } = document;
    if (currentSession !== undefined && record.session === currentSession) continue;

    const started = Date.parse(record.started);
    const ended = record.ended !== undefined ? Date.parse(record.ended) : Number.NaN;
    const at = Math.max(
      Number.isFinite(started) ? started : 0,
      Number.isFinite(ended) ? ended : 0,
    );
    if (at <= since) continue;

    items.push({
      date: mmdd(record.ended ?? record.started),
      user: record.user,
      summary: changeSummary({ outcome: record.outcome, body }),
      at,
    });
  }

  return items
    .sort((a, b) => b.at - a.at || a.user.localeCompare(b.user))
    .slice(0, MAX_CHANGES)
    .map(({ at: _at, ...item }) => item);
}

function firstSentence(text: string): string {
  const cleaned = text
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return "";
  const match = /^.*?[。.!！?？]/.exec(cleaned);
  const sentence = match !== null ? match[0] : cleaned;
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

function parseAdr(filename: string, text: string): AdrItem {
  let body = text;
  try {
    body = parseFrontMatter<unknown>(text).body;
  } catch {
    // A malformed ADR should still contribute its readable title line.
  }

  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  let headingIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^#\s+(.+?)\s*$/.exec(lines[index]);
    if (match !== null) {
      title = match[1].trim();
      headingIndex = index;
      break;
    }
  }

  const paragraph: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^#\s+/.test(line)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }

  if (title.length === 0) {
    title = filename.replace(/\.md$/i, "").replace(/^ADR-\d+-?/i, "");
    if (title.length === 0) title = filename;
  }

  const conclusion = firstSentence(paragraph.join(" "));
  return conclusion.length > 0 ? { title, conclusion } : { title };
}

/** The latest three ADRs, newest filename first, title plus first sentence. */
async function recentAdrs(projectDir: string): Promise<AdrItem[]> {
  const directory = join(projectDir, "decisions");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, MAX_ADRS);

  const adrs: AdrItem[] = [];
  for (const name of names) {
    try {
      adrs.push(parseAdr(name, await readFile(join(directory, name), "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return adrs;
}

const STATE_PATH_PATTERN = /^projects\/[^/]+\/state\.md$/;

/**
 * Spec §8.5: a rebase conflict confined to `state.md` is safe to auto-resolve
 * because its derived region is rebuilt from journals. Take either side, stage
 * it, and let the caller refresh the snapshot; any other file aborts.
 */
async function resolveStateOnlyConflict(
  repoPath: string,
  files: string[],
): Promise<{ ok: boolean; projectDirs: string[] }> {
  const normalized = files
    .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((file) => file.length > 0);
  if (normalized.length === 0 || !normalized.every((file) => STATE_PATH_PATTERN.test(file))) {
    return { ok: false, projectDirs: [] };
  }

  const projectDirs: string[] = [];
  for (const relativePath of normalized) {
    // During a rebase "ours" is the upstream commit and "theirs" is ours; both
    // sides of state.md are derived, so preferring ours is deterministic.
    let taken = await runGit(["checkout", "--ours", "--", relativePath], {
      cwd: repoPath,
      timeoutMs: DEFAULT_PULL_TIMEOUT_MS,
    });
    if (taken.code !== 0) {
      taken = await runGit(["checkout", "--theirs", "--", relativePath], {
        cwd: repoPath,
        timeoutMs: DEFAULT_PULL_TIMEOUT_MS,
      });
    }
    if (taken.code !== 0) return { ok: false, projectDirs: [] };

    const added = await runGit(["add", "--", relativePath], {
      cwd: repoPath,
      timeoutMs: DEFAULT_PULL_TIMEOUT_MS,
    });
    if (added.code !== 0) return { ok: false, projectDirs: [] };
    projectDirs.push(join(repoPath, dirname(relativePath)));
  }

  return { ok: true, projectDirs };
}

function indexPathsFor(slug: string): string[] {
  return [
    "org/conventions.md",
    `projects/${slug}/constraints.md`,
    `projects/${slug}/state.md`,
    `projects/${slug}/decisions/`,
    `projects/${slug}/journal/`,
    `projects/${slug}/versions/`,
  ];
}

/**
 * Startup sync for hooks and `memsync sync`: refresh the memory repo, resolve
 * the workspace project, optionally begin a session, then compute and render a
 * bounded context pack. Unlinked workspaces and missing config are silent.
 */
export async function syncProject(input: SyncProjectInput): Promise<SyncProjectResult> {
  const config = await loadConfig(input.env);
  if (config === undefined) return { code: 0 };

  const repoPath = config.repoPath;

  // Pulls and pushes mutate the git index and must not race a detached
  // maintenance run, which takes the same cross-process lock. A held lock is
  // never waited on indefinitely: startup falls back to the local repo.
  let pullFailure: PullFailure | undefined;
  try {
    await withLock(
      lockPath(input.env),
      { timeoutMs: SYNC_LOCK_TIMEOUT_MS },
      async () => {
        // Retry a previous failed push before reading; never blocks. The
        // pending-push marker written by a failed session end is consumed here.
        try {
          const marker = await readPendingPush(input.env);
          if (marker?.repoPath === repoPath || (await hasPendingPush(repoPath))) {
            const pushed = await pushWithRetry(repoPath);
            if (pushed.ok && marker?.repoPath === repoPath) {
              await clearPendingPush(input.env);
            }
          }
        } catch {
          // Best-effort only.
        }

        if (input.noPull !== true) {
          let stateDirs: string[] = [];
          const pull = await pullRebase(repoPath, pullTimeoutMs(input.env), {
            resolveConflict: async (files) => {
              const resolved = await resolveStateOnlyConflict(repoPath, files);
              if (resolved.ok) stateDirs = resolved.projectDirs;
              return resolved.ok;
            },
          });
          if (!pull.ok) {
            pullFailure = pull;
          } else {
            // Rebuild each state.md snapshot after taking either side.
            for (const projectDir of stateDirs) {
              try {
                await refreshStateSnapshot(projectDir);
              } catch {
                // A stale snapshot must not fail startup.
              }
            }
          }
        }
      },
    );
  } catch {
    if (input.noPull !== true) {
      pullFailure = {
        ok: false,
        reason: "timeout",
        message: "another memsync process holds the lock",
      };
    }
  }

  if (input.strict === true && pullFailure !== undefined) {
    return {
      code: 1,
      reason: `pull failed (${pullFailure.reason})`,
    };
  }

  const resolution = await resolveProject(input.cwd, repoPath, input.env);
  if (!resolution.ok) {
    // The unlinked case is intentionally silent: no context key and no reason.
    return resolution.reason === "unlinked"
      ? { code: 0, context: undefined }
      : { code: 0, reason: resolution.reason };
  }

  // Crashed sessions are repaired on the next startup and committed, so they
  // appear in reports instead of lingering open forever. Never blocks startup.
  try {
    await completeStaleSessions(resolution.projectDir, new Date(), undefined, {
      env: input.env,
      commit: true,
    });
  } catch {
    // Best-effort; a failed repair must not block context rendering.
  }

  // Background maintenance is decided after a successful pull and project
  // resolution. It is fire-and-forget: startup must never wait for it, and a
  // scheduling failure is ignored.
  if (
    pullFailure === undefined &&
    input.noPull !== true &&
    input.noMaintenance !== true &&
    input.env.MEMSYNC_NO_MAINTENANCE !== "1"
  ) {
    void scheduleMaintenance(
      input.env,
      input.cwd,
      input.maintenanceDeps ?? {},
    );
  }

  const identity = identityFor(config);
  const host = hostFor(input.env);
  const cursorTool = cursorToolFor(input);

  let sessionId: string | undefined;
  if (input.tool !== undefined) {
    const explicit = input.sessionId?.trim();
    let implicit = false;
    if (explicit !== undefined && explicit.length > 0) {
      sessionId = explicit;
    } else {
      // Spec §8.1: reuse the env/pointer session before creating a new one.
      const resolved = await resolveSession({
        env: input.env,
        workspace: resolution.workspaceRoot,
        tool: input.tool,
        host,
        projectDir: resolution.projectDir,
      });
      sessionId = resolved.id;
      implicit = resolved.source === "implicit";
    }

    // beginSession also writes the per-tool workspace pointer.
    await beginSession({
      projectDir: resolution.projectDir,
      project: resolution.slug,
      user: identity.user,
      email: identity.email,
      host,
      tool: input.tool,
      session: sessionId,
      workspace: resolution.workspaceRoot,
      versionHint: resolution.meta.current_version,
      implicit,
    });
  }

  let offlineNotice: string | undefined;
  if (pullFailure !== undefined) {
    const cached = await readCachedPack(input.env, resolution.slug);
    if (cached !== undefined) {
      const context = `[memsync] 离线，使用 ${cached.syncedAt} 的缓存\n\n${cached.text}`;
      return {
        code: 0,
        context,
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
    }
    offlineNotice = `[memsync] 离线，使用本地记忆（拉取失败：${pullFailure.reason}）`;
  }

  const now = new Date();
  const state = await computeState(resolution.projectDir, now);
  const seen = await readSeen(input.env);
  const key = seenKey(resolution.slug, identity.email, host, cursorTool);

  const [orgConventions, constraints, adrs, changes] = await Promise.all([
    readOptional(join(repoPath, "org", "conventions.md")),
    readOptional(join(resolution.projectDir, "constraints.md")),
    recentAdrs(resolution.projectDir),
    changesSinceSeen(resolution.projectDir, seen[key], sessionId),
  ]);

  const ownItems = state.openItems.filter(
    (item) => item.email.trim().toLowerCase() === identity.email.trim().toLowerCase(),
  );

  const rendered = renderContextPack({
    project: {
      slug: resolution.slug,
      ...(resolution.meta.name !== undefined ? { name: resolution.meta.name } : {}),
      version: state.version,
      versionStatus: state.versionStatus,
    },
    syncedAt: now.toISOString(),
    budgetChars: resolution.meta.context_budget_chars,
    ...(orgConventions !== undefined ? { orgConventions } : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    state,
    changesSinceSeen: changes,
    ownItems,
    recentAdrs: adrs,
    indexPaths: indexPathsFor(resolution.slug),
  });

  const syncedAt = now.toISOString();
  // The cache stores the pure pack; the offline banner is added on read.
  await writeCachedPack(input.env, resolution.slug, rendered.text, syncedAt);

  // Advance the cursor only when the working copy is up to date. After a
  // failed pull the local repo may be missing remote journals committed before
  // `syncedAt`; a time-based cursor would then skip them forever. Offline cache
  // returns above for the same reason.
  if (pullFailure === undefined) {
    seen[key] = syncedAt;
    await saveSeen(input.env, seen);
  }

  const context =
    offlineNotice !== undefined
      ? `${offlineNotice}\n\n${rendered.text}`
      : rendered.text;

  return {
    code: 0,
    context,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(pullFailure !== undefined
      ? { reason: `pull failed (${pullFailure.reason}); using local memory repo` }
      : {}),
  };
}
