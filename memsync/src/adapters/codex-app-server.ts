import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/** Every app-server operation (including initialize) is bounded by 10 seconds. */
export const CODEX_OPERATION_TIMEOUT_MS = 10_000;

/** Grace period between SIGTERM and SIGKILL when shutting the server down. */
const CODEX_KILL_GRACE_MS = 500;

/**
 * A live app-server session. `codexHome` and `workspace` are recorded by
 * `withCodexAppServer` so later calls (`readConfigVersion`, `trustHooks`) can
 * place requests without widening their public signatures.
 */
export interface CodexClient {
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  readonly codexHome?: string;
  readonly workspace?: string;
}

export interface CodexHook {
  key: string;
  currentHash: string;
  pluginId?: string;
  handlerType: string;
  eventName: string;
  command: string;
  trustStatus: string;
}

/** Raised when the server answers with JSON-RPC "method not found". */
export class CodexMethodUnavailableError extends Error {
  constructor(method: string) {
    super(`codex app-server does not support ${method}`);
    this.name = "CodexMethodUnavailableError";
  }
}

/** JSON-RPC error response. The server's message is not surfaced verbatim. */
export class CodexRpcError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
  }
}

export interface CodexSpawnTarget {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * Resolves an extension-less command through PATHEXT on Windows so `codex`
 * finds `codex.cmd` the same way a shell would.
 */
export function resolveCodexCommand(command: string): string {
  if (process.platform !== "win32") return command;
  if (/\.[^\\/]+$/.test(command)) return command;

  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
  if (extensions.length === 0) return command;

  const hasSeparator = /[\\/]/.test(command);
  const directories = hasSeparator
    ? [dirname(command)]
    : (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  const name = basename(command);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
      const upper = join(directory, `${name}${extension.toUpperCase()}`);
      if (existsSync(upper)) return upper;
    }
  }
  return command;
}

function quoteForCmd(value: string): string {
  // Probe arguments are generated locally and never contain quotes or `%`.
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Builds the concrete process invocation. `.cmd`/`.bat` shims (including the
 * npm-installed Windows `codex.cmd`) cannot be spawned directly on Windows, so
 * they are routed through `cmd.exe /d /s /c`.
 */
export function codexSpawnTarget(command: string, args: string[]): CodexSpawnTarget {
  const resolved = resolveCodexCommand(command);

  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    const inner = [resolved, ...args].map(quoteForCmd).join(" ");
    return {
      file: comspec,
      args: ["/d", "/s", "/c", `"${inner}"`],
      windowsVerbatimArguments: true,
    };
  }

  return { file: resolved, args };
}

export function codexHomeFromEnv(env: NodeJS.ProcessEnv): string {
  const configured = env.CODEX_HOME?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : join(homedir(), ".codex");
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Starts `command app-server --stdio`, performs the `initialize` handshake, and
 * runs `fn` with a request/response client. The child is always terminated
 * (SIGTERM, then SIGKILL after 500ms) even when `fn` throws.
 */
export async function withCodexAppServer<T>(
  command: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  fn: (client: CodexClient) => Promise<T>,
): Promise<T> {
  const target = codexSpawnTarget(command, ["app-server", "--stdio"]);
  const child: ChildProcessWithoutNullStreams = spawn(target.file, target.args, {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(target.windowsVerbatimArguments === true
      ? { windowsVerbatimArguments: true }
      : {}),
  });

  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let exited = false;
  let exitError: Error | undefined;
  let buffered = "";

  const settleAll = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const rememberExit = (error: Error): void => {
    exited = true;
    exitError ??= error;
    settleAll(exitError);
  };

  // stderr is drained but never inspected: it can contain paths and secrets.
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => {});

  child.on("error", () => {
    rememberExit(new Error("failed to start codex app-server"));
  });
  child.on("exit", () => {
    rememberExit(new Error("codex app-server exited before completing the request"));
  });

  const handleLine = (line: string): void => {
    const text = line.trim();
    if (text.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    const id = typeof parsed.id === "number" ? parsed.id : undefined;
    if (id === undefined) return; // notifications are ignored

    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    clearTimeout(waiting.timer);

    if (isRecord(parsed.error)) {
      const code = parsed.error.code;
      waiting.reject(
        new CodexRpcError(
          "codex app-server returned an error",
          typeof code === "number" ? code : undefined,
        ),
      );
      return;
    }

    waiting.resolve(isRecord(parsed.result) ? parsed.result : {});
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      handleLine(line);
    }
  });

  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    termination ??= (async () => {
      child.stdin.end();
      if (!exited) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }

        const killTimer = setTimeout(() => {
          if (!exited) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }, CODEX_KILL_GRACE_MS);
        killTimer.unref?.();

        await new Promise<void>((resolveExit) => {
          if (exited) {
            resolveExit();
            return;
          }
          const guard = setTimeout(resolveExit, 2_000);
          guard.unref?.();
          child.once("exit", () => {
            clearTimeout(guard);
            resolveExit();
          });
        });
        clearTimeout(killTimer);
      }
      settleAll(exitError ?? new Error("codex app-server closed"));
    })();
    return termination;
  };

  const request = (
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (exited) {
      return Promise.reject(
        exitError ?? new Error("codex app-server is not running"),
      );
    }

    return new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`codex app-server request timed out: ${method}`));
        void terminate();
      }, CODEX_OPERATION_TIMEOUT_MS);
      timer.unref?.();

      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });

      try {
        if (!child.stdin.writable) {
          throw new Error("codex app-server is not running");
        }
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        rejectRequest(new Error("codex app-server is not running"));
      }
    });
  };

  const client: CodexClient = {
    request,
    codexHome: codexHomeFromEnv(env),
    workspace,
  };

  try {
    await request("initialize", { clientInfo: { name: "memsync", version: "0" } });
    return await fn(client);
  } finally {
    await terminate();
  }
}

