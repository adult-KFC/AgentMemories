import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runCli, type CliIo } from "../../src/cli.js";
import {
  cliCommand,
  installClaude,
  type InstallReport,
} from "../../src/adapters/claude.js";
import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
} from "../../src/adapters/managed-block.js";

interface InstallSetup {
  root: string;
  configDir: string;
  settingsPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

async function makeSetup(): Promise<InstallSetup> {
  const root = await mkdtemp(join(tmpdir(), "memsync-install-"));
  const configDir = join(root, "claude-config");
  const settingsPath = join(configDir, "settings.json");
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    MEMSYNC_CLI_PATH: join(root, "fake", "memsync.mjs"),
  } as NodeJS.ProcessEnv;

  return { root, configDir, settingsPath, cwd, env };
}

async function readSettings(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8"));
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

function commandsFor(settings: Record<string, any>, event: string): string[] {
  const entries = settings.hooks?.[event] ?? [];
  const commands: string[] = [];
  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      if (typeof hook.command === "string") commands.push(hook.command);
    }
  }
  return commands;
}

describe("cliCommand", () => {
  it("uses process.execPath and prefers MEMSYNC_CLI_PATH", () => {
    const cliPath = join(tmpdir(), "memsync-cli", "memsync.mjs");
    const command = cliCommand({ MEMSYNC_CLI_PATH: cliPath });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([cliPath]);
  });

  it("falls back to the current module path", () => {
    const command = cliCommand({});

    expect(command.command).toBe(process.execPath);
    expect(isAbsolute(command.args[0])).toBe(true);
  });
});

describe("installClaude", () => {
  it("writes SessionStart, SessionEnd, and PreCompact hooks at user scope", async () => {
    const setup = await makeSetup();

    const report = await installClaude({
      env: setup.env,
      scope: "user",
      cwd: setup.cwd,
    });

    expect(report).toMatchObject<Partial<InstallReport>>({
      installed: true,
      settingsPath: setup.settingsPath,
      managedBlockPath: join(setup.cwd, "CLAUDE.md"),
      slashCommandPath: join(setup.cwd, ".claude", "commands", "memsync-sync.md"),
    });
    expect(report.command).toContain("hook session-start --tool claude-code");

    const settings = await readSettings(setup.settingsPath);
    expect(commandsFor(settings, "SessionStart")).toHaveLength(1);
    expect(commandsFor(settings, "SessionEnd")).toHaveLength(1);
    expect(commandsFor(settings, "PreCompact")).toHaveLength(1);
    expect(commandsFor(settings, "SessionStart")[0]).toContain(
      "hook session-start --tool claude-code",
    );
    expect(commandsFor(settings, "SessionEnd")[0]).toContain(
      "hook session-end --tool claude-code",
    );
    expect(commandsFor(settings, "PreCompact")[0]).toContain(
      "hook pre-compact --tool claude-code",
    );
    expect(commandsFor(settings, "SessionStart")[0]).toContain(
      setup.env.MEMSYNC_CLI_PATH as string,
    );
    expect(settings.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: "command",
      timeout: 30,
    });
  });

  it("preserves unrelated hooks and top-level fields", async () => {
    const setup = await makeSetup();
    await mkdir(setup.configDir, { recursive: true });
    await writeFile(
      setup.settingsPath,
      JSON.stringify({
        theme: "dark",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "other" }] }],
          SessionStart: [
            { hooks: [{ type: "command", command: "unrelated-start" }] },
          ],
        },
      }),
      "utf8",
    );

    await installClaude({ env: setup.env, scope: "user", cwd: setup.cwd });

    const after = await readSettings(setup.settingsPath);
    expect(after.theme).toBe("dark");
    expect(after.hooks.Stop[0].hooks[0].command).toBe("other");
    expect(commandsFor(after, "SessionStart")).toContain("unrelated-start");
    expect(commandsFor(after, "SessionStart")).toHaveLength(2);
  });

  it("is idempotent across two installs", async () => {
    const setup = await makeSetup();
    await mkdir(setup.configDir, { recursive: true });
    await writeFile(
      setup.settingsPath,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] },
      }),
      "utf8",
    );

    await installClaude({ env: setup.env, scope: "user", cwd: setup.cwd });
    await installClaude({ env: setup.env, scope: "user", cwd: setup.cwd });

    const after = await readSettings(setup.settingsPath);
    for (const event of ["SessionStart", "SessionEnd", "PreCompact"]) {
      expect(commandsFor(after, event)).toHaveLength(1);
    }
    expect(after.hooks.Stop[0].hooks[0].command).toBe("other");
  });

  it("replaces a previous memsync entry even if its command changed", async () => {
    const setup = await makeSetup();
    await mkdir(setup.configDir, { recursive: true });
    await writeFile(
      setup.settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: '"/old/node" "/old/memsync.mjs" hook session-start --tool claude-code',
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    await installClaude({ env: setup.env, scope: "user", cwd: setup.cwd });

    const after = await readSettings(setup.settingsPath);
    const commands = commandsFor(after, "SessionStart");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(setup.env.MEMSYNC_CLI_PATH as string);
    expect(commands[0]).not.toContain("/old/memsync.mjs");
  });

  it("uses <cwd>/.claude/settings.json at project scope", async () => {
    const setup = await makeSetup();

    const report = await installClaude({
      env: setup.env,
      scope: "project",
      cwd: setup.cwd,
    });

    expect(report.settingsPath).toBe(join(setup.cwd, ".claude", "settings.json"));
    const settings = await readSettings(report.settingsPath);
    expect(commandsFor(settings, "SessionStart")).toHaveLength(1);
  });

  it("writes a managed CLAUDE.md block and preserves existing content", async () => {
    const setup = await makeSetup();
    const claudeMd = join(setup.cwd, "CLAUDE.md");
    await writeFile(claudeMd, "# Existing project notes\n\nkeep me\n", "utf8");

    await installClaude({ env: setup.env, scope: "user", cwd: setup.cwd });
    const first = await readFile(claudeMd, "utf8");

    expect(first).toContain("# Existing project notes");
    expect(first).toContain("keep me");
    expect(first).toContain(MANAGED_BLOCK_BEGIN);
    expect(first).toContain(MANAGED_BLOCK_END);
    expect(first.match(/<!-- memsync:begin -->/g)).toHaveLength(1);
    expect(first).toContain("memsync note");
    expect(first).toContain("constraints.md");
    expect(first).toContain("memsync recall");
    expect(first).toContain("memsync sync --strict");
    expect(first).toContain("记忆已同步");
    expect(first).toContain("记忆未同步");

    const slash = await readFile(
      join(setup.cwd, ".claude", "commands", "memsync-sync.md"),
      "utf8",
    );
    expect(slash).toContain("memsync sync --strict");
    expect(slash).toContain("memsync status");

    await installClaude({ env: setup.env, scope: "user", cwd: setup.cwd });
    const second = await readFile(claudeMd, "utf8");
    expect(second).toBe(first);
    expect(second.match(/<!-- memsync:begin -->/g)).toHaveLength(1);
  });
});

