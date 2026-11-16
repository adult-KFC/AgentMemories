import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli, type CliIo } from "../../src/cli.js";
import {
  makeBareRemote as makeSeedBareRemote,
  type BareRemote,
} from "../helpers.js";

export type { BareRemote };

const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Every e2e test runs against temporary homes. The real user-level Git config
 * is never read: a shared empty `GIT_CONFIG_GLOBAL` plus `GIT_CONFIG_NOSYSTEM`
 * is installed before the first Git process starts, and each home also sets
 * both variables for its own child processes.
 */
let sharedGitConfig: string | undefined;

export async function isolateGit(): Promise<string> {
  if (sharedGitConfig !== undefined) return sharedGitConfig;

  const dir = await mkdtemp(join(tmpdir(), "memsync-e2e-git-"));
  const path = join(dir, "global-gitconfig");
  await writeFile(path, "", "utf8");

  sharedGitConfig = path;
  process.env.GIT_CONFIG_GLOBAL = path;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TERMINAL_PROMPT = "0";
  return path;
}

/** Seeded bare remote; wrapped so the global Git isolation is in place first. */
export async function makeBareRemote(): Promise<BareRemote> {
  await isolateGit();
  return makeSeedBareRemote();
}

export interface TestHome {
  /** Temporary root that holds every artifact of one simulated machine. */
  root: string;
  /** `MEMSYNC_HOME` for this machine. */
  home: string;
  /** Default working directory for CLI calls. */
  workspace: string;
  /** Fake user home so nothing resolves to the real one. */
  userHome: string;
  claudeDir: string;
  codexDir: string;
  gitConfig: string;
  /** Placeholder CLI path referenced by installed hook commands. */
  cliPath: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Creates one isolated machine: a temp `MEMSYNC_HOME`, a temp HOME/USERPROFILE,
 * an empty `GIT_CONFIG_GLOBAL`, an isolated Claude config dir, an isolated
 * Codex home, and a workspace directory.
 */
export async function makeHome(prefix = "memsync-e2e"): Promise<TestHome> {
  await isolateGit();

  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const home = join(root, "memsync-home");
  const workspace = join(root, "workspace");
  const userHome = join(root, "user-home");
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  const gitConfig = join(root, "gitconfig");
  const cliPath = join(root, "memsync-cli.mjs");

  await Promise.all(
    [home, workspace, userHome, claudeDir, codexDir].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  await writeFile(gitConfig, "", "utf8");
  // The path only has to exist: doctor validates the script referenced by the
  // installed hook command, while e2e tests drive the CLI in-process.
  await writeFile(cliPath, "// placeholder CLI path for hook settings\n", "utf8");

  // Product-internal git calls (commit/push/pull) do not always forward the
  // caller's env, so point the process at this home's empty config as well.
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TERMINAL_PROMPT = "0";

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MEMSYNC_HOME: home,
    HOME: userHome,
    USERPROFILE: userHome,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    MEMSYS_HOST: "E2E-HOST",
    MEMSYS_TOOL: "",
    MEMSYS_SESSION: "",
    MEMSYNC_NO_MAINTENANCE: "1",
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    MEMSYNC_CLI_PATH: cliPath,
  };

  return {
    root,
    home,
    workspace,
    userHome,
    claudeDir,
    codexDir,
    gitConfig,
    cliPath,
    env,
  };
}

export interface CliRunResult {
  code: number;
  out: string;
  err: string;
}

export interface RunCliInOptions {
  stdin?: string;
  cwd?: string;
  /** Overrides merged over the home's base environment. */
  env?: NodeJS.ProcessEnv;
}

/** Runs the CLI in-process with one home's environment and captures output. */
export async function runCliIn(
  home: TestHome,
  argv: string[],
  options: RunCliInOptions = {},
): Promise<CliRunResult> {
  const out: string[] = [];
  const err: string[] = [];

  const io: CliIo = {
    cwd: options.cwd ?? home.workspace,
    env: { ...home.env, ...options.env },
    stdin: async () => options.stdin ?? "",
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => err.push(chunk),
  };

  const code = await runCli(argv, io);
  return { code, out: out.join(""), err: err.join("") };
}

/** Runs git inside a temp path with the home's isolated environment. */
export function gitIn(
  home: TestHome,
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...home.env, GIT_TERMINAL_PROMPT: "0" },
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim() || error.message;
          reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Runs git and returns trimmed stdout, throwing with stderr on failure. */
export async function gitOrThrowIn(
  home: TestHome,
  cwd: string,
  args: string[],
): Promise<string> {
  return (await gitIn(home, cwd, args)).stdout.trim();
}

export interface Workspace {
  dir: string;
  baseCommit: string;
}

/** Initializes a workspace repository with a local identity and one commit. */
export async function initWorkspace(
  home: TestHome,
  dir: string = home.workspace,
  label = "workspace",
): Promise<Workspace> {
  await mkdir(dir, { recursive: true });
  await gitOrThrowIn(home, dir, ["init"]);
  await gitOrThrowIn(home, dir, ["config", "user.name", "Test User"]);
  await gitOrThrowIn(home, dir, ["config", "user.email", "test@example.com"]);
  await gitOrThrowIn(home, dir, ["config", "core.autocrlf", "false"]);

  await writeFile(join(dir, "README.md"), `# ${label}\n`, "utf8");
  await gitOrThrowIn(home, dir, ["add", "--", "README.md"]);
  await gitOrThrowIn(home, dir, ["commit", "-m", "chore: init workspace"]);

  return {
    dir,
    baseCommit: await gitOrThrowIn(home, dir, ["rev-parse", "--short", "HEAD"]),
  };
}

/** Writes, stages, and commits one workspace file; returns the short SHA. */
export async function commitWorkspaceFile(
  home: TestHome,
  dir: string,
  filename: string,
  content: string,
  message = `feat: add ${filename}`,
): Promise<string> {
  const fullPath = join(dir, filename);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  await gitOrThrowIn(home, dir, ["add", "--", filename]);
  await gitOrThrowIn(home, dir, ["commit", "-m", message]);
  return gitOrThrowIn(home, dir, ["rev-parse", "--short", "HEAD"]);
}

export const DEFAULT_CONVENTIONS = `# 团队通用规范

## 必须

- MUST 所有代码变更走 MR

## 禁止

- MUST NOT 在日志中输出用户手机号
`;

export const DEFAULT_CONSTRAINTS = `# 核心约束（权威）

## 必须

- MUST 所有对外接口使用 internal/contract 中的 IDL

## 禁止

- MUST NOT 在 domain 层直接调用第三方 HTTP API

## 架构

- 服务分层：api → application → domain → infra

## 常用命令

- \`npm test\`
`;

export interface SeedProjectOptions {
  slug?: string;
  name?: string;
  repos?: string[];
  owners?: string[];
  version?: string;
  budgetChars?: number;
  constraints?: string;
  conventions?: string;
}

export interface SeededProject {
  slug: string;
  repos: string[];
  owners: string[];
  version: string;
  repoPath: string;
  projectDir: string;
}

/**
 * Creates a project through the CLI, then folds the customized authoritative
 * files into the scaffold commit. Keeping them in the introducing commit lets
 * `verify` treat them as the trusted baseline rather than a direct edit.
 */
export async function seedProject(
  home: TestHome,
  options: SeedProjectOptions = {},
): Promise<SeededProject> {
  const slug = options.slug ?? "checkout-service";
  const repos = options.repos ?? [`git@git.corp.com:shop/${slug}.git`];
  const owners = options.owners ?? ["alice@corp.com"];
  const version = options.version ?? "0.4.0";

  const argv = ["project", "add", slug];
  for (const repo of repos) argv.push("--repo", repo);
  for (const owner of owners) argv.push("--owner", owner);
  argv.push("--version", version);
  if (options.name !== undefined) argv.push("--name", options.name);

  const added = await runCliIn(home, argv, { cwd: home.home });
  if (added.code !== 0) {
    throw new Error(`seedProject: project add failed: ${added.err.trim()}`);
  }

  const repoPath = join(home.home, "repo");
  const projectDir = join(repoPath, "projects", slug);

  await writeFile(
    join(projectDir, "constraints.md"),
    options.constraints ?? DEFAULT_CONSTRAINTS,
    "utf8",
  );
  await writeFile(
    join(repoPath, "org", "conventions.md"),
    options.conventions ?? DEFAULT_CONVENTIONS,
    "utf8",
  );

  if (options.budgetChars !== undefined) {
    const metaPath = join(projectDir, "meta.yaml");
    const meta = await readFile(metaPath, "utf8");
    const line = `context_budget_chars: ${options.budgetChars}`;
    const updated = /^context_budget_chars:.*$/m.test(meta)
      ? meta.replace(/^context_budget_chars:.*$/m, line)
      : `${meta.trimEnd()}\n${line}\n`;
    await writeFile(metaPath, updated, "utf8");
  }

  await gitOrThrowIn(home, repoPath, ["add", "--", "projects", "org"]);
  await gitOrThrowIn(home, repoPath, ["commit", "--amend", "--no-edit"]);
  const branch = await gitOrThrowIn(home, repoPath, ["symbolic-ref", "--short", "HEAD"]);
  await gitOrThrowIn(home, repoPath, ["push", "--force", "origin", branch]);

  return { slug, repos, owners, version, repoPath, projectDir };
}

export interface MemoryRepoOptions extends SeedProjectOptions {
  /** Initialize and link the admin workspace (default true). */
  linkWorkspace?: boolean;
}

export interface MemoryRepoSetup {
  remote: BareRemote;
  admin: TestHome;
  project: SeededProject;
  /** The admin's linked workspace. */
  workspace: string;
}

/**
 * Creates a bare remote plus an initialized admin home with one project. The
 * remote's default branch is normalized to `main` so later clones, pushes, and
 * the maintenance policy all agree on one mainline.
 */
export async function makeMemoryRepo(
  options: MemoryRepoOptions = {},
): Promise<MemoryRepoSetup> {
  const remote = await makeBareRemote();
  const admin = await makeHome("memsync-e2e-repo");
  const owners = options.owners ?? ["alice@corp.com"];

  const init = await runCliIn(
    admin,
    [
      "init",
      "--remote",
      remote.remote,
      "--name",
      "Alice",
      "--email",
      owners[0] ?? "alice@corp.com",
    ],
    { cwd: admin.root },
  );
  if (init.code !== 0) {
    throw new Error(`makeMemoryRepo: init failed: ${init.err.trim()}`);
  }

  const repoPath = join(admin.home, "repo");
  const currentBranch = await gitOrThrowIn(admin, repoPath, [
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  if (currentBranch !== "main") {
    await gitOrThrowIn(admin, repoPath, ["branch", "-m", "main"]);
  }
  await gitOrThrowIn(admin, repoPath, ["push", "-u", "origin", "main"]);

  // New clones must land on the team branch, not the throwaway seed branch.
  await gitOrThrowIn(admin, remote.remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  if (currentBranch !== "main") {
    await gitIn(admin, repoPath, ["push", "origin", "--delete", "master"]).catch(
      () => undefined,
    );
  }

  const { linkWorkspace: _linkWorkspace, ...seedOptions } = options;
  const project = await seedProject(admin, { ...seedOptions, owners });

  if (options.linkWorkspace !== false) {
    await initWorkspace(admin, admin.workspace, project.slug);
    const linked = await runCliIn(admin, ["link", project.slug], {
      cwd: admin.workspace,
    });
    if (linked.code !== 0) {
      throw new Error(`makeMemoryRepo: link failed: ${linked.err.trim()}`);
    }
  }

  return { remote, admin, project, workspace: admin.workspace };
}

/** Builds the stdin payload a Claude Code hook receives. */
export function fakeClaudeHook(
  payload: Record<string, unknown> = {},
): string {
  return JSON.stringify({ source: "startup", ...payload });
}
