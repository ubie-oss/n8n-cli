/**
 * Minimal JSONPath evaluator — just enough to extract group ids from a
 * groups-API response and tag names from a workflow.
 *
 * Supported syntax (intentionally small to avoid pulling in jsonpath-plus):
 *   $                  root
 *   .key               dotted access
 *   ['key']            bracketed access (lets keys contain dots/spaces)
 *   ["key"]            same, with double quotes
 *   [n]                positive integer index
 *   [*]                wildcard over arrays and objects
 *
 * Filter predicates (`[?(@.x == "y")]`) are intentionally omitted — same
 * job can be done by extracting the broader set and post-filtering in TS
 * (workflow-acl does this with stripPrefix). Pulling them in would mean
 * shipping an expression parser; keep it simple.
 *
 * Errors during compile (malformed path) throw with a useful message.
 * Errors during evaluation (path doesn't match anything) return an empty
 * array rather than throwing — extractors then naturally produce "no
 * groups found", which is exactly what callers want to detect.
 */

type Step =
  | { kind: "root" }
  | { kind: "key"; name: string }
  | { kind: "index"; idx: number }
  | { kind: "wildcard" };

export class JSONPathCompileError extends Error {
  constructor(path: string, message: string) {
    super(`Invalid JSONPath "${path}": ${message}`);
    this.name = "JSONPathCompileError";
  }
}

export interface CompiledJSONPath {
  readonly source: string;
  evaluate(input: unknown): unknown[];
}

export function compileJSONPath(path: string): CompiledJSONPath {
  const steps = parse(path);
  return {
    source: path,
    evaluate(input: unknown): unknown[] {
      let cursors: unknown[] = [input];
      for (const step of steps) {
        cursors = step.kind === "root" ? cursors : advance(cursors, step);
      }
      return cursors;
    },
  };
}

/** Convenience wrapper for one-shot evaluation. */
export function evaluateJSONPath(path: string, input: unknown): unknown[] {
  return compileJSONPath(path).evaluate(input);
}

function parse(path: string): Step[] {
  if (!path) throw new JSONPathCompileError(path, "expression is empty");
  if (path[0] !== "$") throw new JSONPathCompileError(path, 'must start with "$"');

  const steps: Step[] = [{ kind: "root" }];
  let i = 1;

  while (i < path.length) {
    const c = path[i];

    if (c === ".") {
      i++;
      if (path[i] === "[" || path[i] === "." || i >= path.length) {
        throw new JSONPathCompileError(path, `unexpected character after "." at ${i}`);
      }
      const start = i;
      while (i < path.length && path[i] !== "." && path[i] !== "[") i++;
      const name = path.slice(start, i);
      if (name === "*") {
        steps.push({ kind: "wildcard" });
      } else if (name.length === 0) {
        throw new JSONPathCompileError(path, `empty key at ${start}`);
      } else {
        steps.push({ kind: "key", name });
      }
      continue;
    }

    if (c === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) throw new JSONPathCompileError(path, `unclosed "[" at ${i}`);
      const inner = path.slice(i + 1, close).trim();
      i = close + 1;

      if (inner === "*") {
        steps.push({ kind: "wildcard" });
        continue;
      }

      // Quoted key
      const quoted = matchQuoted(inner);
      if (quoted !== null) {
        steps.push({ kind: "key", name: quoted });
        continue;
      }

      // Integer index
      if (/^\d+$/.test(inner)) {
        steps.push({ kind: "index", idx: Number.parseInt(inner, 10) });
        continue;
      }

      throw new JSONPathCompileError(
        path,
        `unsupported bracket expression "[${inner}]" — only [*], [n], and ['key'] are supported`,
      );
    }

    throw new JSONPathCompileError(path, `unexpected character "${c}" at ${i}`);
  }

  return steps;
}

function matchQuoted(s: string): string | null {
  if (s.length < 2) return null;
  const q = s[0];
  if ((q === "'" || q === '"') && s[s.length - 1] === q) {
    return s.slice(1, -1);
  }
  return null;
}

function advance(cursors: unknown[], step: Step): unknown[] {
  const next: unknown[] = [];
  for (const cursor of cursors) {
    if (cursor === null || cursor === undefined) continue;

    if (step.kind === "key") {
      if (typeof cursor === "object" && !Array.isArray(cursor)) {
        const obj = cursor as Record<string, unknown>;
        if (step.name in obj) next.push(obj[step.name]);
      }
      continue;
    }

    if (step.kind === "index") {
      if (Array.isArray(cursor) && step.idx >= 0 && step.idx < cursor.length) {
        next.push(cursor[step.idx]);
      }
      continue;
    }

    if (step.kind === "wildcard") {
      if (Array.isArray(cursor)) {
        for (const item of cursor) next.push(item);
      } else if (typeof cursor === "object") {
        for (const v of Object.values(cursor as Record<string, unknown>)) {
          next.push(v);
        }
      }
    }
  }
  return next;
}
