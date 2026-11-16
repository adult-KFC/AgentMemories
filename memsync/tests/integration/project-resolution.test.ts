import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { gitOrThrow } from "../../src/core/git.js";
import {
  gitCommonDir,
  loadRepoMap,
  resolveProject,
  saveRepoMap,
} from "../../src/core/project.js";
import { SchemaError } from "../../src/core/schema.js";
import { commitFile } from "../helpers.js";

const MAINTAINANCE = { interval_hours: 72, cooldown_hours: 6, mainline_only: true };

function projectMeta(slug: string, repos: string[]) {
  return {
    slug,
    repos,
    owners: ["alice@corp.com"],
    current_version: "0.1.0",
    version_status: "active",
    context_budget_chars: 12000,
    maintenance: MAINTAINANCE,
  };
}

async function makeMemoryRepo(projects: Record<string, string[]>): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "memsync-memory-"));
  for (const [slug, repos] of Object.entries(projects)) {
    const dir = join(repo, "projects", slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.yaml"), stringify(projectMeta(slug, repos)), "utf8");
  }
  return repo;
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memsync-workspace-"));
  await gitOrThrow(["init"], { cwd: dir });
  await gitOrThrow(["config", "user.name", "Test User"], { cwd: dir });
  await gitOrThrow(["config", "user.email", "test@example.com"], { cwd: dir });
  return dir;
}

async function addRemote(workspace: string, name: string, url: string): Promise<void> {
  await gitOrThrow(["remote", "add", name, url], { cwd: workspace });
}

async function writeMemSyncJson(dir: string, value: unknown): Promise<void> {
  await writeFile(join(dir, ".memsync.json"), JSON.stringify(value), "utf8");
}

async function commonKey(workspace: string): Promise<string> {
  const common = await gitCommonDir(workspace);
  if (!common) throw new Error(`no common dir for ${workspace}`);
  return realpath(common);
}

async function mapHome(key: string, slug: string): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), "memsync-home-"));
  await saveRepoMap({ MEMSYNC_HOME: home } as NodeJS.ProcessEnv, { [key]: slug });
  return { MEMSYNC_HOME: home } as NodeJS.ProcessEnv;
}

