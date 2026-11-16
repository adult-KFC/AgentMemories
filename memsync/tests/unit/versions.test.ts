import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/core/git.js";
import { journalPath, type SessionRecord } from "../../src/core/journal.js";
import { serializeFrontMatter, readProjectMeta } from "../../src/core/schema.js";
import { reportByPerson } from "../../src/core/reports.js";
import {
  aggregateJournals,
  refreshStateSnapshot,
  release,
  setVersion,
} from "../../src/core/versions.js";

const META = [
  "slug: checkout-service",
  "repos:",
  "  - git@git.corp.com:shop/checkout-service.git",
  "owners:",
  "  - alice@corp.com",
  "current_version: 0.4.0",
  "version_status: active",
  "maintenance:",
  "  interval_hours: 72",
  "  cooldown_hours: 6",
  "  mainline_only: true",
  "",
].join("\n");

const STATE = [
  "# 当前状态",
  "",
  "<!-- memsync:derived:begin -->",
  "<!-- memsync:derived:end -->",
  "",
  "## 人工备注",
  "",
  "- 发布窗口暂定 11-20",
  "",
].join("\n");

const DEFAULT_BODY = [
  "## 工作摘要",
  "",
  "",
  "## AI 记录",
  "",
  "",
  "## 未完成 / 交接",
  "",
].join("\n");

interface Project {
  home: string;
  projectDir: string;
}

async function makeProject(): Promise<Project> {
  const home = await mkdtemp(join(tmpdir(), "memsync-versions-"));
  const projectDir = join(home, "repo", "projects", "checkout-service");
  await mkdir(join(projectDir, "versions"), { recursive: true });
  await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
  await writeFile(join(projectDir, "state.md"), STATE, "utf8");
  return { home, projectDir };
}

async function initMemoryRepo(project: Project): Promise<void> {
  const repo = join(project.home, "repo");
  await runGit(["init"], { cwd: repo });
  await runGit(["config", "user.name", "Test User"], { cwd: repo });
  await runGit(["config", "user.email", "test@example.com"], { cwd: repo });
  await runGit(["config", "core.autocrlf", "false"], { cwd: repo });
}

function body(input: {
  summary?: string;
  notes?: string[];
  todos?: string[];
}): string {
  return [
    "## 工作摘要",
    "",
    input.summary ?? "",
    "",
    "## AI 记录",
    "",
    ...(input.notes ?? []),
    "",
    "## 未完成 / 交接",
    "",
    ...(input.todos ?? []).map((todo) => `- [ ] ${todo}`),
    "",
  ].join("\n");
}

async function writeJournal(
  projectDir: string,
  overrides: Partial<SessionRecord>,
  journalBody: string = DEFAULT_BODY,
): Promise<string> {
  const record: SessionRecord = {
    id: "aaaaaa",
    project: "checkout-service",
    user: "alice",
    email: "alice@corp.com",
    host: "host-a",
    tool: "claude-code",
    session: "session-1",
    started: "2026-11-10T09:00:00+08:00",
    ended: "2026-11-10T18:00:00+08:00",
    workspace: "/workspace",
    base_commit: "base",
    version_hint: "0.4.0",
    commits: [],
    files_changed: 1,
    insertions: 2,
    deletions: 0,
    outcome: "completed",
    summary_source: "ai",
    ...overrides,
  };
  const path = journalPath(projectDir, record);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, serializeFrontMatter(record, journalBody), "utf8");
  return path;
}

/** Alice (two sessions), Bob, and Carol (old version) journals. */
async function seedJournals(projectDir: string): Promise<void> {
  await writeJournal(
    projectDir,
    {
      id: "a1a1a1",
      user: "alice",
      email: "Alice@Corp.com",
      session: "session-alice-1",
      started: "2026-11-10T09:00:00+08:00",
      ended: "2026-11-10T18:00:00+08:00",
      commits: ["a1", "a2"],
      outcome: "completed",
    },
    body({
      summary: "合并购物车",
      notes: [
        "- 09:10 [progress] 购物车合并逻辑",
        "- 09:20 [blocker] 等待库存接口",
      ],
      todos: ["补充测试"],
    }),
  );

  await writeJournal(
    projectDir,
    {
      id: "a2a2a2",
      user: "alice",
      email: "alice@corp.com",
      session: "session-alice-2",
      started: "2026-11-11T09:00:00+08:00",
      ended: "2026-11-11T17:00:00+08:00",
      commits: ["a3"],
      outcome: "partial",
    },
    body({
      notes: ["- 10:00 [progress] 优化结算"],
      todos: ["补文档"],
    }),
  );

  await writeJournal(
    projectDir,
    {
      id: "b1b1b1",
      user: "bob",
      email: "bob@corp.com",
      host: "host-b",
      session: "session-bob-1",
      started: "2026-11-12T09:00:00+08:00",
      ended: "2026-11-12T17:00:00+08:00",
      commits: ["b1"],
      outcome: "completed",
    },
    body({
      summary: "库存接口联调",
      todos: ["回归"],
    }),
  );

  await writeJournal(
    projectDir,
    {
      id: "c1c1c1",
      user: "carol",
      email: "carol@corp.com",
      host: "host-c",
      session: "session-carol-1",
      started: "2026-11-01T09:00:00+08:00",
      ended: "2026-11-01T17:00:00+08:00",
      version_hint: "0.3.0",
      commits: ["c1"],
      outcome: "completed",
    },
    body({ summary: "旧版本工作" }),
  );
}

