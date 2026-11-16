import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../../src/cli.js";
import { writeFileAtomic } from "../../src/core/atomic.js";
import { readCachedPack, readSeen, saveSeen, seenKey, writeCachedPack } from "../../src/core/cache.js";
import { saveConfig } from "../../src/core/config.js";
import { gitOrThrow, runGit } from "../../src/core/git.js";
import {
  SECTION_HANDOFF,
  appendNote,
  createJournal,
  findJournalBySession,
  listJournals,
  readJournal,
  readJournalDocument,
  setSectionContent,
} from "../../src/core/journal.js";
import { cloneOrUpdateRepo } from "../../src/core/repo.js";
import { serializeFrontMatter } from "../../src/core/schema.js";
import {
  beginSession,
  endSession,
  readPendingPush,
  writeSessionSummary,
} from "../../src/core/session.js";
import { computeState } from "../../src/core/state.js";
import { getStatus } from "../../src/core/status.js";
import { syncProject } from "../../src/core/sync.js";
import type { BareRemote } from "../helpers.js";
import { makeBareRemote, makeTwoClones } from "../helpers.js";

const HOST = "WIN-TEST";
const SLUG = "checkout-service";
const EMAIL = "alice@corp.com";
const META = `slug: checkout-service
repos:
  - git@git.corp.com:shop/checkout-service.git
owners:
  - alice@corp.com
current_version: 0.4.0
version_status: active
context_budget_chars: 12000
maintenance:
  interval_hours: 72
  cooldown_hours: 6
  mainline_only: true
`;

const CONSTRAINTS = `# 核心约束（权威）

## 必须

- MUST 所有对外接口使用 internal/contract 中的 IDL
  - 适用：所有对外 HTTP/RPC 接口
  - 状态：active

## 禁止

- MUST NOT 在 domain 层直接调用第三方 HTTP API

## 架构

- 服务分层：api → application → domain → infra
`;

const CONVENTIONS = `# 团队通用规范

## 必须

- MUST 所有代码变更走 MR

## 禁止

- MUST NOT 在日志中输出用户手机号
`;

interface Setup {
  remote: BareRemote;
  home: string;
  repoPath: string;
  projectDir: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

async function makeSetup(): Promise<Setup> {
  const remote = await makeBareRemote();
  const home = await mkdtemp(join(tmpdir(), "memsync-sync-home-"));
  const repoPath = join(home, "repo");
  await cloneOrUpdateRepo({ remoteUrl: remote.remote, repoPath });
  await gitOrThrow(["config", "user.name", "Test User"], { cwd: repoPath });
  await gitOrThrow(["config", "user.email", "test@example.com"], { cwd: repoPath });

  const env = {
    ...process.env,
    MEMSYNC_HOME: home,
    MEMSYS_HOST: HOST,
    MEMSYS_TOOL: "",
  } as NodeJS.ProcessEnv;

  await saveConfig(env, {
    version: 1,
    repoPath,
    remoteUrl: remote.remote,
    identity: { name: "Alice", email: EMAIL },
    defaultBudgetChars: 12_000,
  });

  const projectDir = join(repoPath, "projects", SLUG);
  await mkdir(join(projectDir, "journal"), { recursive: true });
  await mkdir(join(projectDir, "decisions"), { recursive: true });
  await mkdir(join(projectDir, "versions"), { recursive: true });
  await mkdir(join(repoPath, "org"), { recursive: true });
  await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
  await writeFile(join(projectDir, "constraints.md"), CONSTRAINTS, "utf8");
  await writeFile(join(repoPath, "org", "conventions.md"), CONVENTIONS, "utf8");

  const workspace = await mkdtemp(join(tmpdir(), "memsync-sync-ws-"));
  await writeFile(join(workspace, ".memsync.json"), `{"project":"${SLUG}"}\n`, "utf8");

  return { remote, home, repoPath, projectDir, workspace, env };
}

interface TestIo extends CliIo {
  out: string[];
  err: string[];
}

function makeIo(cwd: string, env: NodeJS.ProcessEnv): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    env,
    stdin: async () => "",
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    out,
    err,
  };
}

