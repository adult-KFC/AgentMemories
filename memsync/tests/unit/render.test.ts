import { describe, expect, it } from "vitest";
import {
  parseConstraintMarkdown,
  renderContextPack,
  type RenderInput,
} from "../../src/core/render.js";
import type { ComputedState, OpenItem } from "../../src/core/state.js";

const CONSTRAINTS = `# 核心约束（权威）

## 必须

- MUST 所有对外接口使用 internal/contract 中的 IDL
  - 适用：所有对外 HTTP/RPC 接口
  - 例外：legacy-report 模块
  - 状态：active
- MUST 已被取代的旧约束
  - 状态：superseded

## 禁止

- MUST NOT 在 domain 层直接调用第三方 HTTP 客户端

## 架构

- 服务分层：api → application → domain → infra
- 跨服务通信只允许同步 HTTP 与异步事件两种形式

## 常用命令

- 构建：pnpm build
`;

const CONVENTIONS = `# 团队通用规范

## 必须

- MUST 所有代码变更走 MR，不直接推 main
- MUST 提交信息使用 conventional commits

## 禁止

- MUST NOT 在日志中输出用户手机号
`;

const STATE: ComputedState = {
  version: "0.4.0",
  versionStatus: "active",
  inProgress: [
    {
      user: "alice",
      email: "alice@corp.com",
      date: "2026-11-13",
      text: "购物车合并逻辑",
      sessionId: "session-a",
    },
  ],
  blockers: [
    {
      user: "bob",
      email: "bob@corp.com",
      date: "2026-11-12",
      text: "支付重试等待库存服务接口确认",
      sessionId: "session-b",
    },
  ],
  recentlyDone: [
    {
      user: "bob",
      email: "bob@corp.com",
      date: "2026-11-12",
      summary: "完成库存接口联调",
      sessionId: "session-c",
    },
  ],
  openItems: [],
};

function ownItems(count: number): OpenItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: index % 2 === 0 ? ("todo" as const) : ("handoff" as const),
    text: `未完成事项 ${index}`,
    date: "2026-11-13",
    user: "alice",
    email: "alice@corp.com",
    sessionId: "session-a",
  }));
}

function fixture(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    project: {
      slug: "checkout-service",
      name: "结算服务",
      version: "0.4.0",
      versionStatus: "active",
    },
    syncedAt: "2026-11-13T16:10:00+08:00",
    budgetChars: 12_000,
    orgConventions: CONVENTIONS,
    constraints: CONSTRAINTS,
    state: STATE,
    changesSinceSeen: [
      {
        date: "11-13",
        user: "bob",
        summary: "完成库存接口联调；决策：重试上限 3 次",
      },
    ],
    ownItems: ownItems(2),
    recentAdrs: [
      { title: "ADR-0002 支付重试策略", conclusion: "重试上限为 3 次。" },
      { title: "ADR-0001 服务分层", conclusion: "采用 api → application → domain → infra。" },
    ],
    indexPaths: [
      "org/conventions.md",
      "projects/checkout-service/constraints.md",
      "projects/checkout-service/state.md",
      "projects/checkout-service/decisions/",
      "projects/checkout-service/journal/",
      "projects/checkout-service/versions/",
    ],
    ...overrides,
  };
}

