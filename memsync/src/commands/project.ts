import { CommanderError } from "commander";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import type { CliIo } from "../cli.js";
import { writeFileAtomic } from "../core/atomic.js";
import { gitOrThrow } from "../core/git.js";
import { detectDefaultBranch, memoryRepoForEnv } from "../core/project.js";
import { commitPaths, isGitRepo, pushWithRetry } from "../core/repo.js";
import {
  DEFAULT_CONTEXT_BUDGET_CHARS,
  DEFAULT_MAINTENANCE,
  isValidEmail,
  isValidSlug,
  type ProjectConfig,
} from "../core/schema.js";
import type { CommandModule } from "./index.js";

const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";

const CONSTRAINTS_TEMPLATE = `# 核心约束（权威）

<!-- 本文件只能通过 \`memsync approve\` 修改；直接编辑会被 \`memsync verify\` 报告。 -->

## 必须

## 禁止

## 架构

## 常用命令
`;

const CONVENTIONS_TEMPLATE = `# 团队通用规范

<!-- 本文件只能通过 \`memsync approve\` 修改；直接编辑会被 \`memsync verify\` 报告。 -->

## 必须

## 禁止

## 架构

## 常用命令
`;

const STATE_TEMPLATE = `# 当前状态

<!-- memsync:derived:begin -->
<!-- memsync:derived:end -->

## 人工备注
`;

const GOVERNANCE_TEMPLATE = stringify({ owners: [] });

const PROJECT_DIRECTORIES = ["journal", "decisions", "proposals", "versions", "archive"];
const PLACEHOLDER_FILE = ".gitkeep";

interface AddOptions {
  repo?: string[];
  owner?: string[];
  name?: string;
  version?: string;
  defaultBranch?: string;
}

function collect(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function writeIfAbsent(path: string, content: string): Promise<void> {
  if (await pathExists(path)) return;
  await writeFileAtomic(path, content);
}

function fail(io: CliIo, label: string, code: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  io.stderr(`${label}: ${message}\n`);
  throw new CommanderError(1, code, message);
}

async function runProjectAdd(io: CliIo, slug: string, options: AddOptions): Promise<void> {
  const normalizedSlug = slug;
  if (!isValidSlug(normalizedSlug)) {
    throw new Error(
      `invalid slug "${slug}"; use lowercase letters, digits, and hyphens (e.g. checkout-service)`,
    );
  }

  const repos = (options.repo ?? []).map((repo) => repo.trim()).filter((repo) => repo.length > 0);
  if (repos.length === 0) {
    throw new Error("at least one --repo <url> is required");
  }

  const owners = (options.owner ?? []).map((owner) => owner.trim()).filter((owner) => owner.length > 0);
  if (owners.length === 0) {
    throw new Error("at least one --owner <email> is required");
  }
  for (const owner of owners) {
    if (!isValidEmail(owner)) throw new Error(`invalid owner email: ${owner}`);
  }

  const memoryRepo = await memoryRepoForEnv(io.env);
  if (!(await isGitRepo(memoryRepo))) {
    throw new Error(`memory repo not found at ${memoryRepo}; run memsync init first`);
  }

  const projectDir = join(memoryRepo, "projects", normalizedSlug);
  if (await pathExists(projectDir)) {
    throw new Error(`project ${normalizedSlug} already exists at ${projectDir}`);
  }

  const name = options.name?.trim();
  const requestedBranch = options.defaultBranch?.trim();
  const defaultBranch =
    requestedBranch !== undefined && requestedBranch.length > 0
      ? requestedBranch
      : await detectDefaultBranch(memoryRepo, io.env);
  const meta: ProjectConfig = {
    slug: normalizedSlug,
    ...(name && name.length > 0 ? { name } : {}),
    repos,
    owners,
    default_branch: defaultBranch,
    current_version: options.version?.trim() || "0.1.0",
    version_status: "active",
    context_budget_chars: DEFAULT_CONTEXT_BUDGET_CHARS,
    maintenance: { ...DEFAULT_MAINTENANCE },
    created: new Date().toISOString().slice(0, 10),
  };

  const projectsDir = join(memoryRepo, "projects");
  const stagingDir = join(projectsDir, `.tmp-${normalizedSlug}`);
  await mkdir(projectsDir, { recursive: true });
  // A stale staging directory from an interrupted run must never block a retry.
  await rm(stagingDir, { recursive: true, force: true });

  try {
    for (const directory of PROJECT_DIRECTORIES) {
      await mkdir(join(stagingDir, directory), { recursive: true });
      // Git cannot track empty directories; keep the scaffold on clone.
      await writeFileAtomic(join(stagingDir, directory, PLACEHOLDER_FILE), "");
    }

    await writeFileAtomic(join(stagingDir, "meta.yaml"), stringify(meta, { lineWidth: 0 }));
    await writeFileAtomic(join(stagingDir, "constraints.md"), CONSTRAINTS_TEMPLATE);
    await writeFileAtomic(join(stagingDir, "state.md"), STATE_TEMPLATE);
    await writeIfAbsent(join(memoryRepo, "org", "conventions.md"), CONVENTIONS_TEMPLATE);
    await writeIfAbsent(join(memoryRepo, "org", "governance.yaml"), GOVERNANCE_TEMPLATE);

    await rename(stagingDir, projectDir);
  } catch (err) {
    // Never leave a partial project that would make a retry report "already exists".
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }

  // Force-add the placeholders so a repo-level .gitignore cannot hide them.
  const placeholders = PROJECT_DIRECTORIES.map(
    (directory) => `projects/${normalizedSlug}/${directory}/${PLACEHOLDER_FILE}`,
  );
  await gitOrThrow(["add", "-f", "--", ...placeholders], { cwd: memoryRepo });

  await commitPaths(
    memoryRepo,
    [`projects/${normalizedSlug}`, "org/conventions.md", "org/governance.yaml"],
    `feat: add project ${normalizedSlug}\n\n${TRAILER}`,
  );

  const pushed = await pushWithRetry(memoryRepo);
  if (!pushed.ok) {
    io.stderr(
      `Warning: project ${normalizedSlug} committed locally but push failed: ${
        pushed.reason ?? "unknown error"
      }\n`,
    );
  }

  io.stdout(`Created project ${normalizedSlug} at ${projectDir}\n`);
}

export const projectCommand: CommandModule = {
  name: "project",
  register(program, io) {
    program
      .command("project")
      .description("Manage projects in the memory repo")
      .command("add <slug>")
      .description("Create a project's memory scaffold, metadata, and org files")
      .option("--repo <url>", "code repository URL (repeatable)", collect)
      .requiredOption("--owner <email>", "project owner email (repeatable)", collect)
      .option("--name <name>", "human-readable project name")
      .option("--version <version>", "initial current_version", "0.1.0")
      .option(
        "--default-branch <branch>",
        "memory repo branch used for maintenance; detected from origin/HEAD by default",
      )
      .action(async (slug: string, options: AddOptions) => {
        try {
          await runProjectAdd(io, slug, options);
        } catch (err) {
          fail(io, "memsync project add", "memsync.project.add.failed", err);
        }
      });
  },
};