const REQUIRED_HOOK_FIELDS = [
  "key",
  "currentHash",
  "handlerType",
  "eventName",
  "command",
  "trustStatus",
] as const;

function assertHook(value: unknown): CodexHook {
  if (!isRecord(value)) {
    throw new Error("codex hooks/list returned a malformed hook");
  }
  for (const field of REQUIRED_HOOK_FIELDS) {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error(`codex hooks/list returned a hook missing ${field}`);
    }
  }

  // `pluginId` is optional: user-defined hooks have no owning plugin and must
  // not make the whole listing unusable.
  let pluginId: string | undefined;
  if (value.pluginId !== undefined && value.pluginId !== null) {
    if (typeof value.pluginId !== "string" || value.pluginId.length === 0) {
      throw new Error("codex hooks/list returned an invalid pluginId");
    }
    pluginId = value.pluginId;
  }

  return {
    key: value.key as string,
    currentHash: value.currentHash as string,
    ...(pluginId !== undefined ? { pluginId } : {}),
    handlerType: value.handlerType as string,
    eventName: value.eventName as string,
    command: value.command as string,
    trustStatus: value.trustStatus as string,
  };
}

/** Lists hooks for the workspace, rejecting malformed or error-bearing payloads. */
export async function listHooks(
  client: CodexClient,
  workspace: string,
): Promise<CodexHook[]> {
  let result: Record<string, unknown>;
  try {
    result = await client.request("hooks/list", { cwds: [workspace] });
  } catch (error) {
    if (error instanceof CodexRpcError && error.code === -32601) {
      throw new CodexMethodUnavailableError("hooks/list");
    }
    throw error;
  }

  const data = result.data;
  if (!Array.isArray(data)) {
    throw new Error("codex hooks/list returned no data array");
  }

  const hooks: CodexHook[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) {
      throw new Error("codex hooks/list returned an invalid workspace entry");
    }
    if (entry.errors !== undefined) {
      if (!Array.isArray(entry.errors)) {
        throw new Error("codex hooks/list returned invalid workspace errors");
      }
      if (entry.errors.length > 0) {
        throw new Error("codex hooks/list reported workspace errors");
      }
    }

    const entryHooks = entry.hooks;
    if (!Array.isArray(entryHooks)) {
      throw new Error("codex hooks/list returned no hooks array");
    }
    for (const hook of entryHooks) {
      hooks.push(assertHook(hook));
    }
  }
  return hooks;
}

function extractLayers(result: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(result.layers)) return result.layers.filter(isRecord);
  if (Array.isArray(result.data)) return result.data.filter(isRecord);
  if (isRecord(result.data) && Array.isArray(result.data.layers)) {
    return result.data.layers.filter(isRecord);
  }
  if (typeof result.filePath === "string") return [result];
  return [];
}

function isUnder(filePath: string, root: string): boolean {
  const path = relative(resolve(root), resolve(filePath));
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

/**
 * Reads the config layer used for trust metadata: the user layer under
 * CODEX_HOME when present, otherwise the first layer reported.
 */
export async function readConfigVersion(
  client: CodexClient,
  workspace: string,
): Promise<{ filePath: string; version: string }> {
  const result = await client.request("config/read", { cwds: [workspace] });
  const layers = extractLayers(result);
  if (layers.length === 0) {
    throw new Error("codex config/read returned no layers");
  }

  const codexHome = client.codexHome ?? codexHomeFromEnv(process.env);
  const userLayer = layers.find(
    (layer) => typeof layer.filePath === "string" && isUnder(layer.filePath, codexHome),
  );
  const chosen = userLayer ?? layers[0];

  const filePath = chosen.filePath;
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("codex config/read returned no filePath");
  }
  const version =
    typeof chosen.version === "string"
      ? chosen.version
      : typeof chosen.version === "number"
        ? String(chosen.version)
        : "";
  if (version.length === 0) {
    throw new Error("codex config/read returned no version");
  }

  return { filePath, version };
}

function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Writes `hooks.state.<key>.trusted_hash` for every hook, then verifies through
 * a fresh `hooks/list` that each selected hook is trusted.
 */
export async function trustHooks(
  client: CodexClient,
  hooks: CodexHook[],
  filePath: string,
  expectedVersion: string,
): Promise<void> {
  if (hooks.length === 0) return;

  const edits = hooks.map((hook) => ({
    keyPath: `hooks.state.${tomlQuote(hook.key)}.trusted_hash`,
    value: hook.currentHash,
    mergeStrategy: "upsert",
  }));

  await client.request("config/batchWrite", {
    edits,
    filePath,
    expectedVersion,
    reloadUserConfig: true,
  });

  const workspace = client.workspace;
  if (workspace === undefined || workspace.length === 0) {
    throw new Error("codex client did not record a workspace for trust verification");
  }

  const after = await listHooks(client, workspace);
  const byKey = new Map(after.map((hook) => [hook.key, hook]));
  for (const hook of hooks) {
    const current = byKey.get(hook.key);
    if (current === undefined || current.trustStatus !== "trusted") {
      throw new Error(`codex hook ${hook.key} is not trusted after writing its hash`);
    }
  }
}
