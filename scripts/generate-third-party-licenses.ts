/**
 * generate-third-party-licenses.ts
 *
 * `bun build --compile` links every production dependency into the shipped
 * binary, so the binary is an aggregate work: n8n-cli's own MIT-licensed code
 * plus third-party code under its own terms. Several of those dependencies —
 * `n8n-workflow` and `@n8n/workflow-sdk` among them — are distributed under the
 * n8n Sustainable Use License, which requires that anyone receiving a copy of
 * the software also receives a copy of its terms.
 *
 * This script walks the production dependency closure (the `dependencies` field,
 * transitively — devDependencies are not bundled) and emits
 * THIRD_PARTY_LICENSES.md with each package's license text, so the notice can be
 * attached to every GitHub release.
 *
 * Usage: bun run scripts/generate-third-party-licenses.ts [--check]
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = join(ROOT, "THIRD_PARTY_LICENSES.md");

/** Filenames that conventionally hold a package's license text. */
const LICENSE_FILE_PATTERN = /^(LICEN[CS]E|COPYING|NOTICE)(\..*)?$/i;

interface PackageManifest {
  name?: string;
  version?: string;
  license?: string;
  licenses?: Array<{ type?: string }>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  /** Full license text, when the package ships one. */
  text: string | null;
}

function readManifest(dir: string): PackageManifest | null {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as PackageManifest;
  } catch {
    return null;
  }
}

/**
 * Resolves a package name to its installed directory, walking up node_modules
 * the way Node's resolution algorithm does.
 */
function resolvePackageDir(name: string, fromDir: string): string | null {
  let current = fromDir;
  for (;;) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Reads a package's license text from whichever LICENSE-ish file it ships. */
function readLicenseText(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  const matches = entries.filter((e) => LICENSE_FILE_PATTERN.test(e)).sort();
  if (matches.length === 0) return null;

  const texts: string[] = [];
  for (const entry of matches) {
    try {
      texts.push(`--- ${entry} ---\n\n${readFileSync(join(dir, entry), "utf-8").trim()}`);
    } catch {
      // Unreadable file — skip it rather than failing the whole run.
    }
  }

  return texts.length > 0 ? texts.join("\n\n") : null;
}

/** Normalises the license field, which has had several shapes over the years. */
function licenseName(manifest: PackageManifest): string {
  if (typeof manifest.license === "string" && manifest.license) return manifest.license;
  const legacy = manifest.licenses?.[0]?.type;
  if (legacy) return legacy;
  return "UNKNOWN";
}

/** Collects the transitive closure of production dependencies. */
function collectProductionDependencies(): LicenseEntry[] {
  const root = readManifest(ROOT);
  if (!root) throw new Error("cannot read the root package.json");

  const seen = new Set<string>();
  const entries: LicenseEntry[] = [];
  const queue = Object.keys(root.dependencies ?? {}).map((name) => ({ name, fromDir: ROOT }));

  while (queue.length > 0) {
    const { name, fromDir } = queue.shift()!;

    const dir = resolvePackageDir(name, fromDir);
    if (!dir) {
      throw new Error(`dependency "${name}" is not installed — run \`bun install\` first`);
    }

    const manifest = readManifest(dir);
    if (!manifest) continue;

    const key = `${name}@${manifest.version ?? "0.0.0"}`;
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({
      name,
      version: manifest.version ?? "unknown",
      license: licenseName(manifest),
      text: readLicenseText(dir),
    });

    // Optional dependencies are bundled when present, so include them too.
    for (const dep of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      queue.push({ name: dep, fromDir: dir });
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function render(entries: LicenseEntry[]): string {
  const lines: string[] = [];

  lines.push("# Third-Party Licenses");
  lines.push("");
  lines.push(
    "The `n8n-cli` binary is built with `bun build --compile`, which links every",
    "production dependency into the executable. The binary is therefore an aggregate",
    "work: n8n-cli's own code is MIT-licensed (see `LICENSE`), while the components",
    "listed below remain under their own terms.",
  );
  lines.push("");
  lines.push(
    "Note in particular that the n8n packages are distributed under the **n8n",
    "Sustainable Use License**, not a permissive license. n8n-cli's MIT license does",
    "not — and cannot — relicense them.",
  );
  lines.push("");
  lines.push("This file is generated by `bun run generate-third-party-licenses`.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Package | Version | License |");
  lines.push("| --- | --- | --- |");
  for (const entry of entries) {
    lines.push(`| \`${entry.name}\` | ${entry.version} | ${entry.license} |`);
  }
  lines.push("");
  lines.push("## License texts");
  lines.push("");

  for (const entry of entries) {
    lines.push(`### ${entry.name}@${entry.version}`);
    lines.push("");
    lines.push(`License: ${entry.license}`);
    lines.push("");
    if (entry.text) {
      lines.push("```");
      lines.push(entry.text);
      lines.push("```");
    } else {
      lines.push(
        `_No license file is included in the published package; see the \`${entry.license}\` terms._`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

const entries = collectProductionDependencies();
const rendered = render(entries);

if (process.argv.includes("--check")) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf-8") : "";
  if (current !== rendered) {
    console.error(
      "THIRD_PARTY_LICENSES.md is out of date.\n" +
        "Run `bun run generate-third-party-licenses` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`THIRD_PARTY_LICENSES.md is up to date (${entries.length} packages).`);
} else {
  writeFileSync(OUTPUT, rendered);
  console.log(`Wrote ${OUTPUT} with ${entries.length} packages.`);
}
