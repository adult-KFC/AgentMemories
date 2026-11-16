import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import {
  applyConstraintChange,
  parseConstraintSections,
  sectionHash,
  type ConstraintChange,
} from "../../src/core/constraints.js";
import {
  approveProposal,
  createProposal,
  verifyConstraintHistory,
} from "../../src/core/proposals.js";
import { gitOrThrow, runGit } from "../../src/core/git.js";
import { parseFrontMatter } from "../../src/core/schema.js";
import type { Identity } from "../../src/types.js";

const TRAILER = "Co-Authored-By: Claude Code <noreply@anthropic.com>";

const CONSTRAINT_TEXT = `# 核心约束（权威）

## 必须

- MUST keep audit trail

## 禁止

- MUST NOT call HTTP directly

## 架构

## 常用命令
`;

const alice: Identity = { name: "Alice", email: "alice@corp.com" };
const bob: Identity = { name: "Bob", email: "bob@corp.com" };

interface Fixture {
  root: string;
  repo: string;
  dir: string;
  constraintsPath: string;
}

async function commitAll(repo: string, message: string): Promise<string> {
  await gitOrThrow(["add", "-A"], { cwd: repo });
  await gitOrThrow(["commit", "-m", message], { cwd: repo });
  return gitOrThrow(["rev-parse", "HEAD"], { cwd: repo });
}

async function makeFixture(options: {
  constraints?: string;
  governanceOwners?: string[];
  governanceText?: string;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "memsync-governance-"));
  const repo = join(root, "repo");
  const dir = join(repo, "projects", "checkout-service");
  await mkdir(join(dir, "proposals"), { recursive: true });
  await mkdir(join(dir, "decisions"), { recursive: true });

  await gitOrThrow(["init"], { cwd: repo });
  await gitOrThrow(["config", "user.name", "Alice"], { cwd: repo });
  await gitOrThrow(["config", "user.email", alice.email], { cwd: repo });
  await gitOrThrow(["config", "core.autocrlf", "false"], { cwd: repo });

  await writeFile(
    join(dir, "meta.yaml"),
    stringify({
      slug: "checkout-service",
      repos: ["git@git.corp.com:shop/checkout-service.git"],
      owners: [alice.email],
      current_version: "0.1.0",
      maintenance: { interval_hours: 72, cooldown_hours: 6, mainline_only: true },
    }),
    "utf8",
  );
  await writeFile(join(dir, "constraints.md"), options.constraints ?? CONSTRAINT_TEXT, "utf8");

  if (options.governanceOwners !== undefined) {
    await mkdir(join(repo, "org"), { recursive: true });
    await writeFile(
      join(repo, "org", "conventions.md"),
      options.governanceText ?? CONSTRAINT_TEXT,
      "utf8",
    );
    await writeFile(
      join(repo, "org", "governance.yaml"),
      stringify({ owners: options.governanceOwners }),
      "utf8",
    );
  }

  await commitAll(repo, "chore: seed project");
  return { root, repo, dir, constraintsPath: join(dir, "constraints.md") };
}

function hashFor(text: string, section = "禁止"): string {
  const sections = parseConstraintSections(text);
  const body = sections.get(section);
  if (body === undefined) throw new Error(`missing section ${section}`);
  return sectionHash(body);
}

function baseChange(overrides: Partial<ConstraintChange> = {}): ConstraintChange {
  return {
    file: "constraints.md",
    section: "禁止",
    op: "add",
    section_hash: hashFor(CONSTRAINT_TEXT),
    items: ["MUST NOT call HTTP directly through a helper"],
    ...overrides,
  };
}

function propose(fixture: Fixture, change: ConstraintChange) {
  return createProposal(fixture.dir, {
    kind: "constraint",
    title: "Tighten HTTP rule",
    rationale: "The domain layer must stay transport-free.",
    change,
    author: alice.name,
    tool: "claude-code",
    host: "alice-laptop",
    now: new Date("2026-11-14T10:00:00Z"),
  });
}

