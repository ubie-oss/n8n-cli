import { describe, expect, it } from "bun:test";
import { EnvSecretResolver } from "../../src/secrets/env.ts";
import { findSecretRefs, resolveSecretRefs } from "../../src/secrets/registry.ts";
import {
  type SecretRef,
  SecretResolveError,
  type SecretResolver,
} from "../../src/secrets/types.ts";

/** A resolver that answers from a fixed table, so tests need no network. */
function fakeResolver(scheme: string, values: Record<string, string>): SecretResolver {
  return {
    scheme,
    description: `fake ${scheme}`,
    async resolve(ref: SecretRef) {
      const value = values[ref.locator];
      if (value === undefined) throw new SecretResolveError(ref, "not found");
      return value;
    },
  };
}

describe("resolveSecretRefs", () => {
  const resolvers = [fakeResolver("vault", { "a/b": "SECRET-AB", "c/d": "SECRET-CD" })];

  it("replaces a reference with its value", async () => {
    expect(await resolveSecretRefs("vault://a/b", resolvers)).toBe("SECRET-AB");
  });

  it("leaves ordinary values alone", async () => {
    expect(await resolveSecretRefs("literal", resolvers)).toBe("literal");
    expect(await resolveSecretRefs(42, resolvers)).toBe(42);
    expect(await resolveSecretRefs(null, resolvers)).toBeNull();
    expect(await resolveSecretRefs(true, resolvers)).toBe(true);
  });

  it("leaves a reference whose scheme no resolver claims", async () => {
    // The check that keeps an OAuth endpoint or a database URL in a credential
    // from being treated as a lookup.
    expect(await resolveSecretRefs("https://example.com", resolvers)).toBe("https://example.com");
    expect(await resolveSecretRefs("postgres://db/app", resolvers)).toBe("postgres://db/app");
  });

  it("recurses through nested objects and arrays", async () => {
    const input = {
      token: "vault://a/b",
      nested: { inner: "vault://c/d", plain: "keep" },
      list: ["vault://a/b", "keep"],
    };

    expect(await resolveSecretRefs(input, resolvers)).toEqual({
      token: "SECRET-AB",
      nested: { inner: "SECRET-CD", plain: "keep" },
      list: ["SECRET-AB", "keep"],
    });
  });

  it("does not rewrite object keys that look like references", async () => {
    // A key is a credential field name; rewriting one would produce a
    // credential n8n cannot interpret.
    expect(await resolveSecretRefs({ "vault://a/b": "value" }, resolvers)).toEqual({
      "vault://a/b": "value",
    });
  });

  it("does not mutate the input", async () => {
    const input = { token: "vault://a/b" };
    await resolveSecretRefs(input, resolvers);
    expect(input.token).toBe("vault://a/b");
  });

  it("reports the field path of a reference that fails", async () => {
    const promise = resolveSecretRefs({ outer: { inner: "vault://missing" } }, resolvers);
    await expect(promise).rejects.toThrow(/at outer\.inner/);
  });
});

describe("findSecretRefs", () => {
  const resolvers = [fakeResolver("vault", {})];

  it("lists references with their field paths, without resolving them", () => {
    const found = findSecretRefs(
      { token: "vault://a/b", nested: { list: ["vault://c/d", "plain"] } },
      resolvers,
    );

    expect(found.map((f) => f.path)).toEqual(["token", "nested.list.0"]);
    expect(found.map((f) => f.ref.raw)).toEqual(["vault://a/b", "vault://c/d"]);
  });

  it("ignores references of unclaimed schemes", () => {
    expect(findSecretRefs({ url: "https://example.com" }, resolvers)).toEqual([]);
  });
});

describe("EnvSecretResolver", () => {
  it("reads the named variable", async () => {
    const resolver = new EnvSecretResolver({ TOKEN: "abc" });
    expect(await resolveSecretRefs("env://TOKEN", [resolver])).toBe("abc");
  });

  it("fails when the variable is unset", async () => {
    const resolver = new EnvSecretResolver({});
    await expect(resolveSecretRefs("env://TOKEN", [resolver])).rejects.toThrow(/is not set/);
  });

  it("fails when the variable is empty, rather than clearing the credential", async () => {
    const resolver = new EnvSecretResolver({ TOKEN: "" });
    await expect(resolveSecretRefs("env://TOKEN", [resolver])).rejects.toThrow(/is empty/);
  });

  it("rejects a locator that is not a bare variable name", async () => {
    const resolver = new EnvSecretResolver({ TOKEN: "abc" });
    await expect(resolveSecretRefs("env://some/path", [resolver])).rejects.toThrow(
      /expected env:\/\/<VARIABLE_NAME>/,
    );
  });
});
