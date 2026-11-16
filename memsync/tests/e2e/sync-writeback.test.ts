import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findJournalBySession,
  listJournals,
  readJournal,
  readJournalDocument,
} from "../../src/core/journal.js";
import type { SessionRecord } from "../../src/core/journal.js";
import {
  commitWorkspaceFile,
  fakeClaudeHook,
  gitIn,
  gitOrThrowIn,
  initWorkspace,
  makeHome,
  makeMemoryRepo,
  runCliIn,
  type TestHome,
} from "./helpers.js";

interface SessionWrite {
  home: TestHome;
  session: string;
  notes: Array<[kind: string, text: string]>;
}

async function writeSession(
  input: SessionWrite,
  summary?: { outcome: string; summary: string },
): Promise<void> {
  const { home, session, notes } = input;
  const begin = await runCliIn(
    home,
    ["session", "begin", "--tool", "claude-code", "--session", session],
    { cwd: home.workspace },
  );
  expect(begin.code, begin.err).toBe(0);

  for (const [kind, text] of notes) {
    const note = await runCliIn(home, ["note", kind, text, "--session", session], {
      cwd: home.workspace,
    });
    expect(note.code, note.err).toBe(0);
  }

  if (summary !== undefined) {
    const summarized = await runCliIn(
      home,
      [
        "session",
        "summary",
        "--outcome",
        summary.outcome,
        "--summary",
        summary.summary,
        "--session",
        session,
      ],
      { cwd: home.workspace },
    );
    expect(summarized.code, summarized.err).toBe(0);
  }

  const end = await runCliIn(home, ["session", "end", "--session", session], {
    cwd: home.workspace,
  });
  expect(end.code, end.err).toBe(0);
}

function additionalContext(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  const context = parsed.hookSpecificOutput?.additionalContext;
  expect(typeof context).toBe("string");
  return context as string;
}

