import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all MemorySync state; defaults to ~/.memsync. */
export function memsyncHome(env: NodeJS.ProcessEnv): string {
  const configured = env.MEMSYNC_HOME;
  return configured && configured.length > 0 ? configured : join(homedir(), ".memsync");
}

export function configPath(env: NodeJS.ProcessEnv): string {
  return join(memsyncHome(env), "config.json");
}

/** Cross-process lock serializing memory-repo mutation and pulls. */
export function lockPath(env: NodeJS.ProcessEnv): string {
  return join(memsyncHome(env), "lock");
}

export function statePath(env: NodeJS.ProcessEnv, name: string): string {
  return join(memsyncHome(env), "state", name);
}

export function cachePath(env: NodeJS.ProcessEnv, name: string): string {
  return join(memsyncHome(env), "cache", name);
}
