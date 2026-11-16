import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  loadConfig,
  memsyncHome,
  saveConfig,
  validateIdentity,
} from "../../src/core/config.js";
import type { GlobalConfig } from "../../src/types.js";

describe("memsyncHome", () => {
  it("uses MEMSYNC_HOME when set", () => {
    expect(memsyncHome({ MEMSYNC_HOME: "/tmp/mem" })).toBe("/tmp/mem");
  });

  it("defaults to ~/.memsync", () => {
    expect(memsyncHome({})).toBe(join(homedir(), ".memsync"));
  });
});

describe("validateIdentity", () => {
  it("rejects identity without email", () => {
    expect(() => validateIdentity({ name: "alice", email: "" })).toThrow(/email/i);
  });

  it("rejects identity without name", () => {
    expect(() => validateIdentity({ name: "", email: "alice@corp.com" })).toThrow(/name/i);
    expect(() => validateIdentity({ name: "   ", email: "alice@corp.com" })).toThrow(/name/i);
  });

  it("rejects malformed email addresses", () => {
    for (const email of ["alice", "alice@", "@corp.com", "alice@corp@"]) {
      expect(() => validateIdentity({ name: "Alice", email })).toThrow(/email/i);
    }
  });

  it("returns the validated identity", () => {
    expect(validateIdentity({ name: "Alice", email: "alice@corp.com" })).toEqual({
      name: "Alice",
      email: "alice@corp.com",
    });
  });
});

describe("global config", () => {
  const config: GlobalConfig = {
    version: 1,
    repoPath: "/tmp/mem/repo",
    remoteUrl: "git@x:y.git",
    identity: { name: "Alice", email: "alice@corp.com" },
    defaultBudgetChars: 12000,
  };

  it("round-trips global config", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-"));
    const env = { MEMSYNC_HOME: home };
    const expected = { ...config, repoPath: join(home, "repo") };
    await saveConfig(env, expected);
    expect(await loadConfig(env)).toEqual(expected);
  });

  it("returns undefined when the config file is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-"));
    expect(await loadConfig({ MEMSYNC_HOME: home })).toBeUndefined();
  });

  it("creates $MEMSYNC_HOME when saving", async () => {
    const home = join(await mkdtemp(join(tmpdir(), "memsync-")), "nested", "home");
    await saveConfig({ MEMSYNC_HOME: home }, config);
    expect(await loadConfig({ MEMSYNC_HOME: home })).toEqual(config);
    await expect(readdir(home)).resolves.toContain("config.json");
  });

  it("throws ConfigError for malformed JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-"));
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), "{ not json", "utf8");
    await expect(loadConfig({ MEMSYNC_HOME: home })).rejects.toBeInstanceOf(ConfigError);
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["an empty object", "{}"],
  ])("throws ConfigError for %s", async (_label, body) => {
    const home = await mkdtemp(join(tmpdir(), "memsync-"));
    await writeFile(join(home, "config.json"), body, "utf8");
    await expect(loadConfig({ MEMSYNC_HOME: home })).rejects.toThrow(/invalid config at/i);
  });

  it("throws ConfigError when a required key is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "memsync-"));
    const { remoteUrl: _remoteUrl, ...withoutRemote } = config;
    await writeFile(join(home, "config.json"), JSON.stringify(withoutRemote), "utf8");
    await expect(loadConfig({ MEMSYNC_HOME: home })).rejects.toBeInstanceOf(ConfigError);
  });
});
