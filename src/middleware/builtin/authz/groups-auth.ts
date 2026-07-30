import { AdcImpersonateTokenSource } from "@/middleware/builtin/iap-auth/adc-impersonate-source.ts";
import {
  EnvTokenSource,
  MetadataServerTokenSource,
  type TokenSource,
} from "@/middleware/builtin/iap-auth/token-source.ts";
import type { GroupsAuthSpec } from "./types.ts";

/**
 * Turns a `GroupsAuthSpec` into a function that stamps credentials onto the
 * outgoing groups request.
 *
 * The token sources are the ones `iap-auth` already uses, so a groups API
 * behind an identity-aware proxy needs no new machinery — and both directions
 * share one vocabulary for "where do id_tokens come from".
 */
export type GroupsAuthenticator = (headers: Record<string, string>) => Promise<void>;

export function buildGroupsAuthenticator(
  spec: GroupsAuthSpec | undefined,
  env: NodeJS.ProcessEnv = process.env,
): GroupsAuthenticator | undefined {
  if (!spec || spec.kind === "none") return undefined;

  if (spec.kind === "bearer-env") {
    if (!spec.tokenEnvVar) {
      throw new Error("authz: groups.auth.kind=bearer-env requires groups.auth.tokenEnvVar");
    }
    const varName = spec.tokenEnvVar;
    return async (headers) => {
      const token = env[varName];
      if (!token) {
        throw new Error(`authz: groups auth env var ${varName} is not set or empty`);
      }
      headers.authorization = `Bearer ${token}`;
    };
  }

  // gcp-id-token
  if (!spec.audience) {
    throw new Error(
      "authz: groups.auth.kind=gcp-id-token requires groups.auth.audience " +
        "(the aud the groups endpoint's gateway expects)",
    );
  }
  const audience = spec.audience;
  const source: TokenSource =
    spec.tokenSource === "adc-impersonate"
      ? buildAdcSource(spec)
      : new MetadataServerTokenSource({
          impersonateServiceAccount: spec.impersonateServiceAccount,
        });
  return async (headers) => {
    headers.authorization = `Bearer ${await source.getToken(audience)}`;
  };
}

function buildAdcSource(spec: GroupsAuthSpec): TokenSource {
  if (!spec.impersonateServiceAccount) {
    throw new Error(
      "authz: groups.auth.tokenSource=adc-impersonate requires groups.auth.impersonateServiceAccount",
    );
  }
  return new AdcImpersonateTokenSource(spec.impersonateServiceAccount);
}

/** Re-exported so tests can inject a trivial source without touching the network. */
export { EnvTokenSource };
