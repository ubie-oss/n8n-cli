import type { Workflow } from "@/api/types.ts";
import generatedSchemas from "@/generated/node-schemas.json";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

/**
 * Detects plaintext secrets embedded in workflow node parameters.
 *
 * Detection layers (best-effort):
 *   1. Schema-declared sensitive params: parameters that n8n itself masks as
 *      password fields (typeOptions.password in node schemas) set to literals.
 *   2. Name heuristics: sensitive key names (Authorization, api-key, token,
 *      secret, password, ...) in parameter objects, name/value collections
 *      (HTTP Request headers, GraphQL headers, query params, Set assignments),
 *      embedded JSON strings (jsonHeaders/jsonBody, ...), URL query strings,
 *      and URL userinfo (https://user:password@host).
 *   3. Value patterns: string values anywhere (including Code node source and
 *      sticky notes) matching well-known secret token formats (AWS, GitHub,
 *      Slack, OpenAI, Google, Stripe, JWT, private key blocks, ...).
 *
 * Values that are pure n8n expressions (e.g. "={{ $env.MY_TOKEN }}") are
 * treated as safe for layers 1-2; known token formats are matched against the
 * raw value so literals embedded inside expressions are still caught.
 *
 * Options:
 *   additionalNames: string[]    extra key names to treat as sensitive
 *   additionalPatterns: string[] extra value regexes to treat as secrets
 *   allowValues: string[]        regexes; matching values are never flagged
 *   minSecretLength: number      minimum literal length for name-based checks (default 8)
 */
export const noPlaintextSecretsRule: Rule = {
  name: "no-plaintext-secrets",
  description: "Detect plaintext secrets (API keys, tokens, passwords) in node parameters",
  defaultSeverity: "error",
  check(
    workflow: Workflow | null,
    _rawJSON: string,
    options?: Record<string, unknown>,
  ): Violation[] {
    if (!workflow) return [];

    const ctx = buildContext(options);
    const violations: Violation[] = [];
    const seen = new Set<string>();

    for (const node of workflow.nodes) {
      const sensitiveParams = new Set(
        (generatedSensitiveParams[node.type] ?? []).concat(ctx.additionalNames),
      );
      const nodeViolations = scanValue(
        { nodeName: node.name, nodeType: node.type, sensitiveParams, ctx },
        "parameters",
        node.parameters ?? {},
      );
      for (const v of nodeViolations) {
        const key = v.message;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push(v);
      }
    }

    return violations;
  },
};

// ---------------------------------------------------------------------------
// Options / context
// ---------------------------------------------------------------------------

interface RuleContext {
  additionalNames: string[];
  additionalPatterns: Array<{ id: string; pattern: RegExp }>;
  allowValues: RegExp[];
  minSecretLength: number;
}

