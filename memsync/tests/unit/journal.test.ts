import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/core/git.js";
import { parseFrontMatter, serializeFrontMatter } from "../../src/core/schema.js";
import {
  appendNote,
  createJournal,
  findJournalBySession,
  journalPath,
  listJournals,
  readJournal,
  type AppendNoteResult,
  type SessionRecord,
} from "../../src/core/journal.js";

const SESSION = "7f3c9a1e-1111-4222-8333-abcdefabcdef";
const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";

interface Fixture {
  projectDir: string;
  path: string;
  record: SessionRecord;
}

async function makeJournal(now = new Date(2026, 10, 13, 14, 32, 5)): Promise<Fixture> {
  const projectDir = await mkdtemp(join(tmpdir(), "memsync-journal-"));
  const { path, record } = await createJournal({
    projectDir,
    project: "checkout-service",
    user: "alice",
    email: "alice@corp.com",
    host: "WIN-CLAUDE",
    tool: "claude-code",
    session: SESSION,
    workspace: "E:\\work\\checkout-service",
    baseCommit: "9f2c1ab",
    versionHint: "0.4.0",
    now,
  });
  return { projectDir, path, record };
}

async function makeGitFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "memsync-journal-git-"));
  await runGit(["init"], { cwd: root });
  await runGit(["config", "user.name", "Test User"], { cwd: root });
  await runGit(["config", "user.email", "test@example.com"], { cwd: root });

  const projectDir = join(root, "projects", "checkout-service");
  const { path, record } = await createJournal({
    projectDir,
    project: "checkout-service",
    user: "alice",
    email: "alice@corp.com",
    host: "WIN-CLAUDE",
    tool: "claude-code",
    session: SESSION,
    workspace: "E:\\work\\checkout-service",
    baseCommit: "9f2c1ab",
    versionHint: "0.4.0",
    now: new Date(2026, 10, 13, 14, 32, 5),
  });
  return { projectDir, path, record };
}

describe("journalPath", () => {
  it("names journal files with time, user, host, tool, session", () => {
    const record: SessionRecord = {
      id: "ab12cd",
      project: "checkout-service",
      user: "alice",
      email: "alice@corp.com",
      host: "win-claude",
      tool: "claude-code",
      session: SESSION,
      started: "2026-11-13T14:32:05+08:00",
      workspace: "E:/work/checkout-service",
      base_commit: "9f2c1ab",
      version_hint: "0.4.0",
      commits: [],
      files_changed: 0,
      insertions: 0,
      deletions: 0,
      outcome: "unknown",
      summary_source: "derived",
    };

    expect(journalPath("/p", record)).toMatch(
      /journal\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}\/\d{6}_alice_win-claude_claude-code_ab12cd\.md$/,
    );
  });

  it("uses the email local part for the user segment (spec §8.8)", () => {
    const record = {
      id: "ab12cd",
      started: "2026-11-13T14:32:05+08:00",
      user: "Alice Kim",
      email: "Alice.Kim+dev@corp.com",
      host: "win-claude",
      tool: "claude-code",
    } as SessionRecord;

    // Lowercased and reduced to [a-z0-9-]; the display name is not used.
    expect(journalPath("/p", record)).toContain("_alice-kim-dev_");
  });

  it("uses the wall-clock time from started", () => {
    const record = {
      id: "ab12cd",
      started: "2026-11-13T14:32:05+08:00",
      user: "alice",
      host: "win-claude",
      tool: "claude-code",
    } as SessionRecord;

    expect(journalPath("/p", record)).toContain("/journal/2026-11/2026-11-13/143205_");
  });
});

