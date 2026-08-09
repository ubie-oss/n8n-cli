import type { Command } from "commander";
import { parseTagFilter } from "@/common/tags.ts";
import { parseMiddlewareList } from "@/middleware/registry.ts";
import { parseEnforceLevel } from "@/proxy/config.ts";
import { parseRoutes } from "@/proxy/rest/router.ts";
import { startProxy } from "@/proxy/server.ts";

interface ProxyOptions {
  listen: string;
  upstream?: string;
  lintConfig?: string;
  enforce: string;
  disableRule?: string[];
  logFormat: string;
  allowDuplicates?: boolean;
  duplicateTtl?: string;
  upstreamTimeout?: string;
  serverMiddleware?: string;
  clientMiddleware?: string;
  tags?: string;
  routes?: string;
  // iap-auth client-middleware options.
  iapAuthAudience?: string;
  iapAuthTokenSource?: string;
  iapAuthTokenEnvVar?: string;
  iapAuthHeaderName?: string;
  iapAuthCacheTtlMs?: string;
  iapAuthTimeoutMs?: string;
  iapAuthMetadataBaseUrl?: string;
  iapAuthImpersonateServiceAccount?: string;
  iapAuthIamCredentialsBaseUrl?: string;
  // api-key-inject client-middleware options. The key value is NEVER taken
  // directly on the CLI — only the name of an env var that holds it.
  apiKeyInjectKeyEnvVar?: string;
  apiKeyInjectHeader?: string;
  apiKeyInjectConflictPolicy?: string;
  // webhook-token-inject client-middleware options. Rules travel as JSON; the
  // token values inside them should be env-var references rather than literals
  // for the same reason api-key-inject refuses a raw key here.
  webhookTokenInjectRules?: string;
  // bearer-token-inject client-middleware options. Same shape and same
  // reasoning as webhook-token-inject's rules.
  bearerTokenInjectRules?: string;
  // impersonator-token client-middleware options. Attaches the user's own
  // Google id_token as a side header so the server can attribute the call
  // to the human running the CLI (instead of the impersonated SA).
  impersonatorTokenAudience?: string;
  impersonatorTokenSource?: string;
  impersonatorTokenEnvVar?: string;
  impersonatorTokenOnError?: string;
  // Authz middleware options (flat namespace so commander stays happy).
  authzEnforce?: string;
  authzOnError?: string;
  authzIdentitySource?: string;
  authzIdentityName?: string;
  authzIdentityDecode?: string;
  authzIdentityClaim?: string;
  authzGroupsUrl?: string;
  authzGroupsMethod?: string;
  authzGroupsHeaders?: string;
  authzGroupsBody?: string;
  authzGroupsExtract?: string;
  authzGroupsCacheTtlMs?: string;
  authzGroupsTimeoutMs?: string;
  authzWorkflowExtract?: string;
  authzWorkflowStripPrefix?: string;
  authzAclSource?: string;
  authzAclCacheTtlMs?: string;
  authzOnMissingAcl?: string;
  authzBootstrapGroups?: string;
  authzActions?: string;
  // stale-write server middleware options.
  staleWriteEnforce?: string;
  staleWriteOnMissingBase?: string;
  staleWriteOnError?: string;
  staleWriteActions?: string;
  // oauth-verify server middleware options. Verifies the incoming
  // Authorization: Bearer against Google's tokeninfo endpoint.
  oauthVerifyEnforce?: string;
  oauthVerifyExpectedAudiences?: string;
  oauthVerifyTrustedPrincipals?: string;
  // impersonator-verify server middleware options. Verifies the side
  // header carrying the human user's id_token attached by the client.
  impersonatorVerifyEnforce?: string;
  impersonatorVerifyRequirement?: string;
  impersonatorVerifyExpectedAudiences?: string;
}

