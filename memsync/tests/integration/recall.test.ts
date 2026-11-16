import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli, type CliIo } from "../../src/cli.js";

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
  projectDir: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

async function writeFileAt(projectDir: string, relativePath: string, content: string): Promise<void> {
  const full = join(projectDir, ...relativePath.split("/"));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function setupProject(): Promise<Setup> {
  const home = await mkdtemp(join(tmpdir(), "memsync-recall-home-"));
  const projectDir = join(home, "repo", "projects", "checkout-service");
  const workspace = await mkdtemp(join(tmpdir(), "memsync-recall-ws-"));

  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
  await writeFile(
    join(workspace, ".memsync.json"),
    '{"project":"checkout-service"}\n',
    "utf8",
  );

  return { home, projectDir, workspace, env: { MEMSYNC_HOME: home } };
}

async function run(setup: Setup, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const captured = capture(setup.workspace, setup.env);
  const code = await runCli(argv, captured.io);
  return { code, out: captured.out.join(""), err: captured.err.join("") };
}

describe("memsync recall", () => {
  it("prints ranked hits with path, type, date, and snippet", async () => {
    const setup = await setupProject();
    await writeFileAt(
      setup.projectDir,
      "constraints.md",
      "# 约束\n\n支付必须走统一网关。\n",
    );
    await writeFileAt(
      setup.projectDir,
      "decisions/ADR-0001-pay.md",
      "# ADR-0001: 改造历史\n\n支付服务拆分。\n",
    );
    await writeFileAt(
      setup.projectDir,
      "archive/2024/old-pay.md",
      "# 旧记录\n\n支付网关迁移历史。\n",
    );

    const result = await run(setup, ["recall", "支付"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("constraints.md (constraint, ");
    expect(result.out).toContain("支付必须走统一网关");
    expect(result.out).toContain("decisions/ADR-0001-pay.md (decision, ");
    expect(result.out).toContain("archive/2024/old-pay.md (archive, ");
    const constraintIndex = result.out.indexOf("constraints.md");
    const decisionIndex = result.out.indexOf("decisions/ADR-0001-pay.md");
    expect(constraintIndex).toBeGreaterThanOrEqual(0);
    expect(constraintIndex).toBeLessThan(decisionIndex);
  });

  it("honours --limit and --all", async () => {
    const setup = await setupProject();
    const body = `# 记录\n\n${"支付".repeat(600)}\n`;
    for (let index = 1; index <= 6; index += 1) {
      await writeFileAt(setup.projectDir, `decisions/ADR-000${index}-pay.md`, body);
    }

    const limited = await run(setup, ["recall", "支付", "--limit", "2"]);
    expect(limited.code).toBe(0);
    expect(limited.out.match(/\(decision, /g)).toHaveLength(2);

    const full = await run(setup, ["recall", "支付", "--all", "--limit", "1"]);
    expect(full.code).toBe(0);
    expect(full.out).toContain(body.trim());
  });

  it("prints No matches. and exits 0 on an empty result", async () => {
    const setup = await setupProject();
    await writeFileAt(setup.projectDir, "constraints.md", "# 约束\n\n禁止直连数据库。\n");

    const result = await run(setup, ["recall", "不存在"]);

    expect(result.code).toBe(0);
    expect(result.out).toBe("No matches.\n");
  });

  it("fails with exit 1 when the workspace is not linked to a project", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-recall-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "memsync-recall-ws-"));
    const captured = capture(workspace, { MEMSYNC_HOME: home });

    const code = await runCli(["recall", "支付"], captured.io);

    expect(code).toBe(1);
    expect(captured.err.join("")).toContain("not linked to a project");
  });

  it("fails with exit 1 when the query is missing", async () => {
    const setup = await setupProject();
    const result = await run(setup, ["recall"]);

    expect(result.code).toBe(1);
    expect(result.err.toLowerCase()).toContain("missing required argument");
  });
});
