import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAX_BUFFER = 4 * 1024 * 1024;

/** Runs git synchronously from a test's point of view and rejects on failure. */
function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Every temporary repo gets a local identity so tests pass without global Git config. */
async function configureRepo(repoPath: string): Promise<void> {
  await git(["config", "user.name", "Test User"], repoPath);
  await git(["config", "user.email", "test@example.com"], repoPath);
  await git(["config", "core.autocrlf", "false"], repoPath);
}

export interface BareRemote {
  remote: string;
  dir: string;
}

/**
 * Creates a bare remote seeded with one commit, so clones get a branch and an
 * upstream tracking ref (an empty bare repo has no branch to pull from).
 */
export async function makeBareRemote(): Promise<BareRemote> {
  const dir = await mkdtemp(join(tmpdir(), "memsync-remote-"));
  const remote = join(dir, "remote.git");
  await git(["init", "--bare", remote], dir);

  const seed = join(dir, "seed");
  // Configure LF in the new repo so the first checkout does not honor a
  // host-level core.autocrlf=true (Git for Windows default).
  await git(["clone", "-c", "core.autocrlf=false", remote, seed], dir);
  await configureRepo(seed);
  await writeFile(join(seed, "README.md"), "memory repo\n", "utf8");
  await git(["add", "--", "README.md"], seed);
  await git(["commit", "-m", "chore: seed memory repo"], seed);
  await git(["push", "-u", "origin", "HEAD"], seed);

  return { remote, dir };
}

export interface TwoClones extends BareRemote {
  a: string;
  b: string;
}

/** Creates a seeded bare remote plus two independent working clones of it. */
export async function makeTwoClones(): Promise<TwoClones> {
  const { remote, dir } = await makeBareRemote();
  const a = join(dir, "a");
  const b = join(dir, "b");

  for (const dest of [a, b]) {
    await git(["clone", "-c", "core.autocrlf=false", remote, dest], dir);
    await configureRepo(dest);
  }

  return { remote, dir, a, b };
}

/** Writes, stages, and commits a single file; returns the short SHA. */
export async function commitFile(
  repoPath: string,
  filename: string,
  content: string,
  message?: string,
): Promise<string> {
  const fullPath = join(repoPath, filename);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  await git(["add", "--", filename], repoPath);
  await git(["commit", "-m", message ?? `chore: add ${filename}`], repoPath);
  const { stdout } = await git(["rev-parse", "--short", "HEAD"], repoPath);
  return stdout.trim();
}

/** Rejects with a descriptive error if the promise does not settle in time. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
