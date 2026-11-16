import { Command, CommanderError } from "commander";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { commands } from "./commands/index.js";
import { VERSION } from "./version.js";

export interface CliIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: () => Promise<string>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /**
   * One interactive line, used by confirmation prompts. Returns `undefined`
   * when no interactive input is available (non-TTY). Test IOs omit it and
   * fall back to `stdin()`.
   */
  readLine?: () => Promise<string | undefined>;
}

/** Default IO backed by the real process streams. */
export function defaultCliIo(): CliIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    stdout: (s) => {
      process.stdout.write(s);
    },
    stderr: (s) => {
      process.stderr.write(s);
    },
    // `stdin()` drains to EOF, which never arrives on an interactive TTY.
    // Prompts must read a single line instead; non-TTY input is not prompted.
    readLine: async () => {
      if (!process.stdin.isTTY) return undefined;
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return await rl.question("");
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * Runs the CLI in-process. Never calls process.exit: commander errors are
 * converted to their exit code so tests and adapters can drive the CLI directly.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const program = new Command();

  program
    .name("memsync")
    .description("Team memory sync for Claude Code and Codex")
    .version(VERSION, "-v, --version", "print the version")
    // Stop root option parsing at the subcommand name so a nested command can
    // own a flag such as `project add --version` without the root --version
    // handler swallowing it.
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.stdout(str),
      writeErr: (str) => io.stderr(str),
    });

  for (const command of commands) {
    command.register(program, io);
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    throw err;
  }
}

/**
 * True when the process entry point is this module. Both sides are resolved
 * through realpath so symlinked bin shims (npm link, global installs) match.
 */
export function isDirectRun(entry: string | undefined, moduleUrl: string): boolean {
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  const io = defaultCliIo();
  runCli(process.argv.slice(2), io)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      io.stderr(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    });
}
