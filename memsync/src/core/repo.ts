import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  GIT_TIMEOUT_EXIT_CODE,
  gitOrThrow,
  runGit,
  type GitResult,
} from "./git.js";

const DEFAULT_PULL_TIMEOUT_MS = 5_000;
const DEFAULT_PUSH_ATTEMPTS = 3;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** True when `repoPath` contains a `.git` directory or gitfile. */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  return pathExists(join(repoPath, ".git"));
}

export interface PullFailure {
  ok: false;
  reason: "timeout" | "conflict" | "error";
  message: string;
}

/**
 * Classifies a non-zero `git pull` result. Exported so timeout classification
 * can be tested directly without injecting a slow git executable.
 */
export function classifyPullFailure(result: GitResult): PullFailure {
  const combined = `${result.stdout}\n${result.stderr}`;
  const message =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `git pull exited with code ${result.code}`;

  if (result.code === GIT_TIMEOUT_EXIT_CODE || /ETIMEDOUT/i.test(combined)) {
    return { ok: false, reason: "timeout", message };
  }
  if (/CONFLICT/i.test(combined)) {
    return { ok: false, reason: "conflict", message };
  }
  return { ok: false, reason: "error", message };
}

async function gitDirFor(repoPath: string): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--git-dir"], {
    cwd: repoPath,
    timeoutMs: DEFAULT_PULL_TIMEOUT_MS,
  });
  if (result.code !== 0) return undefined;

  const dir = result.stdout.trim();
  if (dir.length === 0) return undefined;
  return isAbsolute(dir) ? dir : join(repoPath, dir);
}

/**
 * Leaves the repo usable after an interrupted pull. A timed-out git process
 * can leave index.lock behind, and a conflicted rebase stays in progress until
 * aborted; both would otherwise break every later commit/push.
 */
async function cleanupInterruptedPull(repoPath: string, timedOut: boolean): Promise<void> {
  if (timedOut) {
    const gitDir = await gitDirFor(repoPath);
    if (gitDir) await rm(join(gitDir, "index.lock"), { force: true });
  }
  // Ignore "no rebase in progress" and similar; we only care about the effect.
  await runGit(["rebase", "--abort"], {
    cwd: repoPath,
    timeoutMs: DEFAULT_PULL_TIMEOUT_MS,
  });
}

/** Unmerged paths of an in-progress rebase; empty when none remain. */
async function unmergedFiles(repoPath: string): Promise<string[]> {
  const result = await runGit(["diff", "--name-only", "--diff-filter=U"], {
    cwd: repoPath,
    timeoutMs: DEFAULT_PULL_TIMEOUT_MS,
  });
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface PullRebaseOptions {
  /**
   * Called with the unmerged paths when the rebase stops on a conflict.
   * Return true after staging a resolution; the rebase is continued. Return
   * false to abort, preserving the existing conflict handling.
   */
  resolveConflict?: (files: string[]) => Promise<boolean>;
}

/**
 * Pulls with rebase so local memory commits are replayed on top of the remote.
 * Never throws for git failures; the caller decides whether to retry or abort.
 * A caller-supplied resolver may handle conflicts file-by-file (state.md
 * auto-recovery); every other conflict and timeout is cleaned up so the repo
 * is not left mid-rebase.
 */
export async function pullRebase(
  repoPath: string,
  timeoutMs: number = DEFAULT_PULL_TIMEOUT_MS,
  opts: PullRebaseOptions = {},
): Promise<{ ok: true } | PullFailure> {
  let result = await runGit(["pull", "--rebase", "--autostash"], {
    cwd: repoPath,
    timeoutMs,
  });

  // Bound the loop: each iteration either finishes the rebase or aborts.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (result.code === 0) return { ok: true };

    const failure = classifyPullFailure(result);
    if (failure.reason === "conflict" && opts.resolveConflict !== undefined) {
      const files = await unmergedFiles(repoPath);
      if (files.length > 0 && (await opts.resolveConflict(files))) {
        result = await runGit(["-c", "core.editor=true", "rebase", "--continue"], {
          cwd: repoPath,
          timeoutMs,
        });
        continue;
      }
    }

    if (failure.reason === "conflict" || failure.reason === "timeout") {
      await cleanupInterruptedPull(repoPath, failure.reason === "timeout");
    }
    return failure;
  }

  await cleanupInterruptedPull(repoPath, false);
  return classifyPullFailure(result);
}

