import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../../src/cli.js";
import { compactJournalsDetailed } from "../../src/core/compact.js";
import { runGit } from "../../src/core/git.js";
import {
  formatTimestamp,
  journalPath,
  type SessionRecord,
} from "../../src/core/journal.js";
import { serializeFrontMatter } from "../../src/core/schema.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

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

interface Setup {
  home: string;
  repo: string;
  workspace: string;
  projectDir: string;
  env: NodeJS.ProcessEnv;
}

async function setupProject(): Promise<Setup> {
  const home = await mkdtemp(join(tmpdir(), "memsync-release-home-"));
  const repo = join(home, "repo");
  const projectDir = join(repo, "projects", "checkout-service");
  const workspace = await mkdtemp(join(tmpdir(), "memsync-release-ws-"));

  await mkdir(join(projectDir, "versions"), { recursive: true });
  await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
  await writeFile(join(projectDir, "state.md"), STATE, "utf8");
  await writeFile(
    join(workspace, ".memsync.json"),
    '{"project":"checkout-service"}\n',
    "utf8",
  );

  await runGit(["init"], { cwd: repo });
  await runGit(["config", "user.name", "Test User"], { cwd: repo });
  await runGit(["config", "user.email", "test@example.com"], { cwd: repo });
  await runGit(["config", "core.autocrlf", "false"], { cwd: repo });

  return { home, repo, workspace, projectDir, env: { MEMSYNC_HOME: home } };
}

async function run(setup: Setup, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const captured = capture(setup.workspace, setup.env);
  const code = await runCli(argv, captured.io);
  return { code, out: captured.out.join(""), err: captured.err.join("") };
}

async function writeJournal(
  projectDir: string,
  overrides: Partial<SessionRecord>,
  summary: string,
): Promise<void> {
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
  const journalBody = [
    "## 工作摘要",
    "",
    summary,
    "",
    "## AI 记录",
    "",
    "- 10:00 [progress] 当前工作",
    "",
    "## 未完成 / 交接",
    "",
    "- [ ] 待办事项",
    "",
  ].join("\n");
  const path = journalPath(projectDir, record);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, serializeFrontMatter(record, journalBody), "utf8");
}

async function makeCodeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memsync-release-code-"));
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.name", "Test User"], { cwd: dir });
  await runGit(["config", "user.email", "test@example.com"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "base\n", "utf8");
  await runGit(["add", "README.md"], { cwd: dir });
  await runGit(["commit", "-m", "base"], { cwd: dir });
  await runGit(["tag", "v0.3.0"], { cwd: dir });

  for (const [file, author] of [
    ["a1.txt", "Alice <alice@corp.com>"],
    ["a2.txt", "Alice <alice@corp.com>"],
    ["b1.txt", "Bob <bob@corp.com>"],
  ] as const) {
    await writeFile(join(dir, file), `${file}\n`, "utf8");
    await runGit(["add", file], { cwd: dir });
    await runGit(["commit", "--author", author, "-m", `commit ${file}`], { cwd: dir });
  }
  await runGit(["tag", "v0.4.0"], { cwd: dir });
  return dir;
}

