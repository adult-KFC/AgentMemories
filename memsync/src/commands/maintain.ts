import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import {
  evaluateProjectMaintenance,
  runMaintenance,
} from "../core/maintenance.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import type { CommandModule } from "./index.js";

interface MaintainOptions {
  check?: boolean;
  quiet?: boolean;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync maintain: ${message}\n`);
  throw new CommanderError(1, "memsync.maintain.failed", message);
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

async function runMaintain(io: CliIo, options: MaintainOptions): Promise<void> {
  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    fail(io, resolutionMessage(resolution.reason));
  }

  const now = new Date();
  if (options.check === true) {
    const evaluation = await evaluateProjectMaintenance(
      resolution.projectDir,
      io.env,
      now,
    );
    io.stdout(
      `${evaluation.due ? "due" : "not due"}: ${evaluation.reason}\n`,
    );
    return;
  }

  const result = await runMaintenance(resolution.projectDir, now, { env: io.env });
  if (options.quiet !== true) {
    io.stdout(`state refreshed: ${result.stateRefreshed ? "yes" : "no"}\n`);
    io.stdout(`archived: ${result.archived}\n`);
  }
}

export const maintainCommand: CommandModule = {
  name: "maintain",
  register(program, io) {
    program
      .command("maintain")
      .description("Refresh state and archive old journals according to the policy")
      .option("--check", "report whether maintenance is due without running it")
      .option("--quiet", "suppress normal output")
      .action(async (options: MaintainOptions) => {
        try {
          await runMaintain(io, options);
        } catch (err) {
          failFrom(io, err);
        }
      });
  },
};
