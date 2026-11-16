import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { loadConfig, memsyncHome } from "./config.js";
import { runGit } from "./git.js";
import { statePath } from "./paths.js";
import {
  ProjectMetaNotFoundError,
  SchemaError,
  isValidSlug,
  readProjectMeta,
  type ProjectConfig,
} from "./schema.js";

const GIT_TIMEOUT_MS = 5_000;

export type RepoMap = Record<string, string>;

export type ProjectResolution =
  | {
      ok: true;
      slug: string;
      meta: ProjectConfig;
      projectDir: string;
      workspaceRoot: string;
      gitCommonDir?: string;
    }
  | { ok: false; reason: "unlinked" | "missing_meta" | "ambiguous" };

/** Resolves the memory repo from config, falling back to $MEMSYNC_HOME/repo. */
export async function memoryRepoForEnv(env: NodeJS.ProcessEnv): Promise<string> {
  const config = await loadConfig(env);
  return config?.repoPath ?? join(memsyncHome(env), "repo");
}

/** Reads the local repo map; a missing or corrupt file behaves as an empty map. */
export async function loadRepoMap(env: NodeJS.ProcessEnv): Promise<RepoMap> {
  let raw: string;
  try {
    raw = await readFile(statePath(env, "repo-map.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const map: RepoMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) map[key] = value;
  }
  return map;
}

/** Writes the repo map atomically with sorted keys for stable diffs. */
export async function saveRepoMap(env: NodeJS.ProcessEnv, map: RepoMap): Promise<void> {
  const sorted: RepoMap = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  await writeFileAtomic(statePath(env, "repo-map.json"), `${JSON.stringify(sorted, null, 2)}\n`);
}

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

function stripRepoSuffix(value: string): string {
  let result = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  result = result.replace(/\.git$/i, "").replace(/\/+$/, "");
  return result.replace(/^\/+/, "");
}

/**
 * Returns a stable matching key for a Git remote: lowercase `host/path` with
 * `.git` and trailing slashes removed. SSH, SCP-like, HTTPS, and file/local
 * forms normalize consistently so one repository always maps to one key.
 */
export function normalizeRepoUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "";

  const scheme = SCHEME_PATTERN.exec(trimmed);
  if (scheme) {
    if (scheme[1].toLowerCase() === "file") {
      return stripRepoSuffix(trimmed.replace(/^file:\/\//i, "")).toLowerCase();
    }

    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      const path = stripRepoSuffix(decodeURIComponent(parsed.pathname)).toLowerCase();
      return path.length > 0 ? `${host}/${path}` : host;
    } catch {
      // Fall through to the generic path handling below.
    }
  } else if (!/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    const scp = /^(?:[^@/\\:]+@)?([^/\\:]+):(.+)$/.exec(trimmed);
    if (scp) {
      const host = scp[1].toLowerCase();
      const path = stripRepoSuffix(scp[2]).toLowerCase();
      return path.length > 0 ? `${host}/${path}` : host;
    }
  }

  return stripRepoSuffix(trimmed).toLowerCase();
}

async function gitCommonDirWithEnv(
  workspace: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string | undefined> {
  const result = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: workspace, timeoutMs: GIT_TIMEOUT_MS, env },
  );
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

/** Absolute git common dir for a workspace, or undefined when not in Git. */
export function gitCommonDir(
  workspace: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return gitCommonDirWithEnv(workspace, env);
}

async function gitTopLevel(
  workspace: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--show-toplevel"], {
    cwd: workspace,
    timeoutMs: GIT_TIMEOUT_MS,
    env,
  });
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Memory repo root for `<repo>/projects/<slug>`. */
export function repoRootFromProject(projectDir: string): string {
  return dirname(dirname(projectDir));
}

/**
 * The memory repo's default branch: `refs/remotes/origin/HEAD` when the
 * remote advertises one, otherwise the current branch, otherwise `main`.
 * Used by `project add` so a `master` memory repo is not silently recorded as
 * `main` (which would disable maintenance).
 */
export async function detectDefaultBranch(
  repoPath: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  // The remote's own advertisement is authoritative; a local
  // refs/remotes/origin/HEAD can be stale after the branch is renamed.
  const remoteHead = await runGit(["ls-remote", "--symref", "origin", "HEAD"], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
    env,
  });
  if (remoteHead.code === 0) {
    const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(remoteHead.stdout);
    if (match !== null) return match[1];
  }

  const originHead = await runGit(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS, env },
  );
  if (originHead.code === 0) {
    const value = originHead.stdout.trim();
    if (value.length > 0) {
      return value.startsWith("origin/") ? value.slice("origin/".length) : value;
    }
  }

  const current = await runGit(["branch", "--show-current"], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
    env,
  });
  if (current.code === 0) {
    const value = current.stdout.trim();
    if (value.length > 0) return value;
  }

  return "main";
}

/** True when `branch` exists as a remote-tracking or local ref. */
export async function defaultBranchResolvable(
  repoPath: string,
  branch: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const result = await runGit(["rev-parse", "--verify", "--quiet", ref], {
      cwd: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      env,
    });
    if (result.code === 0) return true;
  }
  return false;
}

function mapLookup(map: RepoMap, raw: string, canonical: string): string | undefined {
  const candidates = [canonical, raw, canonical.replace(/\\/g, "/"), raw.replace(/\\/g, "/")];
  for (const key of candidates) {
    const hit = map[key];
    if (hit !== undefined) return hit;
  }

  const wanted = canonical.replace(/\\/g, "/").toLowerCase();
  for (const [key, slug] of Object.entries(map)) {
    if (key.replace(/\\/g, "/").toLowerCase() === wanted) return slug;
  }
  return undefined;
}

