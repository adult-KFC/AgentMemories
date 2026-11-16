import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../core/atomic.js";
import { statePath } from "../core/paths.js";
import {
  CODEX_OPERATION_TIMEOUT_MS,
  CodexMethodUnavailableError,
  codexSpawnTarget,
  listHooks,
  readConfigVersion,
  trustHooks,
  withCodexAppServer,
  type CodexHook,
} from "./codex-app-server.js";

export interface CodexCapabilities {
  codexVersion?: string;
  plugin: boolean;
  hooks: boolean;
  hookTrust: "supported" | "unknown";
  injectSessionStart: boolean;
  injectUserPrompt: boolean;
  envFile: string | null;
  path: "A" | "A2" | "B";
  probedAt?: string;
}

export interface ProbeCodexOptions {
  command?: string;
  yes?: boolean;
  forcePath?: "A" | "B";
  /**
   * Re-probe even when a cached entry exists. Task 12 must pass `true` after
   * installing the plugin: a path B recorded before installation is otherwise
   * a valid cache entry for the same Codex version and command.
   */
  force?: boolean;
}

const VERSION_TIMEOUT_MS = 5_000;
const PLUGIN_HELP_TIMEOUT_MS = 5_000;
const REGISTRATION_TIMEOUT_MS = 5_000;
const CAPABILITIES_FILE = "capabilities.json";

const INJECTION_PROMPT =
  "If your session context contains a one-time token, reply with that token only. Otherwise reply NO_TOKEN.";
// `node -p` is shell-agnostic (unlike `echo $VAR`) and needs no quoting, which
// matters when the prompt travels through cmd.exe on Windows.
const ENV_PROBE_PROMPT =
  "Run the shell command node -p process.env.MEMSYS_CODEX_ENV_PROBE and report its output.";
const ENV_PROBE_VARIABLE = "MEMSYS_CODEX_ENV_PROBE";

type InjectionEvent = "SessionStart" | "UserPromptSubmit";

interface RunResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

interface BehaviourProbe<T> {
  value: T;
  /** True when the probe could not reach a conclusion and must not be cached. */
  unstable: boolean;
}

