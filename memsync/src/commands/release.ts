import { CommanderError } from "commander";
import { isAbsolute, resolve } from "node:path";
import type { CliIo } from "../cli.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import { release, type ReleaseOptions } from "../core/versions.js";
import type { CommandModule } from "./index.js";

interface ReleaseCommandOptions {
  codeRepo?: string;
  sinceTag?: string;
  toTag?: string;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync release: ${message}\n`);
  throw new CommanderError(1, "memsync.release.failed", message);
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

function releaseOptions(io: CliIo, options: ReleaseCommandOptions): ReleaseOptions {
  const codeRepo = options.codeRepo?.trim();
  const sinceTag = options.sinceTag?.trim();
  const toTag = options.toTag?.trim();

  return {
    ...(codeRepo !== undefined && codeRepo.length > 0
      ? { codeRepo: isAbsolute(codeRepo) ? codeRepo : resolve(io.cwd, codeRepo) }
      : {}),
    ...(sinceTag !== undefined && sinceTag.length > 0 ? { sinceTag } : {}),
    ...(toTag !== undefined && toTag.length > 0 ? { toTag } : {}),
  };
}

async function runRelease(
  io: CliIo,
  version: string,
  options: ReleaseCommandOptions,
): Promise<void> {
  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    fail(io, resolutionMessage(resolution.reason));
  }

  const result = await release(
    resolution.projectDir,
    version,
    releaseOptions(io, options),
  );
  io.stdout(`Released ${version} to ${result.path}\n`);
}

export const releaseCommand: CommandModule = {
  name: "release",
  register(program, io) {
    program
      .command("release <version>")
      .description("Freeze a version and write versions/<version>.md")
      .option("--code-repo <path>", "code repository used to count commits by author")
      .option("--since-tag <tag>", "tag range start (exclusive)")
      .option("--to-tag <tag>", "tag range end (inclusive)")
      .action(async (version: string, options: ReleaseCommandOptions) => {
        try {
          await runRelease(io, version, options);
        } catch (err) {
          failFrom(io, err);
        }
      });
  },
};
