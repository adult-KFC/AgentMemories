/** Result of scanning text for secret-shaped values. */
export interface RedactionResult {
  text: string;
  redacted: boolean;
  counts: Record<string, number>;
}

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const REDACTED = "[REDACTED]";

/**
 * Patterns are ordered so a full PEM block is consumed before its header can
 * be treated as a separate match. Every string here is intentionally narrow:
 * false positives would block legitimate notes such as "task-list".
 */
const RULES: readonly RedactionRule[] = [
  {
    name: "private_key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  {
    // A truncated PEM block still has to be refused.
    name: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  {
    // The left boundary keeps ordinary words such as "risk-management" and
    // "task-based-testing-run" from being treated as OpenAI keys.
    name: "openai_key",
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g,
    replacement: REDACTED,
  },
  {
    name: "github_token",
    pattern: /ghp_[A-Za-z0-9]{20,}/g,
    replacement: REDACTED,
  },
  {
    name: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: REDACTED,
  },
  {
    name: "bearer_token",
    pattern: /Bearer\s+[A-Za-z0-9._-]{12,}/g,
    replacement: `Bearer ${REDACTED}`,
  },
];

/**
 * Replaces secret-shaped substrings with `[REDACTED]`. `counts` contains one
 * entry per matched pattern name; a clean string yields an empty object.
 */
export function redactSecrets(text: string): RedactionResult {
  let result = text;
  const counts: Record<string, number> = {};

  for (const rule of RULES) {
    // RegExp objects with /g keep lastIndex state; rebuild to stay stateless.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let matches = 0;
    result = result.replace(pattern, () => {
      matches += 1;
      return rule.replacement;
    });
    if (matches > 0) counts[rule.name] = (counts[rule.name] ?? 0) + matches;
  }

  return { text: result, redacted: Object.keys(counts).length > 0, counts };
}
