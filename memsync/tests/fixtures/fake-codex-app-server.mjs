#!/usr/bin/env node
// Minimal stand-in for the `codex` executable used by the capability probes.
//
// It can act as the CLI (`--version`, `plugin --help`, `exec`) and as the
// app-server (`app-server --stdio`, newline-delimited JSON-RPC). Behaviour is
// selected with FAKE_CODEX_MODE; optional FAKE_CODEX_* variables tweak single
// probe dimensions. Everything is stdlib-only so the fixture stays dependency
// free and runs with the same Node executable as the tests.
import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const MODE = process.env.FAKE_CODEX_MODE ?? "hooks-ok";
const VERSION = process.env.FAKE_CODEX_VERSION ?? "9.9.9";

function log(entry) {
  const path = process.env.FAKE_CODEX_LOG;
  if (!path) return;
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

function codexHome() {
  return process.env.CODEX_HOME ?? join(process.cwd(), ".fake-codex-home");
}

// Registration state lives in the isolated CODEX_HOME so `plugin
// marketplace add` / `plugin add` in one process is visible to a later
// `exec`. Plugin discovery requires both a registered marketplace and the
// plugin id; a bare directory under plugins/ is deliberately not enough.
function registryFile() {
  return join(codexHome(), ".fake-codex-registry.json");
}

function readRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(), "utf8"));
    return {
      marketplaces: Array.isArray(parsed.marketplaces) ? parsed.marketplaces : [],
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
    };
  } catch {
    return { marketplaces: [], plugins: [] };
  }
}

function updateRegistry(mutate) {
  const registry = readRegistry();
  mutate(registry);
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(registryFile(), JSON.stringify(registry));
}

function write(s) {
  process.stdout.write(s);
}

function fail(message) {
  write(`${message}\n`);
  process.exit(1);
}

// --- app-server -----------------------------------------------------------

// Trust is persisted per key together with the hash that was trusted, so a
// separate process (e.g. `codex exec`) can tell whether an upgraded hook lost
// its trust. A Set alone would forget everything between CLI invocations.
function trustFile() {
  return join(codexHome(), ".fake-codex-trust.json");
}

