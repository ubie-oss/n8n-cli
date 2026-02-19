import type { Tag } from "../api/types.ts";

/**
 * Checks if the workflow has all required tag names (AND condition).
 * @param tags - Workflow tags (can be undefined)
 * @param requiredNames - Required tag names to check
 * @returns true if all required tags are present
 */
export function hasAllTags(tags: Tag[] | undefined, requiredNames: string[]): boolean {
  const tagNames = new Set((tags ?? []).map((t) => t.name));
  return requiredNames.every((name) => tagNames.has(name));
}

/**
 * Parses a comma-separated tag string from environment variable or CLI option.
 * @param value - Comma-separated tag string (e.g., "tag1,tag2,tag3")
 * @returns Array of trimmed, non-empty tag names
 */
export function parseTagFilter(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
