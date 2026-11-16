import { CommanderError } from "commander";
import { hostname } from "node:os";
import type { CliIo } from "../cli.js";
import { loadConfig } from "../core/config.js";
import type { ConstraintItem, ConstraintOp } from "../core/constraints.js";
import { createProposal, type CreateProposalInput } from "../core/proposals.js";
import { memoryRepoForEnv, resolveProject } from "../core/project.js";
import type { CommandModule } from "./index.js";

const OPS: readonly ConstraintOp[] = ["add", "replace", "remove", "supersede"];
const CONSTRAINT_FILES: readonly string[] = ["constraints.md", "org/conventions.md"];

interface ConstraintProposeOptions {
  title?: string;
  section?: string;
  op?: string;
  item?: string[];
  match?: string;
  appliesWhen?: string;
  doNotApplyWhen?: string;
  rationale?: string;
  tool?: string;
  file?: string;
}

interface DecisionProposeOptions {
  title?: string;
  rationale?: string;
  tool?: string;
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

function collect(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

function toolFor(io: CliIo, option: string | undefined): string {
  return option?.trim() || io.env.MEMSYS_TOOL?.trim() || "claude-code";
}

function hostFor(io: CliIo): string {
  return io.env.MEMSYS_HOST?.trim() || hostname();
}

async function proposalContext(io: CliIo): Promise<{
  projectDir: string;
  author: string;
}> {
  const config = await loadConfig(io.env);
  if (config === undefined) {
    throw new Error("memory repo is not configured; run memsync init first");
  }

  const memoryRepo = await memoryRepoForEnv(io.env);
  const resolution = await resolveProject(io.cwd, memoryRepo, io.env);
  if (!resolution.ok) {
    throw new Error(resolutionMessage(resolution.reason));
  }

  return { projectDir: resolution.projectDir, author: config.identity.name };
}

function requireValue(value: string | undefined, flag: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) throw new Error(`${flag} is required`);
  return trimmed;
}

async function runProposeConstraint(
  io: CliIo,
  options: ConstraintProposeOptions,
): Promise<void> {
  const title = requireValue(options.title, "--title");
  const section = requireValue(options.section, "--section");
  const op = requireValue(options.op, "--op") as ConstraintOp;
  if (!OPS.includes(op)) {
    throw new Error(`invalid --op "${options.op}"; expected one of ${OPS.join(", ")}`);
  }

  const match = options.match?.trim();
  if ((op === "replace" || op === "remove" || op === "supersede") && !match) {
    throw new Error(`--match is required for op "${op}"`);
  }

  const rawItems = (options.item ?? []).map((item) => item.trim()).filter(Boolean);
  if ((op === "add" || op === "replace" || op === "supersede") && rawItems.length === 0) {
    throw new Error(`at least one --item is required for op "${op}"`);
  }

  const file = options.file?.trim() || "constraints.md";
  if (!CONSTRAINT_FILES.includes(file)) {
    throw new Error(
      `invalid --file "${file}"; expected one of ${CONSTRAINT_FILES.join(", ")}`,
    );
  }

  const appliesWhen = options.appliesWhen?.trim();
  const doNotApplyWhen = options.doNotApplyWhen?.trim();
  const items: (string | ConstraintItem)[] =
    appliesWhen !== undefined || doNotApplyWhen !== undefined
      ? rawItems.map((text) => ({
          text,
          ...(appliesWhen !== undefined && appliesWhen.length > 0 ? { appliesWhen } : {}),
          ...(doNotApplyWhen !== undefined && doNotApplyWhen.length > 0
            ? { doNotApplyWhen }
            : {}),
        }))
      : rawItems;

  const { projectDir, author } = await proposalContext(io);
  const input: CreateProposalInput = {
    kind: "constraint",
    title,
    rationale: options.rationale?.trim() ?? "",
    change: {
      file,
      section,
      op,
      // An empty hash tells createProposal to pin the current section content.
      section_hash: "",
      ...(match !== undefined && match.length > 0 ? { match } : {}),
      items,
    },
    author,
    tool: toolFor(io, options.tool),
    host: hostFor(io),
  };

  const created = await createProposal(projectDir, input);
  io.stdout(`Created proposal ${created.id}\n`);
  io.stdout(`Path: ${created.path}\n`);
}

async function runProposeDecision(
  io: CliIo,
  options: DecisionProposeOptions,
): Promise<void> {
  const title = requireValue(options.title, "--title");
  const rationale = requireValue(options.rationale, "--rationale");
  const { projectDir, author } = await proposalContext(io);

  const created = await createProposal(projectDir, {
    kind: "decision",
    title,
    rationale,
    author,
    tool: toolFor(io, options.tool),
    host: hostFor(io),
  });
  io.stdout(`Created proposal ${created.id}\n`);
  io.stdout(`Path: ${created.path}\n`);
}

function fail(io: CliIo, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  io.stderr(`memsync propose: ${message}\n`);
  throw new CommanderError(1, "memsync.propose.failed", message);
}

export const proposeCommand: CommandModule = {
  name: "propose",
  register(program, io) {
    const propose = program
      .command("propose")
      .description("Create a governance proposal for constraints or decisions");

    propose
      .command("constraint")
      .description("Propose a structured change to the project constraints")
      .requiredOption("--title <title>", "short proposal title")
      .requiredOption("--section <section>", "constraint section heading, e.g. 禁止")
      .requiredOption("--op <op>", `change operation (${OPS.join("|")})`)
      .option(
        "--file <file>",
        "constraint file to change (constraints.md or org/conventions.md)",
        "constraints.md",
      )
      .option("--item <text>", "constraint item (repeatable)", collect)
      .option("--match <text>", "existing item text for replace/remove/supersede")
      .option("--applies-when <condition>", "applicability sub-item for the new items")
      .option("--do-not-apply-when <condition>", "exception sub-item for the new items")
      .option("--rationale <text>", "why the constraint should change")
      .option("--tool <tool>", "authoring tool name")
      .action(async (options: ConstraintProposeOptions) => {
        try {
          await runProposeConstraint(io, options);
        } catch (err) {
          if (err instanceof CommanderError) throw err;
          fail(io, err);
        }
      });

    propose
      .command("decision")
      .description("Propose a decision; approval creates an ADR")
      .requiredOption("--title <title>", "decision title")
      .requiredOption("--rationale <text>", "why this decision is needed")
      .option("--tool <tool>", "authoring tool name")
      .action(async (options: DecisionProposeOptions) => {
        try {
          await runProposeDecision(io, options);
        } catch (err) {
          if (err instanceof CommanderError) throw err;
          fail(io, err);
        }
      });
  },
};
