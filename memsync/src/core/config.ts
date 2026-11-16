import { readFile } from "node:fs/promises";
import type { GlobalConfig, Identity } from "../types.js";
import { writeFileAtomic } from "./atomic.js";
import { configPath } from "./paths.js";

export { memsyncHome } from "./paths.js";

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

/** Returns undefined when the config file is absent; throws ConfigError on malformed JSON. */
export async function loadConfig(env: NodeJS.ProcessEnv): Promise<GlobalConfig | undefined> {
  const path = configPath(env);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid config JSON at ${path}`, { cause: err });
  }

  return assertGlobalConfig(parsed, path);
}

const REQUIRED_CONFIG_KEYS = [
  "version",
  "repoPath",
  "remoteUrl",
  "identity",
  "defaultBudgetChars",
] as const;

function assertGlobalConfig(value: unknown, path: string): GlobalConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`Invalid config at ${path}`);
  }

  const candidate = value as Record<string, unknown>;
  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!(key in candidate) || candidate[key] === undefined) {
      throw new ConfigError(`Invalid config at ${path}`);
    }
  }

  return value as GlobalConfig;
}

/** Creates $MEMSYNC_HOME when missing and replaces config.json atomically. */
export async function saveConfig(env: NodeJS.ProcessEnv, config: GlobalConfig): Promise<void> {
  await writeFileAtomic(configPath(env), `${JSON.stringify(config, null, 2)}\n`);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

/** Validates the single source of identity used for commits and ownership. */
export function validateIdentity(input: { name?: string; email?: string }): Identity {
  const name = input.name?.trim() ?? "";
  if (name.length === 0) {
    throw new Error("Identity name is required");
  }

  const email = input.email?.trim() ?? "";
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error("Identity email is required and must contain a local part and a domain");
  }

  return { name, email };
}
