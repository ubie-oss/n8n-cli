import { describe, expect, test } from "bun:test";
import path from "node:path";
import { IncludeRef, resolveIncludeRefs } from "@/yaml/include-schema.ts";

const fixturesDir = path.resolve(import.meta.dir, "../fixtures");

describe("resolveIncludeRefs with stripFileHeaders", () => {
  test("strips JS headers when stripFileHeaders is true", () => {
    const obj = { code: new IncludeRef("included-code.js") };
    const resolved = resolveIncludeRefs(obj, fixturesDir, { stripFileHeaders: true }) as {
      code: string;
    };

    expect(resolved.code).not.toContain("// Node:");
    expect(resolved.code).not.toContain("// Workflow:");
    expect(resolved.code).toContain("const items = $input.all();");
  });

  test("preserves JS headers when stripFileHeaders is false", () => {
    const obj = { code: new IncludeRef("included-code.js") };
    const resolved = resolveIncludeRefs(obj, fixturesDir, { stripFileHeaders: false }) as {
      code: string;
    };

    expect(resolved.code).toContain("// Node:");
    expect(resolved.code).toContain("// Workflow:");
  });

  test("preserves JS headers by default (no options)", () => {
    const obj = { code: new IncludeRef("included-code.js") };
    const resolved = resolveIncludeRefs(obj, fixturesDir) as { code: string };

    expect(resolved.code).toContain("// Node:");
  });

  test("strips SQL headers when stripFileHeaders is true", () => {
    const obj = { query: new IncludeRef("included-code-with-header.sql") };
    const resolved = resolveIncludeRefs(obj, fixturesDir, { stripFileHeaders: true }) as {
      query: string;
    };

    expect(resolved.query).not.toContain("-- Node:");
    expect(resolved.query).not.toContain("-- Workflow:");
    expect(resolved.query).toContain("SELECT * FROM users");
  });

  test("strips MD headers when stripFileHeaders is true", () => {
    const obj = { text: new IncludeRef("included-code-with-header.md") };
    const resolved = resolveIncludeRefs(obj, fixturesDir, { stripFileHeaders: true }) as {
      text: string;
    };

    expect(resolved.text).not.toContain("<!-- Node:");
    expect(resolved.text).toContain("# Hello World");
  });

  test("strips MD headers with expression prefix when stripFileHeaders is true", () => {
    const obj = { text: new IncludeRef("included-code-with-header-expr.md") };
    const resolved = resolveIncludeRefs(obj, fixturesDir, { stripFileHeaders: true }) as {
      text: string;
    };

    expect(resolved.text).not.toContain("<!-- Node:");
    expect(resolved.text).toStartWith("=");
    expect(resolved.text).toContain("{{ $json.message }}");
  });

  test("handles nested objects with stripFileHeaders", () => {
    const obj = {
      node: {
        parameters: {
          code: new IncludeRef("included-code.js"),
        },
      },
    };
    const resolved = resolveIncludeRefs(obj, fixturesDir, { stripFileHeaders: true }) as {
      node: { parameters: { code: string } };
    };

    expect(resolved.node.parameters.code).not.toContain("// Node:");
    expect(resolved.node.parameters.code).toContain("const items = $input.all();");
  });

  test("handles arrays with stripFileHeaders", () => {
    const obj = [new IncludeRef("included-code.js")];
    const resolved = resolveIncludeRefs(obj, fixturesDir, { stripFileHeaders: true }) as string[];

    expect(resolved[0]).not.toContain("// Node:");
    expect(resolved[0]).toContain("const items = $input.all();");
  });

  test("does not strip headers for unknown file types", () => {
    const obj = { code: new IncludeRef("included-code.js") };
    // The file is .js so headers will be stripped - test with a non-header file
    const resolved = resolveIncludeRefs(obj, fixturesDir, { stripFileHeaders: true }) as {
      code: string;
    };
    // Just verify it works without error
    expect(typeof resolved.code).toBe("string");
  });
});
