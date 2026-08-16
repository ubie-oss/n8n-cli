import type { Node, Workflow } from "@/api/types.ts";
import { globMatch } from "@/common/mcp.ts";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

const RULE_NAME = "banned-node";

type MatchKind = "exact" | "glob" | "regex";
type ExpressionMode = "allow" | "deny";

/** Raw matcher as written in the config: exactly one of `type` / `pattern`. */
interface RawNodeMatcher {
  type?: string;
  pattern?: string;
  match?: MatchKind;
  reason?: string;
}

/** Value-level rule attached to a parameter path. */
interface RawValueRule {
  allow?: string[];
  pattern?: string;
  match?: MatchKind;
  expressions?: ExpressionMode;
}

/** Per-node parameter policy, keyed in the config by a node type matcher. */
interface RawParamsPolicy {
  allowParams?: string[];
  denyParams?: string[];
  expressions?: ExpressionMode;
  values?: Record<string, RawValueRule>;
}

/** A compiled matcher. */
type CompiledPattern =
  | { kind: "exact"; value: string }
  | { kind: "glob"; glob: string }
  | { kind: "regex"; regex: RegExp };

type CompiledNodeMatcher = CompiledPattern & { reason?: string };

interface ParsedOptions {
  deny: CompiledNodeMatcher[];
  allow: CompiledNodeMatcher[];
  params: Record<string, RawParamsPolicy>;
}

interface ParseResult {
  options?: ParsedOptions;
  errors: Violation[];
}

/**
 * Detects disallowed node types and parameter usage.
 *
 * This is an extension of the original exact-match banned list. Options:
 *
 *   deny:   Array of node matchers. Any node matching one is banned outright
 *           (this is the same list the legacy `nodes` option maps onto).
 *   allow:  Array of node matchers. When non-empty this switches the rule into
 *           allowlist mode: every node must match at least one entry, otherwise
 *           it is banned. Entries may still be narrowed further by `params`.
 *   params: Record keyed by a node type matcher (exact type, `*`-glob, or
 *           `/regex/`) describing what the parameters of matching nodes must
 *           look like. Multiple keys can match one node; they are merged in
 *           order of specificity (broadest first, exact last) so a broad
 *           default like `"*"` can be overridden per node type:
 *             - allowParams: when present, every top-level parameter name must
 *               match at least one of these patterns (exact, `*`-glob, or
 *               `/re/`). Patterns match the parameter *key*, so allow a whole
 *               object with `additionalFields` (exact) or `additional*`, not
 *               `additionalFields.*` (which is a path into the parameter).
 *               Parameters that match none are violations.
 *             - denyParams: top-level parameter names matching any pattern are
 *               violations. To forbid a nested key, use `values` with an empty
 *               `allow` list instead.
 *             - expressions: "allow" (default) or "deny" — the node's default
 *               policy for expression values (strings beginning with `=` or
 *               containing `{{ ... }}`).
 *             - values: record of parameter path -> value rule. Paths use dot
 *               notation (`channelId.value`) and support `*` globs; for each
 *               field (`allow`, `pattern`, `expressions`) the most specific
 *               matching path rule that defines that field wins, so a broad
 *               rule and a narrow rule compose rather than shadow one another.
 *               Each value rule can combine:
 *                 - allow:      exact values the parameter may hold.
 *                 - pattern:    a glob (default) or regex (with `match:
 *                               "regex"`) the value must match.
 *                 - expressions:"allow" / "deny" for just that path,
 *                               overriding the node default.
 *
 * A `match` field on a matcher selects "exact" | "glob" | "regex" for `pattern`
 * (default: "glob"). Expression values skip literal `allow` / `pattern` checks
 * because they are dynamic; the expressions policy decides their fate instead.
 */
export const bannedNodeRule: Rule = {
  name: RULE_NAME,
  description: "Detect usage of banned node types and parameter/value/expression policies",
  defaultSeverity: "warning",
  check(
    workflow: Workflow | null,
    _rawJSON: string,
    options?: Record<string, unknown>,
  ): Violation[] {
    if (!workflow) return [];

    const { options: opts, errors } = parseOptions(options);
    const violations: Violation[] = [...errors];
    if (!opts) return violations;

    for (const node of workflow.nodes) {
      violations.push(...checkNode(node, opts));
    }
    return violations;
  },
};

