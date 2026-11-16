import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../../src/cli.js";
import { runGit } from "../../src/core/git.js";
import {
  createJournal,
  findJournalBySession,
  readJournal,
} from "../../src/core/journal.js";
import { endSession, writeSessionPointer } from "../../src/core/session.js";

const SESSION = "7f3c9a1e-1111-4222-8333-abcdefabcdef";
const META = [
  "slug: checkout-service",
  "repos:",
  "  - git@git.corp.com:shop/checkout-service.git",
  "owners:",
  "  - alice@corp.com",
  "current_version: 0.4.0",
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

function capture(cwd: string, env: NodeJS.ProcessEnv, stdin = ""): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      cwd,
      env,
      stdin: async () => stdin,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    },
  };
}

interface Setup {
  workspace: string;
  projectDir: string;
  journalPath: string;
  env: NodeJS.ProcessEnv;
}

async function setup(): Promise<Setup> {
  const home = await mkdtemp(join(tmpdir(), "memsync-note-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "memsync-note-ws-"));
  const memoryRepo = join(home, "repo");
  const projectDir = join(memoryRepo, "projects", "checkout-service");

  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "meta.yaml"), META, "utf8");
  await writeFile(join(workspace, ".memsync.json"), '{"project":"checkout-service"}\n', "utf8");

  const { path } = await createJournal({
    projectDir,
    project: "checkout-service",
    user: "alice",
    email: "alice@corp.com",
    host: "win-claude",
    tool: "claude-code",
    session: SESSION,
    workspace,
    baseCommit: "9f2c1ab",
    versionHint: "0.4.0",
  });

  return {
    workspace,
    projectDir,
    journalPath: path,
    env: { MEMSYNC_HOME: home, MEMSYS_HOST: "win-claude" },
  };
}

