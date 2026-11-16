import type { Command } from "commander";
import type { CliIo } from "../cli.js";
import { approveCommand } from "./approve.js";
import { compactCommand } from "./compact.js";
import { doctorCommand } from "./doctor.js";
import { hookCommand } from "./hook.js";
import { initCommand } from "./init.js";
import { installCommand } from "./install.js";
import { linkCommand } from "./link.js";
import { maintainCommand } from "./maintain.js";
import { noteCommand } from "./note.js";
import { projectCommand } from "./project.js";
import { proposeCommand } from "./propose.js";
import { recallCommand } from "./recall.js";
import { releaseCommand } from "./release.js";
import { reportCommand } from "./report.js";
import { runCommand } from "./run.js";
import { sessionCommand } from "./session.js";
import { stateCommand } from "./state.js";
import { statusCommand } from "./status.js";
import { syncCommand } from "./sync.js";
import { verifyCommand } from "./verify.js";
import { versionCommand } from "./version.js";

export interface CommandModule {
  name: string;
  register(program: Command, io: CliIo): void;
}

/** Registry of CLI command modules; each module registers itself on the root program. */
export const commands: CommandModule[] = [
  initCommand,
  projectCommand,
  linkCommand,
  noteCommand,
  sessionCommand,
  syncCommand,
  installCommand,
  hookCommand,
  runCommand,
  proposeCommand,
  approveCommand,
  recallCommand,
  verifyCommand,
  versionCommand,
  releaseCommand,
  stateCommand,
  reportCommand,
  maintainCommand,
  compactCommand,
  statusCommand,
  doctorCommand,
];
