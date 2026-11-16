import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexSpawnTarget } from "../../src/adapters/codex-app-server.js";
import {
  probeCodex,
  type CodexCapabilities,
} from "../../src/adapters/codex-probe.js";
import { makeFakeCodex } from "../fixtures/codex-shim.js";

interface Setup {
  root: string;
  memsyncHome: string;
  codexHome: string;
  workspace: string;
  command: string;
  logPath: string;
  capabilitiesPath: string;
  env: NodeJS.ProcessEnv;
}

async function setup(mode: string, extra: NodeJS.ProcessEnv = {}): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "memsync-probe-"));
  const memsyncHome = join(root, "memsync-home");
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "workspace");
  await mkdir(memsyncHome, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const fake = await makeFakeCodex();
  const logPath = join(root, "fake-codex.log");

  return {
    root,
    memsyncHome,
    codexHome,
    workspace,
    command: fake.command,
    logPath,
    capabilitiesPath: join(memsyncHome, "state", "capabilities.json"),
    env: {
      ...process.env,
      MEMSYNC_HOME: memsyncHome,
      CODEX_HOME: codexHome,
      FAKE_CODEX_MODE: mode,
      FAKE_CODEX_LOG: logPath,
      ...extra,
    },
  };
}

async function readLog(path: string): Promise<Record<string, any>[]> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Runs the fake executable directly, bypassing probeCodex. */
function runFake(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string } {
  const target = codexSpawnTarget(command, args);
  const result = spawnSync(target.file, target.args, {
    env,
    encoding: "utf8",
    windowsHide: true,
    ...(target.windowsVerbatimArguments === true
      ? { windowsVerbatimArguments: true }
      : {}),
  });
  return { status: result.status, stdout: String(result.stdout ?? "") };
}

function degradedShape(caps: CodexCapabilities): void {
  expect(caps.path).toBe("B");
  expect(caps.hooks).toBe(false);
  expect(caps.injectSessionStart).toBe(false);
  expect(caps.injectUserPrompt).toBe(false);
  expect(caps.envFile).toBeNull();
}

