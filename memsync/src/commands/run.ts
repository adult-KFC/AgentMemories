import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { runWrappedTool } from "../adapters/codex-run.js";
import type { CommandModule } from "./index.js";

export const runCommand: CommandModule = {
  name: "run",
  register(program, io) {
    program
      .command("run")
      .description("Run a tool inside a MemorySync session (Codex fallback wrapper)")
      .argument("<tool>", "tool to wrap (codex)")
      .argument("[args...]", "arguments passed to the tool (place them after --)")
      .allowUnknownOption(true)
      .action(async (tool: string, args: string[] | undefined) => {
        const name = tool?.trim();
        if (name !== "codex") {
          io.stderr(`memsync run: unsupported tool "${name ?? ""}"; expected codex\n`);
          throw new CommanderError(
            1,
            "memsync.run.unsupported",
            "unsupported tool",
          );
        }

        const code = await runWrappedTool({
          tool: "codex",
          args: args ?? [],
          io,
        });
        if (code !== 0) {
          throw new CommanderError(code, "memsync.run.failed", "wrapped tool failed");
        }
      });
  },
};