describe("memsync version set", () => {
  it("updates meta and commits with the trailer", async () => {
    const setup = await setupProject();

    const result = await run(setup, ["version", "set", "0.5.0", "--status", "active"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("0.5.0");
    const meta = await readFile(join(setup.projectDir, "meta.yaml"), "utf8");
    expect(meta).toContain("current_version: 0.5.0");
    const log = await runGit(["log", "-1", "--format=%B"], { cwd: setup.repo });
    expect(log.stdout).toContain("Co-Authored-By: Claude Code <noreply@anthropic.com>");
  });

  it("exits 1 for an invalid status with a clear message", async () => {
    const setup = await setupProject();

    const result = await run(setup, ["version", "set", "0.5.0", "--status", "nope"]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/status/i);
    expect(result.err).not.toMatch(/\n\s+at\s/);
  });

  it("exits 1 with a link hint when the workspace is unlinked", async () => {
    const setup = await setupProject();
    const unlinked = await mkdtemp(join(tmpdir(), "memsync-release-unlinked-"));

    const captured = capture(unlinked, setup.env);
    const code = await runCli(["version", "set", "0.5.0", "--status", "active"], captured.io);

    expect(code).toBe(1);
    expect(captured.err.join("")).toMatch(/memsync link/i);
  });
});

describe("memsync release", () => {
  it("writes versions/<version>.md and freezes the version", async () => {
    const setup = await setupProject();
    await writeJournal(
      setup.projectDir,
      { id: "a1a1a1", email: "alice@corp.com", commits: ["a1"] },
      "合并购物车",
    );
    const codeRepo = await makeCodeRepo();

    const result = await run(setup, [
      "release",
      "0.4.0",
      "--code-repo",
      codeRepo,
      "--since-tag",
      "v0.3.0",
      "--to-tag",
      "v0.4.0",
    ]);

    expect(result.code).toBe(0);
    const versionFile = await readFile(
      join(setup.projectDir, "versions", "0.4.0.md"),
      "utf8",
    );
    expect(versionFile).toContain("# 版本 0.4.0");
    expect(versionFile).toContain("alice@corp.com");
    expect(versionFile).toContain("合并购物车");
    expect(await readFile(join(setup.projectDir, "meta.yaml"), "utf8")).toContain(
      "version_status: frozen",
    );
  });

  it("exits 1 with a clear message for an unknown tag", async () => {
    const setup = await setupProject();
    const codeRepo = await makeCodeRepo();

    const result = await run(setup, [
      "release",
      "0.4.0",
      "--code-repo",
      codeRepo,
      "--since-tag",
      "v9.9.9",
      "--to-tag",
      "v0.4.0",
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/unknown tag/i);
    expect(result.err).not.toMatch(/\n\s+at\s/);
  });
});

describe("memsync state refresh", () => {
  it("rebuilds the derived block and keeps human notes", async () => {
    const setup = await setupProject();
    await writeJournal(
      setup.projectDir,
      { id: "a1a1a1", commits: ["a1"] },
      "合并购物车",
    );

    const result = await run(setup, ["state", "refresh"]);

    expect(result.code).toBe(0);
    const state = await readFile(join(setup.projectDir, "state.md"), "utf8");
    expect(state).toContain("<!-- memsync:derived:begin -->");
    expect(state).toContain("当前版本：0.4.0");
    expect(state).toContain("发布窗口暂定 11-20");
  });
});

describe("memsync report", () => {
  it("filters entries older than --since 7d", async () => {
    const setup = await setupProject();
    const now = new Date();
    const recent = new Date(now.getTime() - 1 * DAY_MS);
    const old = new Date(now.getTime() - 30 * DAY_MS);

    await writeJournal(
      setup.projectDir,
      {
        id: "r1r1r1",
        user: "recent",
        email: "recent@corp.com",
        session: "session-recent",
        started: formatTimestamp(recent),
        ended: formatTimestamp(new Date(recent.getTime() + 3_600_000)),
        commits: ["r1"],
      },
      "近期工作",
    );
    await writeJournal(
      setup.projectDir,
      {
        id: "o1o1o1",
        user: "old",
        email: "old@corp.com",
        session: "session-old",
        started: formatTimestamp(old),
        ended: formatTimestamp(new Date(old.getTime() + 3_600_000)),
        commits: ["o1"],
      },
      "旧工作",
    );

    const result = await run(setup, ["report", "--since", "7d"]);

    expect(result.code).toBe(0);
    const lines = result.out.trim().split("\n");
    expect(lines[0]).toBe("用户 | 完成 | 进行中 | 阻塞 | 提交数");
    expect(result.out).toContain("recent@corp.com");
    expect(result.out).not.toContain("old@corp.com");
  });

  it("accepts an ISO date and includes older entries", async () => {
    const setup = await setupProject();
    await writeJournal(
      setup.projectDir,
      {
        id: "o1o1o1",
        user: "old",
        email: "old@corp.com",
        session: "session-old",
        started: "2026-01-05T09:00:00+08:00",
        ended: "2026-01-05T18:00:00+08:00",
        commits: ["o1"],
      },
      "旧工作",
    );

    const result = await run(setup, ["report", "--since", "2020-01-01"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("old@corp.com");
  });

  it("includes archived journals in both the release and report", async () => {
    const setup = await setupProject();
    await writeJournal(
      setup.projectDir,
      { id: "arc123", email: "alice@corp.com", commits: ["a1"] },
      "归档月份的合并工作",
    );
    const compacted = await compactJournalsDetailed(setup.projectDir, new Date());
    expect(compacted.count).toBe(1);

    const report = await run(setup, ["report", "--since", "2020-01-01"]);
    expect(report.code).toBe(0);
    expect(report.out).toContain("alice@corp.com");

    const release = await run(setup, ["release", "0.4.0"]);
    expect(release.code).toBe(0);
    const versionFile = await readFile(
      join(setup.projectDir, "versions", "0.4.0.md"),
      "utf8",
    );
    expect(versionFile).toContain("归档月份的合并工作");
  });

  it("exits 1 for an invalid --since value", async () => {
    const setup = await setupProject();

    const result = await run(setup, ["report", "--since", "not-a-date"]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/since/i);
    expect(result.err).not.toMatch(/\n\s+at\s/);
  });
});
