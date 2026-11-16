import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli.js";
import { saveConfig } from "../../src/core/config.js";
import { runDoctor } from "../../src/core/doctor.js";
import { runGit } from "../../src/core/git.js";
import { createJournal } from "../../src/core/journal.js";
import { cloneOrUpdateRepo } from "../../src/core/repo.js";
import { makeBareRemote } from "../helpers.js";

const SLUG = "checkout-service";
const EMAIL = "alice@corp.com";
const HOST = "WIN-TEST";

const META = [
  "slug: checkout-service",
  "repos:",
  "  - git@git.corp.com:shop/checkout-service.git",
  "owners:",
  "  - alice@corp.com",
  "current_version: 0.4.0",
  "version_status: active",
  "context_budget_chars: 12000",
  "maintenance:",
  "  interval_hours: 72",
  "  cooldown_hours: 6",
  "  mainline_only: true",
  "",
].join("\n");

interface Setup {
  home: string;
  repoPath: string;
  projectDir: string;
  workspace: string;
  claudeDir: string;
  cliPath: string;
  env: NodeJS.ProcessEnv;
}

async function configureGit(repoPath: string): Promise<void> {
  await runGit(["config", "user.name", "Test User"], { cwd: repoPath });
  await runGit(["config", "user.email", "test@example.com"], { cwd: repoPath });
  await runGit(["config", "core.autocrlf", "false"], { cwd: repoPath });
}

async function makeSetup(): Promise<Setup> {
  const remote = await makeBareRemote();
  const root = await mkdtemp(join(tmpdir(), "memsync-doctor-"));
  const home = join(root, "home");
  const claudeDir = join(root, "claude");
  await mkdir(home, { recursive: true });
  await mkdir(claudeDir, { recursive: true });

  const repoPath = join(home, "repo");
  await cloneOrUpdateRepo({ remoteUrl: remote.remote, repoPath });
  await configureGit(repoPath);

  const cliPath = join(root, "memsync.mjs");
  await writeFile(cliPath, "// fake cli\n", "utf8");

  const env = {
    ...process.env,
    MEMSYNC_HOME: home,
    MEMSYS_HOST: HOST,
    CLAUDE_CONFIG_DIR: claudeDir,
    MEMSYNC_CLI_PATH: cliPath,
  } as NodeJS.ProcessEnv;

  await saveConfig(env, {
    version: 1,
    repoPath,
    remoteUrl: remote.remote,
    identity: { name: "Alice", email: EMAIL },
    defaultBudgetChars: 12_000,
  });

  const projectDir = join(repoPath, "projects", SLUG);
  await mkdir(join(projectDir, "journal"), { recursive: true });
  await writeFile(join(projectDir, "meta.yaml"), META, "utf8");

  const workspace = await mkdtemp(join(tmpdir(), "memsync-doctor-ws-"));
  await writeFile(join(workspace, ".memsync.json"), `{"project":"${SLUG}"}\n`, "utf8");
  await createJournal({
    projectDir,
    project: SLUG,
    user: "alice",
    email: EMAIL,
    host: HOST,
    tool: "claude-code",
    session: "doctor-session",
    workspace,
    baseCommit: "unknown",
  });

  await runGit(["add", "-A"], { cwd: repoPath });
  await runGit(["commit", "-m", "chore: seed doctor repo"], { cwd: repoPath });
  await runGit(["push"], { cwd: repoPath });

  return { home, repoPath, projectDir, workspace, claudeDir, cliPath, env };
}

