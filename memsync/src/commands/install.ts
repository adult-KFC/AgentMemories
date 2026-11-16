import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { installClaude, type InstallScope } from "../adapters/claude.js";
import type { CodexHook } from "../adapters/codex-app-server.js";
import { installCodex, type InstallReport } from "../adapters/codex-install.js";
import type { CommandModule } from "./index.js";

interface InstallOptions {
  tool?: string;
  scope?: string;
  yes?: boolean;
  forcePath?: string;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync install: ${message}\n`);
  throw new CommanderError(1, "memsync.install.failed", message);
}

function isScope(value: string): value is InstallScope {
  return value === "user" || value === "project";
}

function reportLines(report: InstallReport): string[] {
  const lines: string[] = [];
  if (report.path === "B") {
    lines.push("memsync install: codex fallback (AGENTS.md + wrapper)");
  } else {
    lines.push(`memsync install: codex plugin hooks installed (path ${report.path})`);
  }
  for (const command of report.commands) lines.push(`command: ${command}`);
  if (report.hooks !== undefined) lines.push(`hooks: ${report.hooks.length}`);
  if (report.managedBlockPath !== undefined) {
    lines.push(`managed block: ${report.managedBlockPath}`);
  }
  return lines;
}

export const installCommand: CommandModule = {
  name: "install",
  register(program, io) {
    program
      .command("install")
      .description("Install tool hooks and the managed instructions block")
      .option("--tool <tool>", "tool name (claude-code or codex)")
      .option("--scope <scope>", "user or project", "user")
      .option("--yes", "trust the Codex hooks without prompting")
      .option("--force-path <path>", "force the Codex path (A or B)")
      .action(async (options: InstallOptions) => {
        try {
          const tool = options.tool?.trim();
          if (tool === undefined || tool.length === 0) {
            fail(io, "--tool is required (claude-code or codex)");
          }

          const scope = options.scope?.trim() || "user";
          if (!isScope(scope)) {
            fail(io, `invalid scope "${scope}"; expected user or project`);
          }

          if (tool === "codex") {
            const forced = options.forcePath?.trim();
            if (forced !== undefined && forced !== "A" && forced !== "B") {
              fail(io, `invalid path "${forced}"; expected A or B`);
            }

            const confirmTrust = async (hooks: CodexHook[]): Promise<boolean> => {
              if (options.yes === true) return true;
              for (const hook of hooks) {
                io.stdout(
                  `hook: ${hook.key} ${hook.eventName} ${hook.command}\n`,
                );
              }
              io.stdout("? trust these Codex hooks? [y/N] ");
              try {
                // On a TTY `stdin()` waits for EOF; ask for one line instead.
                // Test IOs without `readLine` keep the immediate-stdin shape.
                const answer =
                  io.readLine !== undefined ? await io.readLine() : await io.stdin();
                if (answer === undefined) return false;
                return /^(y|yes)$/i.test(answer.trim());
              } catch {
                return false;
              }
            };

            const report = await installCodex({
              env: io.env,
              cwd: io.cwd,
              scope,
              confirmTrust,
              ...(options.yes === true ? { yes: true } : {}),
              ...(forced === "A" || forced === "B" ? { forcePath: forced } : {}),
            });
            if (report.warning !== undefined) {
              io.stderr(`memsync install: ${report.warning}\n`);
            }
            io.stdout(`${reportLines(report).join("\n")}\n`);
            return;
          }

          if (tool !== "claude-code") {
            fail(io, `invalid tool "${tool}"; expected claude-code or codex`);
          }

          const report = await installClaude({
            env: io.env,
            scope,
            cwd: io.cwd,
          });

          io.stdout(
            "memsync install: claude-code hooks installed\n" +
              `settings: ${report.settingsPath}\n` +
              `managed block: ${report.managedBlockPath}\n` +
              `slash command: ${report.slashCommandPath}\n` +
              `hook: ${report.command}\n`,
          );
        } catch (err) {
          if (err instanceof CommanderError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          fail(io, message.replace(/\s+/g, " ").trim());
        }
      });
  },
};
