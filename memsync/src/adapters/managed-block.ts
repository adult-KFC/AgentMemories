import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../core/atomic.js";

export const MANAGED_BLOCK_BEGIN = "<!-- memsync:begin -->";
export const MANAGED_BLOCK_END = "<!-- memsync:end -->";

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Renders `content` wrapped in the managed markers, ending with exactly one LF. */
export function renderManagedBlock(content: string): string {
  const body = normalize(content).replace(/^\n+/, "").replace(/\n+$/, "");
  return `${MANAGED_BLOCK_BEGIN}\n${body}\n${MANAGED_BLOCK_END}\n`;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Creates or updates the memsync-managed block in `path`. Content outside the
 * markers is preserved; the block itself is replaced as a whole. Re-running
 * with the same content is idempotent, and the file always ends with LF.
 */
export async function mergeManagedBlock(path: string, content: string): Promise<void> {
  const block = renderManagedBlock(content);
  const existing = await readOptional(path);

  if (existing === undefined) {
    await writeFileAtomic(path, block);
    return;
  }

  const text = normalize(existing);
  const begin = text.indexOf(MANAGED_BLOCK_BEGIN);

  if (begin === -1) {
    const prefix = text.replace(/\n+$/, "");
    await writeFileAtomic(path, prefix.length > 0 ? `${prefix}\n\n${block}` : block);
    return;
  }

  const end = text.indexOf(MANAGED_BLOCK_END, begin + MANAGED_BLOCK_BEGIN.length);
  const before = text.slice(0, begin).replace(/\n+$/, "");
  const after =
    end === -1
      ? ""
      : text
          .slice(end + MANAGED_BLOCK_END.length)
          .replace(/^\n+/, "")
          .replace(/\n+$/, "");

  const parts: string[] = [];
  if (before.length > 0) parts.push(before);
  parts.push(block.replace(/\n$/, ""));
  if (after.length > 0) parts.push(after);

  await writeFileAtomic(path, `${parts.join("\n\n")}\n`);
}
