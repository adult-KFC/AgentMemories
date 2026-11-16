import { execFile } from "node:child_process";

/** Exit code reported when git was killed after exceeding its timeout. */
export const GIT_TIMEOUT_EXIT_CODE = 124;

const MAX_BUFFER = 4 * 1024 * 1024;

export interface GitOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs git without interpreting the result. Non-zero exits and timeouts are
 * returned to the caller rather than thrown, so lock/pull retry logic can
 * classify them. A timeout is reported as exit code 124.
 */
export function runGit(args: string[], opts: GitOptions): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
        let err = typeof stderr === "string" ? stderr : String(stderr ?? "");

        if (!error) {
          resolve({ code: 0, stdout: out, stderr: err });
          return;
        }

        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        const timedOut =
          failure.code === "ETIMEDOUT" ||
          (failure.killed === true && opts.timeoutMs !== undefined);

        if (timedOut && err.length === 0) {
          err = `git ${args.join(" ")} timed out${
            opts.timeoutMs !== undefined ? ` after ${opts.timeoutMs}ms` : ""
          }`;
        } else if (err.length === 0 && failure.message) {
          // Spawn failures (git missing, cwd missing) carry their detail here.
          err = failure.message;
        }

        const code = timedOut
          ? GIT_TIMEOUT_EXIT_CODE
          : typeof failure.code === "number"
            ? failure.code
            : 1;

        resolve({ code, stdout: out, stderr: err });
      },
    );

    // execFile can emit an error before the callback in rare spawn races.
    child.on("error", () => {
      // The callback still runs and resolves the promise; nothing to do here.
    });
  });
}

/** Runs git and throws an Error containing stderr when the command fails. */
export async function gitOrThrow(args: string[], opts: GitOptions): Promise<string> {
  const result = await runGit(args, opts);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(`git ${args.join(" ")} failed with code ${result.code}: ${detail}`);
  }
  return result.stdout.trim();
}
