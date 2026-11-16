import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { runCli, type CliIo } from "../../src/cli.js";
import { gitOrThrow } from "../../src/core/git.js";
import { gitCommonDir, loadRepoMap } from "../../src/core/project.js";
import { readProjectMeta } from "../../src/core/schema.js";
import { makeBareRemote } from "../helpers.js";

interface Captured {
  io: CliIo;
  out: string[];
  err: string[];
}

function capture(cwd: string, env: NodeJS.ProcessEnv): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      cwd,
      env,
      stdin: async () => "",
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    },
  };
}

/** Preserves the machine's Git config while pinning the memsync home and prompts. */
function envFor(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    MEMSYNC_HOME: home,
    ...overrides,
  };
}

interface CommandResult {
  code: number;
  out: string;
  err: string;
}

async function run(home: string, argv: string[], cwd: string = home): Promise<CommandResult> {
  const captured = capture(cwd, envFor(home));
  const code = await runCli(argv, captured.io);
  return { code, out: captured.out.join(""), err: captured.err.join("") };
}

async function setupMemoryHome(): Promise<{ remote: string; dir: string; home: string }> {
  const bare = await makeBareRemote();
  const home = await mkdtemp(join(tmpdir(), "memsync-home-"));
  const result = await run(home, [
    "init",
    "--remote",
    bare.remote,
    "--name",
    "Alice",
    "--email",
    "alice@corp.com",
  ]);
  expect(result.code).toBe(0);
  return { remote: bare.remote, dir: bare.dir, home };
}

async function addProject(
  home: string,
  slug: string,
  repos: string[] = [`git@git.corp.com:shop/${slug}.git`],
  extra: string[] = [],
): Promise<CommandResult> {
  const repoArgs = repos.flatMap((repo) => ["--repo", repo]);
  const result = await run(home, [
    "project",
    "add",
    slug,
    ...repoArgs,
    "--owner",
    "alice@corp.com",
    ...extra,
  ]);
  expect(result.code).toBe(0);
  return result;
}

