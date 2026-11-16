import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOrThrow, runGit } from "../../src/core/git.js";
import { gitCommonDir, normalizeRepoUrl, repoRootFromProject } from "../../src/core/project.js";
import { commitFile } from "../helpers.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memsync-url-repo-"));
  await gitOrThrow(["init"], { cwd: dir });
  await gitOrThrow(["config", "user.name", "Test User"], { cwd: dir });
  await gitOrThrow(["config", "user.email", "test@example.com"], { cwd: dir });
  return dir;
}

describe("normalizeRepoUrl", () => {
  it("normalizes ssh and https remotes to the same key", () => {
    expect(normalizeRepoUrl("git@git.corp.com:shop/checkout.git")).toBe(
      normalizeRepoUrl("https://git.corp.com/shop/checkout"),
    );
  });

  it("strips .git, trailing slashes, and lowercases host and path", () => {
    expect(normalizeRepoUrl("git@Git.Corp.com:Shop/Checkout.git")).toBe(
      "git.corp.com/shop/checkout",
    );
    expect(normalizeRepoUrl("https://Git.Corp.com/Shop/Checkout.git/")).toBe(
      "git.corp.com/shop/checkout",
    );
    expect(normalizeRepoUrl("ssh://git@git.corp.com/shop/checkout.git/")).toBe(
      "git.corp.com/shop/checkout",
    );
  });

  it("ignores ssh ports and userinfo", () => {
    expect(normalizeRepoUrl("ssh://git@git.corp.com:2222/shop/checkout")).toBe(
      "git.corp.com/shop/checkout",
    );
    expect(normalizeRepoUrl("https://alice@git.corp.com/shop/checkout")).toBe(
      "git.corp.com/shop/checkout",
    );
  });

  it("treats file URLs and Windows paths as the same key", () => {
    expect(normalizeRepoUrl("file:///C:/work/checkout.git")).toBe("c:/work/checkout");
    expect(normalizeRepoUrl("C:\\work\\checkout.git")).toBe("c:/work/checkout");
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeRepoUrl("   ")).toBe("");
  });
});

describe("gitCommonDir", () => {
  it("returns the absolute common dir for a repository", async () => {
    const repo = await makeRepo();
    const common = await gitCommonDir(repo);
    expect(common).toBeTruthy();
    expect(await realpath(common as string)).toBe(await realpath(join(repo, ".git")));
  });

  it("returns undefined outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memsync-not-a-repo-"));
    expect(await gitCommonDir(dir)).toBeUndefined();
  });

  it("returns the same common dir for a linked worktree", async () => {
    const repo = await makeRepo();
    await commitFile(repo, "README.md", "repo\n");
    const worktree = `${repo}-worktree`;
    await gitOrThrow(["worktree", "add", worktree, "-b", "linked"], { cwd: repo });

    const mainCommon = await gitCommonDir(repo);
    const worktreeCommon = await gitCommonDir(worktree);
    expect(mainCommon).toBeTruthy();
    expect(worktreeCommon).toBeTruthy();
    expect(await realpath(worktreeCommon as string)).toBe(await realpath(mainCommon as string));

    const status = await runGit(["status", "--porcelain"], { cwd: worktree });
    expect(status.code).toBe(0);
  });
});

describe("repoRootFromProject", () => {
  it("walks back from projects/<slug> to the memory repo root", () => {
    expect(repoRootFromProject(join("/mem", "repo", "projects", "checkout-service"))).toBe(
      join("/mem", "repo"),
    );
    expect(repoRootFromProject(join("/mem", "repo", "projects", "checkout-service") + "/")).toBe(
      join("/mem", "repo"),
    );
  });
});