async function addTeamJournals(setup: Setup): Promise<void> {
  await beginSession({
    projectDir: setup.projectDir,
    project: SLUG,
    user: "alice",
    email: EMAIL,
    host: HOST,
    tool: "claude-code",
    session: "alice-session",
    workspace: setup.workspace,
  });
  await appendNote({
    projectDir: setup.projectDir,
    sessionId: "alice-session",
    kind: "progress",
    text: "购物车合并逻辑",
  });
  await appendNote({
    projectDir: setup.projectDir,
    sessionId: "alice-session",
    kind: "blocker",
    text: "等待库存接口确认",
  });
  await appendNote({
    projectDir: setup.projectDir,
    sessionId: "alice-session",
    kind: "todo",
    text: "并发压测",
  });
  await endSession({
    projectDir: setup.projectDir,
    sessionId: "alice-session",
    env: setup.env,
  });

  await beginSession({
    projectDir: setup.projectDir,
    project: SLUG,
    user: "bob",
    email: "bob@corp.com",
    host: HOST,
    tool: "codex",
    session: "bob-session",
    workspace: setup.workspace,
  });
  await appendNote({
    projectDir: setup.projectDir,
    sessionId: "bob-session",
    kind: "progress",
    text: "支付重试",
  });
  await endSession({
    projectDir: setup.projectDir,
    sessionId: "bob-session",
    env: setup.env,
  });
}

describe("cache and seen cursor", () => {
  it("returns undefined for a missing cached pack", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-cache-home-"));
    const env = { ...process.env, MEMSYNC_HOME: home } as NodeJS.ProcessEnv;

    expect(await readCachedPack(env, "ghost")).toBeUndefined();
  });

  it("builds the documented key order", () => {
    expect(seenKey("checkout-service", "alice@corp.com", HOST, "claude-code")).toBe(
      `alice@corp.com|${HOST}|claude-code|checkout-service`,
    );
  });

  it("round-trips the seen cursor", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-cache-home-"));
    const env = { ...process.env, MEMSYNC_HOME: home } as NodeJS.ProcessEnv;
    const key = seenKey(SLUG, EMAIL, HOST, "codex");

    await saveSeen(env, { [key]: "2026-11-14T00:00:00.000Z" });

    expect(await readSeen(env)).toEqual({ [key]: "2026-11-14T00:00:00.000Z" });
  });
});

describe("computeState", () => {
  it("derives progress, blockers, completions, open items, and version from recent journals", async () => {
    const setup = await makeSetup();
    await addTeamJournals(setup);

    const state = await computeState(setup.projectDir, new Date());

    expect(state.version).toBe("0.4.0");
    expect(state.versionStatus).toBe("active");
    expect(state.inProgress.map((item) => item.text)).toContain("购物车合并逻辑");
    // bob's progress was followed by his own completed session.
    expect(state.inProgress.map((item) => item.text)).not.toContain("支付重试");
    expect(state.blockers.map((item) => item.text)).toContain("等待库存接口确认");
    expect(state.recentlyDone.map((item) => item.user)).toContain("bob");
    expect(state.openItems.map((item) => item.text)).toContain("并发压测");
  });

  it("ignores journals older than the window", async () => {
    const setup = await makeSetup();
    await addTeamJournals(setup);

    const state = await computeState(
      setup.projectDir,
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      14,
    );

    expect(state.inProgress).toEqual([]);
    expect(state.blockers).toEqual([]);
    expect(state.recentlyDone).toEqual([]);
    expect(state.openItems).toEqual([]);
  });

  it("does not report checked todos or handoffs as unfinished", async () => {
    const setup = await makeSetup();
    await beginSession({
      projectDir: setup.projectDir,
      project: SLUG,
      user: "alice",
      email: EMAIL,
      host: HOST,
      tool: "claude-code",
      session: "checked-session",
      workspace: setup.workspace,
    });

    const journal = await findJournalBySession(setup.projectDir, "checked-session");
    expect(journal).toBeDefined();
    const document = await readJournalDocument(journal as string);
    const body = setSectionContent(
      document.body,
      SECTION_HANDOFF,
      "- [ ] 未完成项\n- [x] 已完成项\n- [X] 也已完成的项",
    );
    await writeFileAtomic(
      journal as string,
      serializeFrontMatter({ ...document.record, ...document.extras }, body),
    );

    const state = await computeState(setup.projectDir, new Date());
    const texts = state.openItems.map((item) => item.text);

    expect(texts).toContain("未完成项");
    expect(texts).not.toContain("已完成项");
    expect(texts).not.toContain("也已完成的项");
  });
});

