import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedCodexCapabilities } from "../adapters/codex-install.js";
import { loadConfig, validateIdentity } from "./config.js";
import { runGit } from "./git.js";
import { listJournals, readJournalDocument } from "./journal.js";
import { configPath } from "./paths.js";
import { defaultBranchResolvable } from "./project.js";
import { isGitRepo } from "./repo.js";
import {
  ProjectMetaNotFoundError,
  readProjectMeta,
} from "./schema.js";
import { directoryBytes } from "./status.js";
import type { GlobalConfig } from "../types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

const REMOTE_TIMEOUT_MS = 5_000;
const REPO_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const directory =
    configured !== undefined && configured.length > 0
      ? configured
      : join(homedir(), ".claude");
  return join(directory, "settings.json");
}

const MEMSYNC_HOOK_PATTERN = /memsync[\w.-]*["']?\s+hook\s+/;

/** Every hook command string in a settings file. */
function hookCommands(settings: unknown): string[] {
  if (!isObject(settings) || !isObject(settings.hooks)) return [];
  const commands: string[] = [];

  for (const value of Object.values(settings.hooks)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!isObject(entry)) continue;
      if (Array.isArray(entry.hooks)) {
        for (const hook of entry.hooks) {
          if (isObject(hook) && typeof hook.command === "string") {
            commands.push(hook.command);
          }
        }
      } else if (typeof entry.command === "string") {
        commands.push(entry.command);
      }
    }
  }
  return commands;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The hook command is `"<node>" "<cli>" hook ...`; the CLI script is the path
 * that must still exist. Unquoted commands fall back to their first token.
 */
function hookScriptPath(command: string): string | undefined {
  const quoted = [...command.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (quoted.length >= 2) return quoted[1];
  if (quoted.length === 1) return quoted[0];
  const first = command.trim().split(/\s+/)[0];
  return first !== undefined && first.length > 0 ? first : undefined;
}

async function checkConfig(
  env: NodeJS.ProcessEnv,
): Promise<{ check: DoctorCheck; config?: GlobalConfig }> {
  try {
    const config = await loadConfig(env);
    if (config === undefined) {
      return {
        check: { name: "config", ok: false, detail: `missing ${configPath(env)}` },
      };
    }
    return {
      check: { name: "config", ok: true, detail: configPath(env) },
      config,
    };
  } catch (err) {
    return {
      check: { name: "config", ok: false, detail: errorMessage(err) },
    };
  }
}

async function checkRepo(config: GlobalConfig | undefined): Promise<DoctorCheck> {
  if (config === undefined) {
    return { name: "repo", ok: false, detail: "no config" };
  }
  if (!(await isGitRepo(config.repoPath))) {
    return { name: "repo", ok: false, detail: `not a git repository: ${config.repoPath}` };
  }
  return { name: "repo", ok: true, detail: config.repoPath };
}

/**
 * Surfaces a warning when a project records a `default_branch` that does not
 * exist in the memory repo: maintenance would silently never run. This is a
 * warning (ok: true) because a newly created branch can legitimately lag.
 */
async function checkDefaultBranches(
  config: GlobalConfig | undefined,
): Promise<DoctorCheck> {
  if (config === undefined) {
    return { name: "default-branch", ok: true, detail: "not checked (no config)" };
  }

  let entries;
  try {
    entries = await readdir(join(config.repoPath, "projects"), { withFileTypes: true });
  } catch {
    return { name: "default-branch", ok: true, detail: "no projects" };
  }

  const unresolved: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".tmp-")) continue;
    try {
      const meta = await readProjectMeta(join(config.repoPath, "projects", entry.name));
      const branch = meta.default_branch?.trim() || "main";
      if (!(await defaultBranchResolvable(config.repoPath, branch))) {
        unresolved.push(`${entry.name}: ${branch}`);
      }
    } catch (err) {
      if (err instanceof ProjectMetaNotFoundError) continue;
      unresolved.push(`${entry.name}: unreadable meta (${errorMessage(err)})`);
    }
  }

  if (unresolved.length > 0) {
    return {
      name: "default-branch",
      ok: true,
      detail: `warning: configured default branch cannot be resolved (${unresolved.join(", ")}); maintenance will not run. Fix meta.yaml default_branch or push the branch`,
    };
  }
  return { name: "default-branch", ok: true, detail: "all project default branches resolve" };
}

async function checkGitRemote(
  env: NodeJS.ProcessEnv,
  config: GlobalConfig | undefined,
): Promise<DoctorCheck> {
  if (config === undefined) {
    return { name: "git-remote", ok: false, detail: "no config" };
  }
  const result = await runGit(["ls-remote", "--heads", "origin"], {
    cwd: config.repoPath,
    timeoutMs: REMOTE_TIMEOUT_MS,
    env,
  });
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    return { name: "git-remote", ok: false, detail };
  }
  return { name: "git-remote", ok: true, detail: config.remoteUrl };
}