async function writeClaudeSettings(
  setup: Setup,
  command: string,
): Promise<void> {
  await writeFile(
    join(setup.claudeDir, "settings.json"),
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command, timeout: 30 }] }],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeCapabilities(home: string, path: string): Promise<void> {
  await mkdir(join(home, "state"), { recursive: true });
  await writeFile(
    join(home, "state", "capabilities.json"),
    `${JSON.stringify(
      {
        "1.2.3|codex": {
          codexVersion: "1.2.3",
          plugin: true,
          hooks: true,
          hookTrust: "supported",
          injectSessionStart: true,
          injectUserPrompt: true,
          envFile: null,
          path,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function hookCommand(node: string, cliPath: string): string {
  return `"${node}" "${cliPath}" hook session-start --tool claude-code`;
}

interface TestIo extends CliIo {
  out: string[];
  err: string[];
}

function makeIo(cwd: string, env: NodeJS.ProcessEnv): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    env,
    stdin: async () => "",
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    out,
    err,
  };
}

describe("runDoctor", () => {
  it("passes every check for a healthy installation", async () => {
    const setup = await makeSetup();
    await writeClaudeSettings(setup, hookCommand(process.execPath, setup.cliPath));
    await writeCapabilities(setup.home, "A");

    const checks = await runDoctor(setup.env);

    const names = checks.map((check) => check.name);
    expect(names).toEqual([
      "config",
      "repo",
      "git-remote",
      "identity",
      "claude-hooks",
      "codex-capabilities",
      "default-branch",
      "repo-size",
      "clock",
    ]);
    for (const check of checks) {
      expect(check, check.name).toMatchObject({ name: check.name, ok: true });
    }
  });

  it("fails claude-hooks when the configured hook command path is missing", async () => {
    const setup = await makeSetup();
    await writeClaudeSettings(
      setup,
      hookCommand(process.execPath, join(setup.claudeDir, "memsync-missing.mjs")),
    );
    await writeCapabilities(setup.home, "A");

    const checks = await runDoctor(setup.env);
    const hooks = checks.find((check) => check.name === "claude-hooks");

    expect(hooks?.ok).toBe(false);
    expect(hooks?.detail).toContain("memsync-missing.mjs");
  });

  it("fails claude-hooks when no memsync hook is installed", async () => {
    const setup = await makeSetup();
    await writeClaudeSettings(setup, "node unrelated.mjs");
    await writeCapabilities(setup.home, "A");

    const checks = await runDoctor(setup.env);

    expect(checks.find((check) => check.name === "claude-hooks")?.ok).toBe(false);
  });

  it("warns when a project's configured default branch cannot be resolved", async () => {
    const setup = await makeSetup();
    await writeClaudeSettings(setup, hookCommand(process.execPath, setup.cliPath));
    await writeCapabilities(setup.home, "A");
    await writeFile(
      join(setup.projectDir, "meta.yaml"),
      `${META}default_branch: release-does-not-exist\n`,
      "utf8",
    );

    const checks = await runDoctor(setup.env);
    const branch = checks.find((check) => check.name === "default-branch");

    expect(branch?.ok).toBe(true);
    expect(branch?.detail).toContain("release-does-not-exist");
    expect(branch?.detail).toMatch(/warning/i);
  });

  it("fails codex-capabilities when the cache is missing or invalid", async () => {
    const setup = await makeSetup();
    await writeClaudeSettings(setup, hookCommand(process.execPath, setup.cliPath));

    const checks = await runDoctor(setup.env);
    expect(checks.find((check) => check.name === "codex-capabilities")?.ok).toBe(false);

    await mkdir(join(setup.home, "state"), { recursive: true });
    await writeFile(join(setup.home, "state", "capabilities.json"), "{bad json\n", "utf8");
    const after = await runDoctor(setup.env);
    expect(after.find((check) => check.name === "codex-capabilities")?.ok).toBe(false);
  });
});

describe("memsync doctor command", () => {
  it("prints results and exits 1 when a check fails", async () => {
    const setup = await makeSetup();
    // No hook settings and no capabilities: at least two checks fail.
    const io = makeIo(setup.workspace, setup.env);

    const code = await runCli(["doctor"], io);

    expect(code).toBe(1);
    expect(io.out.join("")).toContain("claude-hooks");
    expect(io.out.join("")).toContain("codex-capabilities");
  });

  it("exits 0 when every check passes", async () => {
    const setup = await makeSetup();
    await writeClaudeSettings(setup, hookCommand(process.execPath, setup.cliPath));
    await writeCapabilities(setup.home, "A2");
    const io = makeIo(setup.workspace, setup.env);

    const code = await runCli(["doctor"], io);

    expect(code).toBe(0);
    expect(io.out.join("")).not.toContain("FAIL");
  });
});
