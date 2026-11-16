import { CommanderError } from "commander";
import { join } from "node:path";
import type { CliIo } from "../cli.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import { refreshStateSnapshot } from "../core/versions.js";
import type { CommandModule } from "./index.js";

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync state: ${message}\n`);
  throw new CommanderError(1, "memsync.state.failed", message);
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

async function runRefresh(io: CliIo): Promise<void> {
  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    fail(io, resolutionMessage(resolution.reason));
  }

  await refreshStateSnapshot(resolution.projectDir);
  io.stdout(`Refreshed state snapshot at ${join(resolution.projectDir, "state.md")}\n`);
}

export const stateCommand: CommandModule = {
  name: "state",
  register(program, io) {
    program
      .command("state")
      .description("Maintain the human-readable state snapshot")
      .command("refresh")
      .description("Rebuild the derived block in state.md, preserving human notes")
      .action(async () => {
        try {
          await runRefresh(io);
        } catch (err) {
          failFrom(io, err);
        }
      });
  },
};