// ---------------------------------------------------------------------------
// Options parsing
// ---------------------------------------------------------------------------

function parseOptions(options?: Record<string, unknown>): ParseResult {
  if (!options) return { errors: [] };

  const errors: Violation[] = [];
  const deny: CompiledNodeMatcher[] = [];
  const allow: CompiledNodeMatcher[] = [];

  for (const raw of asObjectArray(options.deny, "deny", errors)) {
    const matcher = parseMatcher(raw, errors);
    if (matcher) deny.push(matcher);
  }
  // Legacy `nodes` option is an alias for `deny`.
  for (const raw of asObjectArray(options.nodes, "nodes", errors)) {
    const matcher = parseMatcher(raw, errors);
    if (matcher) deny.push(matcher);
  }
  for (const raw of asObjectArray(options.allow, "allow", errors)) {
    const matcher = parseMatcher(raw, errors);
    if (matcher) allow.push(matcher);
  }

  const params: Record<string, RawParamsPolicy> = {};
  const rawParams = options.params;
  if (rawParams !== undefined) {
    if (typeof rawParams !== "object" || Array.isArray(rawParams)) {
      errors.push(configError(`"params" must be an object, got ${typeof rawParams}`));
    } else {
      for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
        const policy = parseParamsPolicy(key, value, errors);
        if (policy) params[key] = policy;
      }
    }
  }

  const hasAny = deny.length > 0 || allow.length > 0 || Object.keys(params).length > 0;
  return { options: hasAny ? { deny, allow, params } : undefined, errors };
}

/** Reads an option as an array of objects, collecting invalid entries as errors. */
function asObjectArray(
  value: unknown,
  optionName: string,
  errors: Violation[],
): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(configError(`"${optionName}" must be an array, got ${typeof value}`));
    return [];
  }
  return value.filter((entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) return true;
    errors.push(configError(`"${optionName}" entries must be objects`));
    return false;
  });
}

function parseMatcher(
  raw: Record<string, unknown>,
  errors: Violation[],
): CompiledNodeMatcher | null {
  const matcher = raw as RawNodeMatcher;
  const reason = typeof matcher.reason === "string" ? matcher.reason : undefined;

  if (typeof matcher.type === "string" && matcher.pattern === undefined) {
    return { kind: "exact", value: matcher.type, reason };
  }

  if (typeof matcher.pattern === "string" && matcher.type === undefined) {
    const match = matcher.match;
    if (match !== undefined && match !== "exact" && match !== "glob" && match !== "regex") {
      errors.push(
        configError(`Invalid "match" value "${String(match)}" in matcher for "${matcher.pattern}"`),
      );
      return null;
    }
    const pattern = compilePattern(matcher.pattern, match, errors);
    if (!pattern) return null;
    return { ...pattern, reason };
  }

  errors.push(configError('Invalid node matcher: provide exactly one of "type" or "pattern"'));
  return null;
}

function parseParamsPolicy(
  key: string,
  value: unknown,
  errors: Violation[],
): RawParamsPolicy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(configError(`"params.${key}" must be an object`));
    return undefined;
  }
  // Validate regex-style keys up front so matcher resolution can trust them.
  if (isRegexString(key)) {
    if (!compileRegex(key)) {
      errors.push(configError(`Invalid regex in params key "/${key}/"`));
      return undefined;
    }
  }

  const raw = value as Record<string, unknown>;
  const policy: RawParamsPolicy = {};

  if (raw.expressions !== undefined) {
    if (raw.expressions !== "allow" && raw.expressions !== "deny") {
      errors.push(
        configError(
          `"params.${key}.expressions" must be "allow" or "deny", got "${String(raw.expressions)}"`,
        ),
      );
      return undefined;
    }
    policy.expressions = raw.expressions;
  }

  const allowParams = readStringArray(raw.allowParams, `params.${key}.allowParams`, errors);
  if (allowParams !== undefined) policy.allowParams = allowParams;
  const denyParams = readStringArray(raw.denyParams, `params.${key}.denyParams`, errors);
  if (denyParams !== undefined) policy.denyParams = denyParams;

  if (raw.values !== undefined) {
    if (typeof raw.values !== "object" || raw.values === null || Array.isArray(raw.values)) {
      errors.push(configError(`"params.${key}.values" must be an object`));
    } else {
      const values: Record<string, RawValueRule> = {};
      for (const [path, ruleValue] of Object.entries(raw.values as Record<string, unknown>)) {
        const rule = parseValueRule(key, path, ruleValue, errors);
        if (rule) values[path] = rule;
      }
      if (Object.keys(values).length > 0) policy.values = values;
    }
  }

  const isEmpty =
    policy.expressions === undefined &&
    policy.allowParams === undefined &&
    policy.denyParams === undefined &&
    policy.values === undefined;
  return isEmpty ? undefined : policy;
}