/**
 * Clones the memory repo when `repoPath` is absent, otherwise pulls the latest
 * commits. A directory that exists but is not a git repo is a hard error.
 */
export async function cloneOrUpdateRepo(input: {
  remoteUrl: string;
  repoPath: string;
  timeoutMs?: number;
}): Promise<void> {
  const { remoteUrl, repoPath, timeoutMs } = input;

  if (!(await pathExists(repoPath))) {
    await mkdir(dirname(repoPath), { recursive: true });
    // Pin LF before the initial checkout: a host with global autocrlf=true
    // would otherwise materialize CRLF and leave a fresh clone visibly dirty.
    await gitOrThrow(
      ["clone", "-c", "core.autocrlf=false", remoteUrl, repoPath],
      { cwd: dirname(repoPath) },
    );
    return;
  }

  if (!(await isGitRepo(repoPath))) {
    throw new Error(
      `${repoPath} exists but is not a git repository; move it aside or choose another MEMSYNC_HOME`,
    );
  }

  const pull = await pullRebase(repoPath, timeoutMs);
  if (!pull.ok) {
    throw new Error(`Failed to update ${repoPath} (${pull.reason}): ${pull.message}`);
  }
}

export interface CommitPathsOptions {
  /**
   * Stage whole paths with `git add -A`, so moves and deletions inside a
   * directory are recorded. The default stages exactly the given paths.
   */
  all?: boolean;
}

/**
 * Stages the given paths (never `git add -A` unless `opts.all` is set) and
 * commits when something changed. Returns the short SHA, or undefined when
 * there was nothing to commit.
 */
export async function commitPaths(
  repoPath: string,
  paths: string[],
  message: string,
  opts: CommitPathsOptions = {},
): Promise<string | undefined> {
  if (paths.length === 0) return undefined;

  const addArgs = opts.all === true ? ["add", "-A", "--", ...paths] : ["add", "--", ...paths];
  await gitOrThrow(addArgs, { cwd: repoPath });

  const staged = await runGit(["diff", "--cached", "--quiet"], { cwd: repoPath });
  if (staged.code === 0) return undefined;
  if (staged.code !== 1) {
    const detail = staged.stderr.trim() || staged.stdout.trim() || "no output";
    throw new Error(`git diff --cached failed with code ${staged.code}: ${detail}`);
  }

  await gitOrThrow(["commit", "-m", message], { cwd: repoPath });
  return gitOrThrow(["rev-parse", "--short", "HEAD"], { cwd: repoPath });
}

/**
 * Pushes, pulling with rebase between attempts to absorb a racing push.
 * Returns the last failure reason once all attempts are exhausted.
 */
export async function pushWithRetry(
  repoPath: string,
  attempts: number = DEFAULT_PUSH_ATTEMPTS,
): Promise<{ ok: boolean; reason?: string }> {
  const maxAttempts = Math.max(1, attempts);
  let reason = "push failed";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const push = await runGit(["push"], { cwd: repoPath });
    if (push.code === 0) return { ok: true };

    reason =
      push.stderr.trim() || push.stdout.trim() || `git push exited with code ${push.code}`;

    if (attempt < maxAttempts) {
      const pull = await pullRebase(repoPath);
      if (!pull.ok) {
        // Never push from a repo left mid-rebase or otherwise broken.
        return { ok: false, reason: `${pull.reason}: ${pull.message}` };
      }
    }
  }

  return { ok: false, reason };
}

/**
 * True when HEAD has commits not yet pushed to its upstream. Without an
 * upstream ref the answer is false: guessing would produce phantom syncs.
 */
export async function hasPendingPush(repoPath: string): Promise<boolean> {
  const upstream = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd: repoPath },
  );
  if (upstream.code !== 0 || upstream.stdout.trim().length === 0) return false;

  const count = await runGit(["rev-list", "--count", "@{u}..HEAD"], { cwd: repoPath });
  if (count.code !== 0) return false;

  const parsed = Number.parseInt(count.stdout.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0;
}
