import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { SUPPORTED_TOOLS } from "../core/session.js";
import { syncProject } from "../core/sync.js";
import type { Tool } from "../types.js";
import type { CommandModule } from "./index.js";

interface SyncOptions {
  tool?: string;
  session?: string;
  /** Commander sets false when `--no-pull` is passed. */
  pull?: boolean;
  strict?: boolean;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync sync: ${message}\n`);
  throw new CommanderError(1, "memsync.sync.failed", message);
}

async function runSync(io: CliIo, options: SyncOptions): Promise<void> {
  const rawTool = options.tool?.trim();
  if (rawTool !== undefined && rawTool.length > 0 && !SUPPORTED_TOOLS.includes(rawTool as Tool)) {
    fail(io, `invalid tool "${rawTool}"; expected one of ${SUPPORTED_TOOLS.join(", ")}`);
  }
  const tool = rawTool !== undefined && rawTool.length > 0 ? (rawTool as Tool) : undefined;
  const sessionId = options.session?.trim();

  const result = await syncProject({
    cwd: io.cwd,
    env: io.env,
    ...(tool !== undefined ? { tool } : {}),
    ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
    noPull: options.pull === false,
    ...(options.strict === true ? { strict: true } : {}),
  });

  if (result.reason !== undefined) {
    const label = options.strict === true ? "" : "warning: ";
    io.stderr(`memsync sync: ${label}${result.reason}\n`);
  }
  if (result.context !== undefined) {
    io.stdout(
      result.context.endsWith("\n") ? result.context : `${result.context}\n`,
    );
  }
  if (result.code !== 0) {
    throw new CommanderError(result.code, "memsync.sync.failed", "sync failed");
  }
}

export const syncCommand: CommandModule = {
  name: "sync",
  register(program, io) {
    program
      .command("sync")
      .description("Refresh memory and print the bounded startup context")
      .option("--tool <tool>", "tool name (claude-code or codex)")
      .option("--session <id>", "explicit session id")
      .option("--no-pull", "skip pulling the memory repo")
      .option("--strict", "exit non-zero instead of using cache when the pull fails")
      .action(async (options: SyncOptions) => {
        try {
          await runSync(io, options);
        } catch (err) {
          if (err instanceof CommanderError) throw err;
          fail(io, err instanceof Error ? err.message : String(err));
        }
      });
  },
};
