import { describe, expect, test } from "bun:test";
import { AdcImpersonateTokenSource } from "@/middleware/builtin/iap-auth/adc-impersonate-source.ts";
import { iapAuthFactory } from "@/middleware/builtin/iap-auth/factory.ts";

/**
 * Minting a gateway id_token from a developer laptop: there is no metadata
 * server there, so the caller credential comes from ADC and the id_token is
 * minted as the target service account through the IAM Credentials API.
 */

const CREDS = {
  type: "authorized_user",
  client_id: "client-abc.apps.googleusercontent.com",
  client_secret: "secret",
  refresh_token: "refresh",
};

const TARGET = "gate@example.iam.gserviceaccount.com";

interface Call {
  url: string;
  body: string;
  auth?: string;
}

function makeSource(
  opts: {
    creds?: Record<string, unknown>;
    idTokenStatus?: number;
    idTokenBody?: unknown;
    now?: () => number;
  } = {},
) {
  const calls: Call[] = [];
  const source = new AdcImpersonateTokenSource(TARGET, {
    readCredentials: async () => (opts.creds ?? CREDS) as never,
    tokenEndpoint: "https://token.test/token",
    iamCredentialsBaseUrl: "https://iam.test/v1",
    now: opts.now,
    fetcher: async (url, init) => {
      calls.push({
        url,
        body: String(init?.body ?? ""),
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      if (url === "https://token.test/token") {
        return new Response(JSON.stringify({ access_token: "caller-access-token" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(opts.idTokenBody ?? { token: "minted-id-token" }), {
        status: opts.idTokenStatus ?? 200,
      });
    },
  });
  return { source, calls };
}

describe("AdcImpersonateTokenSource", () => {
  test("exchanges ADC for an access token, then mints an id_token as the target SA", async () => {
    const { source, calls } = makeSource();

    const token = await source.getToken("https://gateway.example.run.app");

    expect(token).toBe("minted-id-token");
    expect(calls).toHaveLength(2);
    // 1) refresh_token grant WITHOUT an audience — we want an access_token here.
    expect(calls[0]!.url).toBe("https://token.test/token");
    expect(calls[0]!.body).toContain("grant_type=refresh_token");
    expect(calls[0]!.body).not.toContain("audience=");
    // 2) generateIdToken on the target SA, authorised by that access_token.
    expect(calls[1]!.url).toBe(
      `https://iam.test/v1/projects/-/serviceAccounts/${encodeURIComponent(TARGET)}:generateIdToken`,
    );
    expect(calls[1]!.auth).toBe("Bearer caller-access-token");
    expect(JSON.parse(calls[1]!.body)).toEqual({
      audience: "https://gateway.example.run.app",
      includeEmail: true,
    });
  });

  test("caches per audience so a multi-call command mints once", async () => {
    const { source, calls } = makeSource({ now: () => 1_000 });

    await source.getToken("aud-a");
    await source.getToken("aud-a");
    await source.getToken("aud-b");

    // 2 calls for the first audience, 2 more for the second — not 6.
    expect(calls).toHaveLength(4);
  });

  test("service-account key files are rejected with a pointer to the right source", async () => {
    const { source } = makeSource({ creds: { type: "service_account" } });

    await expect(source.getToken("aud")).rejects.toThrow(/authorized_user.*metadata/s);
  });

  test("an incomplete ADC file says how to fix it", async () => {
    const { source } = makeSource({ creds: { type: "authorized_user" } });

    await expect(source.getToken("aud")).rejects.toThrow(/application-default login/);
  });

  test("a denied impersonation names the role the caller is missing", async () => {
    const { source } = makeSource({ idTokenStatus: 403, idTokenBody: { error: "forbidden" } });

    await expect(source.getToken("aud")).rejects.toThrow(/serviceAccountTokenCreator/);
  });
});

describe("iapAuthFactory: adc-impersonate", () => {
  test("requires the target service account", () => {
    expect(() =>
      iapAuthFactory.build({ audience: "aud", tokenSourceKind: "adc-impersonate" }),
    ).toThrow(/impersonateServiceAccount/);
  });

  test("builds when the target is given", () => {
    expect(() =>
      iapAuthFactory.build({
        audience: "aud",
        tokenSourceKind: "adc-impersonate",
        impersonateServiceAccount: TARGET,
      }),
    ).not.toThrow();
  });

  test("is selectable from the environment", () => {
    const opts = iapAuthFactory.loadFromEnv({
      N8N_IAP_AUTH_TOKEN_SOURCE: "adc-impersonate",
      N8N_IAP_AUTH_IMPERSONATE_SERVICE_ACCOUNT: TARGET,
    } as NodeJS.ProcessEnv);

    expect(opts.tokenSourceKind).toBe("adc-impersonate");
    expect(opts.impersonateServiceAccount).toBe(TARGET);
  });
});
