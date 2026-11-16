import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { loadConfig } from "../core/config.js";
import { approveProposal } from "../core/proposals.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import type { CommandModule } from "./index.js";

interface ApproveOptions {
  force?: boolean;
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

async function runApprove(io: CliIo, id: string, options: ApproveOptions): Promise<void> {
  const proposalId = id.trim();
  if (proposalId.length === 0) throw new Error("proposal id is required");

  const config = await loadConfig(io.env);
  if (config === undefined) {
    throw new Error("memory repo is not configured; run memsync init first");
  }

  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    throw new Error(resolutionMessage(resolution.reason));
  }

  const result = await approveProposal(resolution.projectDir, proposalId, config.identity, {
    ...(options.force === true ? { force: true } : {}),
  });

  if (!result.applied) {
    throw new Error(result.reason ?? `proposal ${proposalId} was not applied`);
  }

  io.stdout(`Approved proposal ${proposalId}\n`);
  if (options.force === true) {
    io.stderr(`Warning: forced approval by ${config.identity.email} was recorded\n`);
  }
}

export const approveCommand: CommandModule = {
  name: "approve",
  register(program, io) {
    program
      .command("approve <id>")
      .description("Approve a proposal as a project owner and apply its change")
      .option("--force", "approve even when the identity is not an owner")
      .action(async (id: string, options: ApproveOptions) => {
        try {
          await runApprove(io, id, options);
        } catch (err) {
          if (err instanceof CommanderError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          io.stderr(`memsync approve: ${message}\n`);
          throw new CommanderError(1, "memsync.approve.failed", message);
        }
      });
  },
};
