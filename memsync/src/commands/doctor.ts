import { CommanderError } from "commander";
import type { CliIo } from "../cli.js";
import { runDoctor, type DoctorCheck } from "../core/doctor.js";
import type { CommandModule } from "./index.js";

interface DoctorOptions {
  json?: boolean;
}

function render(check: DoctorCheck): string {
  const status = check.ok ? "ok" : "FAIL";
  const detail = check.detail !== undefined ? `: ${check.detail}` : "";
  return `${status}  ${check.name}${detail}`;
}

async function run(io: CliIo, options: DoctorOptions): Promise<void> {
  const checks = await runDoctor(io.env);

  if (options.json === true) {
    io.stdout(`${JSON.stringify(checks, null, 2)}\n`);
  } else {
    io.stdout(`${checks.map(render).join("\n")}\n`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new CommanderError(
      1,
      "memsync.doctor.failed",
      `${failed.length} check(s) failed`,
    );
  }
}

export const doctorCommand: CommandModule = {
  name: "doctor",
  register(program, io) {
    program
      .command("doctor")
      .description("Diagnose config, repo, hooks, Codex capabilities, size, and clock")
      .option("--json", "print machine-readable results")
      .action(async (options: DoctorOptions) => {
        try {
          await run(io, options);
        } catch (err) {
          if (err instanceof CommanderError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          io.stderr(`memsync doctor: ${message}\n`);
          throw new CommanderError(1, "memsync.doctor.failed", message);
        }
      });
  },
};