async function makeWorkspace(remote?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memsync-workspace-"));
  await gitOrThrow(["init"], { cwd: dir });
  await gitOrThrow(["config", "user.name", "Test User"], { cwd: dir });
  await gitOrThrow(["config", "user.email", "test@example.com"], { cwd: dir });
  if (remote) await gitOrThrow(["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

async function commonKey(workspace: string): Promise<string> {
  const common = await gitCommonDir(workspace);
  if (!common) throw new Error(`no common dir for ${workspace}`);
  return realpath(common);
}

async function commitSeed(workspace: string): Promise<void> {
  await writeFile(join(workspace, "README.md"), "seed\n", "utf8");
  await gitOrThrow(["add", "--", "README.md"], { cwd: workspace });
  await gitOrThrow(["commit", "-m", "chore: seed"], { cwd: workspace });
}

describe("memsync project add", () => {
  it("creates the project scaffold, commits it, and pushes", async () => {
    const { home, remote, dir } = await setupMemoryHome();

    const result = await addProject(
      home,
      "checkout-service",
      ["git@git.corp.com:shop/checkout-service.git", "https://git.corp.com/shop/checkout-service"],
      ["--name", "结算服务", "--version", "0.4.0"],
    );

    expect(result.out).toContain("checkout-service");

    const repo = join(home, "repo");
    const projectDir = join(repo, "projects", "checkout-service");
    for (const sub of ["journal", "decisions", "proposals", "versions", "archive"]) {
      expect((await stat(join(projectDir, sub))).isDirectory()).toBe(true);
    }

    const meta = await readProjectMeta(projectDir);
    expect(meta).toMatchObject({
      slug: "checkout-service",
      name: "结算服务",
      repos: [
        "git@git.corp.com:shop/checkout-service.git",
        "https://git.corp.com/shop/checkout-service",
      ],
      owners: ["alice@corp.com"],
      current_version: "0.4.0",
      version_status: "active",
      context_budget_chars: 12000,
      maintenance: { interval_hours: 72, cooldown_hours: 6, mainline_only: true },
    });
    expect(meta.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const constraints = await readFile(join(projectDir, "constraints.md"), "utf8");
    expect(constraints).toContain("# 核心约束（权威）");
    expect(constraints).toContain("memsync approve");
    expect(constraints).toContain("## 必须");
    expect(constraints).toContain("## 禁止");

    const state = await readFile(join(projectDir, "state.md"), "utf8");
    expect(state).toContain("<!-- memsync:derived:begin -->");
    expect(state).toContain("<!-- memsync:derived:end -->");
    expect(state).toContain("## 人工备注");

    const conventions = await readFile(join(repo, "org", "conventions.md"), "utf8");
    expect(conventions).toContain("# 团队通用规范");
    expect(conventions).toContain("## 必须");

    const governance = parse(await readFile(join(repo, "org", "governance.yaml"), "utf8"));
    expect(governance).toEqual({ owners: [] });

    const message = await gitOrThrow(["log", "-1", "--pretty=%B"], { cwd: repo });
    expect(message).toContain("project checkout-service");
    expect(message).toContain("Co-Authored-By: Claude Code <noreply@anthropic.com>");

    const files = (
      await gitOrThrow(["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: repo })
    )
      .split(/\r?\n/)
      .filter(Boolean);
    for (const path of [
      "projects/checkout-service/meta.yaml",
      "projects/checkout-service/constraints.md",
      "projects/checkout-service/state.md",
      "projects/checkout-service/journal/.gitkeep",
      "projects/checkout-service/decisions/.gitkeep",
      "projects/checkout-service/proposals/.gitkeep",
      "projects/checkout-service/versions/.gitkeep",
      "projects/checkout-service/archive/.gitkeep",
      "org/conventions.md",
      "org/governance.yaml",
    ]) {
      expect(files).toContain(path);
    }

    // The commit was pushed: a fresh clone of the remote has the project and
    // every scaffold directory, even though Git cannot track empty dirs.
    const verifyDir = await mkdtemp(join(tmpdir(), "memsync-verify-"));
    const clonePath = join(verifyDir, "verify");
    await gitOrThrow(["clone", "-c", "core.autocrlf=false", remote, clonePath], {
      cwd: verifyDir,
    });
    const cloneProjectDir = join(clonePath, "projects", "checkout-service");
    expect((await readProjectMeta(cloneProjectDir)).slug).toBe("checkout-service");
    for (const sub of ["journal", "decisions", "proposals", "versions", "archive"]) {
      expect((await stat(join(cloneProjectDir, sub))).isDirectory()).toBe(true);
      expect((await stat(join(cloneProjectDir, sub, ".gitkeep"))).isFile()).toBe(true);
    }
  });

  it("detects a master memory repo instead of hardcoding main", async () => {
    // The bare test remote is seeded on its default `master` branch.
    const { home, remote } = await setupMemoryHome();
    const branch = await gitOrThrow(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd: join(home, "repo") },
    );
    expect(branch).toBe("origin/master");

    await addProject(home, "checkout-service", undefined, ["--default-branch", "master"]);

    const meta = await readProjectMeta(join(home, "repo", "projects", "checkout-service"));
    expect(meta.default_branch).toBe("master");
    expect(remote).toBeTruthy();
  });

  it("detects the remote default branch and allows --default-branch to override it", async () => {
    const { home } = await setupMemoryHome();

    await addProject(home, "detected-service");
    const detected = await readProjectMeta(
      join(home, "repo", "projects", "detected-service"),
    );
    expect(detected.default_branch).toBe("master");

    await addProject(home, "release-service", undefined, [
      "--default-branch",
      "release/1.0",
    ]);
    const overridden = await readProjectMeta(
      join(home, "repo", "projects", "release-service"),
    );
    expect(overridden.default_branch).toBe("release/1.0");
  });

  it("tracks scaffold placeholders even when the repo ignores .gitkeep", async () => {
    const { home } = await setupMemoryHome();
    const repo = join(home, "repo");
    await writeFile(join(repo, ".gitignore"), ".gitkeep\n", "utf8");

    await addProject(home, "checkout-service");

    const files = (
      await gitOrThrow(["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: repo })
    )
      .split(/\r?\n/)
      .filter(Boolean);
    for (const sub of ["journal", "decisions", "proposals", "versions", "archive"]) {
      expect(files).toContain(`projects/checkout-service/${sub}/.gitkeep`);
    }
  });

  it("removes staging when a write fails and allows a retry", async () => {
    const { home } = await setupMemoryHome();
    const repo = join(home, "repo");
    // A file where the org directory must go makes the org write fail mid-add.
    await writeFile(join(repo, "org"), "blocker", "utf8");

    const failed = await run(home, [
      "project",
      "add",
      "checkout-service",
      "--repo",
      "git@git.corp.com:shop/checkout-service.git",
      "--owner",
      "alice@corp.com",
    ]);

    expect(failed.code).not.toBe(0);
    expect(existsSync(join(repo, "projects", "checkout-service"))).toBe(false);
    expect(existsSync(join(repo, "projects", ".tmp-checkout-service"))).toBe(false);

    await rm(join(repo, "org"), { force: true });
    expect((await addProject(home, "checkout-service")).code).toBe(0);
    expect(existsSync(join(repo, "projects", "checkout-service", "meta.yaml"))).toBe(true);
  });

  it("does not let a stale staging directory block a retry", async () => {
    const { home } = await setupMemoryHome();
    const repo = join(home, "repo");
    const stale = join(repo, "projects", ".tmp-checkout-service");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "leftover.txt"), "stale", "utf8");

    await addProject(home, "checkout-service");

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(repo, "projects", "checkout-service", "meta.yaml"))).toBe(true);
  });

  it("refuses to overwrite an existing project", async () => {
    const { home } = await setupMemoryHome();
    await addProject(home, "checkout-service", undefined, ["--version", "0.1.0"]);

    const second = await run(home, [
      "project",
      "add",
      "checkout-service",
      "--repo",
      "git@git.corp.com:shop/checkout-service.git",
      "--owner",
      "bob@corp.com",
      "--version",
      "9.9.9",
    ]);

    expect(second.code).not.toBe(0);
    expect(second.err).toMatch(/already exists/i);
    const meta = await readProjectMeta(
      join(home, "repo", "projects", "checkout-service"),
    );
    expect(meta.current_version).toBe("0.1.0");
    expect(meta.owners).toEqual(["alice@corp.com"]);
  });

  it("validates the slug", async () => {
    const { home } = await setupMemoryHome();
    const result = await run(home, [
      "project",
      "add",
      "Bad Slug",
      "--repo",
      "git@git.corp.com:shop/x.git",
      "--owner",
      "alice@corp.com",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/slug/i);
    expect(existsSync(join(home, "repo", "projects", "Bad Slug"))).toBe(false);
  });

  it("requires --owner to be an email", async () => {
    const { home } = await setupMemoryHome();

    const missing = await run(home, [
      "project",
      "add",
      "checkout-service",
      "--repo",
      "git@git.corp.com:shop/checkout-service.git",
    ]);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toMatch(/owner/i);

    const invalid = await run(home, [
      "project",
      "add",
      "checkout-service",
      "--repo",
      "git@git.corp.com:shop/checkout-service.git",
      "--owner",
      "not-an-email",
    ]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.err).toMatch(/email/i);
  });

  it("requires at least one --repo", async () => {
    const { home } = await setupMemoryHome();
    const result = await run(home, [
      "project",
      "add",
      "checkout-service",
      "--owner",
      "alice@corp.com",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/repo/i);
  });

  it("treats a failed push as a warning", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-home-"));
    const repo = join(home, "repo");
    await mkdir(repo, { recursive: true });
    await gitOrThrow(["init"], { cwd: repo });
    await gitOrThrow(["config", "user.name", "Alice"], { cwd: repo });
    await gitOrThrow(["config", "user.email", "alice@corp.com"], { cwd: repo });

    const result = await run(home, [
      "project",
      "add",
      "solo-service",
      "--repo",
      "git@example.com:team/solo-service.git",
      "--owner",
      "alice@corp.com",
    ]);

    expect(result.code).toBe(0);
    expect(result.err).toMatch(/push/i);
    expect(existsSync(join(repo, "projects", "solo-service", "meta.yaml"))).toBe(true);
    expect(await gitOrThrow(["log", "-1", "--pretty=%s"], { cwd: repo })).toContain(
      "solo-service",
    );
  });

  it("does not overwrite existing org files", async () => {
    const { home } = await setupMemoryHome();
    const repo = join(home, "repo");
    await mkdir(join(repo, "org"), { recursive: true });
    await writeFile(join(repo, "org", "conventions.md"), "# Custom conventions\n", "utf8");
    await writeFile(join(repo, "org", "governance.yaml"), "owners:\n  - lead@corp.com\n", "utf8");

    await addProject(home, "checkout-service");

    expect(await readFile(join(repo, "org", "conventions.md"), "utf8")).toBe(
      "# Custom conventions\n",
    );
    expect(parse(await readFile(join(repo, "org", "governance.yaml"), "utf8"))).toEqual({
      owners: ["lead@corp.com"],
    });
  });
});

describe("memsync link", () => {
  it("writes .memsync.json, updates the repo map, and hints at committing it", async () => {
    const { home } = await setupMemoryHome();
    await addProject(home, "checkout-service", [
      "git@git.corp.com:shop/checkout-service.git",
    ]);
    const workspace = await makeWorkspace("https://git.corp.com/shop/checkout-service");

    const result = await run(home, ["link", "checkout-service"], workspace);

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/commit/i);
    const pointer = JSON.parse(await readFile(join(workspace, ".memsync.json"), "utf8"));
    expect(pointer).toEqual({ project: "checkout-service" });

    const map = await loadRepoMap(envFor(home));
    expect(map[await commonKey(workspace)]).toBe("checkout-service");
  });

  it("resolves the slug from a matching remote when omitted", async () => {
    const { home } = await setupMemoryHome();
    await addProject(home, "checkout-service", [
      "git@git.corp.com:shop/checkout-service.git",
    ]);
    const workspace = await makeWorkspace("https://git.corp.com/shop/checkout-service");

    const result = await run(home, ["link"], workspace);

    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(join(workspace, ".memsync.json"), "utf8"))).toEqual({
      project: "checkout-service",
    });
  });

  it("rejects an unknown slug", async () => {
    const { home } = await setupMemoryHome();
    const workspace = await makeWorkspace();

    const result = await run(home, ["link", "ghost"], workspace);

    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/not found|unknown/i);
    expect(existsSync(join(workspace, ".memsync.json"))).toBe(false);
  });

  it("overwrites an existing pointer", async () => {
    const { home } = await setupMemoryHome();
    await addProject(home, "checkout-service");
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, ".memsync.json"), '{"project":"old"}', "utf8");

    expect((await run(home, ["link", "checkout-service"], workspace)).code).toBe(0);
    expect(JSON.parse(await readFile(join(workspace, ".memsync.json"), "utf8"))).toEqual({
      project: "checkout-service",
    });
  });

  it("does not commit the code workspace", async () => {
    const { home } = await setupMemoryHome();
    await addProject(home, "checkout-service");
    const workspace = await makeWorkspace();
    await commitSeed(workspace);
    const before = await gitOrThrow(["rev-list", "--count", "HEAD"], { cwd: workspace });

    expect((await run(home, ["link", "checkout-service"], workspace)).code).toBe(0);

    const after = await gitOrThrow(["rev-list", "--count", "HEAD"], { cwd: workspace });
    expect(after).toBe(before);
    const status = await gitOrThrow(["status", "--porcelain"], { cwd: workspace });
    expect(status).toContain("?? .memsync.json");
  });

  it("adds .memsync/ to the workspace .gitignore exactly once", async () => {
    const { home } = await setupMemoryHome();
    await addProject(home, "checkout-service");
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, ".gitignore"), "node_modules/\n", "utf8");

    expect((await run(home, ["link", "checkout-service"], workspace)).code).toBe(0);
    expect((await run(home, ["link", "checkout-service"], workspace)).code).toBe(0);

    const gitignore = await readFile(join(workspace, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore.split(/\r?\n/).filter((line) => line.trim() === ".memsync/")).toHaveLength(
      1,
    );
  });

  it("records the shared common dir when linking a worktree", async () => {
    const { home } = await setupMemoryHome();
    await addProject(home, "checkout-service");
    const workspace = await makeWorkspace();
    await commitSeed(workspace);
    const worktree = `${workspace}-wt`;
    await gitOrThrow(["worktree", "add", worktree, "-b", "feature"], { cwd: workspace });

    expect((await run(home, ["link", "checkout-service"], worktree)).code).toBe(0);

    expect(JSON.parse(await readFile(join(worktree, ".memsync.json"), "utf8"))).toEqual({
      project: "checkout-service",
    });
    const map = await loadRepoMap(envFor(home));
    expect(map[await commonKey(workspace)]).toBe("checkout-service");
  });
});
