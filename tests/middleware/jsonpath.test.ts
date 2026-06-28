import { describe, expect, test } from "bun:test";
import { compileJSONPath, evaluateJSONPath, JSONPathCompileError } from "@/middleware/jsonpath.ts";

describe("jsonpath: dotted keys", () => {
  test("$.a.b returns nested value", () => {
    expect(evaluateJSONPath("$.a.b", { a: { b: 1 } })).toEqual([1]);
  });

  test("missing key returns []", () => {
    expect(evaluateJSONPath("$.a.b", { a: {} })).toEqual([]);
  });
});

describe("jsonpath: wildcard", () => {
  test("$.groups[*].id returns each id", () => {
    const input = { groups: [{ id: "g1" }, { id: "g2" }] };
    expect(evaluateJSONPath("$.groups[*].id", input)).toEqual(["g1", "g2"]);
  });

  test("$.tags[*].name returns names", () => {
    const input = { tags: [{ name: "owner:eng" }, { name: "owner:ops" }, { name: "production" }] };
    expect(evaluateJSONPath("$.tags[*].name", input)).toEqual([
      "owner:eng",
      "owner:ops",
      "production",
    ]);
  });

  test("wildcard over object yields values", () => {
    expect(evaluateJSONPath("$.map[*]", { map: { a: 1, b: 2 } })).toEqual([1, 2]);
  });
});

describe("jsonpath: bracketed keys and indexes", () => {
  test("$['weird key']", () => {
    expect(evaluateJSONPath("$['weird key']", { "weird key": 7 })).toEqual([7]);
  });

  test("$.list[0]", () => {
    expect(evaluateJSONPath("$.list[0]", { list: ["a", "b"] })).toEqual(["a"]);
  });

  test("$.list[2] out of range yields []", () => {
    expect(evaluateJSONPath("$.list[2]", { list: ["a", "b"] })).toEqual([]);
  });
});

describe("jsonpath: compile errors", () => {
  test("missing $ throws", () => {
    expect(() => compileJSONPath(".a.b")).toThrow(JSONPathCompileError);
  });

  test("unsupported filter throws", () => {
    expect(() => compileJSONPath("$.x[?(@.y=='z')]")).toThrow(JSONPathCompileError);
  });

  test("unclosed bracket throws", () => {
    expect(() => compileJSONPath("$.x[0")).toThrow(JSONPathCompileError);
  });

  test("empty expression throws", () => {
    expect(() => compileJSONPath("")).toThrow(JSONPathCompileError);
  });
});

describe("jsonpath: compiled re-use", () => {
  test("a compiled path can evaluate multiple inputs", () => {
    const compiled = compileJSONPath("$.groups[*].id");
    expect(compiled.evaluate({ groups: [{ id: "x" }] })).toEqual(["x"]);
    expect(compiled.evaluate({ groups: [{ id: "y" }, { id: "z" }] })).toEqual(["y", "z"]);
  });
});
