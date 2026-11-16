import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexMethodUnavailableError,
  listHooks,
  readConfigVersion,
  trustHooks,
  withCodexAppServer,
  type CodexHook,
} from "../../src/adapters/codex-app-server.js";
import { makeFakeCodex } from "../fixtures/codex-shim.js";

interface Setup {
  root: string;
  workspace: string;
  codexHome: string;
  command: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
}

async function setup(mode: string, extra: NodeJS.ProcessEnv = {}): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "memsync-rpc-"));
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(codexHome, { recursive: true });

  const fake = await makeFakeCodex();
  const logPath = join(root, "fake-codex.log");

  return {
    root,
    workspace,
    codexHome,
    command: fake.command,
    logPath,
    env: {
      ...process.env,
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

describe("withCodexAppServer", () => {
  it("initializes the session and lists hooks", async () => {
    const test = await setup("hooks-ok");

    const hooks = await withCodexAppServer(test.command, test.workspace, test.env, (client) =>
      listHooks(client, test.workspace),
    );

    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject<Partial<CodexHook>>({
      key: "memsync/session.start",
      currentHash: "sha256:abc123",
      pluginId: "memsync",
      handlerType: "command",
      eventName: "SessionStart",
      command: "memsync hook session-start --tool codex",
      trustStatus: "untrusted",
    });
    expect(await readLog(test.logPath)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "app-server" })]),
    );
  });

  it("accepts a hook without a pluginId", async () => {
    const test = await setup("hooks-ok", { FAKE_CODEX_DROP_PLUGIN: "1" });

    const hooks = await withCodexAppServer(test.command, test.workspace, test.env, (client) =>
      listHooks(client, test.workspace),
    );

    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.pluginId).toBeUndefined();
    expect(hooks[0]?.key).toBe("memsync/session.start");
  });

  it("maps JSON-RPC -32601 to CodexMethodUnavailableError", async () => {
    const test = await setup("method-not-found");

    await expect(
      withCodexAppServer(test.command, test.workspace, test.env, (client) =>
        listHooks(client, test.workspace),
      ),
    ).rejects.toBeInstanceOf(CodexMethodUnavailableError);
  });

  it.each([
    ["non-array-data", /data/i],
    ["workspace-error", /errors/i],
    ["missing-field", /currentHash/i],
  ])("rejects malformed hooks payload %s", async (payload, message) => {
    const test = await setup("hooks-ok", { FAKE_CODEX_HOOKS_PAYLOAD: payload });

    await expect(
      withCodexAppServer(test.command, test.workspace, test.env, (client) =>
        listHooks(client, test.workspace),
      ),
    ).rejects.toThrow(message);
  });

  it("does not leak app-server stderr into errors", async () => {
    const test = await setup("hooks-ok", { FAKE_CODEX_CRASH: "1" });

    let error: unknown;
    try {
      await withCodexAppServer(test.command, test.workspace, test.env, (client) =>
        listHooks(client, test.workspace),
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("SECRET_PATH");
    expect((error as Error).message).not.toContain("token=abc");
  });
});

describe("readConfigVersion", () => {
  it("prefers the user layer under CODEX_HOME over the first layer", async () => {
    const test = await setup("hooks-ok", { FAKE_CODEX_PROJECT_LAYER: "1" });

    const config = await withCodexAppServer(test.command, test.workspace, test.env, (client) =>
      readConfigVersion(client, test.workspace),
    );

    expect(config).toEqual({
      filePath: join(test.codexHome, "config.toml"),
      version: "user-v1",
    });
  });
});

describe("trustHooks", () => {
  it("writes a TOML-quoted trusted_hash and verifies the result", async () => {
    const test = await setup("hooks-ok");
    let filePath = "";
    let version = "";

    await withCodexAppServer(test.command, test.workspace, test.env, async (client) => {
      const hooks = await listHooks(client, test.workspace);
      expect(hooks[0]?.key).toBe("memsync/session.start");

      const config = await readConfigVersion(client, test.workspace);
      filePath = config.filePath;
      version = config.version;

      await trustHooks(client, hooks, filePath, version);

      const after = await listHooks(client, test.workspace);
      expect(after[0]?.trustStatus).toBe("trusted");
    });

    const writes = await readLog(test.logPath);
    const batch = writes.find((entry) => entry.kind === "batchWrite");
    expect(batch).toBeDefined();
    expect(batch?.params).toMatchObject({
      filePath,
      expectedVersion: version,
      reloadUserConfig: true,
      edits: [
        {
          keyPath: 'hooks.state."memsync/session.start".trusted_hash',
          value: "sha256:abc123",
          mergeStrategy: "upsert",
        },
      ],
    });
  });

  it("throws when the trust write is not reflected by hooks/list", async () => {
    const test = await setup("hooks-ok", { FAKE_CODEX_TRUST_REJECT: "1" });

    await expect(
      withCodexAppServer(test.command, test.workspace, test.env, async (client) => {
        const hooks = await listHooks(client, test.workspace);
        const config = await readConfigVersion(client, test.workspace);
        await trustHooks(client, hooks, config.filePath, config.version);
      }),
    ).rejects.toThrow(/trust/i);
  });

  it("does nothing when the hook list is empty", async () => {
    const test = await setup("hooks-ok");

    await expect(
      withCodexAppServer(test.command, test.workspace, test.env, async (client) => {
        await trustHooks(client, [], join(test.codexHome, "config.toml"), "user-v1");
      }),
    ).resolves.toBeUndefined();
  });
});
