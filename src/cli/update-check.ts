import fs from "node:fs";
import os from "node:os";
import path from "node:path";

declare const CLI_VERSION: string;

const REPO = "ubie-oss/n8n-cli";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface CacheEntry {
  lastCheckedAt: string;
  latestVersion: string | null;
}

/** Resolve the cache file path in a platform-appropriate location. */
export function cacheFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (env.XDG_CACHE_HOME) {
    return path.join(env.XDG_CACHE_HOME, "n8n-cli", "update-check.json");
  }
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Caches", "n8n-cli", "update-check.json");
    case "win32":
      return path.join(
        env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
        "n8n-cli",
        "Cache",
        "update-check.json",
      );
    default:
      return path.join(home, ".cache", "n8n-cli", "update-check.json");
  }
}

/**
 * Compare two semver-ish versions. Returns 1 if a>b, -1 if a<b, 0 if equal.
 * Strips leading "v" and trailing "-dirty"/pre-release suffixes for comparison.
 */
export function compareVersions(a: string, b: string): number {
  const normalize = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((s) => Number.parseInt(s, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n));

  const parsedA = normalize(a);
  const parsedB = normalize(b);
  const len = Math.max(parsedA.length, parsedB.length);
  for (let i = 0; i < len; i++) {
    const x = parsedA[i] ?? 0;
    const y = parsedB[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function isCheckDisabled(): boolean {
  if (process.env.N8N_CLI_DISABLE_UPDATE_CHECK === "1") return true;
  if (process.env.CI === "true" || process.env.CI === "1") return true;
  return false;
}

function readCache(filePath: string): CacheEntry | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as CacheEntry).lastCheckedAt === "string"
    ) {
      return parsed as CacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(filePath: string, entry: CacheEntry): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
  } catch {
    // ignore — cache write failures must not affect the CLI
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "n8n-cli-update-check",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { tag_name?: unknown };
    return typeof json.tag_name === "string" ? json.tag_name : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function currentVersion(): string | null {
  const v = typeof CLI_VERSION !== "undefined" ? CLI_VERSION : "dev";
  if (v === "dev" || v === "unknown" || v === "") return null;
  return v;
}

/**
 * Kick off an update check. Returns a promise so the caller can await it
 * before showing the notice. Safe to fire-and-forget if the caller prefers.
 * Silent on all errors.
 */
export async function runUpdateCheck(): Promise<void> {
  if (isCheckDisabled()) return;
  if (currentVersion() === null) return;

  const file = cacheFilePath();
  const cache = readCache(file);
  const now = Date.now();
  if (cache) {
    const last = Date.parse(cache.lastCheckedAt);
    if (!Number.isNaN(last) && now - last < CHECK_INTERVAL_MS) return;
  }

  const latest = await fetchLatestVersion();
  writeCache(file, {
    lastCheckedAt: new Date(now).toISOString(),
    latestVersion: latest,
  });
}

/**
 * If a newer version is known (from a prior check), print a one-line notice
 * to stderr. Never throws.
 */
export function maybeShowUpdateNotice(): void {
  if (isCheckDisabled()) return;
  const current = currentVersion();
  if (current === null) return;

  const cache = readCache(cacheFilePath());
  if (!cache || !cache.latestVersion) return;

  if (compareVersions(cache.latestVersion, current) > 0) {
    const latest = cache.latestVersion;
    process.stderr.write(
      `\n[n8n-cli] A new version ${latest} is available (current: ${current}).\n` +
        `  Update: git pull && make build  (https://github.com/${REPO}/releases/latest)\n` +
        `  Silence: export N8N_CLI_DISABLE_UPDATE_CHECK=1\n`,
    );
  }
}