export function registerProxyCommand(program: Command): void {
  program
    .command("proxy")
    .description(
      "Run a transparent HTTP proxy that intercepts n8n public-API workflow saves and runs middleware (lint, authz, ...)",
    )
    .option("--listen <addr>", "Address to bind (host:port or :port)", ":8080")
    .option("--upstream <url>", "Upstream n8n base URL (env: N8N_API_URL)")
    .option("-c, --lint-config <path>", "Path to .n8nlintrc.json (auto-discovered if omitted)")
    .option("--enforce <level>", "Enforcement level for workflow saves: off, warn, error", "error")
    .option("--disable-rule <rules...>", "Disable specific rules (can be repeated)")
    .option("--log-format <fmt>", "Log format: text, json", "text")
    .option(
      "--allow-duplicates",
      "Skip the upstream duplicate-name check on POST /api/v1/workflows (the check is on by default; under enforce=error a match returns 409, under enforce=warn a header is attached)",
    )
    .option("--duplicate-ttl <ms>", "TTL (ms) for the cached upstream workflow-name index", "60000")
    .option(
      "--upstream-timeout <ms>",
      "Per-request upstream timeout in milliseconds (0 disables)",
      "30000",
    )
    .option(
      "--server-middleware <list>",
      "Comma-separated server-middleware chain (default: lint; env: N8N_SERVER_MIDDLEWARES). Example: lint,authz",
    )
    .option(
      "--client-middleware <list>",
      "Comma-separated client-middleware chain run on outgoing upstream requests (default: empty; env: N8N_CLIENT_MIDDLEWARES). Example: iap-auth,api-key-inject",
    )
    // iap-auth options — only meaningful when "iap-auth" is in the client-middleware chain.
    .option(
      "--iap-auth-audience <id>",
      "OAuth2 client_id of the IAP-protected upstream backend (sets the id_token aud claim)",
    )
    .option(
      "--iap-auth-token-source <kind>",
      "Where to obtain the id_token: metadata (GCE metadata server, default), env, static",
    )
    .option(
      "--iap-auth-token-env-var <name>",
      "Env var holding a pre-minted id_token (token-source=env)",
    )
    .option(
      "--iap-auth-header-name <name>",
      "Header the id_token is written to: authorization (default) or proxy-authorization. Use proxy-authorization when the upstream application needs a bearer token of its own in Authorization — IAP then reads the id_token from Proxy-Authorization and forwards Authorization to the backend unread. The proxy, not the caller, must supply that token (see --bearer-token-inject-rules): a caller's own Authorization is still discarded. env: N8N_IAP_AUTH_HEADER_NAME",
    )
    .option(
      "--iap-auth-cache-ttl-ms <ms>",
      "Id-token cache lifetime in milliseconds (default: 3000000, i.e. 50 min)",
    )
    .option(
      "--iap-auth-timeout-ms <ms>",
      "HTTP timeout per metadata-server call in milliseconds (default: 5000)",
    )
    .option("--iap-auth-metadata-base-url <url>", "Override the metadata server base URL (testing)")
    .option(
      "--iap-auth-impersonate-service-account <email>",
      "Target service-account email to impersonate. When set, the proxy mints id_tokens for THIS SA via iamcredentials.googleapis.com:generateIdToken. The workload SA needs roles/iam.serviceAccountTokenCreator on it.",
    )
    .option(
      "--iap-auth-iam-credentials-base-url <url>",
      "Override the iamcredentials API base URL (testing)",
    )
    // api-key-inject options — only meaningful when "api-key-inject" is in the client-middleware chain.
    .option(
      "--api-key-inject-key-env-var <name>",
      "Name of the env var holding the shared API key value (the raw key is never accepted on the CLI). env: N8N_API_KEY_INJECT_KEY or N8N_API_KEY_INJECT_KEY_ENV_VAR.",
    )
    .option(
      "--api-key-inject-header <name>",
      "Header to inject the shared API key into (default: X-N8N-API-KEY)",
    )
    .option(
      "--api-key-inject-conflict-policy <policy>",
      "Behavior when the incoming request already carries the header: replace (default) or set-if-absent",
    )
    // webhook-token-inject options — only meaningful when "webhook-token-inject"
    // is in the client-middleware chain.
    .option(
      "--webhook-token-inject-rules <json>",
      "JSON array of path-scoped webhook token rules: " +
        '[{"pathPrefix":"/webhook/x/","header":"x-token","tokenEnvVar":"X_TOKEN"}]. ' +
        "Each rule needs exactly one of tokenEnvVar (preferred) or token, and an " +
        "optional conflictPolicy of set-if-absent (default) or replace. " +
        "env: N8N_WEBHOOK_TOKEN_INJECT_RULES",
    )
    // bearer-token-inject options — only meaningful when "bearer-token-inject"
    // is in the client-middleware chain.
    .option(
      "--bearer-token-inject-rules <json>",
      "JSON array of path-scoped Authorization rules: " +
        '[{"pathPrefix":"/mcp-server/","tokenEnvVar":"MCP_TOKEN"}]. ' +
        "Each rule needs exactly one of tokenEnvVar (preferred) or token, and an " +
        'optional scheme (default "Bearer"). Requires --iap-auth-header-name=' +
        "proxy-authorization when the upstream sits behind IAP. " +
        "env: N8N_BEARER_TOKEN_INJECT_RULES",
    )
    .option(
      "--tags <tags>",
      "Only run middleware against workflow saves whose tags contain ALL of the listed names (AND condition; env: PROXY_FILTER_BY_TAGS). Non-matching saves are forwarded transparently.",
    )
    .option(
      "--routes <table>",
      "Endpoints to treat as policy-relevant, one per line or comma-separated: " +
        '"METHOD /path/:id -> action [body=workflow]" (env: N8N_PROXY_ROUTES). ' +
        "Defaults to workflow create/update/tags/delete/activate.",
    )
    // Authz options — only meaningful when "authz" is in the server-middleware chain.
    .option("--authz-enforce <level>", "Authz enforcement level: off, warn, error")
    .option("--authz-on-error <mode>", "Behavior when groups API fails: deny, allow")
    .option("--authz-identity-source <kind>", "Where to read identity from: header, env, none")
    .option("--authz-identity-name <name>", "Header or env-var name holding the identity")
    .option("--authz-identity-decode <mode>", "Identity decode strategy: raw, jwt")
    .option("--authz-identity-claim <name>", "JWT claim name (decode=jwt)")
    .option("--authz-groups-url <url>", "Groups API endpoint")
    .option("--authz-groups-method <method>", "HTTP method for groups API", "POST")
    .option("--authz-groups-headers <json>", "Headers (JSON object string)")
    .option(
      "--authz-groups-body <template>",
      "Body template; supports ${env:X} and ${json:identity}",
    )
    .option("--authz-groups-extract <jsonpath>", "JSONPath to extract group ids from response")
    .option("--authz-groups-cache-ttl-ms <ms>", "Identity→groups cache TTL in milliseconds")
    .option("--authz-groups-timeout-ms <ms>", "Groups API HTTP timeout in milliseconds")
    .option(
      "--authz-workflow-extract <jsonpath>",
      "JSONPath to extract allowed-group strings from workflow",
    )
    .option(
      "--authz-workflow-strip-prefix <prefix>",
      "Prefix to strip from each extracted ACL value",
    )
    .option(
      "--authz-acl-source <kind>",
      "Where to read the ACL from: request (body, legacy) or upstream (stored workflow — required for tag-based ACLs and the only non-forgeable option)",
    )
    .option(
      "--authz-acl-cache-ttl-ms <ms>",
      "Cache lifetime for stored-ACL lookups (default: 10000)",
    )
    .option(
      "--authz-on-missing-acl <mode>",
      "What to do when the target declares no ACL (every create included): deny (default) or allow",
    )
    .option(
      "--authz-bootstrap-groups <groups>",
      "Comma-separated groups allowed to act when the target has no ACL; overrides --authz-on-missing-acl",
    )
    .option(
      "--authz-actions <actions>",
      "Comma-separated route actions this middleware authorizes (default: all it sees)",
    )
    // Stale-write options — only meaningful when "stale-write" is in the
    // server-middleware chain.
    .option(
      "--stale-write-enforce <level>",
      "Stale-write enforcement level: off (default), warn, error. Rejects an update whose X-N8n-Base-Updated-At does not match the stored workflow",
    )
    .option(
      "--stale-write-on-missing-base <mode>",
      "What to do when the caller sends no base revision: allow (default) or deny",
    )
    .option(
      "--stale-write-on-error <mode>",
      "Behavior when the stored workflow cannot be read: deny (default) or allow",
    )
    .option(
      "--stale-write-actions <actions>",
      "Comma-separated route actions the guard applies to (default: update)",
    )
    // oauth-verify — verifies incoming Authorization: Bearer via Google tokeninfo.
    .option(
      "--oauth-verify-enforce <level>",
      "oauth-verify enforcement level: off, warn, deny (default: deny)",
    )
    .option(
      "--oauth-verify-expected-audiences <list>",
      "Comma-separated accepted `aud` claims (e.g. Cloud Run URL, IAP client_id)",
    )
    .option(
      "--oauth-verify-trusted-principals <list>",
      "Comma-separated bearer principals (emails / subjects) permitted to attach an X-Impersonator-Id-Token",
    )
    // impersonator-verify — verifies X-Impersonator-Id-Token (the human user's id_token).
    .option(
      "--impersonator-verify-enforce <level>",
      "impersonator-verify enforcement level: off, warn, deny (default: deny)",
    )
    .option(
      "--impersonator-verify-requirement <mode>",
      "Behavior when the impersonator header is absent: optional, require (default: optional)",
    )
    .option(
      "--impersonator-verify-expected-audiences <list>",
      "Comma-separated accepted `aud` claims for the impersonator token (typically the gcloud ADC OAuth client id)",
    )
    // impersonator-token — attaches the user's id_token as a side header.
    .option(
      "--impersonator-token-audience <id>",
      "aud claim for the minted user id_token (default: gcloud ADC OAuth client id)",
    )
    .option(
      "--impersonator-token-source <kind>",
      "Where the token comes from: adc (default), env, static",
    )
    .option(
      "--impersonator-token-env-var <name>",
      "Env var holding a pre-minted id_token (source=env)",
    )
    .option(
      "--impersonator-token-on-error <mode>",
      "Behavior on token-fetch failure: throw (default) or skip",
    )
    .action((opts: ProxyOptions) => {
      const upstream = opts.upstream ?? process.env.N8N_API_URL;
      if (!upstream) {
        console.error(
          "Error: --upstream is required (or set N8N_API_URL). Example: --upstream https://n8n.example.com",
        );
        process.exit(1);
      }

      const logFormat = opts.logFormat === "json" ? "json" : "text";
      const enforce = parseEnforceLevel(opts.enforce);
      const duplicateTtlMs = parsePositiveInt(opts.duplicateTtl, "--duplicate-ttl");
      const upstreamTimeoutMs = parsePositiveInt(opts.upstreamTimeout, "--upstream-timeout");

      const middlewares = parseMiddlewareList(opts.serverMiddleware);
      const clientMiddlewares = parseMiddlewareList(opts.clientMiddleware);
      const filterByTags = parseTagFilter(opts.tags ?? process.env.PROXY_FILTER_BY_TAGS);
      const routes = parseRoutes(opts.routes ?? process.env.N8N_PROXY_ROUTES);

      const handle = startProxy({
        routes,
        listen: opts.listen,
        upstream,
        lintConfigPath: opts.lintConfig,
        enforce,
        disableRules: opts.disableRule ?? [],
        logFormat,
        allowDuplicates: !!opts.allowDuplicates,
        duplicateTtlMs,
        upstreamTimeoutMs,
        middlewares,
        middlewareCliOptions: extractMiddlewareCliOpts(opts),
        clientMiddlewares: clientMiddlewares.length > 0 ? clientMiddlewares : undefined,
        clientMiddlewareCliOptions: extractClientMiddlewareCliOpts(opts),
        filterByTags: filterByTags.length > 0 ? filterByTags : undefined,
      });

      // Friendly startup line on stderr so it never pollutes JSON log streams.
      // The displayed middleware list reflects what was passed via
      // --server-middleware; when empty, the env-var (N8N_SERVER_MIDDLEWARES)
      // or default chain wins inside startProxy, so this line just says
      // "(env/default)" to avoid lying about an empty chain.
      const mwDisplay = middlewares.length
        ? middlewares.join(",")
        : (process.env.N8N_SERVER_MIDDLEWARES ?? "lint (default)");
      const clientMwDisplay = clientMiddlewares.length
        ? clientMiddlewares.join(",")
        : (process.env.N8N_CLIENT_MIDDLEWARES ?? "(none)");
      const tagsDisplay = filterByTags.length > 0 ? `, tags=${filterByTags.join(",")}` : "";
      console.error(
        `n8n-cli proxy listening on ${opts.listen} → ${upstream} (enforce=${enforce}, server-middlewares=${mwDisplay}, client-middlewares=${clientMwDisplay}${tagsDisplay})`,
      );

      const shutdown = async (signal: string) => {
        console.error(`\nReceived ${signal}, shutting down proxy...`);
        await handle.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    });
}

/**
 * Strips the `opts` bag down to just the keys middleware factories know
 * how to read. Keeping the projection explicit prevents commander
 * artifacts (`_optionValues`, etc.) from leaking into factory inputs.
 */
/** Exported for unit tests that assert declared flags actually reach a factory. */
export function extractMiddlewareCliOpts(opts: ProxyOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (k: keyof ProxyOptions) => {
    if (opts[k] !== undefined) out[k] = opts[k];
  };
  copy("authzEnforce");
  copy("authzOnError");
  copy("authzIdentitySource");
  copy("authzIdentityName");
  copy("authzIdentityDecode");
  copy("authzIdentityClaim");
  copy("authzGroupsUrl");
  copy("authzGroupsMethod");
  copy("authzGroupsHeaders");
  copy("authzGroupsBody");
  copy("authzGroupsExtract");
  copy("authzGroupsCacheTtlMs");
  copy("authzGroupsTimeoutMs");
  copy("authzWorkflowExtract");
  copy("authzWorkflowStripPrefix");
  copy("staleWriteEnforce");
  copy("staleWriteOnMissingBase");
  copy("staleWriteOnError");
  copy("staleWriteActions");
  copy("oauthVerifyEnforce");
  copy("oauthVerifyExpectedAudiences");
  copy("oauthVerifyTrustedPrincipals");
  copy("impersonatorVerifyEnforce");
  copy("impersonatorVerifyRequirement");
  copy("impersonatorVerifyExpectedAudiences");
  return out;
}

/**
 * Strips the `opts` bag down to keys that client-middleware factories
 * read. Keeping the projection explicit prevents commander artifacts
 * (`_optionValues`, etc.) from leaking into factory inputs.
 */
export function extractClientMiddlewareCliOpts(opts: ProxyOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (k: keyof ProxyOptions) => {
    if (opts[k] !== undefined) out[k] = opts[k];
  };
  copy("iapAuthAudience");
  copy("iapAuthTokenSource");
  copy("iapAuthTokenEnvVar");
  copy("iapAuthHeaderName");
  copy("iapAuthCacheTtlMs");
  copy("iapAuthTimeoutMs");
  copy("iapAuthMetadataBaseUrl");
  copy("iapAuthImpersonateServiceAccount");
  copy("iapAuthIamCredentialsBaseUrl");
  copy("apiKeyInjectKeyEnvVar");
  copy("apiKeyInjectHeader");
  copy("apiKeyInjectConflictPolicy");
  copy("webhookTokenInjectRules");
  copy("bearerTokenInjectRules");
  copy("impersonatorTokenAudience");
  copy("impersonatorTokenSource");
  copy("impersonatorTokenEnvVar");
  copy("impersonatorTokenOnError");
  return out;
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    console.error(`Error: ${flag} expects a non-negative integer (got "${value}")`);
    process.exit(1);
  }
  return Number.parseInt(value, 10);
}