/** Runs a short-lived `codex` invocation; stderr is drained and never surfaced. */
function runCodex(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> {
  const target = codexSpawnTarget(command, args);

  return new Promise<RunResult>((resolve) => {
    let stdout = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(target.file, target.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(target.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(guard);
      resolve({ code, stdout, timedOut });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 500).unref?.();
    }, options.timeoutMs);
    timeout.unref?.();

    // Never let a wrapper process (cmd.exe on Windows) stall the probe.
    const guard = setTimeout(() => finish(null), options.timeoutMs + 2_000);
    guard.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    // Drain stderr without retaining it: it may contain paths or secrets.
    child.stderr?.resume();
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

function versionFromOutput(output: string): string | undefined {
  const line = firstLine(output);
  if (line.length === 0) return undefined;
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(line);
  return match ? match[1] : line;
}

async function readCodexVersion(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | undefined> {
  const result = await runCodex(command, ["--version"], {
    cwd,
    env,
    timeoutMs: VERSION_TIMEOUT_MS,
  }).catch(() => undefined);
  if (result === undefined || result.timedOut || result.code !== 0) return undefined;
  return versionFromOutput(result.stdout);
}

async function hasPluginSubcommand(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<BehaviourProbe<boolean>> {
  const result = await runCodex(command, ["plugin", "--help"], {
    cwd,
    env,
    timeoutMs: PLUGIN_HELP_TIMEOUT_MS,
  }).catch(() => undefined);

  if (result === undefined || result.timedOut) {
    // Could not even ask: treat as uncertain rather than "no plugin".
    return { value: false, unstable: true };
  }
  return { value: result.code === 0, unstable: false };
}

interface RpcProbeResult {
  hooks: boolean;
  hookTrust: "supported" | "unknown";
  /** True when the result is inconclusive and must not be cached. */
  unstable: boolean;
}

const OWNED_PLUGIN_ID = "memsync-codex-adapter";
/**
 * The exact command shape our installer writes: an absolute Node + memsync
 * script followed by one of the Codex hook events. Matching only this shape
 * (plus our plugin id/key) keeps `--yes` from trusting a foreign hook that
 * merely mentions "memsync" somewhere in its command line.
 */
const OWNED_HOOK_COMMAND =
  /(?:^|[\s"'])(?:[^"'\s]*[\\/])?memsync[^"'\s]*["']?\s+hook\s+(?:session-start|user-prompt-submit|stop)\s+--tool\s+codex["']?\s*$/i;

function isMemsyncOwnedHook(hook: CodexHook): boolean {
  if (hook.pluginId === OWNED_PLUGIN_ID) return true;
  if (hook.key.startsWith(`${OWNED_PLUGIN_ID}@`)) return true;

  // A hook explicitly owned by another plugin is never trusted, even if its
  // command text mentions memsync. The legacy probe fixture uses pluginId
  // "memsync"; a hook without a plugin id is accepted only with our exact
  // command shape.
  if (hook.pluginId !== undefined && hook.pluginId !== "memsync") return false;
  return OWNED_HOOK_COMMAND.test(hook.command.trim());
}

async function probeViaAppServer(
  command: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  yes: boolean,
): Promise<RpcProbeResult> {
  try {
    return await withCodexAppServer(command, workspace, env, async (client) => {
      let hooks: CodexHook[];
      try {
        hooks = await listHooks(client, workspace);
      } catch (error) {
        if (error instanceof CodexMethodUnavailableError) {
          return { hooks: false, hookTrust: "unknown", unstable: false };
        }
        // Malformed payloads and transport failures are inconclusive.
        return { hooks: false, hookTrust: "unknown", unstable: true };
      }

      let config: { filePath: string; version: string };
      try {
        config = await readConfigVersion(client, workspace);
      } catch {
        return { hooks: true, hookTrust: "unknown", unstable: true };
      }

      let hookTrust: "supported" | "unknown" = "supported";
      let unstable = false;
      if (yes) {
        // Never trust hooks owned by other plugins: the caller only consented
        // to memsync's own hook set.
        const ours = hooks.filter(isMemsyncOwnedHook);
        if (ours.length > 0) {
          try {
            await trustHooks(client, ours, config.filePath, config.version);
          } catch {
            // A failed trust write is a failed capability check, not a stable
            // "unsupported" result: force a re-probe next time.
            hookTrust = "unknown";
            unstable = true;
          }
        }
      }

      return { hooks: true, hookTrust, unstable };
    });
  } catch {
    return { hooks: false, hookTrust: "unknown", unstable: true };
  }
}

const PROBE_PLUGIN_ID = "memsync-probe";

/**
 * Writes a throwaway plugin in the isolated CODEX_HOME with a single hook.
 * The plugin layout mirrors the one the installer will use, but it only ever
 * contains the probe script written here.
 */
async function writeProbePlugin(
  codexHome: string,
  event: InjectionEvent,
  scriptBody: string,
): Promise<string> {
  const pluginRoot = join(codexHome, "plugins", PROBE_PLUGIN_ID);
  const hooksDir = join(pluginRoot, "hooks");
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(hooksDir, { recursive: true });

  const scriptPath = join(hooksDir, "probe-hook.mjs");
  await writeFile(scriptPath, `${scriptBody}\n`, "utf8");

  const command = `"${process.execPath}" "${scriptPath}"`;
  const hooks = {
    hooks: {
      [event]: [{ hooks: [{ type: "command", command, timeout: 10 }] }],
    },
  };
  await writeFile(
    join(hooksDir, "hooks.json"),
    `${JSON.stringify(hooks, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(
      { name: PROBE_PLUGIN_ID, version: "0.0.0", hooks: "hooks/hooks.json" },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return pluginRoot;
}

/**
 * Writes the probe plugin plus a marketplace entry and registers both through
 * the Codex CLI inside the isolated CODEX_HOME. A real Codex only executes
 * registered plugin hooks, so an unregistered directory would make every
 * behavioural probe falsely negative.
 */
async function installProbePlugin(
  command: string,
  env: NodeJS.ProcessEnv,
  base: string,
  codexHome: string,
  workspace: string,
  event: InjectionEvent,
  scriptBody: string,
): Promise<BehaviourProbe<boolean>> {
  const pluginRoot = await writeProbePlugin(codexHome, event, scriptBody);
  const marketplaceRoot = join(base, "marketplace");
  await mkdir(join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(
    join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify(
      {
        name: "memsync-probe-marketplace",
        plugins: [
          {
            id: PROBE_PLUGIN_ID,
            name: PROBE_PLUGIN_ID,
            path: pluginRoot,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const probeEnv = { ...env, CODEX_HOME: codexHome };
  const marketplaceAdd = await runCodex(
    command,
    ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
    { cwd: workspace, env: probeEnv, timeoutMs: REGISTRATION_TIMEOUT_MS },
  );
  if (marketplaceAdd.timedOut || marketplaceAdd.code !== 0) {
    return { value: false, unstable: true };
  }

  const pluginAdd = await runCodex(
    command,
    ["plugin", "add", PROBE_PLUGIN_ID, "--json"],
    { cwd: workspace, env: probeEnv, timeoutMs: REGISTRATION_TIMEOUT_MS },
  );
  if (pluginAdd.timedOut || pluginAdd.code !== 0) {
    return { value: false, unstable: true };
  }

  return { value: true, unstable: false };
}

async function probeInjection(
  command: string,
  env: NodeJS.ProcessEnv,
  event: InjectionEvent,
): Promise<BehaviourProbe<boolean>> {
  let base: string | undefined;
  try {
    base = await mkdtemp(join(tmpdir(), "memsync-codex-inject-"));
    const nonce = randomBytes(16).toString("hex");
    const codexHome = join(base, "home");
    const workspace = join(base, "workspace");
    await mkdir(codexHome, { recursive: true });
    await mkdir(workspace, { recursive: true });

    // Do not expose a caller's env file to a throwaway probe session.
    const probeEnv = withoutEnvFileVariables(env);

    const installed = await installProbePlugin(
      command,
      probeEnv,
      base,
      codexHome,
      workspace,
      event,
      `process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:${JSON.stringify(
        nonce,
      )}}}));`,
    );
    if (!installed.value) {
      return { value: false, unstable: installed.unstable };
    }

    const result = await runCodex(command, ["exec", INJECTION_PROMPT], {
      cwd: workspace,
      env: { ...probeEnv, CODEX_HOME: codexHome },
      timeoutMs: CODEX_OPERATION_TIMEOUT_MS,
    });

    if (result.timedOut) return { value: false, unstable: true };
    return {
      value: result.stdout.includes(nonce),
      // A non-zero exit means `codex exec` could not run the probe at all.
      unstable: result.code !== 0,
    };
  } catch {
    return { value: false, unstable: true };
  } finally {
    if (base !== undefined) {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Removes every `*ENV_FILE*` key so the probe cannot touch a caller file. */
function withoutEnvFileVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/ENV_FILE/i.test(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

async function probeEnvFile(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<BehaviourProbe<string | null>> {
  let base: string | undefined;
  try {
    base = await mkdtemp(join(tmpdir(), "memsync-codex-inject-"));
    const nonce = randomBytes(16).toString("hex");
    const codexHome = join(base, "home");
    const workspace = join(base, "workspace");
    const namesFile = join(base, "env-names.txt");
    await mkdir(codexHome, { recursive: true });
    await mkdir(workspace, { recursive: true });

    // Never inherit a caller's env file: drop every *ENV_FILE* variable before
    // the probe. The variable names present at spawn time form the baseline;
    // only names the runtime adds later count as runtime-provided.
    const probeEnv = withoutEnvFileVariables(env);
    const baseline = new Set(Object.keys(probeEnv));

    // The hook records variable *names* only and, when the runtime provides an
    // env file under the probe directory, exports a nonce there so a later
    // shell command can prove it.
    const script = [
      `import { appendFileSync, writeFileSync } from "node:fs";`,
      `import { isAbsolute, relative, resolve } from "node:path";`,
      `writeFileSync(${JSON.stringify(namesFile)}, Object.keys(process.env).join("\\n"));`,
      `const file = process.env.CODEX_ENV_FILE;`,
      `if (file) {`,
      `  const rel = relative(${JSON.stringify(base)}, resolve(file));`,
      `  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {`,
      `    appendFileSync(file, "export ${ENV_PROBE_VARIABLE}='${nonce}'\\n");`,
      `  }`,
      `}`,
    ].join("\n");

    const installed = await installProbePlugin(
      command,
      probeEnv,
      base,
      codexHome,
      workspace,
      "SessionStart",
      script,
    );
    if (!installed.value) {
      return { value: null, unstable: installed.unstable };
    }

    const result = await runCodex(command, ["exec", ENV_PROBE_PROMPT], {
      cwd: workspace,
      env: { ...probeEnv, CODEX_HOME: codexHome },
      timeoutMs: CODEX_OPERATION_TIMEOUT_MS,
    });

    if (result.timedOut) return { value: null, unstable: true };

    let names: string[] = [];
    try {
      names = (await readFile(namesFile, "utf8"))
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    } catch {
      // Hook never ran: inconclusive.
      return { value: null, unstable: result.code !== 0 };
    }

    const runtimeNames = names.filter((name) => !baseline.has(name));
    const candidate =
      runtimeNames.find((name) => name === "CODEX_ENV_FILE") ??
      runtimeNames.find((name) => /ENV_FILE/i.test(name));
    if (candidate === undefined) {
      return { value: null, unstable: result.code !== 0 };
    }

    // Found a candidate: only trust it when the export demonstrably reaches a
    // later command.
    if (!result.stdout.includes(nonce)) {
      return { value: null, unstable: result.code !== 0 };
    }

    return { value: candidate, unstable: false };
  } catch {
    return { value: null, unstable: true };
  } finally {
    if (base !== undefined) {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapabilities(value: unknown): value is CodexCapabilities {
  if (!isRecord(value)) return false;
  return (
    typeof value.plugin === "boolean" &&
    typeof value.hooks === "boolean" &&
    (value.hookTrust === "supported" || value.hookTrust === "unknown") &&
    typeof value.injectSessionStart === "boolean" &&
    typeof value.injectUserPrompt === "boolean" &&
    (value.envFile === null || typeof value.envFile === "string") &&
    (value.path === "A" || value.path === "A2" || value.path === "B")
  );
}

async function readCachedCapabilities(
  env: NodeJS.ProcessEnv,
  key: string,
): Promise<CodexCapabilities | undefined> {
  let raw: string;
  try {
    raw = await readFile(statePath(env, CAPABILITIES_FILE), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const entry = parsed[key];
  return isCapabilities(entry) ? entry : undefined;
}

async function writeCachedCapabilities(
  env: NodeJS.ProcessEnv,
  key: string,
  capabilities: CodexCapabilities,
): Promise<void> {
  let cache: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(
      await readFile(statePath(env, CAPABILITIES_FILE), "utf8"),
    );
    if (isRecord(parsed)) cache = parsed;
  } catch {
    // Missing or corrupt cache is replaced.
  }

  cache[key] = capabilities;
  await writeFileAtomic(
    statePath(env, CAPABILITIES_FILE),
    `${JSON.stringify(cache, null, 2)}\n`,
  );
}

function forcedCapabilities(
  path: "A" | "B" | undefined,
  codexVersion: string | undefined,
  probedAt: string,
): CodexCapabilities | undefined {
  if (path === undefined) return undefined;
  return {
    ...(codexVersion !== undefined ? { codexVersion } : {}),
    plugin: false,
    hooks: false,
    hookTrust: "unknown",
    injectSessionStart: false,
    injectUserPrompt: false,
    envFile: null,
    path,
    probedAt,
  };
}

/**
 * Detects Codex capabilities with behavioural probes under an isolated
 * CODEX_HOME. Any uncertainty degrades to path B. Results are cached at
 * `$MEMSYNC_HOME/state/capabilities.json` keyed by `<version>|<command>`.
 *
 * Cached entries never bypass a confirmed (`yes`) run: trust is re-verified
 * every time a caller asks for it. Task 12 must pass `force: true` when
 * re-probing after plugin installation, because a path B result recorded
 * before installation is otherwise valid for the same Codex version/command.
 */
export async function probeCodex(
  env: NodeJS.ProcessEnv,
  workspace: string,
  opts: ProbeCodexOptions = {},
): Promise<CodexCapabilities> {
  const command = opts.command ?? "codex";
  const probedAt = new Date().toISOString();
  const codexVersion = await readCodexVersion(command, env, workspace);

  const forced = forcedCapabilities(opts.forcePath, codexVersion, probedAt);
  if (forced !== undefined) return forced;

  const cacheKey = `${codexVersion ?? ""}|${command}`;
  // A confirmed run must actually perform the trust write; never answer it
  // from a cache produced by an unconfirmed probe.
  if (codexVersion !== undefined && opts.force !== true && opts.yes !== true) {
    const cached = await readCachedCapabilities(env, cacheKey);
    if (cached !== undefined) return cached;
  }

  let plugin = false;
  let hooks = false;
  let hookTrust: "supported" | "unknown" = "unknown";
  let injectSessionStart = false;
  let injectUserPrompt = false;
  let envFile: string | null = null;
  let uncertain = codexVersion === undefined;

  if (codexVersion !== undefined) {
    const pluginProbe = await hasPluginSubcommand(command, env, workspace);
    plugin = pluginProbe.value;
    uncertain ||= pluginProbe.unstable;

    const rpc = await probeViaAppServer(command, workspace, env, opts.yes === true);
    hooks = rpc.hooks;
    hookTrust = rpc.hookTrust;
    uncertain ||= rpc.unstable;

    if (hooks) {
      const sessionStart = await probeInjection(command, env, "SessionStart");
      injectSessionStart = sessionStart.value;
      uncertain ||= sessionStart.unstable;

      const userPrompt = await probeInjection(command, env, "UserPromptSubmit");
      injectUserPrompt = userPrompt.value;
      uncertain ||= userPrompt.unstable;

      const envProbe = await probeEnvFile(command, env);
      envFile = envProbe.value;
      uncertain ||= envProbe.unstable;
    }
  }

  // Uncertainty always wins: a partially observed capability set must never
  // be promoted to path A/A2.
  const path: "A" | "A2" | "B" = uncertain
    ? "B"
    : hooks && injectSessionStart
      ? "A"
      : hooks && injectUserPrompt
        ? "A2"
        : "B";

  const capabilities: CodexCapabilities = {
    ...(codexVersion !== undefined ? { codexVersion } : {}),
    plugin,
    hooks,
    hookTrust,
    injectSessionStart,
    injectUserPrompt,
    envFile,
    path,
    probedAt,
  };

  if (codexVersion !== undefined && !uncertain) {
    await writeCachedCapabilities(env, cacheKey, capabilities).catch(() => {});
  }

  return capabilities;
}
