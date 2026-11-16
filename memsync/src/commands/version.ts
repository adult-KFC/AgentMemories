import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import { setVersion } from "../core/versions.js";
import type { CommandModule } from "./index.js";

interface SetOptions {
  status: string;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync version: ${message}\n`);
  throw new CommanderError(1, "memsync.version.failed", message);
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

async function runSet(io: CliIo, version: string, options: SetOptions): Promise<void> {
  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    fail(io, resolutionMessage(resolution.reason));
  }

  await setVersion(
    resolution.projectDir,
    version,
    options.status as "planning" | "active" | "frozen",
  );
  io.stdout(`Version ${version} set to ${options.status}\n`);
}

export const versionCommand: CommandModule = {
  name: "version",
  register(program, io) {
    program
      .command("version")
      .description("Manage the project's current version in meta.yaml")
      .command("set <version>")
      .description("Set current_version and version_status atomically")
      .requiredOption("--status <status>", "planning, active, or frozen")
      .action(async (version: string, options: SetOptions) => {
        try {
          await runSet(io, version, options);
        } catch (err) {
          failFrom(io, err);
        }
      });
  },
};
