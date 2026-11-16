import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../../src/cli.js";
import { runGit } from "../../src/core/git.js";
import {
  appendNote,
  createJournal,
  findJournalBySession,
  formatTimestamp,
  listJournals,
  readJournal,
} from "../../src/core/journal.js";
import {
  beginSession,
  completeStaleSessions,
  endSession,
  writeSessionPointer,
  writeSessionSummary,
} from "../../src/core/session.js";
import { parseFrontMatter, serializeFrontMatter } from "../../src/core/schema.js";
import { makeBareRemote } from "../helpers.js";

const SESSION = "7f3c9a1e-1111-4222-8333-abcdefabcdef";
const HOST = "WIN-TEST";
const TOOL = "claude-code" as const;
const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";

const META = [
  "slug: checkout-service",
  "repos:",
  "  - git@git.corp.com:shop/checkout-service.git",
  "owners:",
  "  - alice@corp.com",
  "current_version: 0.4.0",
  "maintenance:",
  "  interval_hours: 72",
  "  cooldown_hours: 6",
  "  mainline_only: true",
  "",
].join("\n");

interface Setup {
  home: string;
  projectDir: string;
  workspace: string;
}

async function makeSetup(): Promise<Setup> {
  const home = await mkdtemp(join(tmpdir(), "memsync-life-home-"));
  const projectDir = join(home, "repo", "projects", "checkout-service");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "meta.yaml"), META, "utf8");

  const workspace = await mkdtemp(join(tmpdir(), "memsync-life-ws-"));
  await writeFile(join(workspace, ".memsync.json"), '{"project":"checkout-service"}\n', "utf8");

  return { home, projectDir, workspace };
}

async function initRepo(repoPath: string): Promise<void> {
  await runGit(["init"], { cwd: repoPath });
  await runGit(["config", "user.name", "Test User"], { cwd: repoPath });
  await runGit(["config", "user.email", "test@example.com"], { cwd: repoPath });
  await runGit(["config", "core.autocrlf", "false"], { cwd: repoPath });
}

async function commitFile(
  repoPath: string,
  filename: string,
  content: string,
): Promise<string> {
  const fullPath = join(repoPath, filename);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  await runGit(["add", "--", filename], { cwd: repoPath });
  await runGit(["commit", "-m", `chore: add ${filename}`], { cwd: repoPath });
  const result = await runGit(["rev-parse", "--short", "HEAD"], { cwd: repoPath });
  return result.stdout.trim();
}

async function begin(
  setup: Setup,
  overrides: Partial<Parameters<typeof beginSession>[0]> = {},
) {
  return beginSession({
    projectDir: setup.projectDir,
    project: "checkout-service",
    user: "alice",
    email: "alice@corp.com",
    host: HOST,
    tool: TOOL,
    session: SESSION,
    workspace: setup.workspace,
    ...overrides,
  });
}

describe("beginSession", () => {
  it("reads HEAD and meta.current_version, creates the journal, and writes the pointer", async () => {
    const setup = await makeSetup();
    await initRepo(setup.workspace);
    const head = await commitFile(setup.workspace, "README.md", "hello\n");

    const record = await begin(setup);

    expect(record).toMatchObject({
      session: SESSION,
      project: "checkout-service",
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: TOOL,
      workspace: setup.workspace,
      base_commit: head,
      version_hint: "0.4.0",
      outcome: "unknown",
      summary_source: "derived",
    });
    expect(await findJournalBySession(setup.projectDir, SESSION)).toBeDefined();

    const pointer = JSON.parse(
      await readFile(
        join(setup.workspace, ".memsync", "sessions", `current-${TOOL}.json`),
        "utf8",
      ),
    );
    expect(pointer).toMatchObject({
      session: SESSION,
      tool: TOOL,
      host: HOST,
      baseCommit: head,
    });
  });

  it("honours an explicit base commit and version hint", async () => {
    const setup = await makeSetup();
    const record = await begin(setup, { baseCommit: "deadbee", versionHint: "9.9.9" });
    expect(record.base_commit).toBe("deadbee");
    expect(record.version_hint).toBe("9.9.9");
  });
});

