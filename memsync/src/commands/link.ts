import { CommanderError } from "commander";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CliIo } from "../cli.js";
import { writeFileAtomic } from "../core/atomic.js";
import { runGit } from "../core/git.js";
import {
  gitCommonDir,
  loadRepoMap,
  memoryRepoForEnv,
  resolveProject,
  saveRepoMap,
} from "../core/project.js";
import {
  ProjectMetaNotFoundError,
  isValidSlug,
  readProjectMeta,
} from "../core/schema.js";
import type { CommandModule } from "./index.js";

const GIT_TIMEOUT_MS = 5_000;

function fail(io: CliIo, label: string, code: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  io.stderr(`${label}: ${message}\n`);
  throw new CommanderError(1, code, message);
}

async function gitWorkspaceRoot(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runGit(["rev-parse", "--show-toplevel"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    env,
  });
  if (result.code !== 0) return resolve(cwd);
  const value = result.stdout.trim();
  return value.length > 0 ? value : resolve(cwd);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * `.memsync/` holds session pointers and prompt markers; it is runtime state,
 * never code to commit. Append it to the workspace .gitignore once.
 */
async function ensureMemsyncIgnored(workspace: string): Promise<void> {
  const path = join(workspace, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const lines = existing.split(/\r?\n/);
  if (lines.some((line) => line.trim() === ".memsync/" || line.trim() === ".memsync")) {
    return;
  }

  const prefix =
    existing.length === 0 ? "" : existing.endsWith("\n") ? existing : `${existing}\n`;
  await writeFileAtomic(path, `${prefix}.memsync/\n`);
}

async function runLink(io: CliIo, slugArg?: string): Promise<void> {
  const memoryRepo = await memoryRepoForEnv(io.env);

  let slug: string;
  let workspaceRoot: string;

  if (slugArg !== undefined) {
    slug = slugArg;
    if (!isValidSlug(slug)) {
      throw new Error(
        `invalid slug "${slugArg}"; use lowercase letters, digits, and hyphens (e.g. checkout-service)`,
      );
    }
    try {
      await readProjectMeta(join(memoryRepo, "projects", slug));
    } catch (err) {
      if (err instanceof ProjectMetaNotFoundError) {
        throw new Error(`project ${slug} not found in ${memoryRepo}`);
      }
      throw err;
    }
    workspaceRoot = await gitWorkspaceRoot(io.cwd, io.env);
  } else {
    const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
    if (!resolution.ok) {
      if (resolution.reason === "ambiguous") {
        throw new Error(
          "multiple projects match this workspace; pass a slug: memsync link <slug>",
        );
      }
      if (resolution.reason === "missing_meta") {
        throw new Error(
          "the workspace points at a project whose meta.yaml is missing; run memsync project add <slug>",
        );
      }
      throw new Error("workspace is not linked to a project; pass a slug: memsync link <slug>");
    }
    slug = resolution.slug;
    workspaceRoot = resolution.workspaceRoot;
  }

  const pointerPath = join(workspaceRoot, ".memsync.json");
  await writeFileAtomic(pointerPath, `${JSON.stringify({ project: slug }, null, 2)}\n`);
  await ensureMemsyncIgnored(workspaceRoot);

  const common = await gitCommonDir(workspaceRoot, io.env);
  if (common) {
    const map = await loadRepoMap(io.env);
    map[await canonicalPath(common)] = slug;
    await saveRepoMap(io.env, map);
  } else {
    io.stderr(
      `Warning: ${workspaceRoot} is not a git repository; the repo map was not updated\n`,
    );
  }

  io.stdout(`Linked ${workspaceRoot} to project ${slug}\n`);
  io.stdout("Commit .memsync.json so teammates resolve this project automatically.\n");
}

export const linkCommand: CommandModule = {
  name: "link",
  register(program, io) {
    program
      .command("link [slug]")
      .description("Bind the current workspace to a project and write .memsync.json")
      .action(async (slug?: string) => {
        try {
          await runLink(io, slug);
        } catch (err) {
          fail(io, "memsync link", "memsync.link.failed", err);
        }
      });
  },
};
