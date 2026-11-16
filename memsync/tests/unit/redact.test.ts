import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/core/redact.js";

const OPENAI_KEY = "sk-abc123DEF456ghi789";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const BEARER = "Bearer abcdefghijkl.mnopqrst";
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA1234567890",
  "abcdefghijklmnopqrstuvwxyz",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

describe("redactSecrets", () => {
  it("leaves clean text untouched", () => {
    const result = redactSecrets("Finished the cart merge and added six tests.");
    expect(result.redacted).toBe(false);
    expect(result.text).toBe("Finished the cart merge and added six tests.");
    expect(result.counts).toEqual({});
  });

  it("redacts OpenAI-style keys", () => {
    const result = redactSecrets(`token ${OPENAI_KEY} end`);
    expect(result.redacted).toBe(true);
    expect(result.counts).toEqual({ openai_key: 1 });
    expect(result.text).not.toContain(OPENAI_KEY);
    expect(result.text).toContain("[REDACTED]");
  });

  it("redacts GitHub tokens", () => {
    const result = redactSecrets(`use ${GITHUB_TOKEN}`);
    expect(result.redacted).toBe(true);
    expect(result.counts).toEqual({ github_token: 1 });
    expect(result.text).not.toContain(GITHUB_TOKEN);
  });

  it("redacts AWS access key ids", () => {
    const result = redactSecrets(`aws ${AWS_KEY}`);
    expect(result.redacted).toBe(true);
    expect(result.counts).toEqual({ aws_access_key: 1 });
    expect(result.text).not.toContain(AWS_KEY);
  });

  it("redacts a whole PEM private key block", () => {
    const result = redactSecrets(`before\n${PEM}\nafter`);
    expect(result.redacted).toBe(true);
    expect(result.counts).toEqual({ private_key: 1 });
    expect(result.text).not.toContain("MIIEowIBAAKCAQEA1234567890");
    expect(result.text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(result.text).toContain("before");
    expect(result.text).toContain("after");
  });

  it("redacts bearer tokens but keeps the scheme readable", () => {
    const result = redactSecrets(`Authorization: ${BEARER}`);
    expect(result.redacted).toBe(true);
    expect(result.counts).toEqual({ bearer_token: 1 });
    expect(result.text).not.toContain("abcdefghijkl.mnopqrst");
    expect(result.text).toContain("Bearer [REDACTED]");
  });

  it("counts every occurrence across patterns", () => {
    const result = redactSecrets(`${OPENAI_KEY} and ${OPENAI_KEY} and ${GITHUB_TOKEN}`);
    expect(result.counts).toEqual({ openai_key: 2, github_token: 1 });
  });

  it("does not redact short or unrelated text", () => {
    const text = "sk-short task-list AKIA123";
    const result = redactSecrets(text);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe(text);
  });

  it("does not treat ordinary hyphenated words as OpenAI keys", () => {
    for (const text of [
      "risk-management",
      "disk-usage-trends",
      "desk-top-organization",
      "task-based-testing-run",
    ]) {
      const result = redactSecrets(text);
      expect(result.redacted, text).toBe(false);
      expect(result.text).toBe(text);
    }
  });

  it("still redacts a real key after a boundary", () => {
    const result = redactSecrets(`token:${OPENAI_KEY}`);
    expect(result.counts).toEqual({ openai_key: 1 });
    expect(result.text).toBe("token:[REDACTED]");
  });
});
