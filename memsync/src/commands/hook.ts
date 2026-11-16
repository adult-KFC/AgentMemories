import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { handleClaudeHook, type ClaudeHookEvent } from "../adapters/claude.js";
import {
  handleCodexHook,
  type CodexHookEvent,
} from "../adapters/codex-install.js";
import type { CommandModule } from "./index.js";

const CLAUDE_EVENTS: readonly ClaudeHookEvent[] = [
  "session-start",
  "session-end",
  "pre-compact",
];

const CODEX_EVENTS: readonly CodexHookEvent[] = [
  "session-start",
  "user-prompt-submit",
  "stop",
];

interface HookOptions {
  tool?: string;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync hook: ${message}\n`);
  throw new CommanderError(1, "memsync.hook.failed", message);
}

function isClaudeEvent(value: string): value is ClaudeHookEvent {
  return (CLAUDE_EVENTS as readonly string[]).includes(value);
}

function isCodexEvent(value: string): value is CodexHookEvent {
  return (CODEX_EVENTS as readonly string[]).includes(value);
}

async function readStdin(io: CliIo): Promise<string | undefined> {
  try {
    return await io.stdin();
  } catch (err) {
    io.stderr(
      `memsync hook: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    io.stdout("{}\n");
    return undefined;
  }
}

export const hookCommand: CommandModule = {
  name: "hook",
  register(program, io) {
    program
      .command("hook")
      .description("Hook entry point for Claude Code and Codex (reads JSON from stdin)")
      .argument("<event>", "hook event (depends on --tool)")
      .option("--tool <tool>", "tool name (claude-code or codex)", "claude-code")
      .action(async (event: string, options: HookOptions) => {
        const tool = options.tool?.trim() || "claude-code";

        if (tool === "codex") {
          if (!isCodexEvent(event)) {
            fail(
              io,
              `unknown event "${event}"; expected ${CODEX_EVENTS.join(", ")}`,
            );
          }
          const raw = await readStdin(io);
          if (raw === undefined) return;

          const handled = await handleCodexHook(event, raw, io);
          io.stdout(handled.stdout);
          if (handled.code !== 0) {
            throw new CommanderError(
              handled.code,
              "memsync.hook.failed",
              "hook failed",
            );
          }
          return;
        }

        if (tool !== "claude-code") {
          fail(io, `invalid tool "${tool}"; expected claude-code or codex`);
        }
        if (!isClaudeEvent(event)) {
          fail(
            io,
            `unknown event "${event}"; expected ${CLAUDE_EVENTS.join(", ")}`,
          );
        }

        const raw = await readStdin(io);
        if (raw === undefined) return;

        const handled = await handleClaudeHook(event, raw, io);
        io.stdout(handled.stdout);
        if (handled.code !== 0) {
          throw new CommanderError(handled.code, "memsync.hook.failed", "hook failed");
        }
      });
  },
};
