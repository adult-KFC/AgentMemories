import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { memsyncHome, statePath } from "./paths.js";

export interface CachedPack {
  text: string;
  syncedAt: string;
}

function packsDir(env: NodeJS.ProcessEnv): string {
  return join(memsyncHome(env), "cache", "packs");
}

function packTextPath(env: NodeJS.ProcessEnv, slug: string): string {
  return join(packsDir(env), `${slug}.md`);
}

function packMetaPath(env: NodeJS.ProcessEnv, slug: string): string {
  return join(packsDir(env), `${slug}.meta.json`);
}

/** Returns the cached startup pack and its sync time, or undefined when absent. */
export async function readCachedPack(
  env: NodeJS.ProcessEnv,
  slug: string,
): Promise<CachedPack | undefined> {
  let text: string;
  try {
    text = await readFile(packTextPath(env, slug), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }

  let syncedAt = "unknown";
  try {
    const raw = await readFile(packMetaPath(env, slug), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).syncedAt === "string"
    ) {
      syncedAt = (parsed as Record<string, string>).syncedAt;
    }
  } catch {
    // A corrupt or missing sidecar still leaves the pack usable; the offline
    // warning just reports an unknown cache time.
  }

  return { text, syncedAt };
}

/** Writes the pack and its `{ syncedAt }` sidecar atomically. */
export async function writeCachedPack(
  env: NodeJS.ProcessEnv,
  slug: string,
  text: string,
  syncedAt: string,
): Promise<void> {
  await writeFileAtomic(packTextPath(env, slug), text);
  await writeFileAtomic(
    packMetaPath(env, slug),
    `${JSON.stringify({ syncedAt }, null, 2)}\n`,
  );
}

/** Cursor key: one entry per user, host, tool, and project. */
export function seenKey(
  projectSlug: string,
  email: string,
  host: string,
  tool: string,
): string {
  return `${email}|${host}|${tool}|${projectSlug}`;
}

/** Reads `$MEMSYNC_HOME/state/seen.json`; missing or corrupt files act as empty. */
export async function readSeen(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(statePath(env, "seen.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const seen: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) seen[key] = value;
  }
  return seen;
}

/** Atomically replaces the seen cursor file with sorted keys. */
export async function saveSeen(
  env: NodeJS.ProcessEnv,
  seen: Record<string, string>,
): Promise<void> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(seen).sort()) sorted[key] = seen[key];
  await writeFileAtomic(
    statePath(env, "seen.json"),
    `${JSON.stringify(sorted, null, 2)}\n`,
  );
}
