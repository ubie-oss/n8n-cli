import { describe, expect, test } from "bun:test";
import { preprocessTsWorkflow, TsPreprocessError } from "@/ts/preprocess.ts";

describe("preprocessTsWorkflow", () => {
  test("strips value imports so the SDK interpreter never sees them", () => {
    const { code } = preprocessTsWorkflow(
      `import { workflow, node } from "@n8n/workflow-sdk";\nconst a = node({});\n`,
    );

    expect(code).not.toContain("import");
    expect(code).toContain("const a = node({})");
  });

  test("strips type-only imports and type annotations", () => {
    const { code } = preprocessTsWorkflow(
      [
        `import type { NodeConfig } from "@n8n/workflow-sdk";`,
        `const cfg: NodeConfig = { name: "x" } as NodeConfig;`,
        "",
      ].join("\n"),
    );

    expect(code).not.toContain("NodeConfig");
    expect(code).toContain('const cfg = { name: "x" }');
  });

  test("keeps export default, which is how the SDK returns the workflow", () => {
    const { code } = preprocessTsWorkflow(`const wf = workflow("a", "b");\nexport default wf;\n`);

    expect(code).toContain("export default wf");
  });

  test("strips re-exports but not the default export", () => {
    const { code } = preprocessTsWorkflow(
      [`export * from "./other";`, `export { x } from "./other";`, "export default wf;", ""].join(
        "\n",
      ),
    );

    expect(code).not.toContain("./other");
    expect(code).toContain("export default wf");
  });

  test("blanks stripped statements in place, keeping the rest line-aligned", () => {
    // The metadata block is removed after transpiling, so the lines around it
    // must not shift — only the block itself becomes blank.
    const source = [
      `const wf = workflow("a", "b");`,
      "export const meta = { active: true };",
      "export default wf;",
      "",
    ].join("\n");

    const { code } = preprocessTsWorkflow(source);
    const lines = code.split("\n");

    expect(lines[0]).toContain("const wf");
    expect(lines[1]?.trim()).toBe("");
    expect(lines[2]).toContain("export default");
  });

  test("keeps template literal interpolations intact for the SDK to escape", () => {
    // `${$json.field}` is an n8n runtime variable, not a JS interpolation for us
    // to resolve — the SDK escapes it during parsing, so it must arrive verbatim.
    const interpolation = ["$", "{$json.field}"].join("");
    const { code } = preprocessTsWorkflow(`const a = { jsCode: \`value ${interpolation}\` };\n`);

    expect(code).toContain(interpolation);
  });

  test("keeps offsets correct when the source contains astral characters", () => {
    // Bun's transpiler escapes non-BMP characters, so compare the decoded value
    // rather than the literal text. The point of the test is that the surrounding
    // code survives intact — a UTF-16/code-point offset mix-up would corrupt it.
    const { code } = preprocessTsWorkflow(
      [
        `import { node } from "@n8n/workflow-sdk";`,
        `const a = node({ name: "🚀 launch", other: "kept" });`,
        "",
      ].join("\n"),
    );

    expect(code).not.toContain("import");
    expect(code).toContain('other: "kept"');
    expect(JSON.parse(`"${code.match(/name: "(.*?)"/)?.[1]}"`)).toBe("🚀 launch");
  });

  describe("metadata block", () => {
    test("lifts export const meta out of the code", () => {
      const { code, meta } = preprocessTsWorkflow(
        [
          "export const meta = { active: true, tags: ['prod', 'billing'] };",
          "export default wf;",
          "",
        ].join("\n"),
      );

      expect(meta).toEqual({ active: true, tags: ["prod", "billing"] });
      expect(code).not.toContain("meta");
      expect(code).toContain("export default wf");
    });

    test("defaults to an empty object when absent", () => {
      const { meta } = preprocessTsWorkflow("export default wf;\n");
      expect(meta).toEqual({});
    });

    test("survives a satisfies annotation", () => {
      const { meta } = preprocessTsWorkflow(
        "export const meta = { active: false } satisfies { active: boolean };\nexport default wf;\n",
      );
      expect(meta).toEqual({ active: false });
    });

    test("rejects a non-literal value rather than guessing", () => {
      expect(() => preprocessTsWorkflow("export const meta = { active: compute() };\n")).toThrow(
        TsPreprocessError,
      );
    });

    test("rejects wrongly typed fields", () => {
      expect(() => preprocessTsWorkflow("export const meta = { active: 'yes' };\n")).toThrow(
        /active must be a boolean/,
      );
      expect(() => preprocessTsWorkflow("export const meta = { tags: [1, 2] };\n")).toThrow(
        /tags must be an array of strings/,
      );
    });
  });

  test("reports a syntax error instead of throwing something opaque", () => {
    expect(() => preprocessTsWorkflow("const a = (((;\n")).toThrow(TsPreprocessError);
  });
});

describe("preprocessTsWorkflow metadata typing", () => {
  test("accepts updatedAt as a string", () => {
    const { meta } = preprocessTsWorkflow(
      'export const meta = { updatedAt: "2026-08-07T00:00:00.000Z" };\n',
    );
    expect(meta.updatedAt).toBe("2026-08-07T00:00:00.000Z");
  });

  test("rejects a non-string updatedAt", () => {
    expect(() => preprocessTsWorkflow("export const meta = { updatedAt: 123 };\n")).toThrow(
      /updatedAt must be a string/,
    );
  });
});