describe("e2e sync and write-back", () => {
  it("scenario 1: new machine init/link/sync injects constraints and progress", async () => {
    const team = await makeMemoryRepo({ version: "0.4.0" });

    // The team already has work in progress when the new machine joins.
    await writeSession(
      {
        home: team.admin,
        session: "seed-progress",
        notes: [["progress", "购物车合并逻辑进行中"]],
      },
      { outcome: "partial", summary: "购物车合并未完成" },
    );

    const machine = await makeHome("memsync-e2e-new-machine");
    const init = await runCliIn(
      machine,
      [
        "init",
        "--remote",
        team.remote.remote,
        "--name",
        "New Dev",
        "--email",
        "new@corp.com",
      ],
      { cwd: machine.root },
    );
    expect(init.code, init.err).toBe(0);

    const workspace = await initWorkspace(machine, machine.workspace, "new-machine");
    expect(workspace.baseCommit).toBeTruthy();

    const link = await runCliIn(machine, ["link", team.project.slug], {
      cwd: machine.workspace,
    });
    expect(link.code, link.err).toBe(0);

    const startedAt = Date.now();
    const started = await runCliIn(
      machine,
      ["hook", "session-start", "--tool", "claude-code"],
      {
        cwd: machine.workspace,
        stdin: fakeClaudeHook({
          session_id: "new-machine-session",
          cwd: machine.workspace,
        }),
      },
    );
    const elapsedMs = Date.now() - startedAt;

    expect(started.code, started.err).toBe(0);
    const context = additionalContext(started.out);

    // Team conventions, project constraints, version, and current progress.
    expect(context).toContain("## 团队规范");
    expect(context).toContain("MUST 所有代码变更走 MR");
    expect(context).toContain("## 项目核心约束");
    expect(context).toContain("MUST 所有对外接口使用 internal/contract 中的 IDL");
    expect(context).toContain("版本 0.4.0");
    expect(context).toContain("购物车合并逻辑进行中");

    // Startup budget from the acceptance criteria: <= 10s excluding first clone.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 90_000);

  it("scenario 2: two users write in the same minute without manual conflict", async () => {
    const team = await makeMemoryRepo();

    const bobHome = await makeHome("memsync-e2e-bob");
    const bobInit = await runCliIn(
      bobHome,
      [
        "init",
        "--remote",
        team.remote.remote,
        "--name",
        "Bob",
        "--email",
        "bob@corp.com",
      ],
      { cwd: bobHome.root },
    );
    expect(bobInit.code, bobInit.err).toBe(0);
    await initWorkspace(bobHome, bobHome.workspace, "bob-workspace");
    const bobLink = await runCliIn(bobHome, ["link", team.project.slug], {
      cwd: bobHome.workspace,
    });
    expect(bobLink.code, bobLink.err).toBe(0);

    // Both developers write three notes and end the session back to back.
    await writeSession({
      home: team.admin,
      session: "alice-s2",
      notes: [
        ["progress", "Alice 笔记 1"],
        ["progress", "Alice 笔记 2"],
        ["decision", "Alice 笔记 3"],
      ],
    });
    await writeSession({
      home: bobHome,
      session: "bob-s2",
      notes: [
        ["progress", "Bob 笔记 1"],
        ["blocker", "Bob 笔记 2"],
        ["decision", "Bob 笔记 3"],
      ],
    });

    // Pull the other side's commit and inspect the merged memory repo.
    const sync = await runCliIn(team.admin, ["sync"], { cwd: team.workspace });
    expect(sync.code, sync.err).toBe(0);

    const journals = await listJournals(team.project.projectDir);
    const documents = await Promise.all(journals.map((path) => readJournalDocument(path)));
    const s2 = documents.filter(
      (document) =>
        document.record.session === "alice-s2" || document.record.session === "bob-s2",
    );
    expect(s2).toHaveLength(2);

    const records = new Map(s2.map((document) => [document.record.session, document.record]));
    expect(records.get("alice-s2")).toMatchObject({
      user: "Alice",
      email: "alice@corp.com",
      host: "E2E-HOST",
    });
    expect(records.get("bob-s2")).toMatchObject({
      user: "Bob",
      email: "bob@corp.com",
      host: "E2E-HOST",
    });

    for (const document of s2) {
      const body = document.body;
      expect(body).toContain(`${document.record.session === "alice-s2" ? "Alice" : "Bob"} 笔记`);
      for (const index of [1, 2, 3]) {
        const author = document.record.session === "alice-s2" ? "Alice" : "Bob";
        expect(body).toContain(`${author} 笔记 ${index}`);
      }
    }

    // The two journals were created within the same minute-scale window.
    const alice = records.get("alice-s2") as SessionRecord;
    const bob = records.get("bob-s2") as SessionRecord;
    expect(Math.abs(Date.parse(alice.started) - Date.parse(bob.started))).toBeLessThan(60_000);

    // No manual conflict resolution and no leftover conflict markers.
    const markers = await gitIn(team.admin, team.project.repoPath, [
      "grep",
      "-l",
      "<<<<<<<",
    ]).catch(() => ({ stdout: "", stderr: "" }));
    expect(markers.stdout.trim()).toBe("");
  }, 90_000);

  it("scenario 4: offline startup uses the cached pack and retries a pending push", async () => {
    const team = await makeMemoryRepo();

    // Prime the cache with an online startup sync.
    const primed = await runCliIn(team.admin, ["sync"], { cwd: team.workspace });
    expect(primed.code, primed.err).toBe(0);

    const offlineRemote = join(team.admin.root, "offline.git");
    await gitOrThrowIn(team.admin, team.project.repoPath, [
      "remote",
      "set-url",
      "origin",
      offlineRemote,
    ]);

    const offline = await runCliIn(team.admin, ["sync"], { cwd: team.workspace });
    expect(offline.code, offline.err).toBe(0);
    expect(offline.out).toContain("[memsync] 离线");
    expect(offline.out).toContain("缓存");

    // Work done while offline is committed locally and queued for push.
    await writeSession({
      home: team.admin,
      session: "offline-s4",
      notes: [["progress", "离线期间完成的工作"]],
    });

    const pending = await runCliIn(team.admin, ["status"], { cwd: team.workspace });
    expect(pending.out).toContain("pending push: yes");

    // Reconnect: the next startup retries the queued push.
    await gitOrThrowIn(team.admin, team.project.repoPath, [
      "remote",
      "set-url",
      "origin",
      team.remote.remote,
    ]);
    const online = await runCliIn(team.admin, ["sync"], { cwd: team.workspace });
    expect(online.code, online.err).toBe(0);

    const flushed = await runCliIn(team.admin, ["status"], { cwd: team.workspace });
    expect(flushed.out).toContain("pending push: no");

    const remoteLog = await gitOrThrowIn(team.admin, team.remote.remote, [
      "log",
      "--all",
      "--format=%s",
    ]);
    expect(remoteLog).toContain("journal: offline-s4 end");
  }, 90_000);

  it("scenario 5: session end records stats and report groups by person", async () => {
    const team = await makeMemoryRepo();

    const bobHome = await makeHome("memsync-e2e-bob-report");
    const bobInit = await runCliIn(
      bobHome,
      [
        "init",
        "--remote",
        team.remote.remote,
        "--name",
        "Bob",
        "--email",
        "bob@corp.com",
      ],
      { cwd: bobHome.root },
    );
    expect(bobInit.code, bobInit.err).toBe(0);
    await initWorkspace(bobHome, bobHome.workspace, "bob-report");
    const bobLink = await runCliIn(bobHome, ["link", team.project.slug], {
      cwd: bobHome.workspace,
    });
    expect(bobLink.code, bobLink.err).toBe(0);

    const runTrackedSession = async (
      home: TestHome,
      session: string,
      author: string,
    ): Promise<void> => {
      const begin = await runCliIn(
        home,
        ["session", "begin", "--tool", "claude-code", "--session", session],
        { cwd: home.workspace },
      );
      expect(begin.code, begin.err).toBe(0);

      const note = await runCliIn(
        home,
        ["note", "progress", `${author} 完成支付重试`, "--session", session],
        { cwd: home.workspace },
      );
      expect(note.code, note.err).toBe(0);

      await commitWorkspaceFile(
        home,
        home.workspace,
        `src/${session}.ts`,
        "line1\nline2\n",
        `feat: ${author} payment retry`,
      );

      const summarized = await runCliIn(
        home,
        [
          "session",
          "summary",
          "--outcome",
          "completed",
          "--summary",
          `${author} 交付支付重试`,
          "--session",
          session,
        ],
        { cwd: home.workspace },
      );
      expect(summarized.code, summarized.err).toBe(0);

      const end = await runCliIn(home, ["session", "end", "--session", session], {
        cwd: home.workspace,
      });
      expect(end.code, end.err).toBe(0);
    };

    await runTrackedSession(team.admin, "alice-s5", "Alice");
    await runTrackedSession(bobHome, "bob-s5", "Bob");

    // Alice pulls Bob's journal before reporting.
    const sync = await runCliIn(team.admin, ["sync"], { cwd: team.workspace });
    expect(sync.code, sync.err).toBe(0);

    const alicePath = await findJournalBySession(team.project.projectDir, "alice-s5");
    expect(alicePath).toBeDefined();
    const alice = await readJournal(alicePath as string);

    expect(alice.started).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(alice.ended).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(alice.branch).toBeTruthy();
    expect(alice.commits).toHaveLength(1);
    expect(alice.files_changed).toBe(1);
    expect(alice.insertions).toBe(2);
    expect(alice.deletions).toBe(0);
    expect(alice.outcome).toBe("completed");

    const body = await readFile(alicePath as string, "utf8");
    expect(body).toContain("Alice 完成支付重试");

    const report = await runCliIn(team.admin, ["report", "--since", "1d"], {
      cwd: team.workspace,
    });
    expect(report.code, report.err).toBe(0);
    const personLines = report.out
      .split(/\r?\n/)
      .filter((line) => line.includes("@corp.com"));
    expect(personLines).toHaveLength(2);
    expect(report.out).toContain("alice@corp.com | 1");
    expect(report.out).toContain("bob@corp.com | 1");
  }, 90_000);

  it("scenario 6/7: unlinked workspace is silent and the budget truncates with a pointer", async () => {
    const team = await makeMemoryRepo();

    // Scenario 6: a configured machine in a workspace that is not linked.
    const unlinked = await makeHome("memsync-e2e-unlinked");
    await initWorkspace(unlinked, unlinked.workspace, "unlinked");

    const hook = await runCliIn(
      team.admin,
      ["hook", "session-start", "--tool", "claude-code"],
      {
        cwd: unlinked.workspace,
        stdin: fakeClaudeHook({
          session_id: "unlinked-session",
          cwd: unlinked.workspace,
        }),
      },
    );
    expect(hook.code).toBe(0);
    expect(hook.out.trim()).toBe("{}");
    expect(hook.err).toBe("");

    const sync = await runCliIn(team.admin, ["sync"], { cwd: unlinked.workspace });
    expect(sync.code).toBe(0);
    expect(sync.out).toBe("");

    // Scenario 7: a tight project budget must truncate and leave a recall pointer.
    const bigConstraints = [
      "# 核心约束（权威）",
      "",
      "## 必须",
      "",
      ...Array.from(
        { length: 40 },
        (_value, index) => `- MUST 约束条目 ${index} ${"说明".repeat(30)}`,
      ),
      "",
      "## 禁止",
      "",
      ...Array.from(
        { length: 40 },
        (_value, index) => `- MUST NOT 禁止条目 ${index} ${"细节".repeat(30)}`,
      ),
      "",
    ].join("\n");
    const bigConventions = [
      "# 团队通用规范",
      "",
      "## 必须",
      "",
      ...Array.from(
        { length: 40 },
        (_value, index) => `- MUST 团队规范 ${index} ${"规范".repeat(30)}`,
      ),
      "",
    ].join("\n");

    const budgetChars = 600;
    const big = await makeMemoryRepo({
      budgetChars,
      constraints: bigConstraints,
      conventions: bigConventions,
    });
    const truncated = await runCliIn(big.admin, ["sync", "--no-pull"], {
      cwd: big.workspace,
    });
    expect(truncated.code, truncated.err).toBe(0);
    // The renderer caps the pack at budget + the 200-char pointer allowance.
    expect(truncated.out.length).toBeLessThanOrEqual(budgetChars + 200 + 1);
    expect(truncated.out).toContain("已省略");
    expect(truncated.out).toContain("memsync recall");
  }, 90_000);

  it("scenario 8: a secret-shaped note is rejected before it reaches disk", async () => {
    const team = await makeMemoryRepo();

    const begin = await runCliIn(
      team.admin,
      ["session", "begin", "--tool", "claude-code", "--session", "secret-s8"],
      { cwd: team.workspace },
    );
    expect(begin.code, begin.err).toBe(0);

    const secret = "sk-1234567890abcdef";
    const rejected = await runCliIn(
      team.admin,
      ["note", "progress", `调用接口时使用 ${secret} 作为密钥`, "--session", "secret-s8"],
      { cwd: team.workspace },
    );

    expect(rejected.code).toBe(1);
    expect(rejected.err).toMatch(/secret/i);

    const journalPath = await findJournalBySession(team.project.projectDir, "secret-s8");
    expect(journalPath).toBeDefined();
    const raw = await readFile(journalPath as string, "utf8");

    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("[REDACTED]");
    // The rejected note was never written at all.
    expect(raw).not.toContain("调用接口时使用");
  }, 60_000);

  it("scenario 11: concurrent Claude sessions bind through CLAUDE_ENV_FILE", async () => {
    const team = await makeMemoryRepo();
    const envFileA = join(team.admin.root, "env-a.sh");
    const envFileB = join(team.admin.root, "env-b.sh");

    // Realistic UUIDs: the journal filename embeds the first six characters,
    // so two concurrent sessions must not share a short-id prefix.
    const sessionA = "a1b2c3d4-1111-4222-8333-aaaaaaaaaaaa";
    const sessionB = "b2c3d4e5-2222-4333-9444-bbbbbbbbbbbb";

    const hookA = await runCliIn(
      team.admin,
      ["hook", "session-start", "--tool", "claude-code"],
      {
        cwd: team.workspace,
        stdin: fakeClaudeHook({ session_id: sessionA, cwd: team.workspace }),
        env: { CLAUDE_ENV_FILE: envFileA },
      },
    );
    const hookB = await runCliIn(
      team.admin,
      ["hook", "session-start", "--tool", "claude-code"],
      {
        cwd: team.workspace,
        stdin: fakeClaudeHook({ session_id: sessionB, cwd: team.workspace }),
        env: { CLAUDE_ENV_FILE: envFileB },
      },
    );
    expect(hookA.code, hookA.err).toBe(0);
    expect(hookB.code, hookB.err).toBe(0);

    const exportedA = await readFile(envFileA, "utf8");
    const exportedB = await readFile(envFileB, "utf8");
    expect(exportedA).toContain(`export MEMSYS_SESSION='${sessionA}'`);
    expect(exportedB).toContain(`export MEMSYS_SESSION='${sessionB}'`);

    // Notes written from each shell resolve MEMSYS_SESSION (no --session) and
    // land in that shell's journal, not the other one.
    const noteA = await runCliIn(
      team.admin,
      ["note", "progress", "来自 A 会话的笔记"],
      {
        cwd: team.workspace,
        env: { MEMSYS_SESSION: sessionA, MEMSYS_TOOL: "claude-code" },
      },
    );
    const noteB = await runCliIn(
      team.admin,
      ["note", "progress", "来自 B 会话的笔记"],
      {
        cwd: team.workspace,
        env: { MEMSYS_SESSION: sessionB, MEMSYS_TOOL: "claude-code" },
      },
    );
    expect(noteA.code, noteA.err).toBe(0);
    expect(noteB.code, noteB.err).toBe(0);

    const documentA = await readJournalDocument(
      (await findJournalBySession(team.project.projectDir, sessionA)) as string,
    );
    const documentB = await readJournalDocument(
      (await findJournalBySession(team.project.projectDir, sessionB)) as string,
    );
    expect(documentA.body).toContain("来自 A 会话的笔记");
    expect(documentA.body).not.toContain("来自 B 会话的笔记");
    expect(documentB.body).toContain("来自 B 会话的笔记");
    expect(documentB.body).not.toContain("来自 A 会话的笔记");

    // Each shell's environment finalizes its own session, not the other's.
    const endA = await runCliIn(team.admin, ["session", "end"], {
      cwd: team.workspace,
      env: { MEMSYS_SESSION: sessionA, MEMSYS_TOOL: "claude-code" },
    });
    expect(endA.code, endA.err).toBe(0);

    const recordA = await readJournal(
      (await findJournalBySession(team.project.projectDir, sessionA)) as string,
    );
    const recordB = await readJournal(
      (await findJournalBySession(team.project.projectDir, sessionB)) as string,
    );
    expect(recordA.ended).toBeTruthy();
    expect(recordB.ended).toBeUndefined();

    const endB = await runCliIn(team.admin, ["session", "end"], {
      cwd: team.workspace,
      env: { MEMSYS_SESSION: sessionB, MEMSYS_TOOL: "claude-code" },
    });
    expect(endB.code, endB.err).toBe(0);

    // Without an env file the pointer can only name the last starter; ending
    // an ambiguous workspace must ask for an explicit --session.
    const pointerSessions = [
      "c3d4e5f6-3333-4444-8555-cccccccccccc",
      "d4e5f6a7-4444-4555-9666-dddddddddddd",
    ];
    for (const session of pointerSessions) {
      const started = await runCliIn(
        team.admin,
        ["hook", "session-start", "--tool", "claude-code"],
        {
          cwd: team.workspace,
          stdin: fakeClaudeHook({ session_id: session, cwd: team.workspace }),
        },
      );
      expect(started.code).toBe(0);
    }

    const ambiguous = await runCliIn(team.admin, ["session", "end"], {
      cwd: team.workspace,
    });
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toMatch(/multiple active sessions/i);
    expect(ambiguous.err).toContain("--session");

    const explicit = await runCliIn(
      team.admin,
      ["session", "end", "--session", pointerSessions[0]],
      { cwd: team.workspace },
    );
    expect(explicit.code, explicit.err).toBe(0);
  }, 90_000);
});
