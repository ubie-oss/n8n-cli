import { describe, expect, test } from "bun:test";
import {
  stripFileHeaders,
  stripJavaScriptHeaders,
  stripSQLHeaders,
  stripMarkdownHeaders,
} from "@/yaml/generator.ts";

describe("stripJavaScriptHeaders", () => {
  test("strips JS header comments", () => {
    const input = "// Node: MyNode\n// Workflow: MyWF\n\nconsole.log('hello');";
    expect(stripJavaScriptHeaders(input)).toBe("console.log('hello');");
  });

  test("returns code unchanged when no headers", () => {
    const input = "console.log('hello');";
    expect(stripJavaScriptHeaders(input)).toBe("console.log('hello');");
  });
});

describe("stripSQLHeaders", () => {
  test("strips SQL header comments", () => {
    const input = "-- Node: SQLNode\n-- Workflow: MyWF\n\nSELECT 1;";
    expect(stripSQLHeaders(input)).toBe("SELECT 1;");
  });

  test("returns code unchanged when no headers", () => {
    const input = "SELECT 1;";
    expect(stripSQLHeaders(input)).toBe("SELECT 1;");
  });
});

describe("stripMarkdownHeaders", () => {
  test("strips MD header comments", () => {
    const input = "<!-- Node: MDNode -->\n<!-- Workflow: MyWF -->\n\n# Title";
    const [clean, hasExpr] = stripMarkdownHeaders(input);
    expect(clean).toBe("# Title");
    expect(hasExpr).toBe(false);
  });

  test("strips MD header with expression prefix", () => {
    const input = "=<!-- Node: MDNode -->\n<!-- Workflow: MyWF -->\n\n{{ $json.msg }}";
    const [clean, hasExpr] = stripMarkdownHeaders(input);
    expect(clean).toBe("{{ $json.msg }}");
    expect(hasExpr).toBe(true);
  });

  test("returns code unchanged when no headers", () => {
    const [clean, hasExpr] = stripMarkdownHeaders("# Title");
    expect(clean).toBe("# Title");
    expect(hasExpr).toBe(false);
  });
});

describe("stripFileHeaders", () => {
  test("strips headers from .js files", () => {
    const input = "// Node: MyNode\n// Workflow: MyWF\n\nconsole.log('hello');";
    expect(stripFileHeaders(input, "code.js")).toBe("console.log('hello');");
  });

  test("strips headers from .sql files", () => {
    const input = "-- Node: SQLNode\n-- Workflow: MyWF\n\nSELECT 1;";
    expect(stripFileHeaders(input, "query.sql")).toBe("SELECT 1;");
  });

  test("strips headers from .md files without expression", () => {
    const input = "<!-- Node: MDNode -->\n<!-- Workflow: MyWF -->\n\n# Title";
    expect(stripFileHeaders(input, "doc.md")).toBe("# Title");
  });

  test("strips headers from .md files with expression prefix", () => {
    const input = "=<!-- Node: MDNode -->\n<!-- Workflow: MyWF -->\n\n{{ $json.msg }}";
    expect(stripFileHeaders(input, "prompt.md")).toBe("={{ $json.msg }}");
  });

  test("returns content unchanged for unknown extensions", () => {
    const input = "some content";
    expect(stripFileHeaders(input, "data.txt")).toBe("some content");
  });

  test("returns content unchanged when no headers present", () => {
    const input = "console.log('no headers');";
    expect(stripFileHeaders(input, "code.js")).toBe("console.log('no headers');");
  });
});
