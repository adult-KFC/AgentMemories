import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli.js";
import { VERSION } from "../../src/version.js";

function fakeIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      cwd: process.cwd(),
      env: process.env,
      stdin: async () => "",
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    },
  };
}

describe("memsync CLI", () => {
  it("prints the package version", async () => {
    const { io, out } = fakeIo();
    const code = await runCli(["--version"], io);
    expect(code).toBe(0);
    expect(out.join("").trim()).toBe(VERSION);
    expect(out.join("")).toMatch(/\d+\.\d+\.\d+/);
  });

  it("returns a non-zero exit code for unknown options instead of exiting", async () => {
    const { io, err } = fakeIo();
    const code = await runCli(["--definitely-not-a-flag"], io);
    expect(code).not.toBe(0);
    expect(err.join("")).toMatch(/unknown option/i);
  });
});
