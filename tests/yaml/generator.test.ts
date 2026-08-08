import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import {
  buildYamlObject,
  stripFileHeaders,
  stripJavaScriptHeaders,
  stripMarkdownHeaders,
  stripSQLHeaders,
} from "@/yaml/generator.ts";

describe("buildYamlObject", () => {
  const baseWorkflow: Workflow = {
    id: "wf-1",
    name: "Test Workflow",
    active: true,
    nodes: [],
    connections: {},
  };

  test("includes tags with id and name only", () => {
    const workflow: Workflow = {
      ...baseWorkflow,
      tags: [
        { id: "tag-1", name: "production", createdAt: "2024-01-01", updatedAt: "2024-01-02" },
        { id: "tag-2", name: "critical" },
      ],
    };
    const result = buildYamlObject(workflow, {});
    expect(result.tags).toEqual([
      { id: "tag-1", name: "production" },
      { id: "tag-2", name: "critical" },
    ]);
  });

  test("omits id when tag has no id", () => {
    const workflow: Workflow = {
      ...baseWorkflow,
      tags: [{ name: "new-tag" }],
    };
    const result = buildYamlObject(workflow, {});
    expect(result.tags).toEqual([{ name: "new-tag" }]);
  });

  test("omits tags field when tags array is empty", () => {
    const workflow: Workflow = {
      ...baseWorkflow,
      tags: [],
    };
    const result = buildYamlObject(workflow, {});
    expect(result.tags).toBeUndefined();
  });

  test("omits tags field when tags is undefined", () => {
    const result = buildYamlObject(baseWorkflow, {});
    expect(result.tags).toBeUndefined();
  });

  test("records updatedAt so apply can tell an update from a revert", () => {
    const result = buildYamlObject({ ...baseWorkflow, updatedAt: "2026-03-01T10:00:00.000Z" }, {});
    expect(result.updatedAt).toBe("2026-03-01T10:00:00.000Z");
    // Written before the bulk of the document, where a reader will see it.
    expect(Object.keys(result).indexOf("updatedAt")).toBeLessThan(
      Object.keys(result).indexOf("nodes"),
    );
  });

  test("omits updatedAt for a workflow that carries none", () => {
    const result = buildYamlObject(baseWorkflow, {});
    expect(result.updatedAt).toBeUndefined();
  });
});

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