function checkIdentity(config: GlobalConfig | undefined): DoctorCheck {
  if (config === undefined) {
    return { name: "identity", ok: false, detail: "no config" };
  }
  try {
    const identity = validateIdentity(config.identity);
    return { name: "identity", ok: true, detail: `${identity.name} <${identity.email}>` };
  } catch (err) {
    return { name: "identity", ok: false, detail: errorMessage(err) };
  }
}

async function checkClaudeHooks(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const path = claudeSettingsPath(env);
  let settings: unknown;
  try {
    settings = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { name: "claude-hooks", ok: false, detail: `settings not found: ${path}` };
    }
    return { name: "claude-hooks", ok: false, detail: `invalid settings JSON: ${path}` };
  }

  const commands = hookCommands(settings).filter((command) =>
    MEMSYNC_HOOK_PATTERN.test(command),
  );
  if (commands.length === 0) {
    return { name: "claude-hooks", ok: false, detail: `no memsync hook in ${path}` };
  }

  for (const command of commands) {
    const script = hookScriptPath(command);
    if (script !== undefined && (await pathExists(script))) {
      return { name: "claude-hooks", ok: true, detail: script };
    }
  }

  const script = hookScriptPath(commands[0]);
  return {
    name: "claude-hooks",
    ok: false,
    detail: `hook command path missing: ${script ?? commands[0]}`,
  };
}

async function checkCodexCapabilities(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const capabilities = await readCachedCodexCapabilities(env);
  if (capabilities === undefined) {
    return {
      name: "codex-capabilities",
      ok: false,
      detail: "no cached capabilities; run memsync install --tool codex",
    };
  }
  return {
    name: "codex-capabilities",
    ok: true,
    detail: `path ${capabilities.path}${
      capabilities.codexVersion !== undefined ? ` (codex ${capabilities.codexVersion})` : ""
    }`,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function checkRepoSize(config: GlobalConfig | undefined): Promise<DoctorCheck> {
  if (config === undefined) {
    return { name: "repo-size", ok: false, detail: "no config" };
  }
  const bytes = await directoryBytes(config.repoPath).catch(() => 0);
  if (bytes >= REPO_SIZE_LIMIT_BYTES) {
    return {
      name: "repo-size",
      ok: false,
      detail: `${formatBytes(bytes)} exceeds ${formatBytes(REPO_SIZE_LIMIT_BYTES)}; run memsync compact`,
    };
  }
  return { name: "repo-size", ok: true, detail: formatBytes(bytes) };
}

async function newestJournalTime(repoPath: string): Promise<number | undefined> {
  let projects;
  try {
    projects = await readdir(join(repoPath, "projects"), { withFileTypes: true });
  } catch {
    return undefined;
  }

  let newest: number | undefined;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    for (const path of await listJournals(join(repoPath, "projects", project.name))) {
      try {
        const { record } = await readJournalDocument(path);
        for (const value of [record.ended, record.started]) {
          if (value === undefined) continue;
          const parsed = Date.parse(value);
          if (Number.isFinite(parsed) && (newest === undefined || parsed > newest)) {
            newest = parsed;
          }
        }
      } catch {
        // Corrupt journals do not break the clock check.
      }
    }
  }
  return newest;
}

async function checkClock(
  config: GlobalConfig | undefined,
  now: Date,
): Promise<DoctorCheck> {
  if (config === undefined) {
    return { name: "clock", ok: true, detail: "no journals" };
  }
  const newest = await newestJournalTime(config.repoPath);
  if (newest === undefined) {
    return { name: "clock", ok: true, detail: "no journals" };
  }

  const skew = Math.abs(now.getTime() - newest);
  if (skew < HOUR_MS) {
    return { name: "clock", ok: true, detail: "newest journal is within 1h of now" };
  }
  return {
    name: "clock",
    ok: true,
    detail: `warning: newest journal is ${(skew / HOUR_MS).toFixed(1)}h from now; check clock skew`,
  };
}

const CHECKS = [
  "config",
  "repo",
  "git-remote",
  "identity",
  "claude-hooks",
  "codex-capabilities",
  "default-branch",
  "repo-size",
  "clock",
] as const;

/** Runs every health check; individual failures never abort the others. */
export async function runDoctor(env: NodeJS.ProcessEnv): Promise<DoctorCheck[]> {
  const now = new Date();
  const { check: configCheck, config } = await checkConfig(env);

  const checks: DoctorCheck[] = [];
  checks.push(configCheck);

  for (const name of CHECKS.slice(1)) {
    try {
      switch (name) {
        case "repo":
          checks.push(await checkRepo(config));
          break;
        case "git-remote":
          checks.push(await checkGitRemote(env, config));
          break;
        case "identity":
          checks.push(checkIdentity(config));
          break;
        case "claude-hooks":
          checks.push(await checkClaudeHooks(env));
          break;
        case "codex-capabilities":
          checks.push(await checkCodexCapabilities(env));
          break;
        case "default-branch":
          checks.push(await checkDefaultBranches(config));
          break;
        case "repo-size":
          checks.push(await checkRepoSize(config));
          break;
        case "clock":
          checks.push(await checkClock(config, now));
          break;
      }
    } catch (err) {
      checks.push({ name, ok: false, detail: errorMessage(err) });
    }
  }

  return checks;
}