function readTrust() {
  try {
    const parsed = JSON.parse(readFileSync(trustFile(), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeTrust(map) {
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(trustFile(), JSON.stringify(map));
}

const TRUSTED = readTrust();

const HOOK_KEY = process.env.FAKE_CODEX_HOOK_KEY ?? 'memsync/session.start';
const HOOK_HASH = process.env.FAKE_CODEX_HOOK_HASH ?? "sha256:abc123";
const HOOK_PLUGIN = process.env.FAKE_CODEX_HOOK_PLUGIN ?? "memsync";
const HOOK_COMMAND =
  process.env.FAKE_CODEX_HOOK_COMMAND ?? "memsync hook session-start --tool codex";

function hookEntry() {
  const entry = {
    key: HOOK_KEY,
    currentHash: HOOK_HASH,
    pluginId: HOOK_PLUGIN,
    handlerType: "command",
    eventName: "SessionStart",
    command: HOOK_COMMAND,
    trustStatus: TRUSTED[HOOK_KEY] === HOOK_HASH ? "trusted" : "untrusted",
  };
  if (process.env.FAKE_CODEX_DROP_PLUGIN === "1") delete entry.pluginId;
  return entry;
}

function hooksListResult(params) {
  const payload = process.env.FAKE_CODEX_HOOKS_PAYLOAD;
  if (payload === "non-array-data") return { data: "nope" };
  if (payload === "workspace-error") {
    return { data: [{ cwd: params.cwds?.[0], errors: ["boom"], hooks: [] }] };
  }
  if (payload === "missing-field") {
    const broken = hookEntry();
    delete broken.currentHash;
    return { data: [{ cwd: params.cwds?.[0], hooks: [broken] }] };
  }
  return { data: [{ cwd: params.cwds?.[0], hooks: [hookEntry()] }] };
}

function configReadResult() {
  const home = codexHome();
  const layers = [];
  if (process.env.FAKE_CODEX_PROJECT_LAYER) {
    layers.push({
      filePath: join(process.cwd(), ".codex", "config.toml"),
      version: "project-v1",
    });
  }
  layers.push({ filePath: join(home, "config.toml"), version: "user-v1" });
  return { layers };
}

function tomlKey(keyPath) {
  const match = /^hooks\.state\.(.+)\.trusted_hash$/.exec(keyPath);
  if (!match) return undefined;
  let raw = match[1];
  if (raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return raw;
}

function batchWrite(params) {
  if (!Array.isArray(params.edits)) return { error: { code: -32602, message: "edits" } };
  if (typeof params.filePath !== "string") return { error: { code: -32602, message: "filePath" } };
  if (typeof params.expectedVersion !== "string") {
    return { error: { code: -32602, message: "expectedVersion" } };
  }
  if (params.reloadUserConfig !== true) {
    return { error: { code: -32602, message: "reloadUserConfig" } };
  }

  log({ kind: "batchWrite", params });
  if (process.env.FAKE_CODEX_TRUST_REJECT !== "1") {
    for (const edit of params.edits) {
      const key = tomlKey(edit.keyPath);
      if (key !== undefined && typeof edit.value === "string") {
        TRUSTED[key] = edit.value;
      }
    }
    writeTrust(TRUSTED);
  }
  return { version: "user-v2" };
}

function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    return { id, result: { userAgent: `fake-codex/${VERSION}` } };
  }
  if (method === "hooks/list") {
    if (MODE === "method-not-found") {
      return { id, error: { code: -32601, message: "Method not found" } };
    }
    return { id, result: hooksListResult(params) };
  }
  if (method === "config/read") {
    if (process.env.FAKE_CODEX_CONFIG_READ_MODE === "method-not-found") {
      return { id, error: { code: -32601, message: "Method not found" } };
    }
    return { id, result: configReadResult() };
  }
  if (method === "config/batchWrite") {
    const result = batchWrite(params);
    return result.error ? { id, error: result.error } : { id, result };
  }
  return { id, error: { code: -32601, message: "Method not found" } };
}

function runAppServer() {
  log({ kind: "app-server", mode: MODE, codexHome: process.env.CODEX_HOME });
  if (process.env.FAKE_CODEX_CRASH === "1") {
    // Deliberately noisy stderr: the client must never surface it.
    process.stderr.write("SECRET_PATH C:\\private\\token=abc\n");
    process.exit(3);
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message?.id !== "number") continue;
      write(`${JSON.stringify(handleRequest(message))}\n`);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

// --- exec -----------------------------------------------------------------

function registeredPluginRoots() {
  const registry = readRegistry();
  const roots = [];
  for (const marketplace of registry.marketplaces) {
    let parsed;
    try {
      parsed = JSON.parse(
        readFileSync(join(marketplace, ".agents", "plugins", "marketplace.json"), "utf8"),
      );
    } catch {
      continue;
    }
    for (const plugin of Array.isArray(parsed.plugins) ? parsed.plugins : []) {
      if (typeof plugin?.id !== "string" || typeof plugin.path !== "string") continue;
      if (!registry.plugins.includes(plugin.id)) continue;
      roots.push(resolve(marketplace, plugin.path));
    }
  }
  return roots;
}

function collectHooks() {
  const hooks = [];
  for (const pluginRoot of registeredPluginRoots()) {
    const file = join(pluginRoot, "hooks", "hooks.json");
    if (!existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
          if (typeof hook?.command === "string") hooks.push({ event, command: hook.command });
        }
      }
    }
  }
  return hooks;
}

function runHooks(event, env) {
  // A real Codex only executes hooks whose current hash is trusted. Opt-in so
  // the capability probes (which register throwaway plugins) stay unaffected.
  if (
    process.env.FAKE_CODEX_ENFORCE_TRUST === "1" &&
    TRUSTED[HOOK_KEY] !== HOOK_HASH
  ) {
    return [];
  }

  const contexts = [];
  for (const hook of collectHooks()) {
    if (hook.event !== event) continue;
    try {
      const output = execSync(hook.command, { encoding: "utf8", env, timeout: 5000 });
      const parsed = JSON.parse(output);
      const context = parsed?.hookSpecificOutput?.additionalContext;
      if (typeof context === "string") contexts.push(context);
    } catch {
      // A hook that fails simply contributes nothing.
    }
  }
  return contexts;
}

function handleExec(args) {
  log({
    kind: "exec",
    args,
    codexHome: process.env.CODEX_HOME,
    mode: MODE,
    hasEnvFile: process.env.CODEX_ENV_FILE !== undefined,
  });
  // An inherited CODEX_ENV_FILE is deliberately left in place: the probe must
  // strip it before spawning, and the test fixture reports what it received.
  const env = { ...process.env };
  let envFile;
  if (MODE === "env-file-ok") {
    envFile = join(process.cwd(), ".fake-codex-env");
    mkdirSync(process.cwd(), { recursive: true });
    writeFileSync(envFile, "", "utf8");
    env.CODEX_ENV_FILE = envFile;
  }

  const contexts = [
    ...runHooks("SessionStart", env),
    ...runHooks("UserPromptSubmit", env),
  ];

  if (MODE === "inject-ok" && contexts.length > 0) {
    write(`${contexts[0]}\n`);
    return;
  }

  if (MODE === "env-file-ok" && envFile !== undefined) {
    let content = "";
    try {
      content = readFileSync(envFile, "utf8");
    } catch {
      // No export reached the env file.
    }
    const match = /MEMSYS_CODEX_ENV_PROBE=(?:'([^']*)'|([^\s]+))/.exec(content);
    write(`${match ? (match[1] ?? match[2]) : "NO_TOKEN"}\n`);
    return;
  }

  write("NO_TOKEN\n");
}

// --- entry ----------------------------------------------------------------

const args = process.argv.slice(2);
log({ kind: "cli", args });

if (args[0] === "app-server" && args[1] === "--stdio") {
  runAppServer();
} else if (args[0] === "--version") {
  write(`${VERSION}\n`);
} else if (args[0] === "plugin") {
  if (args[1] === "--help") {
    write("Usage: codex plugin <command>\n");
    process.exit(0);
  }
  if (process.env.FAKE_CODEX_REGISTRATION_FAIL === "1") {
    fail("plugin registration unavailable");
  }
  const idempotentErrors = process.env.FAKE_CODEX_IDEMPOTENT_ERRORS === "1";
  if (args[1] === "marketplace" && args[2] === "add") {
    const root = args[3];
    if (!root) fail("missing marketplace root");
    if (idempotentErrors && readRegistry().marketplaces.includes(root)) {
      fail("marketplace already added");
    }
    updateRegistry((registry) => {
      if (!registry.marketplaces.includes(root)) registry.marketplaces.push(root);
    });
    write(`${JSON.stringify({ ok: true, marketplace: root })}\n`);
    process.exit(0);
  }
  if (args[1] === "add") {
    const id = args[2];
    if (!id) fail("missing plugin id");
    if (idempotentErrors && readRegistry().plugins.includes(id)) {
      fail("plugin already installed");
    }
    updateRegistry((registry) => {
      if (!registry.plugins.includes(id)) registry.plugins.push(id);
    });
    write(`${JSON.stringify({ ok: true, plugin: id })}\n`);
    process.exit(0);
  }
  fail("unsupported fake plugin command");
} else if (args[0] === "exec") {
  handleExec(args.slice(1));
} else if (args.length === 0) {
  fail("missing command");
} else {
  // Task 12 wrapper mode: record the inherited session env, optionally mutate
  // the journal directory, and exit with a caller-chosen status.
  if (process.env.FAKE_CODEX_ENV_LOG) {
    writeFileSync(
      process.env.FAKE_CODEX_ENV_LOG,
      JSON.stringify({
        args,
        MEMSYS_SESSION: process.env.MEMSYS_SESSION,
        MEMSYS_TOOL: process.env.MEMSYS_TOOL,
        MEMSYS_HOST: process.env.MEMSYS_HOST,
        MEMSYS_WRAPPER: process.env.MEMSYS_WRAPPER,
        wrapperMarker: existsSync(".memsync/wrapper-active"),
        cwd: process.cwd(),
      }),
      "utf8",
    );
  }
  if (process.env.FAKE_CODEX_RM_DIR) {
    rmSync(process.env.FAKE_CODEX_RM_DIR, { recursive: true, force: true });
  }
  const exitCode = process.env.FAKE_CODEX_EXIT_CODE;
  if (exitCode !== undefined) process.exit(Number(exitCode));
  write("ok\n");
}
