import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

/**
 * Creates a js-yaml schema with a custom `!include` tag.
 * `!include` tags are parsed into `IncludeRef` objects that preserve the original path.
 * Use `resolveIncludeRefs` to replace them with actual file contents when needed.
 */
export function createIncludeSchema(_baseDir: string): yaml.Schema {
  const includeType = new yaml.Type("!include", {
    kind: "scalar",
    resolve(data: string): boolean {
      return typeof data === "string" && data.length > 0;
    },
    construct(data: string): IncludeRef {
      return new IncludeRef(data);
    },
    represent(data: unknown): string {
      return String(data);
    },
  });

  return yaml.DEFAULT_SCHEMA.extend([includeType]);
}

/**
 * IncludeRef is a marker class for values that should be serialized as `!include` tags
 * when dumping YAML.
 */
export class IncludeRef {
  constructor(public readonly path: string) {}
}

/**
 * Recursively walks an object tree and replaces every `IncludeRef` with
 * the content of the referenced file (resolved relative to `baseDir`).
 */
export function resolveIncludeRefs(obj: unknown, baseDir: string): unknown {
  if (obj instanceof IncludeRef) {
    const filePath = path.resolve(baseDir, obj.path);
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`!include failed to read "${obj.path}" (resolved to "${filePath}"): ${msg}`);
    }
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveIncludeRefs(item, baseDir));
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveIncludeRefs(value, baseDir);
    }
    return result;
  }
  return obj;
}

/**
 * Creates a js-yaml schema for dumping YAML with `!include` tags.
 * IncludeRef instances are serialized as `!include <path>` scalars.
 */
export function createIncludeDumpSchema(): yaml.Schema {
  const includeRefType = new yaml.Type("!include", {
    kind: "scalar",
    instanceOf: IncludeRef,
    represent(data: unknown): string {
      return (data as IncludeRef).path;
    },
  });

  return yaml.DEFAULT_SCHEMA.extend([includeRefType]);
}
