import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockOptions {
  /** How long to keep retrying before giving up. Defaults to 5000ms. */
  timeoutMs?: number;
  /** Age after which an abandoned lock is removed. Defaults to 30000ms. */
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const RETRY_INTERVAL_MS = 50;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LockObservation {
  token: string | undefined;
  mtimeMs: number;
}

function tokenOf(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

async function observeLock(lockPath: string): Promise<LockObservation | undefined> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  try {
    const info = await stat(lockPath);
    return { token: tokenOf(raw), mtimeMs: info.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function removeIfPresent(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Removes the lock only when its token still matches what the caller observed.
 * This stops an original holder that outlived `staleMs` from deleting the fresh
 * lock a reclaimer created in the meantime. A missing token (legacy lock file)
 * is matched against another missing token.
 */
async function removeLockIfOwned(lockPath: string, token: string | undefined): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  const current = tokenOf(raw);
  const owned = token === undefined ? current === undefined : current === token;
  if (owned) await removeIfPresent(lockPath);
}

/** Refreshes mtime only while we still own the lock, so long sections stay fresh. */
async function refreshLock(lockPath: string, token: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, "utf8");
    if (tokenOf(raw) !== token) return;
    const now = new Date();
    await utimes(lockPath, now, now);
  } catch {
    // The lock may have been removed; nothing to refresh.
  }
}

function startLockRefresh(lockPath: string, token: string, staleMs: number): NodeJS.Timeout {
  const intervalMs = Math.max(10, Math.floor(staleMs / 3));
  const timer = setInterval(() => {
    void refreshLock(lockPath, token);
  }, intervalMs);
  timer.unref();
  return timer;
}

/**
 * Same-process callers queue here so they acquire in call order. The OS file
 * lock alone gives no ordering guarantee between two promises started together.
 */
const inProcessQueues = new Map<string, Promise<void>>();

async function acquireFileLock<T>(
  lockPath: string,
  timeoutMs: number,
  staleMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    const token = randomBytes(8).toString("hex");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      const observed = await observeLock(lockPath);
      if (observed === undefined) continue;

      if (Date.now() - observed.mtimeMs > staleMs) {
        await removeLockIfOwned(lockPath, observed.token);
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock at ${lockPath} after ${timeoutMs}ms`);
      }

      await delay(RETRY_INTERVAL_MS);
      continue;
    }

    try {
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          token,
        })}\n`,
        "utf8",
      );
    } finally {
      await handle.close();
    }

    const refreshTimer = startLockRefresh(lockPath, token, staleMs);
    try {
      return await fn();
    } finally {
      clearInterval(refreshTimer);
      await removeLockIfOwned(lockPath, token);
    }
  }
}

/**
 * Cross-process mutual exclusion via an exclusively created lock file.
 * The lock holds `{ pid, startedAt, token }`, is retried every 50ms, is
 * reclaimed when its mtime is older than `staleMs`, refreshes its mtime while
 * held, and is only unlinked by its owner.
 */
export async function withLock<T>(
  lockPath: string,
  opts: LockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;

  const previous = inProcessQueues.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => held);
  inProcessQueues.set(lockPath, queued);

  await previous;
  try {
    return await acquireFileLock(lockPath, timeoutMs, staleMs, fn);
  } finally {
    release();
    if (inProcessQueues.get(lockPath) === queued) {
      inProcessQueues.delete(lockPath);
    }
  }
}