describe("constraint parsing and hashing", () => {
  it("splits sections by level-two headings", () => {
    const sections = parseConstraintSections(CONSTRAINT_TEXT);

    expect([...sections.keys()]).toEqual(["必须", "禁止", "架构", "常用命令"]);
    expect(sections.get("禁止")).toContain("- MUST NOT call HTTP directly");
    expect(sections.get("架构")?.trim()).toBe("");
  });

  it("normalizes trailing whitespace and line endings before hashing", () => {
    const a = "- MUST X  \r\n  - 适用：API\r\n\r\n";
    const b = "- MUST X\n  - 适用：API";

    expect(sectionHash(a)).toBe(sectionHash(b));
    expect(sectionHash(a)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("applyConstraintChange", () => {
  it("adds items with applicability and exception sub-bullets", async () => {
    const fixture = await makeFixture();
    const change = baseChange({
      items: [
        { text: "MUST X", appliesWhen: "API", doNotApplyWhen: "legacy-report" },
      ],
    });

    await applyConstraintChange(fixture.constraintsPath, change, "proposal-id", alice.email);

    const text = await readFile(fixture.constraintsPath, "utf8");
    expect(text).toContain("- MUST X");
    expect(text).toContain("  - 适用：API");
    expect(text).toContain("  - 例外：legacy-report");
  });

  it("rejects a stale section hash without touching the file", async () => {
    const fixture = await makeFixture();
    const before = await readFile(fixture.constraintsPath, "utf8");
    const change = baseChange({ section_hash: "deadbeef" });

    await expect(
      applyConstraintChange(fixture.constraintsPath, change, "proposal-id", alice.email),
    ).rejects.toThrow(/hash/i);
    expect(await readFile(fixture.constraintsPath, "utf8")).toBe(before);
  });

  it("rejects a match that is not unique without touching the file", async () => {
    const duplicate = CONSTRAINT_TEXT.replace(
      "## 架构",
      "- MUST NOT call HTTP directly\n\n## 架构",
    );
    const fixture = await makeFixture({ constraints: duplicate });
    const before = await readFile(fixture.constraintsPath, "utf8");
    const change = baseChange({
      op: "replace",
      section_hash: hashFor(duplicate),
      match: "- MUST NOT call HTTP directly",
      items: ["MUST NOT call HTTP directly v2"],
    });

    await expect(
      applyConstraintChange(fixture.constraintsPath, change, "proposal-id", alice.email),
    ).rejects.toThrow(/match/i);
    expect(await readFile(fixture.constraintsPath, "utf8")).toBe(before);
  });

  it("replaces exactly the matched item and its sub-bullets", async () => {
    const fixture = await makeFixture();
    const change = baseChange({
      op: "replace",
      match: "- MUST NOT call HTTP directly",
      items: [{ text: "MUST NOT call HTTP through the SDK", appliesWhen: "domain" }],
    });

    await applyConstraintChange(fixture.constraintsPath, change, "proposal-id", alice.email);

    const text = await readFile(fixture.constraintsPath, "utf8");
    expect(text).not.toContain("- MUST NOT call HTTP directly\n");
    expect(text).toContain("- MUST NOT call HTTP through the SDK");
    expect(text).toContain("  - 适用：domain");
  });
});

describe("proposals and approval", () => {
  it("writes a proposal with the computed section hash and required sections", async () => {
    const fixture = await makeFixture();
    const created = await propose(fixture, baseChange({ section_hash: "" }));

    expect(created.id).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(created.path).toBe(join(fixture.dir, "proposals", `${created.id}.md`));

    const raw = await readFile(created.path, "utf8");
    const { data, body } = parseFrontMatter<Record<string, unknown>>(raw);
    expect(data).toMatchObject({
      id: created.id,
      kind: "constraint",
      title: "Tighten HTTP rule",
      project: "checkout-service",
      author: "Alice",
      tool: "claude-code",
      host: "alice-laptop",
      status: "proposed",
    });
    expect(typeof data.created).toBe("string");

    expect(body).toContain("## 提案内容");
    expect(body).toContain("## 变更");
    expect(body).toContain("## 理由");
    expect(body).toContain("## 影响面");
    expect(body).toContain("## 批准记录");

    const block = /```yaml\n([\s\S]*?)```/.exec(body);
    expect(block).not.toBeNull();
    const parsed = parse(block![1]) as { change: ConstraintChange };
    expect(parsed.change.section_hash).toBe(hashFor(CONSTRAINT_TEXT));
    expect(parsed.change.items).toEqual(["MUST NOT call HTTP directly through a helper"]);
  });

  it("rejects approval when the section hash is stale", async () => {
    const fixture = await makeFixture();
    const before = await readFile(fixture.constraintsPath, "utf8");
    const created = await propose(fixture, baseChange({ section_hash: "deadbeef" }));

    const result = await approveProposal(fixture.dir, created.id, alice);

    expect(result).toMatchObject({ applied: false, reason: expect.stringMatching(/hash/i) });
    expect(await readFile(fixture.constraintsPath, "utf8")).toBe(before);
  });

  it("blocks a non-owner unless --force is used", async () => {
    const fixture = await makeFixture();
    const created = await propose(fixture, baseChange());
    const before = await readFile(fixture.constraintsPath, "utf8");

    const denied = await approveProposal(fixture.dir, created.id, bob);
    expect(denied).toMatchObject({
      applied: false,
      reason: expect.stringMatching(/owner/i),
    });
    expect(await readFile(fixture.constraintsPath, "utf8")).toBe(before);

    const forced = await approveProposal(fixture.dir, created.id, bob, { force: true });
    expect(forced.applied).toBe(true);

    const text = await readFile(fixture.constraintsPath, "utf8");
    expect(text).toContain("- MUST NOT call HTTP directly through a helper");

    const message = await gitOrThrow(["log", "-1", "--pretty=%B", "HEAD~1"], {
      cwd: fixture.repo,
    });
    expect(message).toContain(`Memsync-Approved-By: ${bob.email}`);
    expect(message).toContain(`Memsync-Forced-By: ${bob.email}`);
    expect(message.trimEnd().endsWith(TRAILER)).toBe(true);

    const raw = await readFile(created.path, "utf8");
    const { data, body } = parseFrontMatter<Record<string, unknown>>(raw);
    expect(data.status).toBe("approved");
    expect(body).toContain("## 批准记录");
    expect(body).toContain(bob.email);
  });

  it("approves as an owner, applies the change, and commits with the trailer", async () => {
    const fixture = await makeFixture();
    const created = await propose(fixture, baseChange());

    const result = await approveProposal(fixture.dir, created.id, alice);

    expect(result.applied).toBe(true);
    expect(await readFile(fixture.constraintsPath, "utf8")).toContain(
      "- MUST NOT call HTTP directly through a helper",
    );
    const message = await gitOrThrow(["log", "-1", "--pretty=%B", "HEAD~1"], {
      cwd: fixture.repo,
    });
    expect(message).toContain(`Memsync-Approved-By: ${alice.email}`);
    expect(message).not.toContain("Memsync-Forced-By:");
    expect(message.trimEnd().endsWith(TRAILER)).toBe(true);

    // The approval record must name the approval commit, not the follow-up
    // record commit, and carry an ISO timestamp.
    const approvalCommit = await gitOrThrow(["rev-parse", "--short", "HEAD~1"], {
      cwd: fixture.repo,
    });
    const recordBody = parseFrontMatter<Record<string, unknown>>(
      await readFile(created.path, "utf8"),
    ).body;
    expect(recordBody).toContain(`- 提交：${approvalCommit}`);
    expect(recordBody).toMatch(
      /- 时间：\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
    );
    const recordSubject = await gitOrThrow(["log", "-1", "--pretty=%s"], {
      cwd: fixture.repo,
    });
    expect(recordSubject).toBe(`docs: record approval ${approvalCommit}`);
    const recordTrailer = await gitOrThrow(["log", "-1", "--pretty=%B"], {
      cwd: fixture.repo,
    });
    expect(recordTrailer.trimEnd().endsWith(TRAILER)).toBe(true);
  });

  it("restores the constraint and proposal when the approval commit fails", async () => {
    const fixture = await makeFixture();
    const created = await propose(fixture, baseChange());
    const proposalBefore = await readFile(created.path, "utf8");
    const constraintsBefore = await readFile(fixture.constraintsPath, "utf8");
    const headBefore = await gitOrThrow(["rev-parse", "HEAD"], { cwd: fixture.repo });

    const lock = join(fixture.repo, ".git", "index.lock");
    await writeFile(lock, "", "utf8");
    try {
      await expect(approveProposal(fixture.dir, created.id, alice)).rejects.toThrow();
    } finally {
      await rm(lock, { force: true });
    }

    expect(await readFile(fixture.constraintsPath, "utf8")).toBe(constraintsBefore);
    expect(await readFile(created.path, "utf8")).toBe(proposalBefore);
    expect(await gitOrThrow(["rev-parse", "HEAD"], { cwd: fixture.repo })).toBe(headBefore);
  });

  it("removes a newly created ADR when a decision approval commit fails", async () => {
    const fixture = await makeFixture();
    const created = await createProposal(fixture.dir, {
      kind: "decision",
      title: "Adopt PostgreSQL",
      rationale: "The team already operates PostgreSQL clusters.",
      author: alice.name,
      tool: "claude-code",
      host: "alice-laptop",
      now: new Date("2026-11-14T10:00:00Z"),
    });
    const proposalBefore = await readFile(created.path, "utf8");
    const decisionsBefore = (await readdir(join(fixture.dir, "decisions"))).sort();
    const headBefore = await gitOrThrow(["rev-parse", "HEAD"], { cwd: fixture.repo });

    const lock = join(fixture.repo, ".git", "index.lock");
    await writeFile(lock, "", "utf8");
    try {
      await expect(approveProposal(fixture.dir, created.id, alice)).rejects.toThrow();
    } finally {
      await rm(lock, { force: true });
    }

    expect((await readdir(join(fixture.dir, "decisions"))).sort()).toEqual(decisionsBefore);
    expect(await readFile(created.path, "utf8")).toBe(proposalBefore);
    expect(await gitOrThrow(["rev-parse", "HEAD"], { cwd: fixture.repo })).toBe(headBefore);
  });

  it("supersedes an item but keeps the old text marked superseded", async () => {
    const fixture = await makeFixture();
    const created = await propose(
      fixture,
      baseChange({
        op: "supersede",
        match: "- MUST NOT call HTTP directly",
        items: [{ text: "MUST NOT call HTTP directly v2", appliesWhen: "all services" }],
      }),
    );

    expect((await approveProposal(fixture.dir, created.id, alice)).applied).toBe(true);

    const text = await readFile(fixture.constraintsPath, "utf8");
    expect(text).toContain("- MUST NOT call HTTP directly\n");
    expect(text).toContain("  - 状态：superseded");
    expect(text).toContain("- MUST NOT call HTTP directly v2");
    expect(text).toContain("  - 适用：all services");
  });

  it("removes the matched item and its sub-bullets", async () => {
    const fixture = await makeFixture();
    const created = await propose(
      fixture,
      baseChange({
        op: "remove",
        match: "- MUST NOT call HTTP directly",
        items: [],
      }),
    );

    expect((await approveProposal(fixture.dir, created.id, alice)).applied).toBe(true);
    const text = await readFile(fixture.constraintsPath, "utf8");
    expect(text).not.toContain("- MUST NOT call HTTP directly");
  });

  it("uses org governance owners for org/conventions.md", async () => {
    const fixture = await makeFixture({
      governanceOwners: ["carol@corp.com"],
      governanceText: CONSTRAINT_TEXT,
    });
    const change = baseChange({
      file: "org/conventions.md",
      section_hash: hashFor(CONSTRAINT_TEXT),
      items: ["MUST share conventions"],
    });
    const created = await propose(fixture, change);

    const denied = await approveProposal(fixture.dir, created.id, alice);
    expect(denied).toMatchObject({
      applied: false,
      reason: expect.stringMatching(/owner/i),
    });

    const carol: Identity = { name: "Carol", email: "Carol@Corp.com" };
    expect((await approveProposal(fixture.dir, created.id, carol)).applied).toBe(true);
    expect(await readFile(join(fixture.repo, "org", "conventions.md"), "utf8")).toContain(
      "- MUST share conventions",
    );
  });

  it("creates the next ADR for an approved decision proposal", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.dir, "decisions", "ADR-0001-bootstrap.md"), "# bootstrap\n", "utf8");
    await commitAll(fixture.repo, "docs: record bootstrap ADR");

    const created = await createProposal(fixture.dir, {
      kind: "decision",
      title: "Adopt PostgreSQL",
      rationale: "The team already operates PostgreSQL clusters.",
      author: alice.name,
      tool: "claude-code",
      host: "alice-laptop",
      now: new Date("2026-11-14T10:00:00Z"),
    });

    expect((await approveProposal(fixture.dir, created.id, alice)).applied).toBe(true);

    const files = (await readdir(join(fixture.dir, "decisions"))).sort();
    expect(files).toContain("ADR-0002-Adopt-PostgreSQL.md");

    const adr = await readFile(
      join(fixture.dir, "decisions", "ADR-0002-Adopt-PostgreSQL.md"),
      "utf8",
    );
    expect(adr).toContain("Adopt PostgreSQL");
    expect(adr).toContain("The team already operates PostgreSQL clusters.");

    const raw = await readFile(created.path, "utf8");
    expect(parseFrontMatter<Record<string, unknown>>(raw).data.status).toBe("approved");
    const message = await gitOrThrow(["log", "-1", "--pretty=%B", "HEAD~1"], {
      cwd: fixture.repo,
    });
    expect(message).toContain(`Memsync-Approved-By: ${alice.email}`);
    const approvalCommit = await gitOrThrow(["rev-parse", "--short", "HEAD~1"], {
      cwd: fixture.repo,
    });
    expect(parseFrontMatter<Record<string, unknown>>(raw).body).toContain(
      `- 提交：${approvalCommit}`,
    );
  });

  it("returns an error result for an unknown proposal", async () => {
    const fixture = await makeFixture();
    const result = await approveProposal(fixture.dir, "2026-11-14-deadbeef", alice);
    expect(result).toMatchObject({
      applied: false,
      reason: expect.stringMatching(/unknown/i),
    });
  });
});

describe("verifyConstraintHistory", () => {
  it("ignores the creation commit but reports a direct edit", async () => {
    const fixture = await makeFixture({
      governanceOwners: [alice.email],
    });

    const directSha = await (async () => {
      const path = fixture.constraintsPath;
      await writeFile(path, `${await readFile(path, "utf8")}- MUST bypass approval\n`, "utf8");
      return commitAll(fixture.repo, "chore: direct constraint edit");
    })();

    const issues = await verifyConstraintHistory(fixture.repo, "checkout-service");
    expect(issues).toEqual([
      { commit: directSha, file: "projects/checkout-service/constraints.md" },
    ]);

    await writeFile(
      fixture.constraintsPath,
      `${await readFile(fixture.constraintsPath, "utf8")}- MUST be approved\n`,
      "utf8",
    );
    await commitAll(
      fixture.repo,
      `feat: approved constraint\n\nMemsync-Approved-By: ${alice.email}\n\n${TRAILER}`,
    );

    // The approved commit adds no new issue, but the older direct edit remains.
    expect(await verifyConstraintHistory(fixture.repo, "checkout-service")).toEqual([
      { commit: directSha, file: "projects/checkout-service/constraints.md" },
    ]);
  });

  it("accepts an edit commit that carries the approval trailer", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.constraintsPath,
      `${await readFile(fixture.constraintsPath, "utf8")}- MUST be approved\n`,
      "utf8",
    );
    await commitAll(
      fixture.repo,
      `feat: approved constraint\n\nMemsync-Approved-By: ${alice.email}\n\n${TRAILER}`,
    );

    expect(await verifyConstraintHistory(fixture.repo, "checkout-service")).toEqual([]);
  });

  it("reports direct edits to org/conventions.md too", async () => {
    const fixture = await makeFixture({
      governanceOwners: [alice.email],
    });
    const conventionsPath = join(fixture.repo, "org", "conventions.md");
    await writeFile(
      conventionsPath,
      `${await readFile(conventionsPath, "utf8")}- MUST not edit org rules directly\n`,
      "utf8",
    );
    const sha = await commitAll(fixture.repo, "chore: direct org edit");

    const issues = await verifyConstraintHistory(fixture.repo, "checkout-service");
    expect(issues).toEqual([{ commit: sha, file: "org/conventions.md" }]);
  });

  it("returns no issues when a constraint file has a single creation commit", async () => {
    const fixture = await makeFixture();
    expect(await verifyConstraintHistory(fixture.repo, "checkout-service")).toEqual([]);
  });

  it("does not treat the creation commit of a later-added file as an issue", async () => {
    const fixture = await makeFixture();
    const conventionsPath = join(fixture.repo, "org", "conventions.md");
    await mkdir(join(fixture.repo, "org"), { recursive: true });
    await writeFile(conventionsPath, CONSTRAINT_TEXT, "utf8");
    await commitAll(fixture.repo, "chore: add org conventions");

    const issues = await verifyConstraintHistory(fixture.repo, "checkout-service");
    expect(issues).toEqual([]);
  });
});