describe("syncProject", () => {
  it("returns silently when there is no config", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-sync-noconfig-"));
    const workspace = await mkdtemp(join(tmpdir(), "memsync-sync-ws-"));
    const env = { ...process.env, MEMSYNC_HOME: home } as NodeJS.ProcessEnv;

    const result = await syncProject({ cwd: workspace, env, noPull: true });

    expect(result).toEqual({ code: 0 });
  });

  it("returns no context for an unlinked workspace", async () => {
    const setup = await makeSetup();
    const unlinked = await mkdtemp(join(tmpdir(), "memsync-sync-unlinked-"));

    const result = await syncProject({ cwd: unlinked, env: setup.env, noPull: true });

    expect(result).toMatchObject({ code: 0, context: undefined });
  });

  it("renders and caches the pack, then advances the seen cursor", async () => {
    const setup = await makeSetup();
    await addTeamJournals(setup);

    const result = await syncProject({
      cwd: setup.workspace,
      env: setup.env,
      tool: "claude-code",
      sessionId: "explicit-session",
      noPull: true,
    });

    expect(result.code).toBe(0);
    expect(result.sessionId).toBe("explicit-session");
    expect(result.context).toContain("[MemorySync] project=checkout-service version=0.4.0");
    expect(result.context).toContain("## 项目核心约束");
    expect(result.context).toContain("购物车合并逻辑");
    expect(result.context).toContain("并发压测");

    const journals = await listJournals(setup.projectDir);
    const sessions = await Promise.all(journals.map((path) => readJournal(path)));
    expect(sessions.map((record) => record.session)).toContain("explicit-session");
    expect(
      await readFile(
        join(setup.workspace, ".memsync", "sessions", "current-claude-code.json"),
        "utf8",
      ),
    ).toContain("explicit-session");

    const cached = await readCachedPack(setup.env, SLUG);
    expect(cached?.text).toBe(result.context);
    expect(cached?.syncedAt).toBeTruthy();

    const seen = await readSeen(setup.env);
    const key = seenKey(SLUG, EMAIL, HOST, "claude-code");
    expect(seen[key]).toBeTruthy();
  });

  it("prepends changes since the seen cursor", async () => {
    const setup = await makeSetup();
    await createJournal({
      projectDir: setup.projectDir,
      project: SLUG,
      user: "bob",
      email: "bob@corp.com",
      host: HOST,
      tool: "codex",
      session: "bob-session",
      workspace: setup.workspace,
      baseCommit: "unknown",
    });
    await writeSessionSummary(setup.projectDir, "bob-session", {
      outcome: "completed",
      summary: "修复登录令牌刷新",
    });

    const key = seenKey(SLUG, EMAIL, HOST, "claude-code");
    await saveSeen(setup.env, { [key]: "2000-01-01T00:00:00.000Z" });

    const result = await syncProject({ cwd: setup.workspace, env: setup.env, noPull: true });

    expect(result.context).toContain("## 自你上次会话以来");
    expect(result.context).toContain("修复登录令牌刷新");
    const seen = await readSeen(setup.env);
    expect(seen[key]).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("falls back to the cached pack when pull fails", async () => {
    const setup = await makeSetup();
    await writeCachedPack(
      setup.env,
      SLUG,
      "缓存中的记忆",
      "2026-11-13T10:00:00.000Z",
    );
    await rm(setup.remote.dir, { recursive: true, force: true });

    const result = await syncProject({ cwd: setup.workspace, env: setup.env });

    expect(result.code).toBe(0);
    expect(result.context).toContain("[memsync] 离线");
    expect(result.context).toContain("2026-11-13T10:00:00.000Z");
    expect(result.context).toContain("缓存中的记忆");
  });

  it("strict mode fails instead of serving cache when pull fails", async () => {
    const setup = await makeSetup();
    await writeCachedPack(
      setup.env,
      SLUG,
      "缓存中的记忆",
      "2026-11-13T10:00:00.000Z",
    );
    await rm(setup.remote.dir, { recursive: true, force: true });

    const result = await syncProject({
      cwd: setup.workspace,
      env: setup.env,
      strict: true,
    });

    expect(result.code).toBe(1);
    expect(result.context).toBeUndefined();
    expect(result.reason).toContain("pull");
  });

  it("uses the local repo and warns when pull fails without a cache", async () => {
    const setup = await makeSetup();
    await addTeamJournals(setup);
    const key = seenKey(SLUG, EMAIL, HOST, "claude-code");
    const prior = "2000-01-01T00:00:00.000Z";
    await saveSeen(setup.env, { [key]: prior });
    await rm(setup.remote.dir, { recursive: true, force: true });

    const result = await syncProject({ cwd: setup.workspace, env: setup.env });

    expect(result.code).toBe(0);
    expect(result.context).toContain("## 当前进度");
    // Without a cache the local repo is still used, but the spec §13 warning
    // must be present whenever the pull failed.
    expect(result.context).toContain("[memsync] 离线");
    expect(result.reason).toContain("pull");
    // A failed pull must not advance a time-based cursor past unpulled journals.
    expect((await readSeen(setup.env))[key]).toBe(prior);
  });

  it("reuses the env/pointer session instead of creating a new one for sync --tool", async () => {
    const setup = await makeSetup();

    const first = await syncProject({
      cwd: setup.workspace,
      env: setup.env,
      tool: "codex",
      noPull: true,
    });
    expect(first.sessionId).toBeDefined();

    const second = await syncProject({
      cwd: setup.workspace,
      env: setup.env,
      tool: "codex",
      noPull: true,
    });
    expect(second.sessionId).toBe(first.sessionId);

    const codexSessions = (
      await Promise.all((await listJournals(setup.projectDir)).map((path) => readJournal(path)))
    ).filter((record) => record.tool === "codex");
    expect(codexSessions).toHaveLength(1);
  });

  it("completes a crashed session during sync, commits it, and reports it", async () => {
    const setup = await makeSetup();
    const old = new Date(Date.now() - 13 * 60 * 60 * 1_000);
    const crashed = await createJournal({
      projectDir: setup.projectDir,
      project: SLUG,
      user: "alice",
      email: EMAIL,
      host: HOST,
      tool: "claude-code",
      session: "crashed-session",
      workspace: setup.workspace,
      baseCommit: "unknown",
      now: old,
    });

    const result = await syncProject({
      cwd: setup.workspace,
      env: setup.env,
      noPull: true,
    });

    expect(result.code).toBe(0);
    const record = await readJournal(crashed.path);
    expect(record.ended).toBeDefined();
    expect(record.outcome).toBe("unknown");
    expect(record.summary_source).toBe("derived");

    const log = await runGit(["log", "-1", "--pretty=%B"], { cwd: setup.repoPath });
    expect(log.stdout).toContain("complete stale sessions");
    expect(log.stdout).toContain("Co-Authored-By: Claude Code <noreply@anthropic.com>");

    const io = makeIo(setup.workspace, setup.env);
    expect(await runCli(["report", "--since", "2d"], io)).toBe(0);
    expect(io.out.join("")).toContain(EMAIL);
  });

  it("consumes the pending-push marker after a successful sync retry", async () => {
    const setup = await makeSetup();
    const markerPath = join(setup.home, "state", "pending-push.json");
    await mkdir(join(setup.home, "state"), { recursive: true });
    await writeFile(
      markerPath,
      `${JSON.stringify({
        repoPath: setup.repoPath,
        at: "2026-11-13T10:00:00.000Z",
        session: "failed-session",
      })}\n`,
      "utf8",
    );

    const before = await getStatus(setup.env, setup.workspace);
    expect(before.pendingPush).toBe(true);
    expect(before.pendingPushSession).toBe("failed-session");
    expect(await readPendingPush(setup.env)).toBeDefined();

    expect(
      (await syncProject({ cwd: setup.workspace, env: setup.env, noPull: true })).code,
    ).toBe(0);

    expect(await readPendingPush(setup.env)).toBeUndefined();
    expect((await getStatus(setup.env, setup.workspace)).pendingPush).toBe(false);
  });
});

describe("state.md-only conflict recovery", () => {
  function stateDocument(note: string): string {
    return [
      "# 当前状态",
      "",
      "<!-- memsync:derived:begin -->",
      "<!-- memsync:derived:end -->",
      "",
      "## 人工备注",
      "",
      note,
      "",
    ].join("\n");
  }

  it("takes either side, rebuilds the derived block, and continues the rebase", async () => {
    const two = await makeTwoClones();
    const projectRel = join("projects", SLUG);

    await mkdir(join(two.a, projectRel), { recursive: true });
    await writeFile(join(two.a, projectRel, "meta.yaml"), META, "utf8");
    await writeFile(join(two.a, projectRel, "state.md"), stateDocument("- base"), "utf8");
    await runGit(["add", "-A"], { cwd: two.a });
    await runGit(["commit", "-m", "chore: seed project"], { cwd: two.a });
    await runGit(["push"], { cwd: two.a });

    await runGit(["pull"], { cwd: two.b });

    const workspace = await mkdtemp(join(tmpdir(), "memsync-conflict-ws-"));
    await writeFile(join(workspace, ".memsync.json"), `{"project":"${SLUG}"}\n`, "utf8");
    const homeB = await mkdtemp(join(tmpdir(), "memsync-conflict-home-"));
    const envB = {
      ...process.env,
      MEMSYNC_HOME: homeB,
      MEMSYS_HOST: HOST,
      MEMSYS_TOOL: "",
    } as NodeJS.ProcessEnv;
    await saveConfig(envB, {
      version: 1,
      repoPath: two.b,
      remoteUrl: two.remote,
      identity: { name: "Alice", email: EMAIL },
      defaultBudgetChars: 12_000,
    });

    // A commits a state-only change (plus an unrelated file); B commits a
    // different state-only change without pulling, so the rebase conflicts.
    await writeFile(join(two.a, projectRel, "state.md"), stateDocument("- from A"), "utf8");
    await mkdir(join(two.a, "org"), { recursive: true });
    await writeFile(join(two.a, "org", "team.txt"), "fresh team memory\n", "utf8");
    await runGit(["add", "-A"], { cwd: two.a });
    await runGit(["commit", "-m", "docs: A state"], { cwd: two.a });
    await runGit(["push"], { cwd: two.a });

    await writeFile(join(two.b, projectRel, "state.md"), stateDocument("- from B"), "utf8");
    await runGit(["add", "-A"], { cwd: two.b });
    await runGit(["commit", "-m", "docs: B state"], { cwd: two.b });

    const result = await syncProject({
      cwd: workspace,
      env: envB,
      noPull: false,
      noMaintenance: true,
    });

    expect(result.code).toBe(0);
    expect(result.reason).toBeUndefined();

    const state = await readFile(join(two.b, projectRel, "state.md"), "utf8");
    expect(state).not.toContain("<<<<<<<");
    expect(state).toContain("<!-- memsync:derived:begin -->");
    expect(state).toContain("当前版本：0.4.0");
    // The unrelated remote file arrived with the pull.
    expect(await readFile(join(two.b, "org", "team.txt"), "utf8")).toBe(
      "fresh team memory\n",
    );

    const gitStatus = await runGit(["status", "--porcelain"], { cwd: two.b });
    expect(gitStatus.stdout).not.toMatch(/^(UU|AA|DD) /m);
  });
});

describe("sync command", () => {
  it("prints the rendered context to stdout", async () => {
    const setup = await makeSetup();
    const io = makeIo(setup.workspace, setup.env);

    const code = await runCli(["sync", "--no-pull"], io);

    expect(code).toBe(0);
    expect(io.out.join("")).toContain("[MemorySync] project=checkout-service");
    expect(io.err.join("")).toBe("");
  });

  it("prints nothing for an unlinked workspace", async () => {
    const setup = await makeSetup();
    const unlinked = await mkdtemp(join(tmpdir(), "memsync-sync-unlinked-"));
    const io = makeIo(unlinked, setup.env);

    const code = await runCli(["sync", "--no-pull"], io);

    expect(code).toBe(0);
    expect(io.out.join("")).toBe("");
  });

  it("exits 1 for --strict when the pull fails", async () => {
    const setup = await makeSetup();
    await rm(setup.remote.dir, { recursive: true, force: true });
    const io = makeIo(setup.workspace, setup.env);

    const code = await runCli(["sync", "--strict"], io);

    expect(code).toBe(1);
    expect(io.out.join("")).toBe("");
    expect(io.err.join("")).toMatch(/pull/i);
  });
});
