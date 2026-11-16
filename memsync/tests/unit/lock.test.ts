import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../../src/core/lock.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function lockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "lock-")), "x.lock");
}

describe("withLock", () => {
  it("serializes two concurrent critical sections", async () => {
    const order: string[] = [];
    const path = await lockPath();
    await Promise.all([
      withLock(path, {}, async () => {
        order.push("a");
        await delay(30);
        order.push("b");
      }),
      withLock(path, {}, async () => {
        order.push("c");
      }),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("releases the lock when the critical section throws", async () => {
    const path = await lockPath();
    await expect(
      withLock(path, {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(withLock(path, {}, async () => "again")).resolves.toBe("again");
  });

  it("removes locks older than staleMs", async () => {
    const path = await lockPath();
    await writeFile(
      path,
      JSON.stringify({ pid: 999_999, startedAt: new Date(0).toISOString() }),
      "utf8",
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);

    await expect(
      withLock(path, { staleMs: 1_000, timeoutMs: 1_000 }, async () => "fresh"),
    ).resolves.toBe("fresh");
  });

  it("does not release a lock taken over by another owner", async () => {
    const path = await lockPath();
    await withLock(path, { staleMs: 60_000 }, async () => {
      // Simulate a reclaimer replacing our lock with one carrying a new token.
      await writeFile(
        path,
        JSON.stringify({ pid: 1, startedAt: new Date().toISOString(), token: "taken-over" }),
        "utf8",
      );
    });

    const raw = JSON.parse(await readFile(path, "utf8")) as { token?: string };
    expect(raw.token).toBe("taken-over");
  });

  it("times out while a fresh lock is held and leaves it in place", async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }), "utf8");

    await expect(
      withLock(path, { timeoutMs: 100, staleMs: 60_000 }, async () => "never"),
    ).rejects.toThrow(/timed out acquiring lock/i);

    await expect(stat(path)).resolves.toBeDefined();
  });
});
