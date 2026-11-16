import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { getStatus } from "../core/status.js";
import type { CommandModule } from "./index.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function runStatus(io: CliIo): Promise<void> {
  const report = await getStatus(io.env, io.cwd);
  const pendingDetail =
    report.pendingPushSession !== undefined
      ? ` (session ${report.pendingPushSession}${
          report.pendingPushAt !== undefined ? `, since ${report.pendingPushAt}` : ""
        })`
      : "";
  const lines = [
    `config: ${report.configPath ?? "not configured"}`,
    `repo: ${report.repoPath ?? "not configured"}`,
    `last sync: ${report.lastSyncAt ?? "never"}`,
    `pending push: ${report.pendingPush ? "yes" : "no"}${pendingDetail}`,
    `locked: ${report.locked ? "yes" : "no"}`,
    `repo size: ${formatBytes(report.repoBytes)}`,
    `maintenance due: ${report.maintenanceDue ? "yes" : "no"}`,
    ...(report.defaultBranchWarning !== undefined
      ? [`warning: ${report.defaultBranchWarning}`]
      : []),
  ];
  io.stdout(`${lines.join("\n")}\n`);
}

export const statusCommand: CommandModule = {
  name: "status",
  register(program, io) {
    program
      .command("status")
      .description("Show sync, lock, repo size, and maintenance status")
      .action(async () => {
        try {
          await runStatus(io);
        } catch (err) {
          if (err instanceof CommanderError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          io.stderr(`memsync status: ${message}\n`);
          throw new CommanderError(1, "memsync.status.failed", message);
        }
      });
  },
};
