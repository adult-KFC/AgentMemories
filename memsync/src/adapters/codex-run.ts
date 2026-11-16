import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { CliIo } from "../cli.js";
import { loadConfig } from "../core/config.js";
import { resolveProject } from "../core/project.js";
import { beginSession, endSession } from "../core/session.js";
import { syncProject } from "../core/sync.js";
import { codexSpawnTarget } from "./codex-app-server.js";

export interface RunWrappedToolInput {
  tool: "codex";
  args: string[];
  io: CliIo;
}

function oneLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const flattened = raw.replace(/\s+/g, " ").trim();
  return flattened.length > 300 ? `${flattened.slice(0, 299)}…` : flattened;
}

function hostFor(env: NodeJS.ProcessEnv): string {
  const configured = env.MEMSYS_HOST?.trim();
  return configured !== undefined && configured.length > 0 ? configured : hostname();
}

function commandFor(env: NodeJS.ProcessEnv): string {
  const configured = env.MEMSYNC_CODEX_PATH?.trim();
  return configured !== undefined && configured.length > 0 ? configured : "codex";
}

interface WrapperSession {
  sessionId: string;
  projectDir?: string;
}

/**
 * Begins a Codex session for the current workspace. Every top-level wrapper
 * launch is a new session; only an explicitly inherited `MEMSYS_SESSION`
 * (for example a nested invocation) reuses an existing id. Reusing the
 * workspace pointer here would attach later launches to an already-ended
 * journal, so a fresh UUID is always generated otherwise.
 *
 * A missing config or an unlinked workspace still yields a session id so the
 * wrapped process always inherits `MEMSYS_SESSION`; finalization is skipped.
 */
async function beginWrapperSession(
  input: RunWrappedToolInput,
  host: string,
  sessionId: string,
): Promise<WrapperSession> {
  const env = input.io.env;
  const config = await loadConfig(env);
  if (config === undefined) return { sessionId };

  const project = await resolveProject(input.io.cwd, config.repoPath, env);
  if (!project.ok) return { sessionId };

  const user = config.identity?.name?.trim() || "unknown";
  const email = config.identity?.email?.trim() || `${user}@localhost`;
  await beginSession({
    projectDir: project.projectDir,
    project: project.slug,
    user,
    email,
    host,
    tool: "codex",
    session: sessionId,
    workspace: project.workspaceRoot,
    versionHint: project.meta.current_version,
  });

  return { sessionId, projectDir: project.projectDir };
}

function spawnCodex(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  const target = codexSpawnTarget(command, args);

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    const child = spawn(target.file, target.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      windowsHide: true,
      ...(target.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

/**
 * Wrapper entry for path B: starts a Codex session, exports the session env to
 * the child, and finalizes the journal when the child exits. The child's exit
 * code always wins; a failed finalization is only a one-line diagnostic.
 */
export async function runWrappedTool(
  input: RunWrappedToolInput,
): Promise<number> {
  const env = input.io.env;
  const host = hostFor(env);
  const existing = env.MEMSYS_SESSION?.trim();
  const sessionId =
    existing !== undefined && existing.length > 0 ? existing : randomUUID();

  // Refresh memory (pull, push retry, crash repair) before the tool starts.
  // A pull failure is reported by syncProject but never prevents the launch.
  try {
    await syncProject({
      cwd: input.io.cwd,
      env,
      tool: "codex",
      sessionId,
      noPull: false,
    });
  } catch (err) {
    input.io.stderr(`memsync run: sync skipped: ${oneLine(err)}\n`);
  }

  let session: WrapperSession;
  try {
    session = await beginWrapperSession(input, host, sessionId);
  } catch (err) {
    input.io.stderr(`memsync run: ${oneLine(err)}\n`);
    session = { sessionId };
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    MEMSYS_SESSION: session.sessionId,
    MEMSYS_TOOL: "codex",
    MEMSYS_HOST: host,
    MEMSYS_WRAPPER: "1",
  };

  // Codex's shell environment policy may filter MEMSYS_* variables, so leave a
  // file marker the agent instructions can check from the workspace itself.
  const markerPath = join(input.io.cwd, ".memsync", "wrapper-active");
  try {
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(
      markerPath,
      `${JSON.stringify({ session: session.sessionId, tool: "codex", startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
  } catch (err) {
    input.io.stderr(`memsync run: ${oneLine(err)}\n`);
  }

  let code: number;
  try {
    code = await spawnCodex(commandFor(env), input.args, {
      cwd: input.io.cwd,
      env: childEnv,
    });
  } finally {
    try {
      await rm(markerPath, { force: true });
    } catch {
      // The marker is advisory; cleanup failure must not hide the child result.
    }
  }

  if (session.projectDir !== undefined) {
    try {
      await endSession({
        projectDir: session.projectDir,
        sessionId: session.sessionId,
        env,
      });
    } catch (err) {
      input.io.stderr(`memsync run: ${oneLine(err)}\n`);
    }
  }

  return code;
}
