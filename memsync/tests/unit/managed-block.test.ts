import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  mergeManagedBlock,
} from "../../src/adapters/managed-block.js";

async function tempFile(name = "CLAUDE.md"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memsync-block-"));
  return join(dir, name);
}

describe("mergeManagedBlock", () => {
  it("creates the file with markers when it does not exist", async () => {
    const path = await tempFile();

    await mergeManagedBlock(path, "## 记忆\n\n- rule one");

    const text = await readFile(path, "utf8");
    expect(text).toBe(
      `${MANAGED_BLOCK_BEGIN}\n## 记忆\n\n- rule one\n${MANAGED_BLOCK_END}\n`,
    );
    expect(text.endsWith("\n")).toBe(true);
  });

  it("replaces only the managed region and preserves surrounding content", async () => {
    const path = await tempFile();
    await writeFile(
      path,
      `# Project\n\nintro\n\n${MANAGED_BLOCK_BEGIN}\nold body\n${MANAGED_BLOCK_END}\n\nfooter text\n`,
      "utf8",
    );

    await mergeManagedBlock(path, "new body");

    expect(await readFile(path, "utf8")).toBe(
      `# Project\n\nintro\n\n${MANAGED_BLOCK_BEGIN}\nnew body\n${MANAGED_BLOCK_END}\n\nfooter text\n`,
    );
  });

  it("is idempotent across repeated merges", async () => {
    const path = await tempFile();
    await writeFile(
      path,
      `before\n\n${MANAGED_BLOCK_BEGIN}\nold\n${MANAGED_BLOCK_END}\n\nafter\n`,
      "utf8",
    );

    await mergeManagedBlock(path, "content");
    const first = await readFile(path, "utf8");
    await mergeManagedBlock(path, "content");
    const second = await readFile(path, "utf8");

    expect(second).toBe(first);
    expect(second.match(/<!-- memsync:begin -->/g)).toHaveLength(1);
    expect(second.match(/<!-- memsync:end -->/g)).toHaveLength(1);
  });

  it("appends a managed block when no markers exist", async () => {
    const path = await tempFile();
    await writeFile(path, "# Existing instructions\n", "utf8");

    await mergeManagedBlock(path, "memory rules");

    const text = await readFile(path, "utf8");
    expect(text.startsWith("# Existing instructions\n")).toBe(true);
    expect(text).toContain(MANAGED_BLOCK_BEGIN);
    expect(text).toContain("memory rules");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("normalizes CRLF input to LF and closes an unterminated block", async () => {
    const path = await tempFile();
    await writeFile(
      path,
      `head\r\n\r\n${MANAGED_BLOCK_BEGIN}\r\nstale\r\n`,
      "utf8",
    );

    await mergeManagedBlock(path, "fresh\r\nline");

    const text = await readFile(path, "utf8");
    expect(text).not.toContain("\r");
    expect(text).toBe(
      `head\n\n${MANAGED_BLOCK_BEGIN}\nfresh\nline\n${MANAGED_BLOCK_END}\n`,
    );
  });

  it("does not leave a doubled trailing newline on an empty file", async () => {
    const path = await tempFile();
    await writeFile(path, "", "utf8");

    await mergeManagedBlock(path, "body");

    expect(await readFile(path, "utf8")).toBe(
      `${MANAGED_BLOCK_BEGIN}\nbody\n${MANAGED_BLOCK_END}\n`,
    );
  });
});
