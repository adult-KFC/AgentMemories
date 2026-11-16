import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { runCli, type CliIo } from "../../src/cli.js";
import { gitOrThrow } from "../../src/core/git.js";
import { makeBareRemote } from "../helpers.js";

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

function envFor(home: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", MEMSYNC_HOME: home };
}

interface CommandResult {
  code: number;
  out: string;
  err: string;
}

async function run(home: string, argv: string[], cwd: string = home): Promise<CommandResult> {
  const captured = capture(cwd, envFor(home));
  const code = await runCli(argv, captured.io);
  return { code, out: captured.out.join(""), err: captured.err.join("") };
}

async function setupMemoryHome(): Promise<{ remote: string; home: string }> {
  const bare = await makeBareRemote();
  const home = await mkdtemp(join(tmpdir(), "memsync-governance-home-"));
  const result = await run(home, [
    "init",
    "--remote",
    bare.remote,
    "--name",
    "Alice",
    "--email",
    "alice@corp.com",
  ]);
  expect(result.code).toBe(0);
  return { remote: bare.remote, home };
}

async function setupProject(): Promise<{ home: string; workspace: string; repo: string }> {
  const { home } = await setupMemoryHome();
  const repo = join(home, "repo");

  const added = await run(home, [
    "project",
    "add",
    "checkout-service",
    "--repo",
    "git@git.corp.com:shop/checkout-service.git",
    "--owner",
    "alice@corp.com",
  ]);
  expect(added.code).toBe(0);

  const workspace = await mkdtemp(join(tmpdir(), "memsync-governance-workspace-"));
  await gitOrThrow(["init"], { cwd: workspace });
  await gitOrThrow(["config", "user.name", "Test User"], { cwd: workspace });
  await gitOrThrow(["config", "user.email", "test@example.com"], { cwd: workspace });
  expect((await run(home, ["link", "checkout-service"], workspace)).code).toBe(0);

  return { home, workspace, repo };
}

async function proposalIds(home: string): Promise<string[]> {
  const dir = join(home, "repo", "projects", "checkout-service", "proposals");
  return (await readdir(dir))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3));
}

