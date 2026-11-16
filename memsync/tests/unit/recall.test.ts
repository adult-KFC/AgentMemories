import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recall } from "../../src/core/recall.js";

async function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memsync-recall-"));
}

async function writeFileAt(projectDir: string, relativePath: string, content: string): Promise<void> {
  const full = join(projectDir, ...relativePath.split("/"));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

function longBody(term: string, repetitions: number): string {
  return `${Array.from({ length: repetitions }, () => `${term} 相关的详细说明文字。`).join("\n")}\n`;
}

describe("recall", () => {
  it("returns at most 5 hits of 800 chars by default", async () => {
    const dir = await makeProject();
    await writeFileAt(dir, "constraints.md", longBody("支付", 40));
    for (let index = 0; index < 8; index += 1) {
      await writeFileAt(
        dir,
        `decisions/ADR-000${index}-pay.md`,
        `# ADR ${index}\n\n${longBody("支付", 30)}`,
      );
    }

    const hits = await recall(dir, "支付");
    expect(hits.length).toBeLessThanOrEqual(5);
    expect(hits.every((hit) => hit.snippet.length <= 800)).toBe(true);
    expect(hits.reduce((sum, hit) => sum + hit.snippet.length, 0)).toBeLessThanOrEqual(4000);
  });

  it("ranks exact term and recent journals higher", async () => {
    const dir = await makeProject();
    await writeFileAt(dir, "constraints.md", "# 约束\n\n支付必须走统一网关。\n");
    await writeFileAt(dir, "decisions/ADR-0001-pay.md", "# ADR\n\n支付改版。\n");
    await writeFileAt(
      dir,
      "decisions/ADR-0002-frequent.md",
      "# ADR\n\n支付 支付 支付 支付 支付\n",
    );
    await writeFileAt(
      dir,
      "journal/2026-11/2026-11-13/090000_alice_host_claude-code_aaaaaa.md",
      "---\nstarted: 2026-11-13T09:00:00Z\n---\n\n# 日志\n\n支付联调完成。\n",
    );
    await writeFileAt(
      dir,
      "journal/2020-01/2020-01-01/090000_alice_host_claude-code_bbbbbb.md",
      "---\nstarted: 2020-01-01T09:00:00Z\n---\n\n# 日志\n\n支付联调完成。\n",
    );

    const hits = await recall(dir, "支付");
    const paths = hits.map((hit) => hit.path);

    const constraint = paths.indexOf("constraints.md");
    const frequent = paths.indexOf("decisions/ADR-0002-frequent.md");
    const single = paths.indexOf("decisions/ADR-0001-pay.md");
    expect(constraint).toBeGreaterThanOrEqual(0);
    expect(frequent).toBeGreaterThanOrEqual(0);
    expect(single).toBeGreaterThanOrEqual(0);
    expect(frequent).toBeLessThan(single);
    expect(constraint).toBeLessThan(single);

    const recentJournal = paths.findIndex((path) => path.includes("2026-11-13"));
    const oldJournal = paths.findIndex((path) => path.includes("2020-01-01"));
    expect(recentJournal).toBeGreaterThanOrEqual(0);
    expect(oldJournal).toBeGreaterThanOrEqual(0);
    expect(recentJournal).toBeLessThan(oldJournal);
  });

  it("returns the full matched text with all", async () => {
    const dir = await makeProject();
    const body = `# 记录\n\n${longBody("支付", 80)}`;
    await writeFileAt(dir, "decisions/ADR-0001-pay.md", body);
    for (let index = 2; index <= 7; index += 1) {
      await writeFileAt(dir, `decisions/ADR-000${index}-pay.md`, body);
    }

    const hits = await recall(dir, "支付", { all: true });
    expect(hits.length).toBe(5);
    expect(hits[0].snippet).toBe(body);
    expect(hits[0].snippet.length).toBeGreaterThan(800);
  });

  it("searches archives but reports them as archive hits", async () => {
    const dir = await makeProject();
    await writeFileAt(dir, "archive/2024/old-checkout.md", "# 旧决策\n\n支付渠道下线。\n");

    const hits = await recall(dir, "支付");
    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe("archive");
    expect(hits[0].path).toBe("archive/2024/old-checkout.md");
    expect(hits[0].snippet).toContain("支付渠道下线");
  });

  it("uses the body prefix when only the filename matches", async () => {
    const dir = await makeProject();
    const body = `# 支付网关\n\n${"正文内容没有查询词。".repeat(80)}`;
    await writeFileAt(dir, "decisions/ADR-0003-payment.md", body);

    const hits = await recall(dir, "payment");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet.startsWith("# 支付网关")).toBe(true);
    expect(hits[0].snippet.length).toBeLessThanOrEqual(800);
  });

  it("searches versions and proposals as separate types", async () => {
    const dir = await makeProject();
    await writeFileAt(dir, "versions/0.4.0.md", "# 版本 0.4.0\n\n支付拆分完成。\n");
    await writeFileAt(
      dir,
      "proposals/2026-11-01-abcd1234.md",
      "---\nid: 2026-11-01-abcd1234\ncreated: 2026-11-01T10:00:00Z\n---\n\n支付网关调整提案。\n",
    );

    const hits = await recall(dir, "支付");
    expect(hits.map((hit) => hit.type).sort()).toEqual(["proposal", "version"]);
    const version = hits.find((hit) => hit.type === "version");
    expect(version?.path).toBe("versions/0.4.0.md");
  });

  it("includes org/conventions.md in the search space", async () => {
    const repo = await makeProject();
    const projectDir = join(repo, "projects", "checkout-service");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(repo, "org"), { recursive: true });
    await writeFile(
      join(repo, "org", "conventions.md"),
      "# 团队通用规范\n\n- MUST 所有服务统一接入 IDL 网关。\n",
      "utf8",
    );
    await writeFileAt(projectDir, "constraints.md", "# 约束\n\n禁止直连数据库。\n");

    const hits = await recall(projectDir, "IDL 网关");
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("org/conventions.md");
    expect(hits[0].type).toBe("constraint");
    expect(hits[0].snippet).toContain("IDL 网关");
  });

  it("returns an empty list when nothing matches", async () => {
    const dir = await makeProject();
    await writeFileAt(dir, "constraints.md", "# 约束\n\n禁止直连数据库。\n");

    expect(await recall(dir, "完全不存在的词语")).toEqual([]);
  });
});