describe("probeCodex", () => {
  it("treats JSON-RPC -32601 as hooks unsupported", async () => {
    const test = await setup("method-not-found");

    const caps = await probeCodex(test.env, test.workspace, { command: test.command });

    expect(caps.hooks).toBe(false);
    expect(caps.path).toBe("B");
    expect(caps.plugin).toBe(true);
    expect(caps.hookTrust).toBe("unknown");
    expect(caps.codexVersion).toBe("9.9.9");
  });

  it("lists hooks and trusts them by hash when confirmed", async () => {
    const test = await setup("hooks-ok");

    const caps = await probeCodex(test.env, test.workspace, {
      command: test.command,
      yes: true,
    });

    expect(caps.hooks).toBe(true);
    expect(caps.hookTrust).toBe("supported");
    expect(caps.plugin).toBe(true);
    expect(caps.path).toBe("B");

    const log = await readLog(test.logPath);
    expect(JSON.stringify(log)).toContain("trusted_hash");
  });

  it("does not write trust when the caller did not confirm", async () => {
    const test = await setup("hooks-ok");

    await probeCodex(test.env, test.workspace, { command: test.command });

    const log = await readLog(test.logPath);
    expect(JSON.stringify(log)).not.toContain("trusted_hash");
  });

  it("never trusts hooks owned by other plugins", async () => {
    const test = await setup("hooks-ok", {
      FAKE_CODEX_HOOK_PLUGIN: "third-party",
      FAKE_CODEX_HOOK_COMMAND: "third-party-hook --run",
    });

    const caps = await probeCodex(test.env, test.workspace, {
      command: test.command,
      yes: true,
    });

    expect(caps.hooks).toBe(true);
    const log = await readLog(test.logPath);
    expect(JSON.stringify(log)).not.toContain("trusted_hash");
  });

  it("does not trust a foreign hook whose command merely mentions memsync", async () => {
    const test = await setup("hooks-ok", {
      FAKE_CODEX_HOOK_PLUGIN: "third-party",
      FAKE_CODEX_HOOK_KEY: "third-party@SessionStart",
      FAKE_CODEX_HOOK_COMMAND: "memsync hook session-start --tool codex",
    });

    const caps = await probeCodex(test.env, test.workspace, {
      command: test.command,
      yes: true,
    });

    expect(caps.hooks).toBe(true);
    expect(JSON.stringify(await readLog(test.logPath))).not.toContain("trusted_hash");
  });

  it("still trusts our exact hook command when the runtime omits the plugin id", async () => {
    const test = await setup("hooks-ok", {
      FAKE_CODEX_DROP_PLUGIN: "1",
      FAKE_CODEX_HOOK_COMMAND: "memsync hook session-start --tool codex",
    });

    const caps = await probeCodex(test.env, test.workspace, {
      command: test.command,
      yes: true,
    });

    expect(caps.hookTrust).toBe("supported");
    expect(JSON.stringify(await readLog(test.logPath))).toContain("trusted_hash");
  });

  it("selects path B when config/read is unavailable even if injection works", async () => {
    const test = await setup("inject-ok", {
      FAKE_CODEX_CONFIG_READ_MODE: "method-not-found",
    });

    const caps = await probeCodex(test.env, test.workspace, { command: test.command });

    expect(caps.hooks).toBe(true);
    expect(caps.injectSessionStart).toBe(true);
    expect(caps.path).toBe("B");
    // Inconclusive results must not be cached as a stable capability set.
    await expect(readFile(test.capabilitiesPath, "utf8")).rejects.toThrow();
  });

  it("treats failed probe-plugin registration as uncertain", async () => {
    const test = await setup("inject-ok", { FAKE_CODEX_REGISTRATION_FAIL: "1" });

    const caps = await probeCodex(test.env, test.workspace, { command: test.command });

    expect(caps.plugin).toBe(true);
    expect(caps.hooks).toBe(true);
    expect(caps.injectSessionStart).toBe(false);
    expect(caps.path).toBe("B");
    await expect(readFile(test.capabilitiesPath, "utf8")).rejects.toThrow();
  });

  it("only discovers registered plugins", async () => {
    const test = await setup("inject-ok");
    const nonce = "probe-nonce-abc123";
    const pluginRoot = join(test.codexHome, "plugins", "memsync-probe");
    const hooksDir = join(pluginRoot, "hooks");
    await mkdir(hooksDir, { recursive: true });
    const script = join(hooksDir, "hook.mjs");
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:"${nonce}"}}));\n`,
      "utf8",
    );
    const command = `"${process.execPath}" "${script}"`;
    await writeFile(
      join(hooksDir, "hooks.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
      }),
      "utf8",
    );

    const unregistered = runFake(test.command, ["exec", "hi"], test.env);
    expect(unregistered.status).toBe(0);
    expect(unregistered.stdout.trim()).toBe("NO_TOKEN");
    expect(unregistered.stdout).not.toContain(nonce);

    const marketplaceRoot = join(test.root, "marketplace");
    await mkdir(join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
    await writeFile(
      join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({ plugins: [{ id: "memsync-probe", path: pluginRoot }] }),
      "utf8",
    );
    await writeFile(
      join(test.codexHome, ".fake-codex-registry.json"),
      JSON.stringify({ marketplaces: [marketplaceRoot], plugins: ["memsync-probe"] }),
      "utf8",
    );

    const registered = runFake(test.command, ["exec", "hi"], test.env);
    expect(registered.stdout).toContain(nonce);
  });

  it("detects injection only when the nonce is echoed", async () => {
    const ok = await setup("inject-ok");
    const okCaps = await probeCodex(ok.env, ok.workspace, { command: ok.command });

    expect(okCaps.injectSessionStart).toBe(true);
    expect(okCaps.injectUserPrompt).toBe(true);
    expect(okCaps.path).toBe("A");

    const missing = await setup("inject-missing");
    const missingCaps = await probeCodex(missing.env, missing.workspace, {
      command: missing.command,
    });

    expect(missingCaps.injectSessionStart).toBe(false);
    expect(missingCaps.injectUserPrompt).toBe(false);
    expect(missingCaps.path).toBe("B");
  });

  it("detects only a working env file", async () => {
    const ok = await setup("env-file-ok");
    const okCaps = await probeCodex(ok.env, ok.workspace, { command: ok.command });
    expect(okCaps.envFile).toBe("CODEX_ENV_FILE");

    const missing = await setup("env-file-missing");
    const missingCaps = await probeCodex(missing.env, missing.workspace, {
      command: missing.command,
    });
    expect(missingCaps.envFile).toBeNull();
  });

  it("ignores an inherited CODEX_ENV_FILE and never writes it", async () => {
    const missing = await setup("env-file-missing");
    const inherited = join(missing.root, "inherited-env");
    await writeFile(inherited, "keep-me\n", "utf8");
    missing.env.CODEX_ENV_FILE = inherited;

    const caps = await probeCodex(missing.env, missing.workspace, {
      command: missing.command,
    });

    expect(caps.envFile).toBeNull();
    expect(await readFile(inherited, "utf8")).toBe("keep-me\n");
    const execs = (await readLog(missing.logPath)).filter(
      (entry) => entry.kind === "exec",
    );
    expect(execs.length).toBeGreaterThan(0);
    for (const entry of execs) {
      expect(entry.hasEnvFile).toBe(false);
    }
  });

  it("uses a shell-agnostic env file probe command", async () => {
    const test = await setup("env-file-ok");

    await probeCodex(test.env, test.workspace, { command: test.command });

    const envProbes = (await readLog(test.logPath)).filter(
      (entry) =>
        entry.kind === "exec" &&
        JSON.stringify(entry.args).includes("MEMSYS_CODEX_ENV_PROBE"),
    );
    expect(envProbes.length).toBeGreaterThan(0);
    const prompt = (envProbes[0]?.args ?? []).join(" ");
    expect(prompt).toContain("node -p process.env.MEMSYS_CODEX_ENV_PROBE");
    expect(prompt).not.toContain("$");
  });

  it("caches capabilities by codex version and command", async () => {
    const test = await setup("inject-ok");

    const first = await probeCodex(test.env, test.workspace, { command: test.command });
    expect(first.path).toBe("A");
    const appServerRuns = (await readLog(test.logPath)).filter(
      (entry) => entry.kind === "app-server",
    ).length;
    expect(appServerRuns).toBeGreaterThan(0);

    const cache = JSON.parse(await readFile(test.capabilitiesPath, "utf8"));
    const key = `9.9.9|${test.command}`;
    expect(cache[key]).toMatchObject({ path: "A", hooks: true });

    // Same version and command: served from cache, no new app-server spawn.
    test.env.FAKE_CODEX_MODE = "method-not-found";
    const cached = await probeCodex(test.env, test.workspace, { command: test.command });
    expect(cached.path).toBe("A");
    expect(
      (await readLog(test.logPath)).filter((entry) => entry.kind === "app-server").length,
    ).toBe(appServerRuns);

    // force bypasses the cache.
    const forced = await probeCodex(test.env, test.workspace, {
      command: test.command,
      force: true,
    });
    expect(forced.hooks).toBe(false);
    expect(forced.path).toBe("B");

    // A version change invalidates the entry.
    test.env.FAKE_CODEX_VERSION = "10.0.0";
    test.env.FAKE_CODEX_MODE = "hooks-ok";
    const upgraded = await probeCodex(test.env, test.workspace, { command: test.command });
    expect(upgraded.codexVersion).toBe("10.0.0");
    expect(upgraded.hooks).toBe(true);

    const after = JSON.parse(await readFile(test.capabilitiesPath, "utf8"));
    expect(after[`10.0.0|${test.command}`]).toMatchObject({ hooks: true });
  });

  it("re-verifies trust when yes follows a cached unconfirmed probe", async () => {
    const test = await setup("hooks-ok");

    await probeCodex(test.env, test.workspace, { command: test.command });
    expect(JSON.stringify(await readLog(test.logPath))).not.toContain("trusted_hash");

    const confirmed = await probeCodex(test.env, test.workspace, {
      command: test.command,
      yes: true,
    });

    expect(confirmed.hookTrust).toBe("supported");
    expect(JSON.stringify(await readLog(test.logPath))).toContain("trusted_hash");
  });

  it("does not cache a failed trust write", async () => {
    const test = await setup("hooks-ok", { FAKE_CODEX_TRUST_REJECT: "1" });

    const caps = await probeCodex(test.env, test.workspace, {
      command: test.command,
      yes: true,
    });

    expect(caps.hookTrust).toBe("unknown");
    expect(caps.path).toBe("B");
    await expect(readFile(test.capabilitiesPath, "utf8")).rejects.toThrow();
  });

  it("honours forcePath without probing or poisoning the cache", async () => {
    const test = await setup("inject-ok");

    const forced = await probeCodex(test.env, test.workspace, {
      command: test.command,
      forcePath: "B",
    });
    degradedShape(forced);
    expect(
      (await readLog(test.logPath)).filter((entry) => entry.kind === "app-server"),
    ).toHaveLength(0);
    await expect(readFile(test.capabilitiesPath, "utf8")).rejects.toThrow();

    const probed = await probeCodex(test.env, test.workspace, { command: test.command });
    expect(probed.path).toBe("A");
  });

  it("runs behavioural probes under an isolated CODEX_HOME", async () => {
    const test = await setup("inject-ok");
    const userConfig = join(test.codexHome, "config.toml");
    await writeFile(userConfig, 'model = "do-not-read"\n', "utf8");

    await probeCodex(test.env, test.workspace, { command: test.command });

    const execs = (await readLog(test.logPath)).filter((entry) => entry.kind === "exec");
    expect(execs.length).toBeGreaterThan(0);
    for (const entry of execs) {
      expect(entry.codexHome).not.toBe(test.codexHome);
      expect(entry.codexHome).toContain("memsync-codex-");
    }
    expect(await readFile(userConfig, "utf8")).toBe('model = "do-not-read"\n');
  });
});