async function makeCodeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memsync-code-repo-"));
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.name", "Test User"], { cwd: dir });
  await runGit(["config", "user.email", "test@example.com"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "base\n", "utf8");
  await runGit(["add", "README.md"], { cwd: dir });
  await runGit(["commit", "-m", "base"], { cwd: dir });
  await runGit(["tag", "v0.3.0"], { cwd: dir });

  const commits: Array<[string, string]> = [
    ["a1.txt", "Alice <alice@corp.com>"],
    ["a2.txt", "Alice <alice@corp.com>"],
    ["b1.txt", "Bob <bob@corp.com>"],
  ];
  for (const [file, author] of commits) {
    await writeFile(join(dir, file), `${file}\n`, "utf8");
    await runGit(["add", file], { cwd: dir });
    await runGit(["commit", "--author", author, "-m", `commit ${file}`], { cwd: dir });
  }
  await runGit(["tag", "v0.4.0"], { cwd: dir });
  return dir;
}

describe("setVersion", () => {
  it("sets current_version and version_status in meta", async () => {
    const { projectDir } = await makeProject();

    await setVersion(projectDir, "0.5.0", "active");

    const meta = await readProjectMeta(projectDir);
    expect(meta.current_version).toBe("0.5.0");
    expect(meta.version_status).toBe("active");
  });

  it("commits meta.yaml with the trailer and no code tag", async () => {
    const project = await makeProject();
    await initMemoryRepo(project);

    await setVersion(project.projectDir, "0.5.0", "planning");

    const message = await runGit(
      ["log", "-1", "--format=%B"],
      { cwd: join(project.home, "repo") },
    );
    expect(message.stdout).toContain("0.5.0");
    expect(message.stdout).toContain("Co-Authored-By: Claude Code <noreply@anthropic.com>");
    const tags = await runGit(["tag"], { cwd: join(project.home, "repo") });
    expect(tags.stdout.trim()).toBe("");
  });

  it("rejects invalid versions and statuses", async () => {
    const { projectDir } = await makeProject();

    await expect(setVersion(projectDir, "", "active")).rejects.toThrow(/version/i);
    await expect(setVersion(projectDir, "../0.5.0", "active")).rejects.toThrow(/version/i);
    await expect(
      setVersion(projectDir, "0.5.0", "bogus" as never),
    ).rejects.toThrow(/status/i);
  });
});