describe("renderContextPack", () => {
  it("renders sections in priority order", () => {
    const out = renderContextPack(fixture({ budgetChars: 12_000 }));

    expect(out.sections[0]).toBe("identity");
    expect(out.text.indexOf("## 团队规范（摘要）")).toBeLessThan(
      out.text.indexOf("## 项目核心约束"),
    );
    expect(out.text.indexOf("## 项目核心约束")).toBeLessThan(
      out.text.indexOf("## 当前进度"),
    );
    expect(out.text.indexOf("## 当前进度")).toBeLessThan(
      out.text.indexOf("## 自你上次会话以来"),
    );
    expect(out.text.indexOf("## 自你上次会话以来")).toBeLessThan(
      out.text.indexOf("## 你的未完成事项"),
    );
    expect(out.text.indexOf("## 你的未完成事项")).toBeLessThan(
      out.text.indexOf("## 最近决策"),
    );
    expect(out.text.indexOf("## 最近决策")).toBeLessThan(out.text.indexOf("## 写回方式"));
    expect(out.text.indexOf("## 写回方式")).toBeLessThan(out.text.indexOf("## 参考索引"));
    expect(out.truncated).toBe(false);
  });

  it("starts with the identity line", () => {
    const out = renderContextPack(fixture());
    const [first] = out.text.split("\n");

    expect(first).toContain("[MemorySync]");
    expect(first).toContain("project=checkout-service");
    expect(first).toContain("version=0.4.0");
    expect(first).toContain("synced=2026-11-13T16:10:00+08:00");
  });

  it("truncates low-priority sections first and leaves a pointer", () => {
    const out = renderContextPack(fixture({ budgetChars: 250 }));

    expect(out.truncated).toBe(true);
    expect(out.text).toContain("memsync recall");
    expect(out.text.length).toBeLessThanOrEqual(250 + 200);
  });

  it("honours the 24,000 character hard cap", () => {
    const longConstraints = [
      "# 核心约束（权威）",
      "",
      "## 必须",
      "",
      ...Array.from({ length: 200 }, (_, index) => `- MUST 约束条目 ${index} ${"x".repeat(200)}`),
    ].join("\n");

    const out = renderContextPack(
      fixture({ budgetChars: 100_000, constraints: longConstraints }),
    );

    expect(out.text.length).toBeLessThanOrEqual(24_000 + 200);
    expect(out.truncated).toBe(true);
  });

  it("renders applicability sub-items with their parent and skips superseded entries", () => {
    const out = renderContextPack(fixture());

    expect(out.text).toContain("- MUST 所有对外接口使用 internal/contract 中的 IDL");
    expect(out.text).toContain("  - 适用：所有对外 HTTP/RPC 接口");
    expect(out.text).toContain("  - 例外：legacy-report 模块");
    expect(out.text).not.toContain("已被取代的旧约束");
    expect(out.text).toContain("- MUST NOT 在 domain 层直接调用第三方 HTTP 客户端");
  });

  it("renders org convention applicability and exception sub-items", () => {
    const conventions = `# 团队通用规范

## 必须

- MUST 生产日志必须脱敏
  - 适用：所有生产环境日志
  - 例外：本地调试构建
  - 状态：active

## 禁止

- MUST NOT 在日志中输出用户手机号
`;

    const out = renderContextPack(fixture({ orgConventions: conventions }));

    expect(out.text).toContain("- MUST 生产日志必须脱敏");
    expect(out.text).toContain("  - 适用：所有生产环境日志");
    expect(out.text).toContain("  - 例外：本地调试构建");
    expect(out.text).toContain("- MUST NOT 在日志中输出用户手机号");
  });

  it("limits changes to 8 items of at most 300 characters each", () => {
    const changes = Array.from({ length: 12 }, (_, index) => ({
      date: "11-13",
      user: "bob",
      summary: `变化 ${index} ${"y".repeat(400)}`,
    }));

    const out = renderContextPack(fixture({ changesSinceSeen: changes }));
    const lines = out.text.split("\n").filter((line) => line.startsWith("- 11-13 bob"));

    expect(lines).toHaveLength(8);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(300);
  });

  it("limits own unfinished items to 5", () => {
    const out = renderContextPack(fixture({ ownItems: ownItems(9) }));
    const lines = out.text.split("\n").filter((line) => line.startsWith("- [ ]"));

    expect(lines).toHaveLength(5);
  });

  it("limits recent ADRs to 3", () => {
    const out = renderContextPack(
      fixture({
        recentAdrs: Array.from({ length: 5 }, (_, index) => ({
          title: `ADR-000${index + 1} 决策 ${index}`,
          conclusion: `结论 ${index}。`,
        })),
      }),
    );
    const lines = out.text.split("\n").filter((line) => line.startsWith("- ADR-"));

    expect(lines).toHaveLength(3);
  });

  it("includes the fixed write-back instructions", () => {
    const out = renderContextPack(fixture());

    expect(out.text).toContain('memsync note progress "..."');
    expect(out.text).toContain('memsync note decision "..."');
    expect(out.text).toContain("memsync propose constraint");
    expect(out.text).toContain('memsync recall "关键词"');
  });
});

describe("parseConstraintMarkdown", () => {
  it("parses must/must-not/architecture sections and status sub-items", () => {
    const doc = parseConstraintMarkdown(CONSTRAINTS);

    expect(doc.must).toHaveLength(2);
    expect(doc.must[0]).toMatchObject({
      text: "MUST 所有对外接口使用 internal/contract 中的 IDL",
      status: "active",
    });
    expect(doc.must[0]?.details).toEqual([
      "适用：所有对外 HTTP/RPC 接口",
      "例外：legacy-report 模块",
      "状态：active",
    ]);
    expect(doc.must[1]?.status).toBe("superseded");
    expect(doc.mustNot[0]?.text).toBe("MUST NOT 在 domain 层直接调用第三方 HTTP 客户端");
    expect(doc.architecture).toHaveLength(2);
    expect(doc.commands).toEqual(["构建：pnpm build"]);
  });
});