describe("memsync note", () => {
  it("resolves the project and appends a note", async () => {
    const { workspace, journalPath, env } = await setup();
    const { io, out } = capture(workspace, env);

    const code = await runCli(
      ["note", "progress", "--text", "merged the cart", "--session", SESSION],
      io,
    );

    expect(code).toBe(0);
    expect(out.join("")).toMatch(/added/i);
    expect(await readFile(journalPath, "utf8")).toContain("[progress] merged the cart");
  });

  it("reads the note text from stdin", async () => {
    const { workspace, journalPath, env } = await setup();
    const { io } = capture(workspace, env, "note from stdin\n");

    expect(await runCli(["note", "decision", "--session", SESSION], io)).toBe(0);
    expect(await readFile(journalPath, "utf8")).toContain("[decision] note from stdin");
  });

  it("records --version on the journal front matter", async () => {
    const { workspace, journalPath, env } = await setup();
    const { io } = capture(workspace, env);

    expect(
      await runCli(
        ["note", "progress", "--text", "release prep", "--session", SESSION, "--version", "0.5.0"],
        io,
      ),
    ).toBe(0);
    expect((await readJournal(journalPath)).version_hint).toBe("0.5.0");
  });

  it("exits 0 with a warning when the checkpoint commit fails", async () => {
    const { workspace, env } = await setup();
    const repo = join(env.MEMSYNC_HOME as string, "repo");
    await runGit(["init"], { cwd: repo });
    await runGit(["config", "user.name", "Test User"], { cwd: repo });
    await runGit(["config", "user.email", "test@example.com"], { cwd: repo });

    for (let index = 1; index <= 4; index += 1) {
      expect(
        await runCli(
          ["note", "progress", "--text", `step ${index}`, "--session", SESSION],
          capture(workspace, env).io,
        ),
      ).toBe(0);
    }

    const lock = join(repo, ".git", "index.lock");
    await writeFile(lock, "locked", "utf8");
    try {
      const fifth = capture(workspace, env);
      expect(
        await runCli(
          ["note", "progress", "--text", "step 5", "--session", SESSION],
          fifth.io,
        ),
      ).toBe(0);
      expect(fifth.out.join("")).toMatch(/Added/);
      expect(fifth.err.join("")).toMatch(/checkpoint commit failed/i);
    } finally {
      await rm(lock, { force: true });
    }
  });

  it("ignores duplicate notes with exit code 0", async () => {
    const { workspace, env } = await setup();
    const args = ["note", "progress", "--text", "same", "--session", SESSION];

    expect(await runCli(args, capture(workspace, env).io)).toBe(0);
    const second = capture(workspace, env);
    expect(await runCli(args, second.io)).toBe(0);
    expect(second.out.join("")).toMatch(/duplicate/i);
  });

  it("creates an implicit session and pointer when nothing resolves", async () => {
    const { workspace, projectDir, env } = await setup();
    const { io, out } = capture(workspace, env);

    expect(await runCli(["note", "progress", "--text", "implicit note"], io)).toBe(0);
    expect(out.join("")).toMatch(/Added/);

    const pointer = JSON.parse(
      await readFile(
        join(workspace, ".memsync", "sessions", "current-claude-code.json"),
        "utf8",
      ),
    ) as { session: string; tool: string };
    expect(pointer.tool).toBe("claude-code");
    expect(pointer.session).not.toBe(SESSION);

    const journal = await findJournalBySession(projectDir, pointer.session);
    expect(journal).toBeDefined();
    expect(await readFile(journal as string, "utf8")).toContain(
      "[progress] implicit note",
    );
    expect((await readJournal(journal as string)).implicit).toBe(true);
  });

  it("starts a fresh implicit session when the pointer's journal has ended", async () => {
    const { workspace, projectDir, journalPath, env } = await setup();
    await writeSessionPointer(workspace, "claude-code", SESSION, {
      host: "win-claude",
    });
    await endSession({ projectDir, sessionId: SESSION, env });
    const endedText = await readFile(journalPath, "utf8");
    expect((await readJournal(journalPath)).ended).toBeDefined();

    const { io } = capture(workspace, env);
    expect(
      await runCli(["note", "progress", "--text", "after the end"], io),
    ).toBe(0);

    // The closed journal is never mutated; a new implicit one carries the note.
    expect(await readFile(journalPath, "utf8")).toBe(endedText);
    const pointer = JSON.parse(
      await readFile(
        join(workspace, ".memsync", "sessions", "current-claude-code.json"),
        "utf8",
      ),
    ) as { session: string };
    expect(pointer.session).not.toBe(SESSION);

    const fresh = await findJournalBySession(projectDir, pointer.session);
    expect(fresh).toBeDefined();
    const freshRecord = await readJournal(fresh as string);
    expect(freshRecord.implicit).toBe(true);
    expect(freshRecord.ended).toBeUndefined();
    expect(await readFile(fresh as string, "utf8")).toContain(
      "[progress] after the end",
    );
  });

  it("uses MEMSYS_SESSION when --session is omitted", async () => {
    const { workspace, journalPath, env } = await setup();
    const { io } = capture(workspace, { ...env, MEMSYS_SESSION: SESSION });

    expect(
      await runCli(["note", "progress", "--text", "env note"], io),
    ).toBe(0);
    expect(await readFile(journalPath, "utf8")).toContain("[progress] env note");
  });

  it("uses the workspace pointer when --session and the env are absent", async () => {
    const { workspace, journalPath, env } = await setup();
    await writeSessionPointer(workspace, "claude-code", SESSION, {
      host: "win-claude",
    });
    const { io } = capture(workspace, env);

    expect(
      await runCli(["note", "progress", "--text", "pointer note"], io),
    ).toBe(0);
    expect(await readFile(journalPath, "utf8")).toContain(
      "[progress] pointer note",
    );
  });

  it("prefers the MEMSYS_TOOL pointer over the other tool", async () => {
    const { workspace, projectDir, journalPath, env } = await setup();
    const codexSession = "codex-1111-4222-8333-abcdefabcdef";
    const codexJournal = await createJournal({
      projectDir,
      project: "checkout-service",
      user: "alice",
      email: "alice@corp.com",
      host: "win-claude",
      tool: "codex",
      session: codexSession,
      workspace,
      baseCommit: "9f2c1ab",
    });
    await writeSessionPointer(workspace, "claude-code", SESSION, {
      host: "win-claude",
    });
    await writeSessionPointer(workspace, "codex", codexSession, {
      host: "win-claude",
    });

    const { io } = capture(workspace, { ...env, MEMSYS_TOOL: "codex" });

    expect(
      await runCli(["note", "progress", "--text", "codex pointer note"], io),
    ).toBe(0);
    expect(await readFile(codexJournal.path, "utf8")).toContain(
      "[progress] codex pointer note",
    );
    expect(await readFile(journalPath, "utf8")).not.toContain(
      "codex pointer note",
    );
  });

  it("asks for --session when several journals are open for the tool", async () => {
    const { workspace, projectDir, env } = await setup();
    await createJournal({
      projectDir,
      project: "checkout-service",
      user: "alice",
      email: "alice@corp.com",
      host: "win-claude",
      tool: "claude-code",
      session: "second-session",
      workspace,
      baseCommit: "9f2c1ab",
    });
    await writeSessionPointer(workspace, "claude-code", SESSION, {
      host: "win-claude",
    });

    const ambiguous = capture(workspace, env);
    expect(
      await runCli(["note", "progress", "--text", "ambiguous note"], ambiguous.io),
    ).toBe(1);
    expect(ambiguous.err.join("")).toMatch(/multiple active sessions/i);
    expect(ambiguous.err.join("")).toContain("--session");

    // An explicit session is always accepted, even with several open journals.
    const explicit = capture(workspace, env);
    expect(
      await runCli(
        ["note", "progress", "--text", "explicit note", "--session", SESSION],
        explicit.io,
      ),
    ).toBe(0);
  });

  it("exits 1 with a clear message for an unknown session", async () => {
    const { workspace, env } = await setup();
    const { io, err } = capture(workspace, env);

    expect(
      await runCli(["note", "progress", "--text", "hello", "--session", "nope"], io),
    ).toBe(1);
    expect(err.join("")).toMatch(/no journal found for session nope/i);
    expect(err.join("")).not.toMatch(/\n\s+at\s/);
  });

  it("exits 1 for oversized notes", async () => {
    const { workspace, env } = await setup();
    const { io, err } = capture(workspace, env);

    expect(
      await runCli(
        ["note", "progress", "--text", "x".repeat(8193), "--session", SESSION],
        io,
      ),
    ).toBe(1);
    expect(err.join("")).toMatch(/8192/);
  });

  it("exits 1 for secret-shaped text", async () => {
    const { workspace, journalPath, env } = await setup();
    const { io, err } = capture(workspace, env);

    expect(
      await runCli(
        ["note", "progress", "--text", "token sk-abc123DEF456ghi789", "--session", SESSION],
        io,
      ),
    ).toBe(1);
    expect(err.join("")).toMatch(/secret/i);
    expect(await readFile(journalPath, "utf8")).not.toContain("sk-abc123DEF456ghi789");
  });

  it("exits 1 for an invalid kind", async () => {
    const { workspace, env } = await setup();
    const { io, err } = capture(workspace, env);

    expect(
      await runCli(["note", "rant", "--text", "hello", "--session", SESSION], io),
    ).toBe(1);
    expect(err.join("")).toMatch(/kind/i);
  });

  it("exits 1 with a link hint when the workspace is unlinked", async () => {
    const { env } = await setup();
    const workspace = await mkdtemp(join(tmpdir(), "memsync-unlinked-"));
    const { io, err } = capture(workspace, env);

    expect(
      await runCli(["note", "progress", "--text", "hello", "--session", SESSION], io),
    ).toBe(1);
    expect(err.join("")).toMatch(/memsync link/i);
  });
});