describe("memsync install command", () => {
  it("installs claude-code hooks and reports the paths", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.cwd, setup.env);

    const code = await runCli(["install", "--tool", "claude-code"], io);

    expect(code).toBe(0);
    expect(io.out.join("")).toContain(setup.settingsPath);
    expect(io.out.join("")).toContain(join(setup.cwd, "CLAUDE.md"));
    const settings = await readSettings(setup.settingsPath);
    expect(commandsFor(settings, "SessionStart")).toHaveLength(1);
  });

  it("installs at project scope when asked", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.cwd, setup.env);

    const code = await runCli(
      ["install", "--tool", "claude-code", "--scope", "project"],
      io,
    );

    expect(code).toBe(0);
    const settings = await readSettings(join(setup.cwd, ".claude", "settings.json"));
    expect(commandsFor(settings, "SessionStart")).toHaveLength(1);
  });

  it("installs the Codex fallback when path B is forced", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.cwd, setup.env);

    const code = await runCli(
      [
        "install",
        "--tool",
        "codex",
        "--force-path",
        "B",
        "--scope",
        "project",
      ],
      io,
    );

    expect(code).toBe(0);
    expect(io.out.join("")).toMatch(/path B|fallback/i);
    const agents = await readFile(join(setup.cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("memsync:begin");
  });

  it("rejects an invalid scope and a missing tool", async () => {
    const setup = await makeSetup();

    const invalidScope = makeIo(setup.cwd, setup.env);
    expect(
      await runCli(
        ["install", "--tool", "claude-code", "--scope", "galaxy"],
        invalidScope,
      ),
    ).toBe(1);
    expect(invalidScope.err.join("")).toMatch(/scope/i);

    const missingTool = makeIo(setup.cwd, setup.env);
    expect(await runCli(["install"], missingTool)).toBe(1);
    expect(missingTool.err.join("")).toMatch(/tool/i);
  });
});
