import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../../src/cli.js";
import { loadConfig } from "../../src/core/config.js";
import { runGit } from "../../src/core/git.js";
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

/** Preserves the machine's Git config while overriding specific keys. */
function isolatedGitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    ...overrides,
  };
}

describe("memsync init", () => {
  it("clones the remote and persists identity", async () => {
    const { remote } = await makeBareRemote();
    const home = await mkdtemp(join(tmpdir(), "home-"));
    const { io, out } = capture(home, isolatedGitEnv({ MEMSYNC_HOME: home }));

    const code = await runCli(
      ["init", "--remote", remote, "--name", "Alice", "--email", "alice@corp.com"],
      io,
    );

    expect(code).toBe(0);
    const config = await loadConfig({ MEMSYNC_HOME: home });
    expect(config?.identity).toEqual({ name: "Alice", email: "alice@corp.com" });
    expect(config?.repoPath).toBe(join(home, "repo"));
    expect(config?.remoteUrl).toBe(remote);
    expect(existsSync(join(home, "repo", ".git"))).toBe(true);

    const printed = out.join("");
    expect(printed).toContain(join(home, "repo"));
    expect(printed).toContain("alice@corp.com");
    expect(printed).toContain(remote);
  });

  it("sets repo-local autocrlf and commits .gitattributes with the trailer", async () => {
    const { remote } = await makeBareRemote();
    const home = await mkdtemp(join(tmpdir(), "home-"));
    const { io } = capture(home, isolatedGitEnv({ MEMSYNC_HOME: home }));

    expect(
      await runCli(
        ["init", "--remote", remote, "--name", "Alice", "--email", "alice@corp.com"],
        io,
      ),
    ).toBe(0);

    const repo = join(home, "repo");
    expect(await readFile(join(repo, ".gitattributes"), "utf8")).toContain(
      "* text=auto eol=lf",
    );

    const autocrlf = await runGit(["config", "--get", "core.autocrlf"], { cwd: repo });
    expect(autocrlf.stdout.trim()).toBe("false");

    const log = await runGit(["log", "-1", "--pretty=%B", "--name-only"], { cwd: repo });
    expect(log.stdout).toContain(".gitattributes");
    expect(log.stdout).toContain("Co-Authored-By: Claude Code <noreply@anthropic.com>");

    const userEmail = await runGit(["config", "--get", "user.email"], { cwd: repo });
    expect(userEmail.stdout.trim()).toBe("alice@corp.com");
  });

  it("derives identity from git config when flags are absent", async () => {
    const { remote } = await makeBareRemote();
    const home = await mkdtemp(join(tmpdir(), "home-"));
    const cwd = await mkdtemp(join(tmpdir(), "git-cwd-"));
    await runGit(["init"], { cwd });
    await runGit(["config", "user.name", "Bob"], { cwd });
    await runGit(["config", "user.email", "bob@corp.com"], { cwd });

    const { io } = capture(cwd, isolatedGitEnv({ MEMSYNC_HOME: home }));
    expect(await runCli(["init", "--remote", remote], io)).toBe(0);

    expect((await loadConfig({ MEMSYNC_HOME: home }))?.identity).toEqual({
      name: "Bob",
      email: "bob@corp.com",
    });
  });

  it("fails when no email can be resolved", async () => {
    const { remote } = await makeBareRemote();
    const home = await mkdtemp(join(tmpdir(), "home-"));
    const cwd = await mkdtemp(join(tmpdir(), "git-cwd-"));
    const emptyGlobal = join(cwd, "empty-gitconfig");
    await writeFile(emptyGlobal, "", "utf8");

    const { io, err } = capture(
      cwd,
      isolatedGitEnv({
        MEMSYNC_HOME: home,
        GIT_CONFIG_GLOBAL: emptyGlobal,
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: cwd,
        USERPROFILE: cwd,
      }),
    );

    const code = await runCli(["init", "--remote", remote, "--name", "Alice"], io);
    expect(code).not.toBe(0);
    expect(err.join("")).toMatch(/email/i);
    expect(await loadConfig({ MEMSYNC_HOME: home })).toBeUndefined();
  });

  it("keeps existing identity unless flags override it", async () => {
    const { remote } = await makeBareRemote();
    const home = await mkdtemp(join(tmpdir(), "home-"));
    const env = isolatedGitEnv({ MEMSYNC_HOME: home });

    expect(
      await runCli(
        ["init", "--remote", remote, "--name", "Alice", "--email", "alice@corp.com"],
        capture(home, env).io,
      ),
    ).toBe(0);

    expect(await runCli(["init", "--name", "Alicia"], capture(home, env).io)).toBe(0);

    expect((await loadConfig({ MEMSYNC_HOME: home }))?.identity).toEqual({
      name: "Alicia",
      email: "alice@corp.com",
    });
  });

  it("--remote updates the remote and the origin URL", async () => {
    const first = await makeBareRemote();
    const home = await mkdtemp(join(tmpdir(), "home-"));
    const env = isolatedGitEnv({ MEMSYNC_HOME: home });

    expect(
      await runCli(
        [
          "init",
          "--remote",
          first.remote,
          "--name",
          "Alice",
          "--email",
          "alice@corp.com",
        ],
        capture(home, env).io,
      ),
    ).toBe(0);

    // A second bare remote with identical history.
    const secondRemote = join(first.dir, "second.git");
    const cloned = await runGit(["clone", "--bare", first.remote, secondRemote], {
      cwd: first.dir,
    });
    expect(cloned.code).toBe(0);

    expect(await runCli(["init", "--remote", secondRemote], capture(home, env).io)).toBe(0);

    expect((await loadConfig({ MEMSYNC_HOME: home }))?.remoteUrl).toBe(secondRemote);
    const origin = await runGit(["remote", "get-url", "origin"], { cwd: join(home, "repo") });
    expect(origin.stdout.trim()).toBe(secondRemote);
  });
});
