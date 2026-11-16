import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  gitOrThrowIn,
  initWorkspace,
  makeHome,
  makeMemoryRepo,
  runCliIn,
  type TestHome,
} from "./helpers.js";

const HOUR_MS = 60 * 60 * 1_000;

function proposalId(stdout: string): string {
  const match = /Created proposal ([^\s]+)/.exec(stdout);
  if (match === null) {
    throw new Error(`no proposal id in output: ${stdout}`);
  }
  return match[1];
}

async function writeMaintenanceState(
  home: TestHome,
  slug: string,
  entry: Record<string, string>,
): Promise<void> {
  await mkdir(join(home.home, "state"), { recursive: true });
  await writeFile(
    join(home.home, "state", "maintenance.json"),
    `${JSON.stringify({ [slug]: entry }, null, 2)}\n`,
    "utf8",
  );
}

describe("e2e governance and operations", () => {
  it("scenario 3: direct constraint edits fail verify; propose/approve passes", async () => {
    // Direct edit: the commit is reported by verify.
    const direct = await makeMemoryRepo();
    const constraintsPath = join(direct.project.projectDir, "constraints.md");
    const original = await readFile(constraintsPath, "utf8");
    await writeFile(constraintsPath, `${original}- MUST NOT 直接编辑约束\n`, "utf8");
    await gitOrThrowIn(direct.admin, direct.project.repoPath, [
      "add",
      "--",
      `projects/${direct.project.slug}/constraints.md`,
    ]);
    await gitOrThrowIn(direct.admin, direct.project.repoPath, [
      "commit",
      "-m",
      "chore: direct constraint edit",
    ]);
    const directCommit = await gitOrThrowIn(
      direct.admin,
      direct.project.repoPath,
      ["rev-parse", "HEAD"],
    );

    const failed = await runCliIn(direct.admin, ["verify"], {
      cwd: direct.workspace,
    });
    expect(failed.code).toBe(1);
    expect(failed.err).toContain(directCommit);
    expect(failed.err).toContain(`projects/${direct.project.slug}/constraints.md`);

    // Approved path: propose then approve, and verify stays clean.
    const approved = await makeMemoryRepo();
    const proposed = await runCliIn(
      approved.admin,
      [
        "propose",
        "constraint",
        "--title",
        "禁止绕过审批修改约束",
        "--section",
        "禁止",
        "--op",
        "add",
        "--item",
        "MUST NOT 绕过审批修改约束",
        "--rationale",
        "约束变更必须留痕",
      ],
      { cwd: approved.workspace },
    );
    expect(proposed.code, proposed.err).toBe(0);
    const id = proposalId(proposed.out);

    const approve = await runCliIn(approved.admin, ["approve", id], {
      cwd: approved.workspace,
    });
    expect(approve.code, approve.err).toBe(0);

    const updated = await readFile(
      join(approved.project.projectDir, "constraints.md"),
      "utf8",
    );
    expect(updated).toContain("MUST NOT 绕过审批修改约束");

    const verified = await runCliIn(approved.admin, ["verify"], {
      cwd: approved.workspace,
    });
    expect(verified.code, verified.err).toBe(0);
    expect(verified.out).toMatch(/verified/i);
  }, 90_000);

  it("scenario 10: doctor reports missing credentials, hooks, and capabilities", async () => {
    const home = await makeHome("memsync-e2e-doctor");
    const repoPath = join(home.home, "repo");
    await mkdir(repoPath, { recursive: true });
    await gitOrThrowIn(home, repoPath, ["init"]);
    await gitOrThrowIn(home, repoPath, ["config", "user.name", "Test User"]);
    await gitOrThrowIn(home, repoPath, ["config", "user.email", "test@example.com"]);
    await gitOrThrowIn(home, repoPath, [
      "remote",
      "add",
      "origin",
      join(home.root, "missing.git"),
    ]);

    // A valid config with missing credentials: identity cannot be validated.
    await writeFile(
      join(home.home, "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          repoPath,
          remoteUrl: join(home.root, "missing.git"),
          identity: { name: "", email: "" },
          defaultBudgetChars: 12_000,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCliIn(home, ["doctor"], { cwd: home.workspace });

    expect(result.code).toBe(1);
    expect(result.out).toContain("FAIL  identity");
    expect(result.out).toContain("Identity name is required");
    expect(result.out).toContain("FAIL  git-remote");
    expect(result.out).toContain("missing.git");
    expect(result.out).toContain("FAIL  claude-hooks");
    expect(result.out).toContain("settings not found");
    expect(result.out).toContain("FAIL  codex-capabilities");
    expect(result.out).toContain("run memsync install --tool codex");
  }, 60_000);

  it("scenario 12: recall defaults are bounded and --all returns full text", async () => {
    const team = await makeMemoryRepo();
    const marker = "支付".repeat(1000);
    const body = `${"记录".repeat(500)}${marker}${"尾".repeat(500)}`;

    for (let index = 1; index <= 7; index += 1) {
      await writeFile(
        join(
          team.project.projectDir,
          "decisions",
          `ADR-000${index}-pay.md`,
        ),
        `${body}\n`,
        "utf8",
      );
    }

    const limited = await runCliIn(team.admin, ["recall", "支付"], {
      cwd: team.workspace,
    });
    expect(limited.code, limited.err).toBe(0);

    const blocks = limited.out.trim().split("\n\n");
    expect(blocks).toHaveLength(5);

    let totalSnippetChars = 0;
    for (const block of blocks) {
      const [metadata, ...snippetLines] = block.split("\n");
      expect(metadata).toMatch(/\(decision, /);
      const snippet = snippetLines.join("\n");
      expect(snippet.length).toBeLessThanOrEqual(800);
      totalSnippetChars += snippet.length;
    }
    expect(totalSnippetChars).toBeLessThanOrEqual(4_000);
    // The default view never returns the whole matched document.
    expect(limited.out).not.toContain(marker);

    const full = await runCliIn(team.admin, ["recall", "支付", "--all", "--limit", "1"], {
      cwd: team.workspace,
    });
    expect(full.code, full.err).toBe(0);
    expect(full.out).toContain(marker);
  }, 60_000);

  it("scenario 13: supersede retains the old item for recall and injects applicability", async () => {
    const team = await makeMemoryRepo();
    const oldItem = "MUST NOT 在 domain 层直接调用第三方 HTTP API";
    const newItem = "MUST NOT 在 domain 层直接调用任何外部 API";

    const proposed = await runCliIn(
      team.admin,
      [
        "propose",
        "constraint",
        "--title",
        "收紧 domain 层外部调用",
        "--section",
        "禁止",
        "--op",
        "supersede",
        "--match",
        oldItem,
        "--item",
        newItem,
        "--applies-when",
        "所有服务模块",
        "--do-not-apply-when",
        "本地一次性脚本",
        "--rationale",
        "外部依赖范围扩大",
      ],
      { cwd: team.workspace },
    );
    expect(proposed.code, proposed.err).toBe(0);
    const id = proposalId(proposed.out);

    const approve = await runCliIn(team.admin, ["approve", id], {
      cwd: team.workspace,
    });
    expect(approve.code, approve.err).toBe(0);

    const constraints = await readFile(
      join(team.project.projectDir, "constraints.md"),
      "utf8",
    );
    const oldIndex = constraints.indexOf(oldItem);
    expect(oldIndex).toBeGreaterThanOrEqual(0);
    const oldBlock = constraints.slice(oldIndex).split(/\n-\s/)[0];
    expect(oldBlock).toContain("状态：superseded");
    expect(constraints).toContain(`- ${newItem}`);
    expect(constraints).toContain("  - 适用：所有服务模块");
    expect(constraints).toContain("  - 例外：本地一次性脚本");

    // The pack shows only the new, applicable rule.
    const sync = await runCliIn(team.admin, ["sync", "--no-pull"], {
      cwd: team.workspace,
    });
    expect(sync.code, sync.err).toBe(0);
    expect(sync.out).toContain(newItem);
    expect(sync.out).toContain("  - 适用：所有服务模块");
    expect(sync.out).toContain("  - 例外：本地一次性脚本");
    expect(sync.out).not.toContain(oldItem);

    // The superseded item stays searchable.
    const recalled = await runCliIn(team.admin, ["recall", "直接调用第三方"], {
      cwd: team.workspace,
    });
    expect(recalled.code, recalled.err).toBe(0);
    expect(recalled.out).toContain("constraints.md");
    expect(recalled.out).toContain(oldItem);

    const verified = await runCliIn(team.admin, ["verify"], {
      cwd: team.workspace,
    });
    expect(verified.code, verified.err).toBe(0);
  }, 90_000);

  it("scenario 14: maintenance honours the mainline, interval, and cooldown policy", async () => {
    const team = await makeMemoryRepo();
    const repoPath = team.project.repoPath;
    const slug = team.project.slug;

    const head = await gitOrThrowIn(team.admin, repoPath, ["rev-parse", "origin/main"]);
    const now = new Date();

    const commitMain = async (name: string): Promise<string> => {
      await gitOrThrowIn(team.admin, repoPath, ["checkout", "main"]);
      await writeFile(join(repoPath, name), `${name}\n`, "utf8");
      await gitOrThrowIn(team.admin, repoPath, ["add", "--", name]);
      await gitOrThrowIn(team.admin, repoPath, ["commit", "-m", `chore: ${name}`]);
      await gitOrThrowIn(team.admin, repoPath, ["push", "origin", "main"]);
      return gitOrThrowIn(team.admin, repoPath, ["rev-parse", "HEAD"]);
    };

    const check = async (): Promise<string> => {
      const result = await runCliIn(team.admin, ["maintain", "--check"], {
        cwd: team.workspace,
      });
      expect(result.code, result.err).toBe(0);
      return result.out;
    };

    // Same mainline head: never due, even at the interval boundary.
    await writeMaintenanceState(team.admin, slug, {
      baselineHead: head,
      lastSuccessAt: new Date(now.getTime() - 1 * HOUR_MS).toISOString(),
    });
    expect(await check()).toContain("not due: no new mainline commit");

    // New mainline commit plus an elapsed 72h interval: due.
    const newHead = await commitMain("mainline-change.txt");
    await writeMaintenanceState(team.admin, slug, {
      baselineHead: head,
      lastSuccessAt: new Date(now.getTime() - 73 * HOUR_MS).toISOString(),
    });
    expect(await check()).toContain("due: new mainline commit");

    // A recent failed attempt starts the cooldown.
    await writeMaintenanceState(team.admin, slug, {
      baselineHead: head,
      lastSuccessAt: new Date(now.getTime() - 100 * HOUR_MS).toISOString(),
      lastAttemptAt: new Date(now.getTime() - 1 * HOUR_MS).toISOString(),
    });
    expect(await check()).toContain("not due: maintenance cooldown active");

    // A commit on a non-mainline branch never moves the mainline head.
    await writeMaintenanceState(team.admin, slug, {
      baselineHead: newHead,
      lastSuccessAt: new Date(now.getTime() - 1 * HOUR_MS).toISOString(),
    });
    await gitOrThrowIn(team.admin, repoPath, ["checkout", "-b", "feature/off-mainline"]);
    await writeFile(join(repoPath, "feature.txt"), "feature\n", "utf8");
    await gitOrThrowIn(team.admin, repoPath, ["add", "--", "feature.txt"]);
    await gitOrThrowIn(team.admin, repoPath, ["commit", "-m", "feat: off mainline"]);
    expect(await check()).toContain("not due: no new mainline commit");

    // Force a maintenance failure: the attempt is recorded before the work, so
    // the next check is in cooldown and startup is not blocked.
    await commitMain("mainline-change-2.txt");
    await writeMaintenanceState(team.admin, slug, {
      baselineHead: newHead,
      lastSuccessAt: new Date(now.getTime() - 73 * HOUR_MS).toISOString(),
    });

    // A directory where state.md belongs makes the snapshot refresh fail.
    const statePath = join(team.project.projectDir, "state.md");
    await gitOrThrowIn(team.admin, repoPath, ["checkout", "main"]);
    await rm(statePath, { force: true });
    await mkdir(statePath, { recursive: true });

    const failed = await runCliIn(team.admin, ["maintain"], {
      cwd: team.workspace,
    });
    expect(failed.code).toBe(1);

    const recorded = JSON.parse(
      await readFile(join(team.admin.home, "state", "maintenance.json"), "utf8"),
    ) as Record<string, Record<string, string>>;
    expect(recorded[slug].lastAttemptAt).toBeTruthy();

    expect(await check()).toContain("not due: maintenance cooldown active");

    // Startup continues even while the snapshot path is temporarily broken.
    const sync = await runCliIn(team.admin, ["sync", "--no-pull"], {
      cwd: team.workspace,
    });
    expect(sync.code, sync.err).toBe(0);
  }, 120_000);
});