async function findPointer(start: string): Promise<{ dir: string; slug: string } | undefined> {
  let current = resolve(start);

  for (;;) {
    const candidate = join(current, ".memsync.json");
    let raw: string | undefined;
    try {
      raw = await readFile(candidate, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (raw !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new SchemaError(`Invalid .memsync.json at ${candidate}`, { cause: err });
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new SchemaError(`Invalid .memsync.json at ${candidate}: expected an object`);
      }
      const project = (parsed as Record<string, unknown>).project;
      if (typeof project !== "string" || project.trim().length === 0) {
        throw new SchemaError(
          `Invalid .memsync.json at ${candidate}: "project" must be a non-empty string`,
        );
      }
      const slug = project.trim();
      if (!isValidSlug(slug)) {
        throw new SchemaError(
          `Invalid .memsync.json at ${candidate}: "project" must be a lowercase slug`,
        );
      }
      return { dir: current, slug };
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function loadMetaForSlug(
  memoryRepo: string,
  slug: string,
): Promise<{ meta: ProjectConfig; projectDir: string } | undefined> {
  // Repo-map values are local cache data; reject path-like values before they
  // can escape projects/ via path.join.
  if (!isValidSlug(slug)) {
    throw new SchemaError(`Invalid project slug "${slug}" in repo map`);
  }
  const projectDir = join(memoryRepo, "projects", slug);
  try {
    return { meta: await readProjectMeta(projectDir), projectDir };
  } catch (err) {
    if (err instanceof ProjectMetaNotFoundError) return undefined;
    throw err;
  }
}

async function listProjectMetas(
  memoryRepo: string,
): Promise<Array<{ slug: string; meta: ProjectConfig }>> {
  let entries;
  try {
    entries = await readdir(join(memoryRepo, "projects"), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const projects: Array<{ slug: string; meta: ProjectConfig }> = [];
  for (const entry of entries) {
    // Staging directories from an interrupted `project add` are not projects.
    if (!entry.isDirectory() || entry.name.startsWith(".tmp-")) continue;
    try {
      const meta = await readProjectMeta(join(memoryRepo, "projects", entry.name));
      projects.push({ slug: entry.name, meta });
    } catch (err) {
      if (err instanceof ProjectMetaNotFoundError) continue;
      throw err;
    }
  }
  return projects;
}

async function listRemoteUrls(
  workspace: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string[]> {
  const namesResult = await runGit(["remote"], {
    cwd: workspace,
    timeoutMs: GIT_TIMEOUT_MS,
    env,
  });
  if (namesResult.code !== 0) return [];

  const names = namesResult.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const ordered = names.includes("origin")
    ? ["origin", ...names.filter((name) => name !== "origin")]
    : names;

  const urls: string[] = [];
  for (const name of ordered) {
    const result = await runGit(["remote", "get-url", name], {
      cwd: workspace,
      timeoutMs: GIT_TIMEOUT_MS,
      env,
    });
    if (result.code !== 0) continue;
    const url = result.stdout.trim();
    if (url.length > 0) urls.push(url);
  }
  return urls;
}

/**
 * Resolves the project bound to a workspace, in spec order:
 * `.memsync.json` (walking up), the common-dir repo map, then any remote
 * matched against `meta.repos`. Malformed `.memsync.json` is a schema error.
 */
export async function resolveProject(
  cwd: string,
  memoryRepo: string,
  env: NodeJS.ProcessEnv,
): Promise<ProjectResolution> {
  const common = await gitCommonDirWithEnv(cwd, env);
  const withCommon = common ? { gitCommonDir: common } : {};

  const pointer = await findPointer(cwd);
  if (pointer) {
    const found = await loadMetaForSlug(memoryRepo, pointer.slug);
    if (!found) return { ok: false, reason: "missing_meta" };
    return {
      ok: true,
      slug: pointer.slug,
      meta: found.meta,
      projectDir: found.projectDir,
      workspaceRoot: pointer.dir,
      ...withCommon,
    };
  }

  if (common) {
    const map = await loadRepoMap(env);
    const slug = mapLookup(map, common, await canonicalPath(common));
    if (slug !== undefined) {
      const found = await loadMetaForSlug(memoryRepo, slug);
      if (!found) return { ok: false, reason: "missing_meta" };
      return {
        ok: true,
        slug,
        meta: found.meta,
        projectDir: found.projectDir,
        workspaceRoot: (await gitTopLevel(cwd, env)) ?? resolve(cwd),
        ...withCommon,
      };
    }
  }

  const remotes = await listRemoteUrls(cwd, env);
  if (remotes.length > 0) {
    const wanted = new Set(remotes.map(normalizeRepoUrl).filter((key) => key.length > 0));
    const projects = await listProjectMetas(memoryRepo);
    const matches = projects.filter((project) =>
      project.meta.repos.some((repo) => wanted.has(normalizeRepoUrl(repo))),
    );

    if (matches.length > 1) return { ok: false, reason: "ambiguous" };
    if (matches.length === 1) {
      const [match] = matches;
      return {
        ok: true,
        slug: match.slug,
        meta: match.meta,
        projectDir: join(memoryRepo, "projects", match.slug),
        workspaceRoot: (await gitTopLevel(cwd, env)) ?? resolve(cwd),
        ...withCommon,
      };
    }
  }

  return { ok: false, reason: "unlinked" };
}
