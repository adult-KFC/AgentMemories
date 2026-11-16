import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "../../src/core/journal.js";
import { resolveSession, writeSessionPointer } from "../../src/core/session.js";

const HOST = "test-host";
const TOOL = "claude-code" as const;
const SESSION = "7f3c9a1e-1111-4222-8333-abcdefabcdef";

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memsync-session-ws-"));
}

async function makeProjectDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memsync-session-project-"));
}

describe("resolveSession", () => {
  it("prefers explicit session, then env", async () => {
    const workspace = await makeWorkspace();

    const explicit = await resolveSession({
      explicit: "s1",
      env: { MEMSYS_SESSION: "s2" },
      workspace,
      tool: TOOL,
      host: HOST,
    });
    expect(explicit).toEqual({ id: "s1", source: "explicit", ambiguous: false });

    const env = await resolveSession({
      env: { MEMSYS_SESSION: "s2" },
      workspace,
      tool: TOOL,
      host: HOST,
    });
    expect(env).toEqual({ id: "s2", source: "env", ambiguous: false });
  });

  it("uses a matching workspace pointer before an implicit session", async () => {
    const workspace = await makeWorkspace();
    await writeSessionPointer(workspace, TOOL, SESSION, {
      host: HOST,
      baseCommit: "abc1234",
      startedAt: "2026-11-13T14:32:05+08:00",
    });

    const resolved = await resolveSession({
      env: {},
      workspace,
      tool: TOOL,
      host: HOST,
    });
    expect(resolved).toEqual({ id: SESSION, source: "pointer", ambiguous: false });
  });

  it("ignores a pointer whose tool or host does not match", async () => {
    const workspace = await makeWorkspace();
    await writeSessionPointer(workspace, TOOL, SESSION, { host: HOST });

    const wrongHost = await resolveSession({
      env: {},
      workspace,
      tool: TOOL,
      host: "other-host",
    });
    expect(wrongHost.source).toBe("implicit");
    expect(wrongHost.id).not.toBe(SESSION);

    const wrongTool = await resolveSession({
      env: {},
      workspace,
      tool: "codex",
      host: HOST,
    });
    expect(wrongTool.source).toBe("implicit");
    expect(wrongTool.id).not.toBe(SESSION);
  });

  it("creates a fresh implicit id when nothing else resolves", async () => {
    const workspace = await makeWorkspace();
    const resolved = await resolveSession({
      env: {},
      workspace,
      tool: TOOL,
      host: HOST,
    });

    expect(resolved.source).toBe("implicit");
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.id.length).toBeGreaterThan(0);
  });

  it("flags ambiguity with more than one open journal for the workspace and tool", async () => {
    const projectDir = await makeProjectDir();
    const workspace = await makeWorkspace();

    for (const session of ["alpha-session", "bravo-session"]) {
      await createJournal({
        projectDir,
        project: "checkout-service",
        user: "alice",
        email: "alice@corp.com",
        host: HOST,
        tool: TOOL,
        session,
        workspace,
        baseCommit: "abc1234",
      });
    }

    const resolved = await resolveSession({
      env: {},
      workspace,
      tool: TOOL,
      host: HOST,
      projectDir,
    });
    expect(resolved.ambiguous).toBe(true);

    // An explicit session is never ambiguous, even with several open journals.
    const explicit = await resolveSession({
      explicit: "bravo-session",
      env: {},
      workspace,
      tool: TOOL,
      host: HOST,
      projectDir,
    });
    expect(explicit).toEqual({
      id: "bravo-session",
      source: "explicit",
      ambiguous: false,
    });
  });

  it("is not ambiguous when only one open journal exists", async () => {
    const projectDir = await makeProjectDir();
    const workspace = await makeWorkspace();
    await createJournal({
      projectDir,
      project: "checkout-service",
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: TOOL,
      session: SESSION,
      workspace,
      baseCommit: "abc1234",
    });

    const resolved = await resolveSession({
      env: {},
      workspace,
      tool: TOOL,
      host: HOST,
      projectDir,
    });
    expect(resolved.ambiguous).toBe(false);
  });
});

describe("writeSessionPointer", () => {
  it("writes the pointer fields atomically under .memsync/sessions", async () => {
    const workspace = await makeWorkspace();
    await writeSessionPointer(workspace, TOOL, SESSION, {
      host: HOST,
      baseCommit: "abc1234",
      startedAt: "2026-11-13T14:32:05+08:00",
    });

    const path = join(workspace, ".memsync", "sessions", `current-${TOOL}.json`);
    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({
      session: SESSION,
      tool: TOOL,
      host: HOST,
      startedAt: "2026-11-13T14:32:05+08:00",
      baseCommit: "abc1234",
    });
    expect(typeof JSON.parse(raw).cwdHash).toBe("string");
    expect(JSON.parse(raw).cwdHash.length).toBeGreaterThan(0);
  });
});
