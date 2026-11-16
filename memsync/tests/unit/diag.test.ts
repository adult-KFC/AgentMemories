import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnostic } from "../../src/core/diag.js";

async function diagnosticsFile(): Promise<{ home: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), "memsync-diag-"));
  return { home, path: join(home, "state", "diagnostics.jsonl") };
}

describe("diagnostic", () => {
  it("appends one JSON line with hashed string fields and raw counts", async () => {
    const { home, path } = await diagnosticsFile();

    await diagnostic("note.added", { session: "7f3c9a1e-secret", count: 3, ok: true }, {
      MEMSYNC_HOME: home,
    });

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.event).toBe("note.added");
    expect(typeof entry.ts).toBe("string");
    expect(entry.session).toMatch(/^[0-9a-f]{16}$/);
    expect(entry.session).not.toBe("7f3c9a1e-secret");
    expect(entry.count).toBe(3);
    expect(entry.ok).toBe(true);
  });

  it("never writes secret text in plaintext", async () => {
    const { home, path } = await diagnosticsFile();
    const secret = "sk-abc123DEF456ghi789";
    const message = `failed for ${secret}`;

    await diagnostic("note.rejected", { message, length: message.length, reason: "secret" }, {
      MEMSYNC_HOME: home,
    });

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("failed for");
    expect(raw).toContain(`"length":${message.length}`);
  });

  it("hashes nested strings and appends without rewriting earlier lines", async () => {
    const { home, path } = await diagnosticsFile();
    const env = { MEMSYNC_HOME: home };

    await diagnostic("first", { user: "alice" }, env);
    await diagnostic("second", { detail: { host: "win-claude", count: 2 } }, env);

    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    const second = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(first.event).toBe("first");
    expect(second.event).toBe("second");
    expect(second.detail).toMatchObject({ count: 2 });
    expect((second.detail as Record<string, unknown>).host).toMatch(/^[0-9a-f]{16}$/);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain("\r\n");
  });

  it("omits null fields rather than leaking placeholder text", async () => {
    const { home, path } = await diagnosticsFile();
    await diagnostic("empty", { value: undefined }, { MEMSYNC_HOME: home });
    const entry = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, unknown>;
    expect(entry.event).toBe("empty");
    expect("value" in entry).toBe(false);
  });
});
