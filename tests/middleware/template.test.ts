import { describe, expect, test } from "bun:test";
import { expandRecord, expandTemplate } from "@/middleware/template.ts";

describe("template: expandTemplate", () => {
  test("${env:X} expands from env bindings", () => {
    expect(expandTemplate("Bearer ${env:TOKEN}", { env: { TOKEN: "abc" } })).toBe("Bearer abc");
  });

  test("${env:X} expands to empty string when unset", () => {
    expect(expandTemplate("Bearer ${env:MISSING}", { env: {} })).toBe("Bearer ");
  });

  test("${json:identity} expands to a quoted JSON string", () => {
    expect(expandTemplate('{"email": ${json:identity}}', { env: {}, identity: "a@b.c" })).toBe(
      '{"email": "a@b.c"}',
    );
  });

  test('${json:identity} expands to "" when undefined', () => {
    expect(expandTemplate('{"email": ${json:identity}}', { env: {} })).toBe('{"email": ""}');
  });

  test("identity values with quotes are escaped via JSON.stringify", () => {
    expect(expandTemplate('{"id": ${json:identity}}', { env: {}, identity: 'has"quote' })).toBe(
      '{"id": "has\\"quote"}',
    );
  });

  test("unknown json: variable expands to empty (only identity is exposed)", () => {
    expect(expandTemplate("${json:groups}", { env: {} })).toBe("");
  });

  test("non-token text is left intact", () => {
    expect(expandTemplate("plain text", { env: {} })).toBe("plain text");
  });

  test("multiple tokens in one string", () => {
    const out = expandTemplate("u=${json:identity} t=${env:TOKEN}", {
      env: { TOKEN: "tk" },
      identity: "ryo",
    });
    expect(out).toBe('u="ryo" t=tk');
  });
});

describe("template: expandRecord", () => {
  test("expands every value, leaves keys intact", () => {
    const out = expandRecord(
      { Authorization: "Bearer ${env:TOKEN}", "X-Trace": "${json:identity}" },
      { env: { TOKEN: "tk" }, identity: "ryo" },
    );
    expect(out).toEqual({ Authorization: "Bearer tk", "X-Trace": '"ryo"' });
  });
});
