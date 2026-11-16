import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import { parseSince, reportByPerson } from "../core/reports.js";
import type { CommandModule } from "./index.js";

interface ReportOptions {
  since: string;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync report: ${message}\n`);
  throw new CommanderError(1, "memsync.report.failed", message);
}

function failFrom(io: CliIo, err: unknown): never {
  if (err instanceof CommanderError) throw err;
  return fail(io, err instanceof Error ? err.message : String(err));
}

function resolutionMessage(reason: "unlinked" | "missing_meta" | "ambiguous"): string {
  switch (reason) {
    case "ambiguous":
      return "multiple projects match this workspace; run memsync link <slug> to choose one";
    case "missing_meta":
      return "the workspace points at a project whose meta.yaml is missing; run memsync project add <slug>";
    case "unlinked":
      return "workspace is not linked to a project; run memsync link <slug>";
  }
}

async function runReport(io: CliIo, options: ReportOptions): Promise<void> {
  const since = parseSince(options.since);

  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    fail(io, resolutionMessage(resolution.reason));
  }

  const report = await reportByPerson(resolution.projectDir, since);
  io.stdout(report.endsWith("\n") ? report : `${report}\n`);
}

export const reportCommand: CommandModule = {
  name: "report",
  register(program, io) {
    program
      .command("report")
      .description("Print the per-person standup report derived from journals")
      .requiredOption("--since <window>", "7d/30d or an ISO date")
      .action(async (options: ReportOptions) => {
        try {
          await runReport(io, options);
        } catch (err) {
          failFrom(io, err);
        }
      });
  },
};
