import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { compactJournals } from "../core/compact.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import type { CommandModule } from "./index.js";

interface CompactOptions {
  before: string;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync compact: ${message}\n`);
  throw new CommanderError(1, "memsync.compact.failed", message);
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

export function parseBefore(value: string): Date {
  const date = new Date(value.trim());
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid --before date "${value}"; expected ISO 8601 (e.g. 2026-09-01)`);
  }
  return date;
}

async function runCompact(io: CliIo, options: CompactOptions): Promise<void> {
  const before = parseBefore(options.before);
  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    fail(io, resolutionMessage(resolution.reason));
  }

  const moved = await compactJournals(resolution.projectDir, before);
  io.stdout(`Archived ${moved} journal(s) before ${before.toISOString()}\n`);
}

export const compactCommand: CommandModule = {
  name: "compact",
  register(program, io) {
    program
      .command("compact")
      .description("Move journals older than a date into archive (never deletes)")
      .requiredOption("--before <date>", "archive journals before this ISO date")
      .action(async (options: CompactOptions) => {
        try {
          await runCompact(io, options);
        } catch (err) {
          failFrom(io, err);
        }
      });
  },
};