function readStringArray(
  value: unknown,
  optionPath: string,
  errors: Violation[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    errors.push(configError(`"${optionPath}" must be an array of strings`));
    return undefined;
  }
  return (value as string[]).filter((entry) => {
    if (isRegexString(entry) && !compileRegex(entry)) {
      errors.push(configError(`Invalid regex "/${entry}/" in "${optionPath}"`));
      return false;
    }
    return true;
  });
}

function parseValueRule(
  paramsKey: string,
  path: string,
  raw: unknown,
  errors: Violation[],
): RawValueRule | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(configError(`"params.${paramsKey}.values.${path}" must be an object`));
    return undefined;
  }
  const rule = raw as Record<string, unknown>;
  const out: RawValueRule = {};

  if (rule.allow !== undefined) {
    if (!Array.isArray(rule.allow) || rule.allow.some((v) => typeof v !== "string")) {
      errors.push(
        configError(`"params.${paramsKey}.values.${path}.allow" must be an array of strings`),
      );
      return undefined;
    }
    out.allow = rule.allow as string[];
  }

  if (rule.pattern !== undefined) {
    if (typeof rule.pattern !== "string") {
      errors.push(configError(`"params.${paramsKey}.values.${path}.pattern" must be a string`));
      return undefined;
    }
    if (
      rule.match !== undefined &&
      rule.match !== "exact" &&
      rule.match !== "glob" &&
      rule.match !== "regex"
    ) {
      errors.push(
        configError(
          `Invalid "match" value "${String(rule.match)}" in "params.${paramsKey}.values.${path}"`,
        ),
      );
      return undefined;
    }
    out.pattern = rule.pattern;
    out.match = (rule.match as MatchKind) ?? "glob";
    // Validate the pattern up front so a bad regex fails loudly in config
    // review rather than silently disabling the check.
    if (!compilePattern(out.pattern, out.match, errors)) return undefined;
  } else if (rule.match !== undefined) {
    errors.push(
      configError(`"params.${paramsKey}.values.${path}.match" requires "pattern" to be set`),
    );
    return undefined;
  }

  if (rule.expressions !== undefined) {
    if (rule.expressions !== "allow" && rule.expressions !== "deny") {
      errors.push(
        configError(`"params.${paramsKey}.values.${path}.expressions" must be "allow" or "deny"`),
      );
      return undefined;
    }
    out.expressions = rule.expressions;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Pattern helpers
// ---------------------------------------------------------------------------

function autoKind(s: string): MatchKind {
  if (isRegexString(s)) return "regex";
  if (s.includes("*")) return "glob";
  return "exact";
}

/** A string wrapped in `/.../` is treated as a regular expression. */
function isRegexString(s: string): boolean {
  return s.length > 2 && s.startsWith("/") && s.endsWith("/");
}

function compileRegex(s: string): RegExp | null {
  const body = isRegexString(s) ? s.slice(1, -1) : s;
  try {
    return new RegExp(body);
  } catch {
    return null;
  }
}

function compilePattern(
  s: string,
  explicit?: MatchKind,
  errors?: Violation[],
): CompiledPattern | null {
  const kind: MatchKind = explicit ?? autoKind(s);
  if (kind === "regex") {
    const re = compileRegex(s);
    if (!re) {
      errors?.push(configError(`Invalid regex "/${s}/"`));
      return null;
    }
    return { kind: "regex", regex: re };
  }
  if (kind === "glob") return { kind: "glob", glob: s };
  return { kind: "exact", value: s };
}

function patternMatches(pattern: CompiledPattern, value: string): boolean {
  switch (pattern.kind) {
    case "exact":
      return pattern.value === value;
    case "glob":
      return globMatch(pattern.glob, value);
    case "regex":
      return pattern.regex.test(value);
  }
}

/** Higher = more specific. exact > regex > glob > "*". */
function patternSpecificity(pattern: CompiledPattern): number {
  switch (pattern.kind) {
    case "exact":
      return 3;
    case "regex":
      return 2;
    case "glob":
      return pattern.glob === "*" ? 0 : 1;
  }
}

// ---------------------------------------------------------------------------
// Per-node evaluation
// ---------------------------------------------------------------------------

function checkNode(node: Node, opts: ParsedOptions): Violation[] {
  const violations: Violation[] = [];

  const deniedMatcher = opts.deny.find((m) => patternMatches(m, node.type));
  if (deniedMatcher) {
    const reason = deniedMatcher.reason;
    const message = reason
      ? `Node "${node.name}" uses banned type "${node.type}": ${reason}`
      : `Node "${node.name}" uses banned type "${node.type}"`;
    violations.push(violation(message));
    return violations;
  }

  if (opts.allow.length > 0 && !opts.allow.some((m) => patternMatches(m, node.type))) {
    violations.push(
      violation(`Node "${node.name}" uses type "${node.type}" which is not in the allowlist`),
    );
    return violations;
  }

  const policy = resolveParamsPolicy(opts.params, node.type);
  if (policy) {
    const params = (node.parameters as Record<string, unknown>) ?? {};
    violations.push(...checkParams(node, policy, params));
  }

  return violations;
}

/** Merges every params policy matching the node type, broadest first. */
function resolveParamsPolicy(
  params: Record<string, RawParamsPolicy>,
  nodeType: string,
): RawParamsPolicy | undefined {
  interface Entry {
    spec: number;
    policy: RawParamsPolicy;
  }
  const entries: Entry[] = [];
  for (const [key, policy] of Object.entries(params)) {
    const pattern = compilePattern(key);
    if (pattern && patternMatches(pattern, nodeType)) {
      entries.push({ spec: patternSpecificity(pattern), policy });
    }
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => a.spec - b.spec);

  const merged: RawParamsPolicy = {};
  const allowParams: string[] = [];
  const denyParams: string[] = [];
  const values: Record<string, RawValueRule> = {};
  for (const { policy } of entries) {
    for (const p of policy.allowParams ?? []) {
      if (!allowParams.includes(p)) allowParams.push(p);
    }
    for (const p of policy.denyParams ?? []) {
      if (!denyParams.includes(p)) denyParams.push(p);
    }
    if (policy.expressions) merged.expressions = policy.expressions;
    if (policy.values) {
      for (const [path, rule] of Object.entries(policy.values)) {
        values[path] = rule;
      }
    }
  }
  if (allowParams.length > 0) merged.allowParams = allowParams;
  if (denyParams.length > 0) merged.denyParams = denyParams;
  if (Object.keys(values).length > 0) merged.values = values;
  return merged;
}

/** Parameter names that hold code rather than values; expressions never apply. */
const CODE_PARAMS = new Set(["jsCode", "inputSchema"]);

function checkParams(
  node: Node,
  policy: RawParamsPolicy,
  params: Record<string, unknown>,
): Violation[] {
  const violations: Violation[] = [];
  const topKeys = Object.keys(params);

  if (policy.allowParams && policy.allowParams.length > 0) {
    const patterns = policy.allowParams
      .map((p) => compilePattern(p))
      .filter(Boolean) as CompiledPattern[];
    for (const key of topKeys) {
      if (CODE_PARAMS.has(key)) continue;
      if (!patterns.some((pat) => patternMatches(pat, key))) {
        violations.push(
          violation(`Node "${node.name}" (${node.type}): parameter "${key}" is not allowed`),
        );
      }
    }
  }

  if (policy.denyParams && policy.denyParams.length > 0) {
    const patterns = policy.denyParams
      .map((p) => compilePattern(p))
      .filter(Boolean) as CompiledPattern[];
    for (const key of topKeys) {
      if (patterns.some((pat) => patternMatches(pat, key))) {
        violations.push(
          violation(`Node "${node.name}" (${node.type}): parameter "${key}" is not allowed`),
        );
      }
    }
  }

  const leaves: Array<{ path: string; value: unknown }> = [];
  collectLeaves(params, (path, value) => leaves.push({ path, value }));

  if (policy.values) {
    for (const leaf of leaves) {
      const isExpr = isExpressionValue(leaf.value);
      if (!isExpr) {
        const allowRule = findValueRule(leaf.path, policy.values, "allow");
        if (allowRule?.allow) {
          const str = stringifyValue(leaf.value);
          if (!allowRule.allow.includes(str)) {
            violations.push(
              violation(
                `Node "${node.name}" (${node.type}): parameter "${leaf.path}" has value "${str}" which is not allowed (allowed: ${allowRule.allow.join(", ")})`,
              ),
            );
          }
        }
        const patternRule = findValueRule(leaf.path, policy.values, "pattern");
        if (patternRule?.pattern !== undefined) {
          const pattern = compilePattern(patternRule.pattern, patternRule.match ?? "glob");
          const str = stringifyValue(leaf.value);
          if (pattern && !patternMatches(pattern, str)) {
            violations.push(
              violation(
                `Node "${node.name}" (${node.type}): parameter "${leaf.path}" value "${str}" does not match pattern /${patternRule.pattern}/`,
              ),
            );
          }
        }
      }
    }
  }

  if (policy.expressions === "deny" || policy.values) {
    violations.push(...checkExpressions(node, leaves, policy));
  }

  return violations;
}

function checkExpressions(
  node: Node,
  leaves: Array<{ path: string; value: unknown }>,
  policy: RawParamsPolicy,
): Violation[] {
  const violations: Violation[] = [];
  const nodeDefault = policy.expressions ?? "allow";

  for (const leaf of leaves) {
    if (!isExpressionValue(leaf.value)) continue;
    let mode = nodeDefault;
    if (policy.values) {
      const rule = findValueRule(leaf.path, policy.values, "expressions");
      if (rule?.expressions) mode = rule.expressions;
    }
    if (mode === "deny") {
      violations.push(
        violation(
          `Node "${node.name}" (${node.type}): parameter "${leaf.path}" contains an expression, but expressions are not allowed`,
        ),
      );
    }
  }

  return violations;
}

/**
 * Returns the most specific value rule that defines the requested field for a
 * given parameter path. Fields are resolved independently so that, e.g., a
 * broad `additionalFields.*` expressions rule still applies to a leaf that a
 * narrower allow-only rule also matches.
 */
function findValueRule(
  path: string,
  values: Record<string, RawValueRule>,
  field: "allow" | "pattern" | "expressions",
): RawValueRule | undefined {
  let best: RawValueRule | undefined;
  let bestSpec = -1;
  for (const [pathRule, rule] of Object.entries(values)) {
    if (!hasField(rule, field)) continue;
    const pattern = compilePattern(pathRule);
    if (pattern && patternMatches(pattern, path)) {
      const spec = patternSpecificity(pattern);
      if (spec > bestSpec) {
        bestSpec = spec;
        best = rule;
      }
    }
  }
  return best;
}

function hasField(rule: RawValueRule, field: "allow" | "pattern" | "expressions"): boolean {
  switch (field) {
    case "allow":
      return rule.allow !== undefined;
    case "pattern":
      return rule.pattern !== undefined;
    case "expressions":
      return rule.expressions !== undefined;
  }
}

/**
 * Walks a parameters tree collecting leaf paths. Paths use dot notation with
 * `[n]` array indices (e.g. `additionalFields.fallback`, `data[0].value`).
 * Code-bearing parameters are skipped.
 */
function collectLeaves(
  params: Record<string, unknown>,
  onLeaf: (path: string, value: unknown) => void,
  prefix = "",
): void {
  for (const [key, value] of Object.entries(params)) {
    if (prefix === "" && CODE_PARAMS.has(key)) continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const element = value[i];
        if (element && typeof element === "object" && !Array.isArray(element)) {
          collectLeaves(element as Record<string, unknown>, onLeaf, `${path}[${i}]`);
        } else {
          onLeaf(`${path}[${i}]`, element);
        }
      }
    } else if (value && typeof value === "object") {
      collectLeaves(value as Record<string, unknown>, onLeaf, path);
    } else {
      onLeaf(path, value);
    }
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/** True for strings n8n treats as expressions: `=...` or containing `{{ }}`. */
function isExpressionValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (v.startsWith("=")) return true;
  return v.includes("{{") && v.includes("}}");
}

function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function configError(message: string): Violation {
  return { rule: RULE_NAME, severity: "error", message };
}

function violation(message: string): Violation {
  return { rule: RULE_NAME, severity: "warning", message };
}