describe("createJournal", () => {
  it("writes the spec front matter and empty body sections", async () => {
    const { path, record } = await makeJournal();

    expect(record).toMatchObject({
      id: SESSION.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6),
      project: "checkout-service",
      user: "alice",
      email: "alice@corp.com",
      host: "WIN-CLAUDE",
      tool: "claude-code",
      session: SESSION,
      workspace: "E:\\work\\checkout-service",
      base_commit: "9f2c1ab",
      version_hint: "0.4.0",
      commits: [],
      files_changed: 0,
      insertions: 0,
      deletions: 0,
      outcome: "unknown",
      summary_source: "derived",
    });
    expect(record.started).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

    const text = await readFile(path, "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("## 工作摘要");
    expect(text).toContain("## AI 记录");
    expect(text).toContain("## 未完成 / 交接");
    expect(text).not.toContain("\r\n");
    expect(await readJournal(path)).toMatchObject({ session: SESSION, outcome: "unknown" });
  });

  it("creates the month and day directories", async () => {
    const { projectDir, path } = await makeJournal();
    expect(path).toBe(
      journalPath(projectDir, await readJournal(path)),
    );
  });

  it("records the workspace branch when it can be resolved", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "memsync-branch-ws-"));
    await runGit(["init"], { cwd: workspace });
    await runGit(["checkout", "-b", "feature/cart"], { cwd: workspace });
    const projectDir = await mkdtemp(join(tmpdir(), "memsync-branch-"));

    const { record } = await createJournal({
      projectDir,
      project: "checkout-service",
      user: "alice",
      email: "alice@corp.com",
      host: "win-claude",
      tool: "claude-code",
      session: SESSION,
      workspace,
      baseCommit: "9f2c1ab",
      versionHint: "0.4.0",
      now: new Date(2026, 10, 13, 14, 32, 5),
    });

    expect(record.branch).toBe("feature/cart");
  });

  it("is idempotent for an existing session file", async () => {
    const { path, record } = await makeJournal();
    const before = await readFile(path, "utf8");
    const second = await createJournal({
      projectDir: join(path, "..", "..", "..", ".."),
      project: record.project,
      user: record.user,
      email: record.email,
      host: record.host,
      tool: record.tool,
      session: record.session,
      workspace: record.workspace,
      baseCommit: record.base_commit,
      versionHint: record.version_hint,
      now: new Date(2026, 10, 13, 14, 32, 5),
    });
    expect(second.path).toBe(path);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("finds the existing journal when a retry uses a later timestamp", async () => {
    const { projectDir, path, record } = await makeJournal(new Date(2026, 10, 13, 14, 32, 5));

    const retry = await createJournal({
      projectDir,
      project: record.project,
      user: record.user,
      email: record.email,
      host: record.host,
      tool: record.tool,
      session: record.session,
      workspace: record.workspace,
      baseCommit: record.base_commit,
      versionHint: record.version_hint,
      now: new Date(2026, 10, 13, 14, 32, 6),
    });

    expect(retry.path).toBe(path);
    expect(await listJournals(projectDir)).toEqual([path]);
  });
});

describe("listJournals / findJournalBySession", () => {
  it("lists journal files recursively and finds them by session", async () => {
    const { projectDir, path } = await makeJournal();

    expect(await listJournals(projectDir)).toEqual([path]);
    expect(await findJournalBySession(projectDir, SESSION)).toBe(path);
    expect(await findJournalBySession(projectDir, "missing-session")).toBeUndefined();
  });

  it("returns an empty list when no journal exists", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "memsync-empty-"));
    expect(await listJournals(projectDir)).toEqual([]);
  });
});

