import { describe, expect, it } from "bun:test";
import { isSecretRefFor, parseSecretRef } from "../../src/secrets/reference.ts";

describe("parseSecretRef", () => {
  it("parses a scheme and locator", () => {
    expect(parseSecretRef("gcp-sm://my-project/my-secret")).toEqual({
      scheme: "gcp-sm",
      locator: "my-project/my-secret",
      raw: "gcp-sm://my-project/my-secret",
    });
  });

  it("lowercases the scheme but leaves the locator untouched", () => {
    const ref = parseSecretRef("ENV://My_Var");
    expect(ref?.scheme).toBe("env");
    expect(ref?.locator).toBe("My_Var");
  });

  it("returns null for a value that is not a reference", () => {
    expect(parseSecretRef("plain-token-value")).toBeNull();
    expect(parseSecretRef("")).toBeNull();
  });

  it("returns null when the scheme has no locator", () => {
    expect(parseSecretRef("gcp-sm://")).toBeNull();
  });

  it("does not match a reference embedded in a longer string", () => {
    // Only a whole value is a reference. Matching mid-string would mean
    // guessing where the reference ends.
    expect(parseSecretRef("prefix gcp-sm://p/s")).toBeNull();
    expect(parseSecretRef("gcp-sm://p/s suffix")?.locator).toBe("p/s suffix");
  });

  it("parses ordinary URLs as references of an unclaimed scheme", () => {
    // Parsing is not claiming: the registry decides whether a scheme belongs to
    // a resolver, and https does not — so an https value survives resolution.
    expect(parseSecretRef("https://example.com/hook")?.scheme).toBe("https");
    expect(isSecretRefFor("https://example.com/hook", ["gcp-sm", "env"])).toBe(false);
  });
});

describe("isSecretRefFor", () => {
  it("matches only the given schemes", () => {
    expect(isSecretRefFor("env://TOKEN", ["env"])).toBe(true);
    expect(isSecretRefFor("env://TOKEN", ["gcp-sm"])).toBe(false);
  });

  it("is false for non-strings", () => {
    expect(isSecretRefFor(42, ["env"])).toBe(false);
    expect(isSecretRefFor(null, ["env"])).toBe(false);
    expect(isSecretRefFor({ a: "env://X" }, ["env"])).toBe(false);
  });
});