describe("aggregateJournals", () => {
  it("groups by email and filters by version hint", async () => {
    const { projectDir } = await makeProject();
    await seedJournals(projectDir);

    const work = await aggregateJournals(projectDir, { version: "0.4.0" });

    expect(work.map((person) => person.email)).toEqual([
      "alice@corp.com",
      "bob@corp.com",
    ]);
    const alice = work[0];
    expect(alice.completed).toEqual(["合并购物车"]);
    expect(alice.active).toEqual(["优化结算"]);
    expect(alice.blocked).toEqual(["等待库存接口"]);
    expect(alice.commits).toEqual(["a1", "a2", "a3"]);
    expect(alice.remaining).toEqual(["补充测试", "补文档"]);
    expect(work[1].completed).toEqual(["库存接口联调"]);
    expect(work[1].remaining).toEqual(["回归"]);
  });

  it("filters by journal start time", async () => {
    const { projectDir } = await makeProject();
    await seedJournals(projectDir);

    const work = await aggregateJournals(projectDir, {
      version: "0.4.0",
      since: new Date("2026-11-11T00:00:00+08:00"),
    });

    expect(work).toHaveLength(2);
    expect(work[0].commits).toEqual(["a3"]);
    expect(work[0].completed).toEqual([]);
  });
});

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("refreshStateSnapshot", () => {
  it("rewrites only the derived block and preserves human notes", async () => {
    const { projectDir } = await makeProject();
    await seedJournals(projectDir);
    await writeFile(
      join(projectDir, "state.md"),
      STATE.replace(
        "<!-- memsync:derived:end -->",
        "- 旧内容\n<!-- memsync:derived:end -->",
      ),
      "utf8",
    );

    await refreshStateSnapshot(
      projectDir,
      new Date("2026-11-14T10:30:00+08:00"),
    );

    const state = await readFile(join(projectDir, "state.md"), "utf8");
    expect(state).toContain("<!-- memsync:derived:begin -->");
    expect(state).toContain("<!-- memsync:derived:end -->");
    expect(state).toContain("- 当前版本：0.4.0（开发中）");
    expect(state).toContain("进行中：alice — 优化结算");
    expect(state).toContain("最近完成：11-12 bob — 库存接口联调");
    expect(state).toContain("已知阻塞");
    expect(state).toContain("最近同步：2026-11-14T10:30");
    expect(state).not.toContain("旧内容");
    expect(state).toContain("## 人工备注");
    expect(state).toContain("发布窗口暂定 11-20");
  });

  it("prepends a derived block when markers are absent", async () => {
    const { projectDir } = await makeProject();
    await seedJournals(projectDir);
    await writeFile(
      join(projectDir, "state.md"),
      "# 当前状态\n\n## 人工备注\n\n- 手写内容保留\n",
      "utf8",
    );

    await refreshStateSnapshot(projectDir, new Date("2026-11-14T10:30:00+08:00"));

    const state = await readFile(join(projectDir, "state.md"), "utf8");
    expect(state.startsWith("<!-- memsync:derived:begin -->")).toBe(true);
    expect(state).toContain("<!-- memsync:derived:end -->");
    expect(state).toContain("## 人工备注");
    expect(state).toContain("手写内容保留");
  });

  it("replaces a lone begin marker with one complete block", async () => {
    const { projectDir } = await makeProject();
    await writeFile(
      join(projectDir, "state.md"),
      [
        "# 当前状态",
        "",
        "<!-- memsync:derived:begin -->",
        "- stale",
        "",
        "## 人工备注",
        "",
        "- 保留-孤-开始",
        "",
      ].join("\n"),
      "utf8",
    );

    await refreshStateSnapshot(projectDir, new Date("2026-11-14T10:30:00+08:00"));

    const state = await readFile(join(projectDir, "state.md"), "utf8");
    expect(occurrenceCount(state, "<!-- memsync:derived:begin -->")).toBe(1);
    expect(occurrenceCount(state, "<!-- memsync:derived:end -->")).toBe(1);
    expect(state).toContain("- 当前版本：0.4.0（开发中）");
    expect(state).toContain("保留-孤-开始");
  });

  it("replaces a lone end marker with one complete block", async () => {
    const { projectDir } = await makeProject();
    await writeFile(
      join(projectDir, "state.md"),
      [
        "# 当前状态",
        "",
        "- stale",
        "<!-- memsync:derived:end -->",
        "",
        "## 人工备注",
        "",
        "- 保留-孤-结束",
        "",
      ].join("\n"),
      "utf8",
    );

    await refreshStateSnapshot(projectDir, new Date("2026-11-14T10:30:00+08:00"));

    const state = await readFile(join(projectDir, "state.md"), "utf8");
    expect(occurrenceCount(state, "<!-- memsync:derived:begin -->")).toBe(1);
    expect(occurrenceCount(state, "<!-- memsync:derived:end -->")).toBe(1);
    expect(state).toContain("- 当前版本：0.4.0（开发中）");
    expect(state).toContain("保留-孤-结束");
  });

  it("collapses duplicate complete blocks into one", async () => {
    const { projectDir } = await makeProject();
    await writeFile(
      join(projectDir, "state.md"),
      [
        "# 当前状态",
        "",
        "<!-- memsync:derived:begin -->",
        "- 旧块一",
        "<!-- memsync:derived:end -->",
        "",
        "## 人工备注",
        "",
        "- 保留-重复",
        "",
        "<!-- memsync:derived:begin -->",
        "- 旧块二",
        "<!-- memsync:derived:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    await refreshStateSnapshot(projectDir, new Date("2026-11-14T10:30:00+08:00"));

    const state = await readFile(join(projectDir, "state.md"), "utf8");
    expect(occurrenceCount(state, "<!-- memsync:derived:begin -->")).toBe(1);
    expect(occurrenceCount(state, "<!-- memsync:derived:end -->")).toBe(1);
    expect(state).toContain("- 当前版本：0.4.0（开发中）");
    expect(state).toContain("保留-重复");
    expect(state).not.toContain("旧块一");
    expect(state).not.toContain("旧块二");
  });

  it("normalizes CRLF input and leaves LF only", async () => {
    const { projectDir } = await makeProject();
    await writeFile(
      join(projectDir, "state.md"),
      [
        "# 当前状态",
        "",
        "<!-- memsync:derived:begin -->",
        "- 旧块",
        "<!-- memsync:derived:end -->",
        "",
        "## 人工备注",
        "",
        "- 保留-CRLF",
        "",
      ].join("\r\n"),
      "utf8",
    );

    await refreshStateSnapshot(projectDir, new Date("2026-11-14T10:30:00+08:00"));

    const state = await readFile(join(projectDir, "state.md"), "utf8");
    expect(state).not.toContain("\r");
    expect(occurrenceCount(state, "<!-- memsync:derived:begin -->")).toBe(1);
    expect(occurrenceCount(state, "<!-- memsync:derived:end -->")).toBe(1);
    expect(state).toContain("- 当前版本：0.4.0（开发中）");
    expect(state).toContain("保留-CRLF");
    expect(state).not.toContain("旧块");
  });
});

describe("release", () => {
  it("aggregates journals and code commits by author", async () => {
    const project = await makeProject();
    await initMemoryRepo(project);
    await seedJournals(project.projectDir);
    const codeRepo = await makeCodeRepo();

    const result = await release(project.projectDir, "0.4.0", {
      codeRepo,
      sinceTag: "v0.3.0",
      toTag: "v0.4.0",
    });

    expect(result.contributors).toMatchObject({
      "alice@corp.com": 2,
      "bob@corp.com": 1,
    });

    const versionFile = await readFile(result.path, "utf8");
    expect(result.path).toBe(
      join(project.projectDir, "versions", "0.4.0.md"),
    );
    expect(versionFile).toContain("# 版本 0.4.0");
    expect(versionFile).toContain("alice");
    expect(versionFile).toContain("合并购物车");
    expect(versionFile).toContain("补充测试");
    expect(versionFile).toContain("| 2 |");

    const meta = await readProjectMeta(project.projectDir);
    expect(meta.version_status).toBe("frozen");

    const state = await readFile(join(project.projectDir, "state.md"), "utf8");
    expect(state).toContain("<!-- memsync:derived:begin -->");
    expect(state).toContain("当前版本：0.4.0（冻结）");
    expect(state).toContain("发布窗口暂定 11-20");

    const log = await runGit(["log", "-1", "--format=%B"], {
      cwd: join(project.home, "repo"),
    });
    expect(log.stdout).toContain("release: 0.4.0");
    expect(log.stdout).toContain("Co-Authored-By: Claude Code <noreply@anthropic.com>");
  });

  it("keeps journal-only contributors when a code repo is supplied", async () => {
    const project = await makeProject();
    await writeJournal(
      project.projectDir,
      {
        id: "d1d1d1",
        user: "dave",
        email: "dave@corp.com",
        host: "host-d",
        session: "session-dave-1",
        commits: ["d1"],
      },
      body({ summary: "文档整理" }),
    );
    const codeRepo = await makeCodeRepo();

    const result = await release(project.projectDir, "0.4.0", {
      codeRepo,
      sinceTag: "v0.3.0",
      toTag: "v0.4.0",
    });

    expect(result.contributors).toEqual({
      "alice@corp.com": 2,
      "bob@corp.com": 1,
      "dave@corp.com": 1,
    });
  });

  it("counts journal commits when no code repo is supplied", async () => {
    const project = await makeProject();
    await seedJournals(project.projectDir);

    const result = await release(project.projectDir, "0.4.0", {});

    expect(result.contributors).toEqual({
      "alice@corp.com": 3,
      "bob@corp.com": 1,
    });
  });

  it("fails clearly for an unknown tag without mutating meta", async () => {
    const project = await makeProject();
    await seedJournals(project.projectDir);
    const codeRepo = await makeCodeRepo();

    await expect(
      release(project.projectDir, "0.4.0", {
        codeRepo,
        sinceTag: "v9.9.9",
        toTag: "v0.4.0",
      }),
    ).rejects.toThrow(/unknown tag/i);

    expect((await readProjectMeta(project.projectDir)).version_status).toBe("active");
  });
});

describe("reportByPerson", () => {
  it("emits the documented table and filters older entries", async () => {
    const { projectDir } = await makeProject();
    await seedJournals(projectDir);

    const report = await reportByPerson(
      projectDir,
      new Date("2026-11-07T00:00:00Z"),
    );

    expect(report.split("\n")[0]).toBe("用户 | 完成 | 进行中 | 阻塞 | 提交数");
    expect(report).toContain("alice@corp.com | 1 | 1 | 1 | 3");
    expect(report).toContain("bob@corp.com | 1 | 0 | 0 | 1");
    expect(report).not.toContain("carol@corp.com");
  });

  it("returns only the header when nothing matches", async () => {
    const { projectDir } = await makeProject();

    const report = await reportByPerson(projectDir, new Date("2030-01-01T00:00:00Z"));

    expect(report.trim()).toBe("用户 | 完成 | 进行中 | 阻塞 | 提交数");
  });
});