function buildContext(options?: Record<string, unknown>): RuleContext {
  const additionalNames = asStringArray(options?.additionalNames);
  const additionalPatterns = asStringArray(options?.additionalPatterns).flatMap((p, i) => {
    try {
      return [{ id: `custom-pattern-${i + 1}`, pattern: new RegExp(p) }];
    } catch {
      return [];
    }
  });
  const allowValues = asStringArray(options?.allowValues).flatMap((p) => {
    try {
      return [new RegExp(p)];
    } catch {
      return [];
    }
  });
  const minSecretLength =
    typeof options?.minSecretLength === "number" && options.minSecretLength > 0
      ? options.minSecretLength
      : 8;
  return { additionalNames, additionalPatterns, allowValues, minSecretLength };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

// ---------------------------------------------------------------------------
// Layer 1: schema-declared sensitive params (typeOptions.password)
// ---------------------------------------------------------------------------

const generatedSensitiveParams: Record<string, string[]> =
  (generatedSchemas as unknown as { sensitiveParams?: Record<string, string[]> }).sensitiveParams ??
  {};

// ---------------------------------------------------------------------------
// Layer 2: sensitive name heuristics
// ---------------------------------------------------------------------------

/** Word sequences that mark a key name as sensitive when matched contiguously */
const SENSITIVE_NAME_SEQUENCES: string[][] = [
  ["password"],
  ["passwd"],
  ["pwd"],
  ["passphrase"],
  ["secret"],
  ["token"],
  ["bearer"],
  ["cookie"],
  ["authorization"],
  ["api", "key"],
  ["apikey"],
  ["access", "key"],
  ["private", "key"],
];

/** Key names ending with these words describe metadata, not secret values */
const NON_SECRET_SUFFIXES = new Set([
  "name",
  "field",
  "type",
  "mode",
  "id",
  "url",
  "path",
  "header",
  "label",
  "placeholder",
  "description",
]);

/** Splits a key name into lowercase words on case/separator boundaries */
function tokenizeName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

/** Returns true if the key name looks like it holds a secret value */
export function isSensitiveName(name: string, additionalNames: string[] = []): boolean {
  const words = tokenizeName(name);
  if (words.length === 0) return false;
  if (NON_SECRET_SUFFIXES.has(words[words.length - 1]!)) return false;
  if (additionalNames.some((n) => n.toLowerCase() === name.toLowerCase())) return true;
  for (const seq of SENSITIVE_NAME_SEQUENCES) {
    for (let i = 0; i + seq.length <= words.length; i++) {
      if (seq.every((w, j) => words[i + j] === w)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Layer 3: known secret value formats
// ---------------------------------------------------------------------------

const SECRET_VALUE_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "github-fine-grained-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { id: "gitlab-pat", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack-token", pattern: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/ },
  { id: "openai-api-key", pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-legacy-api-key", pattern: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/ },
  { id: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "stripe-key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { id: "stripe-webhook-secret", pattern: /\bwhsec_[A-Za-z0-9]{24,}\b/ },
  { id: "sendgrid-api-key", pattern: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{30,}\b/ },
  { id: "twilio-api-key", pattern: /\bSK[0-9a-f]{32}\b/ },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    id: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  { id: "azure-storage-account-key", pattern: /AccountKey=[A-Za-z0-9+/=]{60,}/ },
];

/** Matches `password: "..."` / `api_key = '...'` style assignments in code/JSON strings */
const ASSIGNMENT_SNIFF_PATTERN =
  /(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i;

// ---------------------------------------------------------------------------
// Literal / placeholder helpers
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERN =
  /your|xxx|placeholder|example|sample|dummy|change[-_ ]?me|todo|fixme|redacted|<[^>]*>|\*{3,}|\$\{[^}]*\}/i;

/** Removes n8n expression segments and the '=' expression-mode prefix */
function maskExpressions(value: string, replacement = ""): string {
  let s = value;
  if (s.startsWith("=")) s = s.slice(1);
  return s.replace(/\{\{[\s\S]*?\}\}/g, replacement);
}

/**
 * Returns the secret-looking literal chunk in a value after removing
 * expression segments, or null if the value has no such literal.
 */
function findLiteralSecretChunk(value: string, ctx: RuleContext): string | null {
  // Strip both expression segments and __EXPR__ markers left by an earlier
  // masking pass (values coming from parsed embedded-JSON strings).
  const masked = maskExpressions(value).replaceAll("__EXPR__", "");
  if (PLACEHOLDER_PATTERN.test(masked)) return null;
  if (isAllowedValue(masked, ctx)) return null;
  const chunkPattern = new RegExp(`[A-Za-z0-9+/_=.\\-]{${ctx.minSecretLength},}`);
  const m = masked.match(chunkPattern);
  if (!m) return null;
  // A lone scheme word ("Bearer"-like) or plain dictionary word is not enough;
  // require some digit/symbol/case variety to reduce noise.
  const chunk = m[0]!;
  if (/^[a-z]+$/.test(chunk) || /^[A-Z]+$/.test(chunk)) {
    return chunk.length >= Math.max(ctx.minSecretLength, 16) ? chunk : null;
  }
  return chunk;
}

function isAllowedValue(value: string, ctx: RuleContext): boolean {
  return ctx.allowValues.some((re) => re.test(value));
}

/** Redacts a secret for display: first 4 chars + ellipsis */
function redact(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "****";
  return `${trimmed.slice(0, 4)}…`;
}

// ---------------------------------------------------------------------------
// Recursive parameter walk
// ---------------------------------------------------------------------------

interface ScanState {
  nodeName: string;
  nodeType: string;
  sensitiveParams: Set<string>;
  ctx: RuleContext;
}

function makeViolation(state: ScanState, message: string): Violation {
  return {
    rule: "no-plaintext-secrets",
    severity: "error",
    message: `Node "${state.nodeName}" (${state.nodeType}): ${message}`,
  };
}

function scanValue(state: ScanState, path: string, value: unknown): Violation[] {
  const violations: Violation[] = [];

  if (typeof value === "string") {
    violations.push(...scanString(state, path, value));
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      violations.push(...scanValue(state, `${path}[${i}]`, value[i]));
    }
  } else if (value && typeof value === "object") {
    violations.push(...scanObject(state, path, value as Record<string, unknown>));
  }

  return violations;
}

function scanObject(state: ScanState, path: string, obj: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];

  // name/value pair collections (HTTP headers, query params, Set assignments, ...)
  const pairName =
    typeof obj.name === "string" ? obj.name : typeof obj.key === "string" ? obj.key : null;
  if (pairName !== null && typeof obj.value === "string") {
    if (isSensitiveName(pairName, state.ctx.additionalNames)) {
      const chunk = findLiteralSecretChunk(obj.value, state.ctx);
      if (chunk) {
        violations.push(
          makeViolation(
            state,
            `parameter "${path}" sets sensitive key "${pairName}" to a plaintext literal ("${redact(chunk)}"). Use n8n credentials or an expression like {{ $env.MY_SECRET }} instead`,
          ),
        );
      }
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    const childPath = `${path}.${key}`;

    if (typeof val === "string") {
      // Layer 1: params n8n itself masks as password fields
      if (state.sensitiveParams.has(key)) {
        const chunk = findLiteralSecretChunk(val, state.ctx);
        if (chunk) {
          violations.push(
            makeViolation(
              state,
              `parameter "${childPath}" is a password-masked field in the node schema but contains a plaintext literal ("${redact(chunk)}"). Use n8n credentials or an expression like {{ $env.MY_SECRET }} instead`,
            ),
          );
        }
      } else if (isSensitiveName(key, state.ctx.additionalNames)) {
        // Layer 2: sensitive-looking key names
        const chunk = findLiteralSecretChunk(val, state.ctx);
        if (chunk) {
          violations.push(
            makeViolation(
              state,
              `parameter "${childPath}" looks like a secret ("${key}") but contains a plaintext literal ("${redact(chunk)}"). Use n8n credentials or an expression like {{ $env.MY_SECRET }} instead`,
            ),
          );
        }
      }
    }

    violations.push(...scanValue(state, childPath, val));
  }

  return violations;
}

function scanString(state: ScanState, path: string, value: string): Violation[] {
  const violations: Violation[] = [];

  // Layer 3: known token formats, matched against the raw value so literals
  // embedded inside expressions are still caught.
  for (const { id, pattern } of [...SECRET_VALUE_PATTERNS, ...state.ctx.additionalPatterns]) {
    const m = value.match(pattern);
    if (m && !isAllowedValue(m[0]!, state.ctx)) {
      violations.push(
        makeViolation(
          state,
          `parameter "${path}" contains a string matching a known secret format (${id}: "${redact(m[0]!)}"). Move it to n8n credentials or an environment variable`,
        ),
      );
    }
  }

  const masked = maskExpressions(value, "__EXPR__");

  // Embedded JSON strings (jsonHeaders, jsonBody, raw bodies, ...): walk the
  // parsed structure instead of running the string heuristics below, so the
  // same secret is not reported twice.
  const trimmed = masked.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") {
        violations.push(...scanValue(state, path, parsed));
        return violations;
      }
    } catch {
      // Not valid JSON - fall through to string heuristics
    }
  }

  // Assignment-style sniffing in code / raw JSON strings
  const assignment = masked.match(ASSIGNMENT_SNIFF_PATTERN);
  if (
    assignment &&
    !assignment[1]!.includes("__EXPR__") &&
    !PLACEHOLDER_PATTERN.test(assignment[1]!) &&
    !isAllowedValue(assignment[1]!, state.ctx)
  ) {
    violations.push(
      makeViolation(
        state,
        `parameter "${path}" contains a hardcoded secret assignment ("${redact(assignment[1]!)}"). Move it to n8n credentials or an environment variable`,
      ),
    );
  }

  // URL userinfo: https://user:password@host
  const userinfo = masked.match(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s:@]+):([^/\s@]+)@/i);
  if (
    userinfo &&
    !userinfo[2]!.includes("__EXPR__") &&
    !PLACEHOLDER_PATTERN.test(userinfo[2]!) &&
    !/^(pass(word)?|pw|user)$/i.test(userinfo[2]!) &&
    !isAllowedValue(userinfo[2]!, state.ctx)
  ) {
    violations.push(
      makeViolation(
        state,
        `parameter "${path}" embeds a password in a URL ("${userinfo[1]}:${redact(userinfo[2]!)}@"). Use n8n credentials instead`,
      ),
    );
  }

  // URL / query-string parameters: ?api_key=...&token=...
  for (const qm of masked.matchAll(/[?&]([A-Za-z0-9_.-]+)=([^&#\s"']+)/g)) {
    const key = qm[1]!;
    const qval = qm[2]!;
    if (!isSensitiveName(key, state.ctx.additionalNames)) continue;
    if (qval.includes("__EXPR__")) continue;
    if (qval.length < state.ctx.minSecretLength) continue;
    if (PLACEHOLDER_PATTERN.test(qval) || isAllowedValue(qval, state.ctx)) continue;
    violations.push(
      makeViolation(
        state,
        `parameter "${path}" passes sensitive query parameter "${key}" as a plaintext literal ("${redact(qval)}"). Use n8n credentials or an expression instead`,
      ),
    );
  }

  return violations;
}
