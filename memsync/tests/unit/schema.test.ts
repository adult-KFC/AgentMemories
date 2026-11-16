import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectMetaNotFoundError,
  SchemaError,
  parseFrontMatter,
  readProjectMeta,
  serializeFrontMatter,
  validateProjectMeta,
} from "../../src/core/schema.js";

const VALID_META = {
  slug: "checkout-service",
  repos: ["git@git.corp.com:shop/checkout-service.git"],
  owners: ["alice@corp.com"],
  current_version: "0.1.0",
  maintenance: { interval_hours: 72, cooldown_hours: 6, mainline_only: true },
};

describe("front matter", () => {
  it("round-trips data and body", () => {
    const data = {
      id: "ab12cd",
      tool: "claude-code",
      commits: ["3a1f2c9", "88de001"],
      nested: { version_hint: "0.4.0" },
    };
    const text = serializeFrontMatter(data, "## 工作摘要\n\n一句话。\n");

    const parsed = parseFrontMatter<typeof data>(text);
    expect(parsed.data).toEqual(data);
    expect(parsed.body).toBe("## 工作摘要\n\n一句话。\n");
  });

  it("handles CRLF and a BOM", () => {
    const text = "﻿---\r\nid: ab12cd\r\n---\r\n\r\n## Body\r\n";
    const parsed = parseFrontMatter<{ id: string }>(text);
    expect(parsed.data).toEqual({ id: "ab12cd" });
    expect(parsed.body).toBe("## Body\n");
  });

  it("returns the whole text when no front matter is present", () => {
    const parsed = parseFrontMatter<Record<string, never>>("# Plain\n");
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe("# Plain\n");
  });

  it("throws SchemaError for malformed YAML", () => {
    expect(() => parseFrontMatter("---\n: : :\n---\nbody")).toThrow(SchemaError);
  });

  it("throws SchemaError for unclosed front matter", () => {
    expect(() => parseFrontMatter("---\nid: ab12cd\nbody")).toThrow(SchemaError);
  });

  it("throws SchemaError when front matter is not a mapping", () => {
    expect(() => parseFrontMatter("---\n- one\n- two\n---\nbody")).toThrow(SchemaError);
  });
});

describe("validateProjectMeta", () => {
  it("accepts a minimal meta and applies defaults", () => {
    expect(validateProjectMeta(VALID_META)).toMatchObject({
      ...VALID_META,
      version_status: "active",
      context_budget_chars: 12000,
    });
  });

  it("preserves optional fields", () => {
    const meta = validateProjectMeta({
      ...VALID_META,
      name: "结算服务",
      default_branch: "main",
      version_status: "frozen",
      context_budget_chars: 8000,
      created: "2026-11-13",
    });
    expect(meta.name).toBe("结算服务");
    expect(meta.default_branch).toBe("main");
    expect(meta.version_status).toBe("frozen");
    expect(meta.context_budget_chars).toBe(8000);
    expect(meta.created).toBe("2026-11-13");
  });

  it.each(["slug", "repos", "owners", "current_version", "maintenance"])(
    "throws SchemaError when %s is missing",
    (key) => {
      const input: Record<string, unknown> = { ...VALID_META };
      delete input[key];
      expect(() => validateProjectMeta(input)).toThrow(SchemaError);
    },
  );

  it("throws SchemaError for non-object input", () => {
    for (const input of [null, undefined, [], "text", 42]) {
      expect(() => validateProjectMeta(input)).toThrow(SchemaError);
    }
  });

  it("rejects invalid slugs", () => {
    for (const slug of ["", "Checkout", "-checkout", "checkout_service", " checkout"]) {
      expect(() => validateProjectMeta({ ...VALID_META, slug })).toThrow(SchemaError);
    }
  });

  it("requires at least one repo", () => {
    expect(() => validateProjectMeta({ ...VALID_META, repos: [] })).toThrow(SchemaError);
    expect(() => validateProjectMeta({ ...VALID_META, repos: "git@x:y.git" })).toThrow(SchemaError);
  });

  it("requires owners to be email addresses", () => {
    expect(() => validateProjectMeta({ ...VALID_META, owners: [] })).toThrow(SchemaError);
    expect(() => validateProjectMeta({ ...VALID_META, owners: ["alice"] })).toThrow(SchemaError);
  });

  it("validates maintenance fields", () => {
    expect(() =>
      validateProjectMeta({ ...VALID_META, maintenance: { interval_hours: 72 } }),
    ).toThrow(SchemaError);
    expect(() =>
      validateProjectMeta({ ...VALID_META, maintenance: { ...VALID_META.maintenance, interval_hours: 0 } }),
    ).toThrow(SchemaError);
    expect(() =>
      validateProjectMeta({
        ...VALID_META,
        maintenance: { ...VALID_META.maintenance, mainline_only: "yes" },
      }),
    ).toThrow(SchemaError);
  });

  it("rejects an unknown version status", () => {
    expect(() =>
      validateProjectMeta({ ...VALID_META, version_status: "draft" }),
    ).toThrow(SchemaError);
  });
});

describe("readProjectMeta", () => {
  it("reads meta.yaml from a project directory", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "memsync-meta-"));
    await writeFile(
      join(projectDir, "meta.yaml"),
      [
        "slug: checkout-service",
        "repos:",
        "  - git@git.corp.com:shop/checkout-service.git",
        "owners:",
        "  - alice@corp.com",
        "current_version: 0.1.0",
        "maintenance:",
        "  interval_hours: 72",
        "  cooldown_hours: 6",
        "  mainline_only: true",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(await readProjectMeta(projectDir)).toMatchObject({
      slug: "checkout-service",
      owners: ["alice@corp.com"],
      current_version: "0.1.0",
    });
  });

  it("throws ProjectMetaNotFoundError when meta.yaml is missing", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "memsync-meta-"));
    await expect(readProjectMeta(projectDir)).rejects.toBeInstanceOf(ProjectMetaNotFoundError);
  });

  it("throws SchemaError for malformed meta", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "memsync-meta-"));
    await writeFile(join(projectDir, "meta.yaml"), "slug: [unclosed\n", "utf8");
    await expect(readProjectMeta(projectDir)).rejects.toBeInstanceOf(SchemaError);
  });

  it("throws SchemaError when required fields are missing", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "memsync-meta-"));
    await writeFile(join(projectDir, "meta.yaml"), "slug: checkout-service\n", "utf8");
    await expect(readProjectMeta(projectDir)).rejects.toBeInstanceOf(SchemaError);
  });
});
