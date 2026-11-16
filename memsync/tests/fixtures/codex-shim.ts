import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the fake Codex executable body (platform independent). */
export const FAKE_CODEX_FIXTURE = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

export interface FakeCodex {
  /** Directory holding the shim; also a convenient temp root. */
  dir: string;
  /** Command accepted by spawn(): `codex` on POSIX, `codex.cmd` on Windows. */
  command: string;
}

/**
 * Creates a per-test executable shim so the probe/CLI code can spawn the fake
 * exactly like a real `codex` binary. Windows cannot spawn `.cmd` files
 * directly, which is why the production spawn path understands `.cmd`.
 */
export async function makeFakeCodex(): Promise<FakeCodex> {
  const dir = await mkdtemp(join(tmpdir(), "memsync-fake-codex-"));

  if (process.platform === "win32") {
    const command = join(dir, "codex.cmd");
    await writeFile(
      command,
      `@echo off\r\n"${process.execPath}" "${FAKE_CODEX_FIXTURE}" %*\r\n`,
      "utf8",
    );
    return { dir, command };
  }

  const command = join(dir, "codex");
  await writeFile(
    command,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX_FIXTURE}" "$@"\n`,
    "utf8",
  );
  await chmod(command, 0o755);
  return { dir, command };
}