describe("resolveProject", () => {
  it("resolves via .memsync.json before remotes", async () => {
    const memoryRepo = await makeMemoryRepo({
      "checkout-service": ["https://git.corp.com/shop/checkout-service"],
      "other-service": ["git@git.corp.com:shop/other-service.git"],
    });
    const workspace = await makeWorkspace();
    // The remote points at a different project; .memsync.json must win.
    await addRemote(workspace, "origin", "git@git.corp.com:shop/other-service.git");
    await writeMemSyncJson(workspace, { project: "checkout-service" });

    const result = await resolveProject(workspace, memoryRepo, {});

    expect(result).toMatchObject({ ok: true, slug: "checkout-service" });
    if (result.ok) {
      expect(result.projectDir).toBe(join(memoryRepo, "projects", "checkout-service"));
      expect(result.workspaceRoot).toBe(workspace);
      expect(result.meta.slug).toBe("checkout-service");
    }
  });

  it("finds .memsync.json in a parent directory and reports that root", async () => {
    const memoryRepo = await makeMemoryRepo({
      "checkout-service": ["https://git.corp.com/shop/checkout-service"],
    });
    const workspace = await makeWorkspace();
    const nested = join(workspace, "src", "deep");
    await mkdir(nested, { recursive: true });
    await writeMemSyncJson(workspace, { project: "checkout-service" });

    const result = await resolveProject(nested, memoryRepo, {});

    expect(result).toMatchObject({ ok: true, slug: "checkout-service" });
    if (result.ok) expect(result.workspaceRoot).toBe(workspace);
  });

  it("returns missing_meta when .memsync.json names an unknown project", async () => {
    const memoryRepo = await makeMemoryRepo({});
    const workspace = await makeWorkspace();
    await writeMemSyncJson(workspace, { project: "ghost" });

    expect(await resolveProject(workspace, memoryRepo, {})).toEqual({
      ok: false,
      reason: "missing_meta",
    });
  });

  it("throws SchemaError for a malformed .memsync.json", async () => {
    const memoryRepo = await makeMemoryRepo({});
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, ".memsync.json"), "{ not json", "utf8");

    await expect(resolveProject(workspace, memoryRepo, {})).rejects.toBeInstanceOf(SchemaError);
  });

  it("throws SchemaError when .memsync.json has no project string", async () => {
    const memoryRepo = await makeMemoryRepo({});
    const workspace = await makeWorkspace();
    await writeMemSyncJson(workspace, { project: 42 });

    await expect(resolveProject(workspace, memoryRepo, {})).rejects.toBeInstanceOf(SchemaError);
  });

  it("rejects path traversal and non-slug project values in .memsync.json", async () => {
    const memoryRepo = await makeMemoryRepo({});
    const workspace = await makeWorkspace();

    for (const project of ["../../elsewhere", "../school/checkout", "Checkout", "a/b"]) {
      await writeMemSyncJson(workspace, { project });
      await expect(resolveProject(workspace, memoryRepo, {})).rejects.toBeInstanceOf(SchemaError);
    }
  });

  it("matches all remotes and normalizes ssh against https", async () => {
    const memoryRepo = await makeMemoryRepo({
      "checkout-service": ["git@git.corp.com:shop/checkout-service.git"],
    });
    const workspace = await makeWorkspace();
    await addRemote(workspace, "origin", "https://github.com/irrelevant/elsewhere.git");
    await addRemote(workspace, "upstream", "https://git.corp.com/shop/checkout-service");

    const result = await resolveProject(workspace, memoryRepo, {});

    expect(result).toMatchObject({ ok: true, slug: "checkout-service" });
    if (result.ok) {
      expect(await realpath(result.workspaceRoot)).toBe(await realpath(workspace));
    }
  });

  it("returns ambiguous when remotes match more than one project", async () => {
    const memoryRepo = await makeMemoryRepo({
      "checkout-service": ["git@git.corp.com:shop/checkout-service.git"],
      "other-service": ["git@git.corp.com:shop/other-service.git"],
    });
    const workspace = await makeWorkspace();
    await addRemote(workspace, "origin", "git@git.corp.com:shop/checkout-service.git");
    await addRemote(workspace, "upstream", "git@git.corp.com:shop/other-service.git");

    expect(await resolveProject(workspace, memoryRepo, {})).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("resolves through the repo map keyed by the canonical common dir", async () => {
    const memoryRepo = await makeMemoryRepo({
      "checkout-service": ["git@git.corp.com:shop/checkout-service.git"],
    });
    const workspace = await makeWorkspace();
    await addRemote(workspace, "origin", "git@example.com:unrelated/thing.git");

    const env = await mapHome(await commonKey(workspace), "checkout-service");
    const result = await resolveProject(workspace, memoryRepo, env);

    expect(result).toMatchObject({ ok: true, slug: "checkout-service" });
    if (result.ok) expect(result.gitCommonDir).toBeTruthy();
  });

  it("returns missing_meta when the repo map points at an unknown project", async () => {
    const memoryRepo = await makeMemoryRepo({});
    const workspace = await makeWorkspace();
    const env = await mapHome(await commonKey(workspace), "ghost");

    expect(await resolveProject(workspace, memoryRepo, env)).toEqual({
      ok: false,
      reason: "missing_meta",
    });
  });

  it("rejects path traversal and non-slug values from the repo map", async () => {
    const memoryRepo = await makeMemoryRepo({});
    const workspace = await makeWorkspace();

    for (const value of ["../../elsewhere", "Checkout", "a/b"]) {
      const env = await mapHome(await commonKey(workspace), value);
      await expect(resolveProject(workspace, memoryRepo, env)).rejects.toBeInstanceOf(
        SchemaError,
      );
    }
  });

  it("resolves a linked worktree through the common dir map", async () => {
    const memoryRepo = await makeMemoryRepo({
      "checkout-service": ["git@git.corp.com:shop/checkout-service.git"],
    });
    const workspace = await makeWorkspace();
    await commitFile(workspace, "README.md", "seed\n");
    const worktree = `${workspace}-wt`;
    await gitOrThrow(["worktree", "add", worktree, "-b", "feature"], { cwd: workspace });

    const env = await mapHome(await commonKey(workspace), "checkout-service");
    const result = await resolveProject(worktree, memoryRepo, env);

    expect(result).toMatchObject({ ok: true, slug: "checkout-service" });
    if (result.ok) {
      expect(await realpath(result.workspaceRoot)).toBe(await realpath(worktree));
    }
  });

  it("returns unlinked when no .memsync.json, map entry, or remote matches", async () => {
    const memoryRepo = await makeMemoryRepo({
      "checkout-service": ["git@git.corp.com:shop/checkout-service.git"],
    });
    const workspace = await makeWorkspace();
    await addRemote(workspace, "origin", "git@example.com:unrelated/thing.git");

    expect(await resolveProject(workspace, memoryRepo, {})).toEqual({
      ok: false,
      reason: "unlinked",
    });
  });

  it("returns unlinked outside a git repository with no .memsync.json", async () => {
    const memoryRepo = await makeMemoryRepo({});
    const dir = await mkdtemp(join(tmpdir(), "memsync-plain-"));

    expect(await resolveProject(dir, memoryRepo, {})).toEqual({ ok: false, reason: "unlinked" });
  });
});

describe("repo map storage", () => {
  it("round-trips entries and creates the state directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-map-"));
    const env = { MEMSYNC_HOME: home } as NodeJS.ProcessEnv;
    const map = { "C:/work/repo/.git": "checkout-service", "C:/work/other/.git": "other" };

    await saveRepoMap(env, map);

    expect(await loadRepoMap(env)).toEqual(map);
  });

  it("returns an empty map when the file is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-map-"));
    expect(await loadRepoMap({ MEMSYNC_HOME: home } as NodeJS.ProcessEnv)).toEqual({});
  });
});