describe("memsync governance workflow", () => {
  it("proposes, approves, applies, and verifies a constraint change", async () => {
    const { home, workspace, repo } = await setupProject();

    const proposed = await run(
      home,
      [
        "propose",
        "constraint",
        "--title",
        "禁止 domain 直接 HTTP",
        "--section",
        "禁止",
        "--op",
        "add",
        "--item",
        "MUST NOT call HTTP directly from domain",
        "--rationale",
        "Domain 层必须与传输解耦",
      ],
      workspace,
    );
    expect(proposed.code).toBe(0);
    expect(proposed.out).toMatch(/proposal/i);

    const ids = await proposalIds(home);
    expect(ids).toHaveLength(1);
    const [id] = ids;

    const approved = await run(home, ["approve", id], workspace);
    expect(approved.code).toBe(0);

    const constraints = await readFile(
      join(repo, "projects", "checkout-service", "constraints.md"),
      "utf8",
    );
    expect(constraints).toContain("- MUST NOT call HTTP directly from domain");

    const message = await gitOrThrow(["log", "-1", "--pretty=%B", "HEAD~1"], { cwd: repo });
    expect(message).toContain("Memsync-Approved-By: alice@corp.com");
    expect(message).toContain("Co-Authored-By: Claude Code <noreply@anthropic.com>");

    const proposal = await readFile(
      join(repo, "projects", "checkout-service", "proposals", `${id}.md`),
      "utf8",
    );
    expect(proposal).toMatch(/^status: approved$/m);
    const approvalCommit = await gitOrThrow(["rev-parse", "--short", "HEAD~1"], { cwd: repo });
    expect(proposal).toContain(`- 提交：${approvalCommit}`);

    expect((await run(home, ["verify"], workspace)).code).toBe(0);
  });

  it("rejects approval when the constraints section changed after proposal", async () => {
    const { home, workspace, repo } = await setupProject();

    expect(
      (
        await run(
          home,
          [
            "propose",
            "constraint",
            "--title",
            "Add rule",
            "--section",
            "禁止",
            "--op",
            "add",
            "--item",
            "MUST NOT bypass approval",
          ],
          workspace,
        )
      ).code,
    ).toBe(0);
    const [id] = await proposalIds(home);

    const constraintsPath = join(repo, "projects", "checkout-service", "constraints.md");
    const current = await readFile(constraintsPath, "utf8");
    await writeFile(
      constraintsPath,
      current.replace("## 禁止\n", "## 禁止\n\n- MUST NOT edit directly\n"),
      "utf8",
    );

    const approved = await run(home, ["approve", id], workspace);
    expect(approved.code).toBe(1);
    expect(approved.err).toMatch(/hash/i);

    const constraints = await readFile(constraintsPath, "utf8");
    expect(constraints).not.toContain("MUST NOT bypass approval");
  });

  it("approves a decision proposal by creating an ADR", async () => {
    const { home, workspace, repo } = await setupProject();

    const proposed = await run(
      home,
      [
        "propose",
        "decision",
        "--title",
        "采用 PostgreSQL",
        "--rationale",
        "团队已有运维经验",
      ],
      workspace,
    );
    expect(proposed.code).toBe(0);
    const [id] = await proposalIds(home);

    expect((await run(home, ["approve", id], workspace)).code).toBe(0);

    const decisions = await readdir(join(repo, "projects", "checkout-service", "decisions"));
    const adr = decisions.find((name) => /^ADR-0001-.*\.md$/.test(name));
    expect(adr).toBeDefined();

    const content = await readFile(
      join(repo, "projects", "checkout-service", "decisions", adr!),
      "utf8",
    );
    expect(content).toContain("采用 PostgreSQL");
    expect(content).toContain("团队已有运维经验");
  });

  it("creates and approves an org conventions proposal with governance owners", async () => {
    const { home, workspace, repo } = await setupProject();

    await writeFile(
      join(repo, "org", "governance.yaml"),
      "owners:\n  - alice@corp.com\n",
      "utf8",
    );
    await gitOrThrow(["add", "--", "org/governance.yaml"], { cwd: repo });
    await gitOrThrow(["commit", "-m", "chore: set org owners"], { cwd: repo });

    const proposed = await run(
      home,
      [
        "propose",
        "constraint",
        "--file",
        "org/conventions.md",
        "--title",
        "Team-wide rule",
        "--section",
        "必须",
        "--op",
        "add",
        "--item",
        "MUST follow org conventions",
      ],
      workspace,
    );
    expect(proposed.code).toBe(0);

    const [id] = await proposalIds(home);
    expect((await run(home, ["approve", id], workspace)).code).toBe(0);

    const conventions = await readFile(join(repo, "org", "conventions.md"), "utf8");
    expect(conventions).toContain("- MUST follow org conventions");
    expect((await run(home, ["verify"], workspace)).code).toBe(0);
  });

  it("rejects an unsupported --file path", async () => {
    const { home, workspace } = await setupProject();

    const result = await run(
      home,
      [
        "propose",
        "constraint",
        "--file",
        "org/other.md",
        "--title",
        "Bad target",
        "--section",
        "必须",
        "--op",
        "add",
        "--item",
        "MUST X",
      ],
      workspace,
    );

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/--file/);
  });

  it("fails clearly for an unknown proposal and an unlinked workspace", async () => {
    const { home, workspace } = await setupProject();

    const unknown = await run(home, ["approve", "2026-01-01-deadbeef"], workspace);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/unknown/i);

    const unlinked = await mkdtemp(join(tmpdir(), "memsync-unlinked-"));
    await gitOrThrow(["init"], { cwd: unlinked });
    const verified = await run(home, ["verify"], unlinked);
    expect(verified.code).toBe(1);
    expect(verified.err).toMatch(/link/i);
  });

  it("verify reports a direct constraint edit with its commit", async () => {
    const { home, workspace, repo } = await setupProject();

    const constraintsPath = join(repo, "projects", "checkout-service", "constraints.md");
    await writeFile(
      constraintsPath,
      `${await readFile(constraintsPath, "utf8")}- MUST NOT edit directly\n`,
      "utf8",
    );
    await gitOrThrow(["add", "--", "projects/checkout-service/constraints.md"], { cwd: repo });
    await gitOrThrow(["commit", "-m", "chore: direct edit"], { cwd: repo });
    const sha = await gitOrThrow(["rev-parse", "HEAD"], { cwd: repo });

    const verified = await run(home, ["verify"], workspace);
    expect(verified.code).toBe(1);
    expect(verified.err).toContain(sha);
    expect(verified.err).toContain("projects/checkout-service/constraints.md");
  });

  it("verify reports a malformed journal with its path and exits 1", async () => {
    const { home, workspace, repo } = await setupProject();
    const journalDir = join(
      repo,
      "projects",
      "checkout-service",
      "journal",
      "2026-11",
      "2026-11-13",
    );
    await mkdir(journalDir, { recursive: true });
    const malformed = join(journalDir, "090000_alice_host_claude-code_aaaaaa.md");
    await writeFile(malformed, "---\nid: [unclosed\n---\n\nbody\n", "utf8");

    const verified = await run(home, ["verify"], workspace);

    expect(verified.code).toBe(1);
    expect(verified.err).toMatch(/invalid journal/i);
    expect(verified.err).toContain("090000_alice_host_claude-code_aaaaaa.md");
  });

  it("verify reports a journal whose filename breaks the naming convention", async () => {
    const { home, workspace, repo } = await setupProject();
    const journalDir = join(
      repo,
      "projects",
      "checkout-service",
      "journal",
      "2026-11",
      "2026-11-13",
    );
    await mkdir(journalDir, { recursive: true });
    const record = [
      "---",
      "id: aaaaaa",
      "project: checkout-service",
      "user: Alice Kim",
      "email: alice@corp.com",
      "host: win-claude",
      "tool: claude-code",
      "session: session-1",
      "started: 2026-11-13T09:00:00+08:00",
      "workspace: /workspace",
      "base_commit: abc1234",
      "commits: []",
      "files_changed: 0",
      "insertions: 0",
      "deletions: 0",
      "outcome: completed",
      "summary_source: derived",
      "---",
      "",
      "## 工作摘要",
      "",
      "work",
      "",
    ].join("\n");
    await writeFile(join(journalDir, "wrong-name.md"), record, "utf8");

    const verified = await run(home, ["verify"], workspace);

    expect(verified.code).toBe(1);
    expect(verified.err).toMatch(/naming convention/i);
    // The expected name uses the email local part (§8.8).
    expect(verified.err).toContain("090000_alice_win-claude_claude-code_aaaaaa.md");
  });

  it("stores the structured change block and front matter in the proposal", async () => {
    const { home, workspace, repo } = await setupProject();

    await run(
      home,
      [
        "propose",
        "constraint",
        "--title",
        "Add API scope",
        "--section",
        "必须",
        "--op",
        "add",
        "--item",
        "MUST X",
        "--applies-when",
        "API",
      ],
      workspace,
    );

    const [id] = await proposalIds(home);
    const raw = await readFile(
      join(repo, "projects", "checkout-service", "proposals", `${id}.md`),
      "utf8",
    );
    const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    expect(frontMatter).not.toBeNull();
    expect(parse(frontMatter![1])).toMatchObject({
      id,
      kind: "constraint",
      project: "checkout-service",
      status: "proposed",
    });

    const block = /```yaml\n([\s\S]*?)```/.exec(raw);
    expect(block).not.toBeNull();
    const parsed = parse(block![1]) as {
      change: { section: string; op: string; section_hash: string; items: unknown[] };
    };
    expect(parsed.change.section).toBe("必须");
    expect(parsed.change.op).toBe("add");
    expect(parsed.change.section_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(parsed.change.items).toEqual([{ text: "MUST X", appliesWhen: "API" }]);
  });
});
