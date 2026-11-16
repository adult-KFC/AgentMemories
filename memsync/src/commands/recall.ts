import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import { recall } from "../core/recall.js";
import type { CommandModule } from "./index.js";

interface RecallCommandOptions {
  limit?: string;
  all?: boolean;
}

function fail(io: CliIo, message: string): never {
  io.stderr(`memsync recall: ${message}\n`);
  throw new CommanderError(1, "memsync.recall.failed", message);
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

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid --limit "${value}"; expected an integer between 1 and 20`);
  }
  return parsed;
}

async function runRecall(
  io: CliIo,
  query: string | undefined,
  options: RecallCommandOptions,
): Promise<void> {
  const trimmed = query?.trim() ?? "";
  if (trimmed.length === 0) {
    fail(io, "a query is required");
  }

  const limit = parseLimit(options.limit);
  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    fail(io, resolutionMessage(resolution.reason));
  }

  const hits = await recall(resolution.projectDir, trimmed, {
    ...(limit !== undefined ? { limit } : {}),
    all: options.all === true,
  });

  if (hits.length === 0) {
    io.stdout("No matches.\n");
    return;
  }

  for (const hit of hits) {
    const date = hit.date ?? "unknown";
    io.stdout(`${hit.path} (${hit.type}, ${date})\n${hit.snippet}\n\n`);
  }
}

export const recallCommand: CommandModule = {
  name: "recall",
  register(program, io) {
    program
      .command("recall <query>")
      .description("Search project memory for a bounded set of ranked hits")
      .option("--limit <n>", "maximum number of hits (1-20, default 5)")
      .option("--all", "return full matched text instead of truncated snippets")
      .action(async (query: string | undefined, options: RecallCommandOptions) => {
        try {
          await runRecall(io, query, options);
        } catch (err) {
          failFrom(io, err);
        }
      });
  },
};
