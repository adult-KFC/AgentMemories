import { CommanderError } from "commander";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliIo } from "../cli.js";
import {
  loadConfig,
  memsyncHome,
  saveConfig,
  validateIdentity,
} from "../core/config.js";
import { gitOrThrow, runGit } from "../core/git.js";
import { cloneOrUpdateRepo, commitPaths } from "../core/repo.js";
import type { GlobalConfig, Identity } from "../types.js";
import type { CommandModule } from "./index.js";

const DEFAULT_BUDGET_CHARS = 12_000;
const PULL_TIMEOUT_MS = 5_000;
const GIT_ATTRIBUTES_LINE = "* text=auto eol=lf";
const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";
const GIT_ATTRIBUTES_MESSAGE = `chore: enforce LF line endings\n\n${TRAILER}`;

interface InitOptions {
  remote?: string;
  name?: string;
  email?: string;
}

async function gitConfigValue(
  cwd: string,
  key: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const result = await runGit(["config", key], {
    cwd,
    timeoutMs: PULL_TIMEOUT_MS,
    env,
  });
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Flag values win over an existing config so re-running init is safe, and any
 * still-missing field falls back to the machine's git identity.
 */
async function resolveIdentity(
  io: CliIo,
  options: InitOptions,
  existing: GlobalConfig | undefined,
): Promise<Identity> {
  const name =
    options.name?.trim() ||
    existing?.identity.name ||
    (await gitConfigValue(io.cwd, "user.name", io.env));
  const email =
    options.email?.trim() ||
    existing?.identity.email ||
    (await gitConfigValue(io.cwd, "user.email", io.env));

  return validateIdentity({ name, email });
}

/** Points an existing clone's origin at the requested remote before updating. */
async function reconcileOrigin(
  repoPath: string,
  remoteUrl: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!existsSync(join(repoPath, ".git"))) return;

  const current = await runGit(["remote", "get-url", "origin"], { cwd: repoPath, env });
  if (current.code !== 0) {
    await gitOrThrow(["remote", "add", "origin", remoteUrl], { cwd: repoPath, env });
    return;
  }
  if (current.stdout.trim() !== remoteUrl) {
    await gitOrThrow(["remote", "set-url", "origin", remoteUrl], { cwd: repoPath, env });
  }
}

/**
 * Ensures the memory repo enforces LF endings. The file is committed only when
 * changed, with the standard trailer, so clones converge on one format.
 */
async function ensureGitAttributes(repoPath: string): Promise<void> {
  const attributesPath = join(repoPath, ".gitattributes");

  let content = "";
  try {
    content = await readFile(attributesPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const hasLine = content
    .split(/\r?\n/)
    .some((line) => line.trim() === GIT_ATTRIBUTES_LINE);
  if (hasLine) return;

  const prefix = content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
  await writeFile(attributesPath, `${prefix}${GIT_ATTRIBUTES_LINE}\n`, "utf8");
  await commitPaths(repoPath, [".gitattributes"], GIT_ATTRIBUTES_MESSAGE);
}

async function runInit(io: CliIo, options: InitOptions): Promise<void> {
  const existing = await loadConfig(io.env);
  const identity = await resolveIdentity(io, options, existing);

  const remoteUrl = options.remote?.trim() || existing?.remoteUrl;
  if (!remoteUrl) {
    throw new Error("a remote URL is required; pass --remote <url>");
  }

  const repoPath = join(memsyncHome(io.env), "repo");

  await reconcileOrigin(repoPath, remoteUrl, io.env);
  await cloneOrUpdateRepo({ remoteUrl, repoPath, timeoutMs: PULL_TIMEOUT_MS });

  const config: GlobalConfig = {
    version: existing?.version ?? 1,
    repoPath,
    remoteUrl,
    identity,
    defaultBudgetChars: existing?.defaultBudgetChars ?? DEFAULT_BUDGET_CHARS,
  };
  await saveConfig(io.env, config);

  // Repo-local settings keep commits working without a global Git identity and
  // pin line endings regardless of the machine's global autocrlf.
  await gitOrThrow(["config", "core.autocrlf", "false"], { cwd: repoPath, env: io.env });
  await gitOrThrow(["config", "user.name", identity.name], { cwd: repoPath, env: io.env });
  await gitOrThrow(["config", "user.email", identity.email], { cwd: repoPath, env: io.env });
  await ensureGitAttributes(repoPath);

  io.stdout(`Memory repo: ${repoPath}\n`);
  io.stdout(`Identity: ${identity.name} <${identity.email}>\n`);
  io.stdout(`Remote: ${remoteUrl}\n`);
}

export const initCommand: CommandModule = {
  name: "init",
  register(program, io) {
    program
      .command("init")
      .description("Clone the team memory repo and write the global config")
      .option("--remote <url>", "git URL of the team memory repository")
      .option("--name <name>", "commit identity name")
      .option("--email <email>", "commit identity email")
      .action(async (options: InitOptions) => {
        try {
          await runInit(io, options);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          io.stderr(`memsync init: ${message}\n`);
          throw new CommanderError(1, "memsync.init.failed", message);
        }
      });
  },
};