describe("endSession", () => {
  async function endWithNote(kind: "blocker" | "todo" | "progress") {
    const setup = await makeSetup();
    await begin(setup);
    await appendNote({
      projectDir: setup.projectDir,
      sessionId: SESSION,
      kind,
      text: `${kind} item`,
    });
    return endSession({ projectDir: setup.projectDir, sessionId: SESSION });
  }

  it("derives blocked, partial, and completed outcomes from notes", async () => {
    expect(await endWithNote("blocker")).toMatchObject({
      outcome: "blocked",
      summarySource: "derived",
    });
    expect(await endWithNote("todo")).toMatchObject({
      outcome: "partial",
      summarySource: "derived",
    });
    expect(await endWithNote("progress")).toMatchObject({
      outcome: "completed",
      summarySource: "derived",
    });
  });

  it("keeps the AI summary and outcome when provided", async () => {
    const setup = await makeSetup();
    await begin(setup);
    await appendNote({
      projectDir: setup.projectDir,
      sessionId: SESSION,
      kind: "blocker",
      text: "derived outcome would be blocked",
    });
    await writeSessionSummary(setup.projectDir, SESSION, {
      outcome: "completed",
      summary: "did work",
    });

    const result = await endSession({
      projectDir: setup.projectDir,
      sessionId: SESSION,
    });

    expect(result).toMatchObject({ outcome: "completed", summarySource: "ai" });
    const path = await findJournalBySession(setup.projectDir, SESSION);
    const text = await readFile(path!, "utf8");
    expect(text).toContain("did work");
  });

  it("records commits and diff stats from base..HEAD", async () => {
    const setup = await makeSetup();
    await initRepo(setup.workspace);
    const base = await commitFile(setup.workspace, "README.md", "hello\n");
    await begin(setup, { baseCommit: base });
    await commitFile(setup.workspace, "src/cart.ts", "line1\nline2\n");

    const result = await endSession({
      projectDir: setup.projectDir,
      sessionId: SESSION,
    });

    expect(result.commits).toHaveLength(1);
    expect(result.stats).toEqual({ filesChanged: 1, insertions: 2, deletions: 0 });

    const record = await readJournal(
      (await findJournalBySession(setup.projectDir, SESSION))!,
    );
    expect(record.commits).toHaveLength(1);
    expect(record.files_changed).toBe(1);
    expect(record.insertions).toBe(2);
    expect(record.deletions).toBe(0);
    expect(record.ended).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("does not double-count uncommitted changes when a base exists", async () => {
    const setup = await makeSetup();
    await initRepo(setup.workspace);
    const base = await commitFile(setup.workspace, "README.md", "hello\n");
    await begin(setup, { baseCommit: base });
    await commitFile(setup.workspace, "src/cart.ts", "line1\nline2\n");
    // One uncommitted insertion; it must appear once, not once per diff call.
    await writeFile(join(setup.workspace, "README.md"), "hello\nworld\n", "utf8");

    const result = await endSession({
      projectDir: setup.projectDir,
      sessionId: SESSION,
    });

    expect(result.commits).toHaveLength(1);
    expect(result.stats).toEqual({ filesChanged: 2, insertions: 3, deletions: 0 });
  });

  it("counts working-tree changes when base data is unavailable", async () => {
    const setup = await makeSetup();
    await initRepo(setup.workspace);
    await commitFile(setup.workspace, "README.md", "hello\n");
    await begin(setup, { baseCommit: "unknown" });
    await writeFile(join(setup.workspace, "README.md"), "hello\nworld\n", "utf8");

    const result = await endSession({
      projectDir: setup.projectDir,
      sessionId: SESSION,
    });

    expect(result.commits).toEqual([]);
    expect(result.stats).toEqual({ filesChanged: 1, insertions: 1, deletions: 0 });
  });

  it("commits only the journal with the end message and trailer", async () => {
    const setup = await makeSetup();
    await initRepo(join(setup.home, "repo"));
    await initRepo(setup.workspace);
    const base = await commitFile(setup.workspace, "README.md", "hello\n");
    await begin(setup, { baseCommit: base });
    await commitFile(setup.workspace, "src/cart.ts", "line1\n");

    await endSession({ projectDir: setup.projectDir, sessionId: SESSION });

    const repoPath = join(setup.home, "repo");
    const log = await runGit(["log", "-1", "--pretty=%B"], { cwd: repoPath });
    expect(log.stdout).toContain(`journal: ${SESSION} end`);
    expect(log.stdout).toContain(TRAILER);

    const files = await runGit(["show", "--name-only", "--pretty="], { cwd: repoPath });
    const changed = files.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(changed).toHaveLength(1);
    expect(changed[0].replace(/\\/g, "/")).toContain(
      "projects/checkout-service/journal/",
    );
  });

  it("retries a failed end commit on a repeated end without duplicating commits", async () => {
    const setup = await makeSetup();
    const repoPath = join(setup.home, "repo");
    await initRepo(repoPath);
    await initRepo(setup.workspace);
    const base = await commitFile(setup.workspace, "README.md", "hello\n");
    await begin(setup, { baseCommit: base });
    await commitFile(setup.workspace, "src/cart.ts", "line1\n");

    const lock = join(repoPath, ".git", "index.lock");
    await writeFile(lock, "locked", "utf8");
    try {
      await expect(
        endSession({ projectDir: setup.projectDir, sessionId: SESSION }),
      ).rejects.toThrow(/index\.lock|unable|fatal/i);
    } finally {
      await rm(lock, { force: true });
    }

    // The first attempt wrote `ended` but could not commit the journal.
    const before = await runGit(["log", "--oneline"], { cwd: repoPath });
    expect(before.code).not.toBe(0);

    const retry = await endSession({ projectDir: setup.projectDir, sessionId: SESSION });
    expect(retry.outcome).toBe("completed");

    const after = await runGit(["log", "--oneline"], { cwd: repoPath });
    expect(after.code).toBe(0);
    expect(
      after.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0),
    ).toHaveLength(1);

    // A further end is a no-op commit-wise.
    await endSession({ projectDir: setup.projectDir, sessionId: SESSION });
    const final = await runGit(["log", "--oneline"], { cwd: repoPath });
    expect(
      final.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0),
    ).toHaveLength(1);
  });

  it("preserves unknown front-matter fields while writing summary and end", async () => {
    const setup = await makeSetup();
    await begin(setup);
    const path = (await findJournalBySession(setup.projectDir, SESSION))!;
    const current = parseFrontMatter<Record<string, unknown>>(await readFile(path, "utf8"));
    await writeFile(
      path,
      serializeFrontMatter(
        { ...current.data, pending_push: true, note_count: 3 },
        current.body,
      ),
      "utf8",
    );

    await writeSessionSummary(setup.projectDir, SESSION, {
      outcome: "partial",
      summary: "shipped part",
    });
    await endSession({ projectDir: setup.projectDir, sessionId: SESSION });

    const after = parseFrontMatter<Record<string, unknown>>(await readFile(path, "utf8"));
    expect(after.data).toMatchObject({
      outcome: "partial",
      summary_source: "ai",
      pending_push: true,
      note_count: 3,
    });
    expect(after.body).toContain("shipped part");
  });

  it("refuses a secret-shaped or oversized AI summary without writing anything", async () => {
    const setup = await makeSetup();
    await begin(setup);
    const path = (await findJournalBySession(setup.projectDir, SESSION))!;
    const before = await readFile(path, "utf8");

    await expect(
      writeSessionSummary(setup.projectDir, SESSION, {
        outcome: "completed",
        summary: "token sk-abc123DEF456ghi789 leaked",
      }),
    ).rejects.toThrow(/secret/i);
    await expect(
      writeSessionSummary(setup.projectDir, SESSION, {
        outcome: "completed",
        summary: "x".repeat(8_193),
      }),
    ).rejects.toThrow(/8192/);

    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("requires an outcome even when summary text is provided", async () => {
    const setup = await makeSetup();
    await begin(setup);

    await expect(
      writeSessionSummary(setup.projectDir, SESSION, { summary: "text only" }),
    ).rejects.toThrow(/outcome/i);
    await expect(
      writeSessionSummary(setup.projectDir, SESSION, { summary: "" }),
    ).rejects.toThrow(/outcome/i);
    await expect(
      writeSessionSummary(setup.projectDir, SESSION, { outcome: "blocked" }),
    ).resolves.toBeUndefined();
  });

  it("writes pending-push and still succeeds when the push fails", async () => {
    const remote = await makeBareRemote();
    const home = await mkdtemp(join(tmpdir(), "memsync-life-home-"));
    const repoPath = join(home, "repo");
    await runGit(["clone", "-c", "core.autocrlf=false", remote.remote, repoPath], {
      cwd: home,
    });
    await initRepo(repoPath);

    const projectDir = join(repoPath, "projects", "checkout-service");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
    const workspace = await mkdtemp(join(tmpdir(), "memsync-life-ws-"));
    await writeFile(join(workspace, ".memsync.json"), '{"project":"checkout-service"}\n', "utf8");
    await initRepo(workspace);
    const base = await commitFile(workspace, "README.md", "hello\n");

    await begin(
      { home, projectDir, workspace },
      { baseCommit: base },
    );
    // Break the remote so `git push` fails while HEAD is still ahead.
    await runGit(["remote", "set-url", "origin", join(remote.dir, "missing.git")], {
      cwd: repoPath,
    });
    await commitFile(workspace, "src/cart.ts", "line1\n");

    const result = await endSession({
      projectDir,
      sessionId: SESSION,
      env: { MEMSYNC_HOME: home },
    });
    expect(result.pendingPush).toBe(true);

    const pending = JSON.parse(
      await readFile(join(home, "state", "pending-push.json"), "utf8"),
    );
    expect(pending).toMatchObject({ repoPath, session: SESSION });
    expect(typeof pending.at).toBe("string");
  });
});

describe("completeStaleSessions", () => {
  it("completes old open sessions with an unknown outcome and leaves others alone", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "memsync-stale-"));
    const workspace = await mkdtemp(join(tmpdir(), "memsync-stale-ws-"));
    const now = new Date();
    const old = new Date(now.getTime() - 13 * 60 * 60 * 1000);

    const stale = await createJournal({
      projectDir,
      project: "checkout-service",
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: TOOL,
      session: "stale-session",
      workspace,
      baseCommit: "abc1234",
      now: old,
    });
    const fresh = await createJournal({
      projectDir,
      project: "checkout-service",
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: TOOL,
      session: "fresh-session",
      workspace,
      baseCommit: "abc1234",
      now,
    });

    expect(await completeStaleSessions(projectDir, now)).toBe(1);

    const staleRecord = await readJournal(stale.path);
    expect(staleRecord.ended).toBeDefined();
    expect(staleRecord.outcome).toBe("unknown");
    expect(staleRecord.summary_source).toBe("derived");
    expect((await readJournal(fresh.path)).ended).toBeUndefined();
  });

  it("does not re-complete an already ended session", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "memsync-stale-"));
    const workspace = await mkdtemp(join(tmpdir(), "memsync-stale-ws-"));
    const old = new Date(Date.now() - 13 * 60 * 60 * 1000);
    const { path } = await createJournal({
      projectDir,
      project: "checkout-service",
      user: "alice",
      email: "alice@corp.com",
      host: HOST,
      tool: TOOL,
      session: "closed-session",
      workspace,
      baseCommit: "abc1234",
      now: old,
    });
    const current = parseFrontMatter<Record<string, unknown>>(await readFile(path, "utf8"));
    await writeFile(
      path,
      serializeFrontMatter(
        { ...current.data, ended: formatTimestamp(old), outcome: "completed" },
        current.body,
      ),
      "utf8",
    );

    expect(await completeStaleSessions(projectDir, new Date())).toBe(0);
    expect((await readJournal(path)).outcome).toBe("completed");
  });
});

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

