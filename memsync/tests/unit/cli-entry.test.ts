import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectRun } from "../../src/cli.js";

const thisFile = fileURLToPath(import.meta.url);

const symlinkCase = (() => {
  const directory = mkdtempSync(join(tmpdir(), "memsync-entry-"));
  const link = join(directory, "entry.mjs");
  try {
    symlinkSync(thisFile, link, "file");
    return { directory, link };
  } catch (err) {
    rmSync(directory, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      return undefined;
    }
    throw err;
  }
})();

afterAll(() => {
  if (symlinkCase) rmSync(symlinkCase.directory, { recursive: true, force: true });
});

describe("isDirectRun", () => {
  it("is false when there is no entry point", () => {
    expect(isDirectRun(undefined, import.meta.url)).toBe(false);
  });

  it("compares real paths of the entry point and module", () => {
    expect(isDirectRun(thisFile, import.meta.url)).toBe(true);
    expect(isDirectRun(join(dirname(thisFile), "other.mjs"), import.meta.url)).toBe(false);
  });

  it.skipIf(!symlinkCase)("recognizes a symlinked entry point", () => {
    expect(isDirectRun(symlinkCase!.link, import.meta.url)).toBe(true);
    expect(isDirectRun(symlinkCase!.link, pathToFileURL(symlinkCase!.link).href)).toBe(true);
  });
});
