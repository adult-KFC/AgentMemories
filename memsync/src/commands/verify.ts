import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import {
  journalPath,
  listJournals,
  readJournalDocument,
} from "../core/journal.js";
import { verifyConstraintHistory } from "../core/proposals.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import type { CommandModule } from "./index.js";

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

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * §7.2 schema check plus the §7.1 filename convention
 * (`HHMMSS_<user>_<host>_<tool>_<short>.md` under `journal/YYYY-MM/YYYY-MM-DD`).
 * A malformed journal is reported instead of being silently skipped.
 */
async function verifyJournals(projectDir: string): Promise<string[]> {
  const issues: string[] = [];

  for (const path of await listJournals(projectDir)) {
    const display = toPosixPath(path);
    try {
      const { record } = await readJournalDocument(path);
      const expected = journalPath(projectDir, record);
      if (toPosixPath(expected) !== display) {
        issues.push(
          `${display}: filename does not match the naming convention (expected ${toPosixPath(expected)})`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push(`${display}: invalid journal (${message})`);
    }
  }

  return issues;
}

async function runVerify(io: CliIo): Promise<void> {
  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    throw new Error(resolutionMessage(resolution.reason));
  }

  const historyIssues = await verifyConstraintHistory(memoryRepo, resolution.slug);
  const journalIssues = await verifyJournals(resolution.projectDir);
  const journalCount = (await listJournals(resolution.projectDir)).length;

  for (const issue of historyIssues) {
    io.stderr(
      `memsync verify: ${issue.commit} modified ${issue.file} without Memsync-Approved-By:\n`,
    );
  }
  for (const issue of journalIssues) {
    io.stderr(`memsync verify: ${issue}\n`);
  }

  if (historyIssues.length === 0 && journalIssues.length === 0) {
    io.stdout(
      `Verified: constraint history and ${journalCount} journal file(s)\n`,
    );
    return;
  }

  const parts = [
    ...(historyIssues.length > 0
      ? [`${historyIssues.length} unapproved constraint change(s)`]
      : []),
    ...(journalIssues.length > 0
      ? [`${journalIssues.length} invalid journal file(s)`]
      : []),
  ];
  throw new CommanderError(1, "memsync.verify.failed", parts.join("; "));
}

export const verifyCommand: CommandModule = {
  name: "verify",
  register(program, io) {
    program
      .command("verify")
      .description("Check that authoritative constraints only changed through approval")
      .action(async () => {
        try {
          await runVerify(io);
        } catch (err) {
          if (err instanceof CommanderError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          io.stderr(`memsync verify: ${message}\n`);
          throw new CommanderError(1, "memsync.verify.failed", message);
        }
      });
  },
};
