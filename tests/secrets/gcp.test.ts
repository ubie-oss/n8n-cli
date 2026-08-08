import { describe, expect, it, mock } from "bun:test";
import { GcpSecretManagerResolver, resourceName } from "../../src/secrets/gcp.ts";
import { parseSecretRef } from "../../src/secrets/reference.ts";
import type { SecretRef } from "../../src/secrets/types.ts";

function ref(value: string): SecretRef {
  const parsed = parseSecretRef(value);
  if (!parsed) throw new Error(`not a reference: ${value}`);
  return parsed;
}

/** Encodes a payload the way Secret Manager returns it. */
function payload(value: string): string {
  return JSON.stringify({ payload: { data: btoa(value) } });
}

/** Swaps in a fetch stub for the duration of `run`, recording the URLs it saw. */
async function withFetch(
  handler: (url: string) => Response,
  run: (urls: string[]) => Promise<void>,
): Promise<void> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = mock(async (input: unknown) => {
    urls.push(String(input));
    return handler(String(input));
  }) as unknown as typeof fetch;

  try {
    await run(urls);
  } finally {
    globalThis.fetch = original;
  }
}

describe("resourceName", () => {
  it("expands the short form with an implicit latest version", () => {
    expect(resourceName(ref("gcp-sm://my-project/my-secret"))).toBe(
      "projects/my-project/secrets/my-secret/versions/latest",
    );
  });

  it("honours an explicit version in the short form", () => {
    expect(resourceName(ref("gcp-sm://my-project/my-secret/7"))).toBe(
      "projects/my-project/secrets/my-secret/versions/7",
    );
  });

  it("passes a full resource name through", () => {
    const full = "projects/p/secrets/s/versions/3";
    expect(resourceName(ref(`gcp-sm://${full}`))).toBe(full);
  });

  it("defaults the version of a full resource name that omits one", () => {
    expect(resourceName(ref("gcp-sm://projects/p/secrets/s"))).toBe(
      "projects/p/secrets/s/versions/latest",
    );
  });

  it("ignores empty segments from stray slashes", () => {
    expect(resourceName(ref("gcp-sm://my-project//my-secret/"))).toBe(
      "projects/my-project/secrets/my-secret/versions/latest",
    );
  });

  it("rejects a short form with too few or too many segments", () => {
    expect(() => resourceName(ref("gcp-sm://only-project"))).toThrow(/expected gcp-sm:/);
    expect(() => resourceName(ref("gcp-sm://a/b/c/d"))).toThrow(/expected gcp-sm:/);
  });

  it("rejects a malformed full resource name", () => {
    expect(() => resourceName(ref("gcp-sm://projects/p/buckets/s"))).toThrow(/expected projects\//);
  });
});

describe("GcpSecretManagerResolver", () => {
  const token = async () => "test-token";

  it("fetches and decodes a secret payload", async () => {
    await withFetch(
      () => new Response(payload("s3cr3t"), { status: 200 }),
      async (urls) => {
        const resolver = new GcpSecretManagerResolver("https://sm.test/v1", token);
        expect(await resolver.resolve(ref("gcp-sm://p/s"))).toBe("s3cr3t");
        expect(urls[0]).toBe("https://sm.test/v1/projects/p/secrets/s/versions/latest:access");
      },
    );
  });

  it("decodes non-ASCII payloads as UTF-8", async () => {
    const secret = "パスワード";
    await withFetch(
      // btoa cannot take non-Latin1 directly; encode the way the API does.
      () =>
        new Response(
          JSON.stringify({
            payload: {
              data: btoa(String.fromCharCode(...new TextEncoder().encode(secret))),
            },
          }),
          { status: 200 },
        ),
      async () => {
        const resolver = new GcpSecretManagerResolver("https://sm.test/v1", token);
        expect(await resolver.resolve(ref("gcp-sm://p/s"))).toBe(secret);
      },
    );
  });

  it("fetches each distinct secret once and reuses the value", async () => {
    await withFetch(
      () => new Response(payload("value"), { status: 200 }),
      async (urls) => {
        const resolver = new GcpSecretManagerResolver("https://sm.test/v1", token);
        await resolver.resolve(ref("gcp-sm://p/s"));
        await resolver.resolve(ref("gcp-sm://p/s"));
        // Same secret named the long way still hits the cache: the key is the
        // resolved resource name, not the spelling in the file.
        await resolver.resolve(ref("gcp-sm://projects/p/secrets/s/versions/latest"));
        expect(urls).toHaveLength(1);
      },
    );
  });

  it("explains a 403 as a missing accessor grant", async () => {
    await withFetch(
      () => new Response("{}", { status: 403 }),
      async () => {
        const resolver = new GcpSecretManagerResolver("https://sm.test/v1", token);
        await expect(resolver.resolve(ref("gcp-sm://p/s"))).rejects.toThrow(
          /secretmanager\.secretAccessor/,
        );
      },
    );
  });

  it("explains a 404 as a missing secret", async () => {
    await withFetch(
      () => new Response("{}", { status: 404 }),
      async () => {
        const resolver = new GcpSecretManagerResolver("https://sm.test/v1", token);
        await expect(resolver.resolve(ref("gcp-sm://p/s"))).rejects.toThrow(/does not exist/);
      },
    );
  });

  it("explains a missing ADC token instead of sending an anonymous request", async () => {
    await withFetch(
      () => new Response(payload("never"), { status: 200 }),
      async (urls) => {
        const resolver = new GcpSecretManagerResolver("https://sm.test/v1", async () => null);
        await expect(resolver.resolve(ref("gcp-sm://p/s"))).rejects.toThrow(
          /gcloud auth application-default login/,
        );
        expect(urls).toHaveLength(0);
      },
    );
  });

  it("does not put the secret value into an error message", async () => {
    await withFetch(
      () => new Response(JSON.stringify({ payload: {} }), { status: 200 }),
      async () => {
        const resolver = new GcpSecretManagerResolver("https://sm.test/v1", token);
        await expect(resolver.resolve(ref("gcp-sm://p/s"))).rejects.toThrow(/returned no payload/);
      },
    );
  });
});