async function cliSetup(): Promise<Setup & { env: NodeJS.ProcessEnv }> {
  const setup = await makeSetup();
  const repoPath = join(setup.home, "repo");
  await writeFile(
    join(setup.home, "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        repoPath,
        remoteUrl: "git@git.corp.com:shop/memory.git",
        identity: { name: "Alice", email: "alice@corp.com" },
        defaultBudgetChars: 12_000,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { ...setup, env: { MEMSYNC_HOME: setup.home } };
}

function startedSession(output: string): string {
  const match = /Session (\S+) started/.exec(output);
  if (!match) throw new Error(`session id not found in output: ${output}`);
  return match[1];
}

describe("memsync session", () => {
  it("begins a session, records a summary, and ends it", async () => {
    const setup = await cliSetup();

    const begin = capture(setup.workspace, setup.env);
    expect(await runCli(["session", "begin", "--tool", "claude-code"], begin.io)).toBe(0);
    const session = startedSession(begin.out.join(""));

    const summary = capture(setup.workspace, setup.env);
    expect(
      await runCli(
        [
          "session",
          "summary",
          "--outcome",
          "completed",
          "--summary",
          "did work",
          "--session",
          session,
        ],
        summary.io,
      ),
    ).toBe(0);

    const end = capture(setup.workspace, setup.env);
    expect(
      await runCli(["session", "end", "--session", session], end.io),
    ).toBe(0);
    expect(end.out.join("")).toMatch(/ended/i);
    expect(end.out.join("")).toMatch(/completed/);

    const path = (await findJournalBySession(setup.projectDir, session))!;
    const record = await readJournal(path);
    expect(record.ended).toBeDefined();
    expect(record.outcome).toBe("completed");
    expect(record.summary_source).toBe("ai");
    expect(await readFile(path, "utf8")).toContain("did work");
  });

  it("resolves an open session from the workspace pointer when --session is omitted", async () => {
    const setup = await cliSetup();
    const begin = capture(setup.workspace, setup.env);
    expect(await runCli(["session", "begin", "--tool", "claude-code"], begin.io)).toBe(0);
    const session = startedSession(begin.out.join(""));

    const end = capture(setup.workspace, setup.env);
    expect(await runCli(["session", "end"], end.io)).toBe(0);

    expect((await readJournal((await findJournalBySession(setup.projectDir, session))!)).ended)
      .toBeDefined();
  });

  it("exits 1 with a clear message for a missing session", async () => {
    const setup = await cliSetup();
    const result = capture(setup.workspace, setup.env);

    expect(
      await runCli(["session", "end", "--session", "missing"], result.io),
    ).toBe(1);
    expect(result.err.join("")).toMatch(/no journal found for session missing/i);
    expect(result.err.join("")).not.toMatch(/\n\s+at\s/);
  });

  it("exits 1 and asks for --session when several sessions are open", async () => {
    const setup = await cliSetup();
    for (const session of ["one", "two"]) {
      await createJournal({
        projectDir: setup.projectDir,
        project: "checkout-service",
        user: "alice",
        email: "alice@corp.com",
        host: HOST,
        tool: TOOL,
        session,
        workspace: setup.workspace,
        baseCommit: "abc1234",
      });
    }

    const result = capture(setup.workspace, setup.env);
    expect(await runCli(["session", "end"], result.io)).toBe(1);
    expect(result.err.join("")).toMatch(/multiple active sessions/i);
    expect(result.err.join("")).toMatch(/--session/);
  });

  it("rejects an invalid tool and an invalid outcome", async () => {
    const setup = await cliSetup();

    const badTool = capture(setup.workspace, setup.env);
    expect(
      await runCli(["session", "begin", "--tool", "vim"], badTool.io),
    ).toBe(1);
    expect(badTool.err.join("")).toMatch(/tool/i);

    const badOutcome = capture(setup.workspace, setup.env);
    expect(
      await runCli(
        ["session", "summary", "--outcome", "done", "--summary", "x", "--session", SESSION],
        badOutcome.io,
      ),
    ).toBe(1);
    expect(badOutcome.err.join("")).toMatch(/outcome/i);
  });

  it("rejects session summary without --outcome", async () => {
    const setup = await cliSetup();
    const result = capture(setup.workspace, setup.env);

    expect(
      await runCli(
        ["session", "summary", "--summary", "text only", "--session", SESSION],
        result.io,
      ),
    ).toBe(1);
    expect(result.err.join("")).toMatch(/--outcome/);
    expect(result.err.join("")).not.toMatch(/\n\s+at\s/);
  });

  it("probes the MEMSYS_TOOL pointer first when both tools have one", async () => {
    const setup = await cliSetup();
    const claudeSession = "claude-session";
    const codexSession = "codex-session";

    for (const [tool, session] of [
      ["claude-code", claudeSession],
      ["codex", codexSession],
    ] as const) {
      await createJournal({
        projectDir: setup.projectDir,
        project: "checkout-service",
        user: "alice",
        email: "alice@corp.com",
        host: HOST,
        tool,
        session,
        workspace: setup.workspace,
        baseCommit: "abc1234",
      });
      await writeSessionPointer(setup.workspace, tool, session, { host: HOST });
    }

    const env = { ...setup.env, MEMSYS_TOOL: "codex", MEMSYS_HOST: HOST };
    const result = capture(setup.workspace, env);
    expect(await runCli(["session", "end"], result.io)).toBe(0);
    expect(result.out.join("")).toContain(codexSession);

    const codex = await readJournal(
      (await findJournalBySession(setup.projectDir, codexSession))!,
    );
    const claude = await readJournal(
      (await findJournalBySession(setup.projectDir, claudeSession))!,
    );
    expect(codex.ended).toBeDefined();
    expect(claude.ended).toBeUndefined();
  });

  it("exits 0 with a stderr warning when the push fails", async () => {
    const remote = await makeBareRemote();
    const home = await mkdtemp(join(tmpdir(), "memsync-life-home-"));
    const repoPath = join(home, "repo");
    await runGit(["clone", "-c", "core.autocrlf=false", remote.remote, repoPath], {
      cwd: home,
    });
    await initRepo(repoPath);
    const projectDir = join(repoPath, "projects", "checkout-service");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
    const workspace = await mkdtemp(join(tmpdir(), "memsync-life-ws-"));
    await writeFile(join(workspace, ".memsync.json"), '{"project":"checkout-service"}\n', "utf8");
    await writeFile(
      join(home, "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          repoPath,
          remoteUrl: remote.remote,
          identity: { name: "Alice", email: "alice@corp.com" },
          defaultBudgetChars: 12_000,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const env = { MEMSYNC_HOME: home };

    const begin = capture(workspace, env);
    expect(await runCli(["session", "begin", "--tool", "claude-code"], begin.io)).toBe(0);
    const session = startedSession(begin.out.join(""));

    await runGit(["remote", "set-url", "origin", join(remote.dir, "missing.git")], {
      cwd: repoPath,
    });

    const end = capture(workspace, env);
    expect(await runCli(["session", "end", "--session", session], end.io)).toBe(0);
    expect(end.err.join("")).toMatch(/push failed/i);

    const pending = JSON.parse(
      await readFile(join(home, "state", "pending-push.json"), "utf8"),
    );
    expect(pending.session).toBe(session);
  });
});
