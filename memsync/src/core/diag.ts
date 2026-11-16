import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { statePath } from "./paths.js";

/**
 * Diagnostics are append-only JSONL. Callers pass counts, lengths, and similar
 * metadata; every string is replaced by a short hash before it hits disk so a
 * secret can never be persisted verbatim.
 */
export function diagnosticHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function sanitizeField(value: unknown): unknown {
  if (typeof value === "string") return diagnosticHash(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizeField).filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeField(nested);
      // undefined/null-ish values are omitted rather than serialized as noise.
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }
  return undefined;
}

/**
 * Appends one diagnostics line to `$MEMSYNC_HOME/state/diagnostics.jsonl`.
 * `event` stays readable; all fields are hashed or numeric.
 */
export async function diagnostic(
  event: string,
  fields: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = statePath(env, "diagnostics.jsonl");
  const sanitized = sanitizeField(fields) as Record<string, unknown> | undefined;
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...(sanitized ?? {}),
  };

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
}
