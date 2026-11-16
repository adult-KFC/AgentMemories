import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findJournalBySession,
  listJournals,
  readJournal,
  readJournalDocument,
} from "../../src/core/journal.js";
import { FAKE_CODEX_FIXTURE, makeFakeCodex } from "../fixtures/codex-shim.js";
import {
  makeMemoryRepo,
  runCliIn,
  type MemoryRepoSetup,
  type TestHome,
} from "./helpers.js";

interface CodexSetup extends MemoryRepoSetup {
  logPath: string;
  fakeEnv: NodeJS.ProcessEnv;
}

async function makeCodexSetup(): Promise<CodexSetup> {
  const team = await makeMemoryRepo();
  const fake = await makeFakeCodex();
  const logPath = join(team.admin.root, "fake-codex.log");

  return {
    ...team,
    logPath,
    fakeEnv: {
      MEMSYNC_CODEX_PATH: fake.command,
      FAKE_CODEX_MODE: "inject-ok",
      FAKE_CODEX_LOG: logPath,
      FAKE_CODEX_HOOK_PLUGIN: "memsync",
      FAKE_CODEX_HOOK_KEY: "memsync-codex-adapter@SessionStart",
    },
  };
}

function execFake(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [FAKE_CODEX_FIXTURE, ...args],
      { cwd, env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`fake codex failed: ${String(stderr).trim() || error.message}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function readLog(path: string): Promise<Array<Record<string, any>>> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

async function trustedHashes(path: string): Promise<string[]> {
  return (await readLog(path))
    .filter((entry) => entry.kind === "batchWrite")
    .flatMap((entry) =>
      Array.isArray(entry.params?.edits)
        ? entry.params.edits
            .filter((edit: unknown) => typeof (edit as { value?: unknown }).value === "string")
            .map((edit: { value: unknown }) => edit.value as string)
        : [],
    );
}

function codexHookPayload(workspace: string, session: string): string {
  return JSON.stringify({ session_id: session, cwd: workspace, source: "startup" });
}

/**
 * The journal filename embeds the first six alphanumeric characters, so the
 * ten launch ids must differ within that prefix to avoid same-second
 * same-name overwrites.
 */
function distinctSessionId(index: number): string {
  return `c0de${index.toString(16).padStart(2, "0")}00-1111-4222-8333-000000000000`;
}

describe("e2e Codex integration", () => {
  it("scenario 9: path A hooks produce a complete record on every launch", async () => {
    const setup = await makeCodexSetup();

    const install = await runCliIn(
      setup.admin,
      ["install", "--tool", "codex", "--yes"],
      { cwd: setup.workspace, env: setup.fakeEnv },
    );
    expect(install.code, install.err).toBe(0);
    expect(install.out).toContain("path A");

    for (let index = 0; index < 10; index += 1) {
      const session = distinctSessionId(index);
      const started = await runCliIn(
        setup.admin,
        ["hook", "session-start", "--tool", "codex"],
        {
          cwd: setup.workspace,
          stdin: codexHookPayload(setup.workspace, session),
          env: setup.fakeEnv,
        },
      );
      expect(started.code, started.err).toBe(0);
      const parsed = JSON.parse(started.out) as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      expect(parsed.hookSpecificOutput?.additionalContext).toContain("项目核心约束");

      const stopped = await runCliIn(
        setup.admin,
        ["hook", "stop", "--tool", "codex"],
        {
          cwd: setup.workspace,
          stdin: codexHookPayload(setup.workspace, session),
          env: setup.fakeEnv,
        },
      );
      expect(stopped.code, stopped.err).toBe(0);

      const path = await findJournalBySession(setup.project.projectDir, session);
      expect(path).toBeDefined();
      const record = await readJournal(path as string);
      expect(record).toMatchObject({
        project: setup.project.slug,
        user: "Alice",
        email: "alice@corp.com",
        host: "E2E-HOST",
        tool: "codex",
        session,
      });
      expect(record.ended).toBeTruthy();
      expect(record.branch).toBeTruthy();
      expect(typeof record.files_changed).toBe("number");
      expect(typeof record.insertions).toBe("number");
      expect(typeof record.deletions).toBe("number");
    }

    // Ten distinct journals, not ten launches overwriting one filename.
    const documents = await Promise.all(
      (await listJournals(setup.project.projectDir)).map((path) =>
        readJournalDocument(path),
      ),
    );
    const pathARecords = documents
      .map((document) => document.record)
      .filter(
        (record) => record.tool === "codex" && record.session.startsWith("c0de"),
      );
    expect(pathARecords).toHaveLength(10);
    expect(new Set(pathARecords.map((record) => record.session)).size).toBe(10);
    expect(pathARecords.every((record) => record.ended !== undefined)).toBe(true);
  }, 120_000);

  it("scenario 9b: path B wraps the tool and records every launch", async () => {
    const setup = await makeCodexSetup();

    const install = await runCliIn(
      setup.admin,
      ["install", "--tool", "codex", "--force-path", "B"],
      { cwd: setup.workspace, env: setup.fakeEnv },
    );
    expect(install.code, install.err).toBe(0);
    expect(install.out).toMatch(/fallback/i);

    const agents = await readFile(join(setup.admin.codexDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("memsync:begin");
    expect(agents).toContain("memsync sync");
    expect(agents).toContain("memsync note");

    // Ten top-level launches must produce ten distinct ended journals; a
    // reused workspace pointer would collapse them into one.
    const sessions = new Set<string>();
    for (let index = 0; index < 10; index += 1) {
      const envLog = join(setup.admin.root, `wrapped-env-${index}.json`);
      const wrapped = await runCliIn(
        setup.admin,
        ["run", "codex", "--", "-p", "hi"],
        {
          cwd: setup.workspace,
          env: {
            ...setup.fakeEnv,
            FAKE_CODEX_ENV_LOG: envLog,
            FAKE_CODEX_EXIT_CODE: "0",
          },
        },
      );
      expect(wrapped.code, wrapped.err).toBe(0);

      const childEnv = JSON.parse(await readFile(envLog, "utf8")) as {
        MEMSYS_SESSION?: string;
        MEMSYS_TOOL?: string;
      };
      expect(childEnv.MEMSYS_TOOL).toBe("codex");
      expect(childEnv.MEMSYS_SESSION).toBeTruthy();

      const session = childEnv.MEMSYS_SESSION as string;
      expect(sessions.has(session)).toBe(false);
      sessions.add(session);

      const path = await findJournalBySession(setup.project.projectDir, session);
      expect(path).toBeDefined();
      const record = await readJournal(path as string);
      expect(record.ended).toBeTruthy();
      expect(record.tool).toBe("codex");
    }

    expect(sessions.size).toBe(10);
    const documents = await Promise.all(
      (await listJournals(setup.project.projectDir)).map((path) =>
        readJournalDocument(path),
      ),
    );
    const wrapperRecords = documents
      .map((document) => document.record)
      .filter((record) => record.tool === "codex");
    expect(wrapperRecords).toHaveLength(10);
    expect(new Set(wrapperRecords.map((record) => record.session)).size).toBe(10);
  }, 120_000);

  it("scenario 9c: non-wrapper Codex sync + note records at least 8 of 10 sessions", async () => {
    const setup = await makeCodexSetup();

    // Non-wrapper mode: the AI runs `memsync sync --tool codex`, writes a note
    // without --session, and ends the session. No Codex hook participates.
    for (let index = 0; index < 10; index += 1) {
      const sync = await runCliIn(setup.admin, ["sync", "--tool", "codex"], {
        cwd: setup.workspace,
      });
      expect(sync.code, sync.err).toBe(0);

      const note = await runCliIn(
        setup.admin,
        ["note", "progress", `非包装器笔记 ${index}`],
        { cwd: setup.workspace },
      );
      expect(note.code, note.err).toBe(0);

      const end = await runCliIn(setup.admin, ["session", "end"], {
        cwd: setup.workspace,
      });
      expect(end.code, end.err).toBe(0);
    }

    const documents = await Promise.all(
      (await listJournals(setup.project.projectDir)).map((path) =>
        readJournalDocument(path),
      ),
    );
    const noted = documents.filter(
      (document) =>
        document.record.tool === "codex" &&
        document.record.ended !== undefined &&
        document.body.includes("非包装器笔记"),
    );
    expect(noted.length).toBeGreaterThanOrEqual(8);
    expect(new Set(noted.map((document) => document.record.session)).size).toBe(
      noted.length,
    );
  }, 120_000);

  it("scenario 15: untrusted hooks never run and a changed hash needs re-trust", async () => {
    const setup = await makeCodexSetup();

    const markerPath = join(setup.admin.root, "memsync-hook-marker.mjs");
    await writeFile(
      markerPath,
      'process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "E2E_HOOK_RAN" } }));\n',
      "utf8",
    );

    const hash1 = "sha256:e2e-hook-1";
    const hash2 = "sha256:e2e-hook-2";

    const install = (hash: string, confirmed: boolean) =>
      runCliIn(
        setup.admin,
        ["install", "--tool", "codex", ...(confirmed ? ["--yes"] : [])],
        {
          cwd: setup.workspace,
          env: {
            ...setup.fakeEnv,
            MEMSYNC_CLI_PATH: markerPath,
            FAKE_CODEX_HOOK_HASH: hash,
          },
        },
      );

    const fakeExec = async (hash: string): Promise<string> => {
      const result = await execFake(["exec", "probe"], {
        ...setup.admin.env,
        ...setup.fakeEnv,
        MEMSYNC_CLI_PATH: markerPath,
        FAKE_CODEX_HOOK_HASH: hash,
        FAKE_CODEX_ENFORCE_TRUST: "1",
      }, setup.workspace);
      return result.stdout;
    };

    // 1. Registered but unconfirmed: the hook must not execute.
    const unconfirmed = await install(hash1, false);
    expect(unconfirmed.code, unconfirmed.err).toBe(0);
    expect(unconfirmed.out).toMatch(/fallback/i);
    expect(await fakeExec(hash1)).not.toContain("E2E_HOOK_RAN");

    // 2. Confirmation trusts the current hash.
    const trusted = await install(hash1, true);
    expect(trusted.code, trusted.err).toBe(0);
    expect(trusted.out).toContain("path A");
    expect(await fakeExec(hash1)).toContain("E2E_HOOK_RAN");
    expect(await trustedHashes(setup.logPath)).toContain(hash1);

    // 3. An upgrade changes the hash; the old trust is not reused.
    const changed = await install(hash2, false);
    expect(changed.code, changed.err).toBe(0);
    expect(changed.out).toMatch(/fallback/i);
    expect(await fakeExec(hash2)).not.toContain("E2E_HOOK_RAN");
    expect(await trustedHashes(setup.logPath)).not.toContain(hash2);

    // 4. Re-confirmation trusts the new hash.
    const retrusted = await install(hash2, true);
    expect(retrusted.code, retrusted.err).toBe(0);
    expect(retrusted.out).toContain("path A");
    expect(await fakeExec(hash2)).toContain("E2E_HOOK_RAN");
    expect(await trustedHashes(setup.logPath)).toContain(hash2);
  }, 180_000);
});
