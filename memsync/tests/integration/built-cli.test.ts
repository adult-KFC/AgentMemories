import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../../src/version.js";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(ROOT, "dist", "memsync.mjs");

beforeAll(async () => {
  // Smoke tests exercise the real bundled entry point, not the TS sources.
  await execFileAsync("npm run build", {
    cwd: ROOT,
    shell: true,
    timeout: 120_000,
    windowsHide: true,
  });
}, 180_000);

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBuilt(
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [DIST, ...args], {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe("built CLI smoke test", () => {
  it("prints the version from dist/memsync.mjs", async () => {
    const result = await runBuilt(["--version"], "", process.env);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
    expect(result.stderr).toBe("");
  });

  it("runs a hook from the bundle and exits 0 on an unconfigured home", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-built-home-"));
    const userHome = join(home, "user-home");
    const claudeDir = join(home, "claude");
    const codexDir = join(home, "codex");
    await mkdir(userHome, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });

    const result = await runBuilt(
      ["hook", "session-start", "--tool", "claude-code"],
      "{}",
      {
        ...process.env,
        MEMSYNC_HOME: join(home, "memsync"),
        MEMSYS_HOST: "BUILT-TEST",
        MEMSYS_TOOL: "",
        MEMSYS_SESSION: "",
        HOME: userHome,
        USERPROFILE: userHome,
        CLAUDE_CONFIG_DIR: claudeDir,
        CODEX_HOME: codexDir,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
  });
});
