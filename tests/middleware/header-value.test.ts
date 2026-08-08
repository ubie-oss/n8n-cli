import { describe, expect, test } from "bun:test";
import { sanitizeHeaderValue } from "@/middleware/header-value.ts";

describe("sanitizeHeaderValue", () => {
  test("passes an ordinary token through untouched", () => {
    expect(sanitizeHeaderValue("n8n_api_abc123", "ctx")).toBe("n8n_api_abc123");
  });

  test("trims the trailing newline a file-mounted secret arrives with", () => {
    // Left to reach `Headers.set`, this becomes a 502 on every matching request
    // with the real cause nowhere in sight.
    expect(sanitizeHeaderValue("token-value\n", "ctx")).toBe("token-value");
    expect(sanitizeHeaderValue("  token-value\r\n", "ctx")).toBe("token-value");
  });

  test("rejects an embedded line break, naming the context", () => {
    expect(() =>
      sanitizeHeaderValue("good\nX-Evil: yes", "bearer-token-inject: rule for /a/"),
    ).toThrow(/bearer-token-inject: rule for \/a\/: token contains a character/);
  });

  test("rejects other control characters", () => {
    expect(() => sanitizeHeaderValue(`tok${String.fromCharCode(0)}en`, "ctx")).toThrow(
      /cannot appear in an HTTP/,
    );
  });

  test("keeps interior spaces — scheme-and-value is a legal header", () => {
    expect(sanitizeHeaderValue("Basic dXNlcjpwYXNz", "ctx")).toBe("Basic dXNlcjpwYXNz");
  });

  test("rejects a value that is nothing but whitespace", () => {
    expect(() => sanitizeHeaderValue("   \n", "ctx")).toThrow(/token is empty/);
  });
});
