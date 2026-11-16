import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_TIMEOUT_EXIT_CODE, gitOrThrow, runGit } from "../../src/core/git.js";
import {
  classifyPullFailure,
  cloneOrUpdateRepo,
  commitPaths,
  hasPendingPush,
  pullRebase,
  pushWithRetry,
} from "../../src/core/repo.js";
import { commitFile, makeTwoClones, withTimeout } from "../helpers.js";

describe("runGit", () => {
  it("reports a non-zero exit without throwing", async () => {
    const { a } = await makeTwoClones();
    const result = await runGit(["rev-parse", "--verify", "definitely-not-a-ref"], { cwd: a });
    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("gitOrThrow surfaces stderr on failure", async () => {
    const { a } = await makeTwoClones();
    await expect(
      gitOrThrow(["rev-parse", "--verify", "definitely-not-a-ref"], { cwd: a }),
    ).rejects.toThrow(/definitely-not-a-ref|fatal/i);
  });

  it("reports a timed-out command as exit code 124", async () => {
    const { a } = await makeTwoClones();
    // hash-object --stdin blocks on stdin, so the timeout path is deterministic.
    const result = await runGit(["hash-object", "--stdin"], { cwd: a, timeoutMs: 100 });
    expect(result.code).toBe(GIT_TIMEOUT_EXIT_CODE);
    expect(result.stderr).toMatch(/timed out/i);
  });
});

describe("classifyPullFailure", () => {
  it("classifies timeouts, conflicts, and generic errors", () => {
    expect(
      classifyPullFailure({ code: GIT_TIMEOUT_EXIT_CODE, stdout: "", stderr: "" }),
    ).toMatchObject({ ok: false, reason: "timeout" });
    expect(
      classifyPullFailure({ code: 1, stdout: "CONFLICT (content): shared.md", stderr: "" }),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(
      classifyPullFailure({ code: 1, stdout: "", stderr: "fatal: something ETIMEDOUT" }),
    ).toMatchObject({ ok: false, reason: "timeout" });

    const generic = classifyPullFailure({
      code: 128,
      stdout: "",
      stderr: "fatal: no tracking information",
    });
    expect(generic.reason).toBe("error");
    expect(generic.message).toContain("no tracking information");
  });
});

describe("repo plumbing", () => {
  it("clones a bare remote, pulls a new commit, and pushes", async () => {
    const { a, b } = await withRemotes();
    await commitFile(a, "a.md", "a");
    expect((await pushWithRetry(a)).ok).toBe(true);
    expect((await withTimeout(pullRebase(b), 5000, "pullRebase")).ok).toBe(true);
    expect(await readFile(join(b, "a.md"), "utf8")).toBe("a");
  });

  it("pushWithRetry recovers from a non-fast-forward by pulling first", async () => {
    const { a, b } = await withRemotes();
    await commitFile(a, "a.md", "a");
    expect((await pushWithRetry(a)).ok).toBe(true);

    await commitFile(b, "b.md", "b");
    expect((await withTimeout(pushWithRetry(b), 5000, "pushWithRetry")).ok).toBe(true);

    expect((await pullRebase(a)).ok).toBe(true);
    expect(await readFile(join(a, "b.md"), "utf8")).toBe("b");
  });

  it("pullRebase classifies a conflict and aborts the rebase", async () => {
    const { a, b } = await withRemotes();
    await commitFile(a, "shared.md", "from a\n");
    expect((await pushWithRetry(a)).ok).toBe(true);

    await commitFile(b, "shared.md", "from b\n");
    const result = await pullRebase(b);

    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(existsSync(join(b, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(join(b, ".git", "rebase-apply"))).toBe(false);
    const status = await runGit(["status", "--porcelain"], { cwd: b });
    expect(status.stdout.trim()).toBe("");
  });

  it("pushWithRetry returns a reason when the remote is unreachable", async () => {
    const { a, dir } = await withRemotes();
    await runGit(["remote", "set-url", "origin", join(dir, "missing.git")], { cwd: a });
    await commitFile(a, "push.md", "x");

    const result = await withTimeout(pushWithRetry(a), 15_000, "pushWithRetry");
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("hasPendingPush is false when there is no upstream", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "memsync-no-upstream-"));
    await runGit(["init"], { cwd });
    await runGit(["config", "user.name", "Test User"], { cwd });
    await runGit(["config", "user.email", "test@example.com"], { cwd });
    await commitFile(cwd, "x.md", "x");

    expect(await hasPendingPush(cwd)).toBe(false);
  });

  it("hasPendingPush follows local commits and pushes", async () => {
    const { a } = await withRemotes();
    expect(await hasPendingPush(a)).toBe(false);
    await commitFile(a, "pending.md", "p");
    expect(await hasPendingPush(a)).toBe(true);
    expect((await pushWithRetry(a)).ok).toBe(true);
    expect(await hasPendingPush(a)).toBe(false);
  });

  it("commitPaths stages only the listed paths and returns a short SHA", async () => {
    const { a } = await withRemotes();
    await writeFile(join(a, "one.md"), "one", "utf8");
    await writeFile(join(a, "two.md"), "two", "utf8");

    const sha = await commitPaths(a, ["one.md"], "chore: add one\n\nbody");
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);

    const committed = await runGit(["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: a });
    const files = committed.stdout.trim().split(/\r?\n/);
    expect(files).toContain("one.md");
    expect(files).not.toContain("two.md");

    const status = await runGit(["status", "--porcelain", "--", "two.md"], { cwd: a });
    expect(status.stdout).toMatch(/^\?\? two\.md/m);
  });

  it("commitPaths returns undefined when nothing changed", async () => {
    const { a } = await withRemotes();
    await commitFile(a, "same.md", "same");
    expect(await commitPaths(a, ["same.md"], "chore: no change")).toBeUndefined();
  });

  it("cloneOrUpdateRepo clones a missing repo and updates it on the next call", async () => {
    const { remote, a } = await withRemotes();
    const target = join(await mkdtemp(join(tmpdir(), "memsync-target-")), "repo");

    await cloneOrUpdateRepo({ remoteUrl: remote, repoPath: target });
    expect(await readFile(join(target, "a.md")).catch(() => undefined)).toBeUndefined();

    await commitFile(a, "later.md", "later");
    expect((await pushWithRetry(a)).ok).toBe(true);

    await cloneOrUpdateRepo({ remoteUrl: remote, repoPath: target });
    expect(await readFile(join(target, "later.md"), "utf8")).toBe("later");
  });

  it("cloneOrUpdateRepo rejects an existing non-git directory", async () => {
    const target = await mkdtemp(join(tmpdir(), "memsync-bad-"));
    await writeFile(join(target, "not-a-repo.txt"), "x", "utf8");

    await expect(
      cloneOrUpdateRepo({ remoteUrl: "https://example.invalid/x.git", repoPath: target }),
    ).rejects.toThrow(/not a git repository/i);
  });
});

async function withRemotes() {
  return makeTwoClones();
}
