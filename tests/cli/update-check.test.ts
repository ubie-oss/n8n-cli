import { describe, expect, test } from "bun:test";
import { cacheFilePath, compareVersions } from "@/cli/update-check.ts";

describe("compareVersions", () => {
  test("returns 0 for equal versions", () => {
    expect(compareVersions("2.1.0", "2.1.0")).toBe(0);
  });

  test("returns 1 when a is newer", () => {
    expect(compareVersions("2.2.0", "2.1.0")).toBe(1);
    expect(compareVersions("2.1.1", "2.1.0")).toBe(1);
    expect(compareVersions("3.0.0", "2.9.9")).toBe(1);
  });

  test("returns -1 when a is older", () => {
    expect(compareVersions("2.0.9", "2.1.0")).toBe(-1);
  });

  test("strips leading v prefix", () => {
    expect(compareVersions("v2.2.0", "2.1.0")).toBe(1);
    expect(compareVersions("v2.1.0", "v2.1.0")).toBe(0);
  });

  test("ignores -dirty / pre-release suffixes", () => {
    expect(compareVersions("2.1.0-dirty", "2.1.0")).toBe(0);
    expect(compareVersions("2.1.0-rc.1", "2.1.0")).toBe(0);
  });

  test("handles missing segments as zero", () => {
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
    expect(compareVersions("2", "2.0.1")).toBe(-1);
  });
});

describe("cacheFilePath", () => {
  test("honors XDG_CACHE_HOME when set", () => {
    const p = cacheFilePath({ XDG_CACHE_HOME: "/tmp/xdg" }, "linux", "/home/u");
    expect(p).toBe("/tmp/xdg/n8n-cli/update-check.json");
  });

  test("uses ~/Library/Caches on darwin", () => {
    const p = cacheFilePath({}, "darwin", "/Users/u");
    expect(p).toBe("/Users/u/Library/Caches/n8n-cli/update-check.json");
  });

  test("uses LOCALAPPDATA on win32", () => {
    const p = cacheFilePath(
      { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      "win32",
      "C:\\Users\\u",
    );
    expect(p).toContain("AppData");
    expect(p).toContain("n8n-cli");
    expect(p).toContain("update-check.json");
  });

  test("falls back to ~/.cache on linux", () => {
    const p = cacheFilePath({}, "linux", "/home/u");
    expect(p).toBe("/home/u/.cache/n8n-cli/update-check.json");
  });
});
