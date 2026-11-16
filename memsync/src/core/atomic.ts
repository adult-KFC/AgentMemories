import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Writes UTF-8 content through a temp file in the same directory, then renames. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  const tempPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    await writeFile(tempPath, content, { encoding: "utf8" });
    await rename(tempPath, path);
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
}