describe("appendNote", () => {
  it("appends progress notes under AI 记录", async () => {
    const { projectDir, path } = await makeJournal();
    const result = await appendNote({
      projectDir,
      sessionId: SESSION,
      kind: "progress",
      text: "merged the cart",
      now: new Date(2026, 10, 13, 15, 2, 4),
    });

    expect(result).toEqual({ added: true, noteCount: 1, checkpoint: false });
    const text = await readFile(path, "utf8");
    expect(text).toContain("- 15:02 [progress] merged the cart");
    // The note lands under AI 记录, before the handoff section.
    expect(text.indexOf("- 15:02 [progress]")).toBeLessThan(text.indexOf("## 未完成 / 交接"));
  });

  it("appends todo and handoff notes under 未完成 / 交接", async () => {
    const { projectDir, path } = await makeJournal();
    await appendNote({ projectDir, sessionId: SESSION, kind: "todo", text: "load test" });
    await appendNote({ projectDir, sessionId: SESSION, kind: "handoff", text: "align with bob" });

    const text = await readFile(path, "utf8");
    const handoffSection = text.slice(text.indexOf("## 未完成 / 交接"));
    expect(handoffSection).toContain("- [ ] load test");
    expect(handoffSection).toContain("- [ ] align with bob");
    expect(text).not.toContain("[todo] load test");
  });

  it("deduplicates identical notes in one session", async () => {
    const { projectDir, path } = await makeJournal();
    const base = { projectDir, sessionId: SESSION, kind: "progress" as const };

    expect((await appendNote({ ...base, text: "same" })).added).toBe(true);
    const before = await readFile(path, "utf8");
    expect(await appendNote({ ...base, text: "same" })).toMatchObject({
      added: false,
      reason: "duplicate",
      noteCount: 1,
      checkpoint: false,
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("does not deduplicate across note kinds", async () => {
    const { projectDir } = await makeJournal();
    await appendNote({ projectDir, sessionId: SESSION, kind: "progress", text: "same" });
    expect(
      await appendNote({ projectDir, sessionId: SESSION, kind: "decision", text: "same" }),
    ).toMatchObject({ added: true, noteCount: 2 });
  });

  it("rejects notes larger than 8192 bytes", async () => {
    const { projectDir, path } = await makeJournal();
    const result = await appendNote({
      projectDir,
      sessionId: SESSION,
      kind: "progress",
      text: "x".repeat(8193),
    });

    expect(result).toEqual({
      added: false,
      reason: "too_large",
      noteCount: 0,
      checkpoint: false,
    });
    expect(await readFile(path, "utf8")).not.toContain("xxxx");
  });

  it("measures the limit in UTF-8 bytes, not characters", async () => {
    const { projectDir } = await makeJournal();
    // 2731 * 3 bytes = 8193 bytes, but only 2731 characters.
    expect(
      await appendNote({
        projectDir,
        sessionId: SESSION,
        kind: "progress",
        text: "记".repeat(2731),
      }),
    ).toMatchObject({ added: false, reason: "too_large" });

    // 2730 * 3 bytes = 8190 bytes is accepted.
    expect(
      await appendNote({
        projectDir,
        sessionId: SESSION,
        kind: "progress",
        text: "记".repeat(2730),
      }),
    ).toMatchObject({ added: true });
  });

  it("rejects secret-shaped text without writing it", async () => {
    const { projectDir, path } = await makeJournal();
    const secret = "token sk-abc123DEF456ghi789";
    const before = await readFile(path, "utf8");

    expect(
      await appendNote({ projectDir, sessionId: SESSION, kind: "progress", text: secret }),
    ).toMatchObject({ added: false, reason: "secret", noteCount: 0 });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("sets checkpoint on every fifth note and commits the journal", async () => {
    const { projectDir, path } = await makeGitFixture();

    for (let index = 1; index <= 4; index += 1) {
      expect(
        await appendNote({
          projectDir,
          sessionId: SESSION,
          kind: "progress",
          text: `step ${index}`,
        }),
      ).toMatchObject({ added: true, noteCount: index, checkpoint: false });
    }

    expect(
      await appendNote({ projectDir, sessionId: SESSION, kind: "progress", text: "step 5" }),
    ).toMatchObject({ added: true, noteCount: 5, checkpoint: true });

    const root = join(projectDir, "..", "..");
    const log = await runGit(["log", "-1", "--pretty=%B"], { cwd: root });
    expect(log.stdout).toContain(`journal: ${SESSION} note progress`);
    expect(log.stdout).toContain(TRAILER);
    const stat = await runGit(["show", "--name-only", "--pretty="], { cwd: root });
    expect(stat.stdout.replace(/\\/g, "/")).toContain(
      "projects/checkout-service/journal/",
    );
  });

  it("serializes concurrent notes under the shared lock without losing one", async () => {
    const fixture = await makeGitFixture();
    const env = { MEMSYNC_HOME: await mkdtemp(join(tmpdir(), "memsync-note-lock-")) };

    const texts = Array.from({ length: 9 }, (_, index) => `parallel note ${index}`);
    const results = await Promise.all(
      texts.map((text) =>
        appendNote({
          projectDir: fixture.projectDir,
          sessionId: SESSION,
          kind: "progress",
          text,
          env,
        }),
      ),
    );

    expect(results.every((result) => result.added)).toBe(true);
    expect(Math.max(...results.map((result) => result.noteCount))).toBe(texts.length);

    const body = await readFile(fixture.path, "utf8");
    for (const text of texts) {
      expect(body.split(`[progress] ${text}`)).toHaveLength(2);
    }
    expect(body.match(/^- \d{2}:\d{2} \[progress\] parallel note/gm)).toHaveLength(
      texts.length,
    );
  });

  it("does not report checkpoint when the project is not a git repository", async () => {
    const { projectDir } = await makeJournal();
    let result: AppendNoteResult | undefined;
    for (let index = 1; index <= 5; index += 1) {
      result = await appendNote({
        projectDir,
        sessionId: SESSION,
        kind: "progress",
        text: `step ${index}`,
      });
    }
    expect(result).toMatchObject({ added: true, noteCount: 5, checkpoint: false });
    expect(result?.checkpointError).toBeUndefined();
    expect((await findJournalBySession(projectDir, SESSION)) !== undefined).toBe(true);
  });

  it("keeps the note when the checkpoint commit fails", async () => {
    const { projectDir } = await makeGitFixture();
    for (let index = 1; index <= 4; index += 1) {
      await appendNote({
        projectDir,
        sessionId: SESSION,
        kind: "progress",
        text: `step ${index}`,
      });
    }

    const lock = join(projectDir, "..", "..", ".git", "index.lock");
    await writeFile(lock, "locked", "utf8");
    try {
      const result = await appendNote({
        projectDir,
        sessionId: SESSION,
        kind: "progress",
        text: "step 5",
      });
      expect(result).toMatchObject({ added: true, noteCount: 5, checkpoint: false });
      expect(result.checkpointError).toMatch(/index\.lock|unable/i);
      const journalPathAfter = await findJournalBySession(projectDir, SESSION);
      expect(journalPathAfter).toBeDefined();
      expect(await readFile(journalPathAfter!, "utf8")).toContain("step 5");
    } finally {
      await rm(lock, { force: true });
    }
  });

  it("preserves §7.2 and unknown front-matter fields on append", async () => {
    const { projectDir, path } = await makeJournal();
    const current = parseFrontMatter<Record<string, unknown>>(await readFile(path, "utf8"));
    const enriched = {
      ...current.data,
      ended: "2026-11-13T16:10:44+08:00",
      commits: ["3a1f2c9", "88de001"],
      files_changed: 14,
      insertions: 320,
      deletions: 41,
      outcome: "completed",
      summary_source: "ai",
      pending_push: true,
      note_count: 2,
    };
    await writeFile(path, serializeFrontMatter(enriched, current.body), "utf8");

    await appendNote({
      projectDir,
      sessionId: SESSION,
      kind: "progress",
      text: "after stats",
    });

    const after = parseFrontMatter<Record<string, unknown>>(await readFile(path, "utf8"));
    expect(after.data).toMatchObject({
      ended: "2026-11-13T16:10:44+08:00",
      commits: ["3a1f2c9", "88de001"],
      files_changed: 14,
      insertions: 320,
      deletions: 41,
      outcome: "completed",
      summary_source: "ai",
      pending_push: true,
      note_count: 2,
    });
    expect(after.body).toContain("[progress] after stats");
  });

  it("throws a clear error for an unknown session", async () => {
    const { projectDir } = await makeJournal();
    await expect(
      appendNote({ projectDir, sessionId: "nope", kind: "progress", text: "x" }),
    ).rejects.toThrow(/no journal found for session nope/i);
  });

  it("throws for an invalid kind", async () => {
    const { projectDir } = await makeJournal();
    await expect(
      appendNote({
        projectDir,
        sessionId: SESSION,
        kind: "rant" as never,
        text: "x",
      }),
    ).rejects.toThrow(/kind/i);
  });

  it("keeps multi-line text on a single journal line", async () => {
    const { projectDir, path } = await makeJournal();
    await appendNote({
      projectDir,
      sessionId: SESSION,
      kind: "progress",
      text: "first line\nsecond line",
    });
    const text = await readFile(path, "utf8");
    expect(text).toContain("- ");
    expect(text).toContain("first line second line");
    expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });

  it("updates version_hint when a note supplies a version", async () => {
    const { projectDir, path } = await makeJournal();
    await appendNote({
      projectDir,
      sessionId: SESSION,
      kind: "progress",
      text: "release prep",
      version: "0.5.0",
    });
    expect((await readJournal(path)).version_hint).toBe("0.5.0");
    expect(await readFile(path, "utf8")).toContain("[progress] release prep");
  });

  it("skips malformed journals while searching for a session", async () => {
    const { projectDir, path } = await makeJournal();
    await mkdir(join(projectDir, "journal", "2026-11", "2026-11-13"), { recursive: true });
    await writeFile(
      join(projectDir, "journal", "2026-11", "2026-11-13", "000000_bad.md"),
      "---\n: : :\n---\nbody\n",
      "utf8",
    );
    expect(await findJournalBySession(projectDir, SESSION)).toBe(path);
  });
});
