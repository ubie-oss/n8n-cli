import type { Workflow } from "@/api/types.ts";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

/** Allowed values for the minInterval option */
export type MinIntervalLevel = "minutes" | "hourly" | "daily" | "weekly" | "monthly";

/** Threshold in seconds for each interval level */
export const THRESHOLD_SECONDS: Record<MinIntervalLevel, number> = {
  minutes: 60,
  hourly: 3600,
  daily: 86400,
  weekly: 604800,
  monthly: 2592000, // 30 days
};

const DEFAULT_MIN_INTERVAL: MinIntervalLevel = "hourly";

interface IntervalEntry {
  field?: string;
  secondsInterval?: number;
  minutesInterval?: number;
  hoursInterval?: number;
  daysInterval?: number;
  weeksInterval?: number;
  monthsInterval?: number;
  cronExpression?: string;
}

/** Converts a single interval entry to seconds. Returns undefined if unrecognized. */
export function intervalToSeconds(entry: IntervalEntry): number | undefined {
  switch (entry.field) {
    case "seconds":
      return (entry.secondsInterval ?? 1) * 1;
    case "minutes":
      return (entry.minutesInterval ?? 1) * 60;
    case "hours":
      return (entry.hoursInterval ?? 1) * 3600;
    case "days":
      return (entry.daysInterval ?? 1) * 86400;
    case "weeks":
      return (entry.weeksInterval ?? 1) * 604800;
    case "months":
      return (entry.monthsInterval ?? 1) * 2592000;
    case "cronExpression":
      return estimateCronIntervalSeconds(entry.cronExpression ?? "");
    default:
      return undefined;
  }
}

/**
 * Estimates minimum interval in seconds from a cron expression.
 * Only handles simple patterns; returns undefined (safe-side skip) for complex expressions.
 *
 * Supports both:
 * - 5-field standard cron: minute hour day-of-month month day-of-week
 * - 6-field n8n cron:      second minute hour day-of-month month day-of-week
 */
export function estimateCronIntervalSeconds(cron: string): number | undefined {
  const parts = cron.trim().split(/\s+/);

  let minute: string;
  let hour: string;
  let dayOfMonth: string;

  if (parts.length === 6) {
    // 6-field cron (n8n format): second minute hour dom month dow
    [, minute, hour, dayOfMonth] = parts as [string, string, string, string, string, string];
  } else if (parts.length === 5) {
    // 5-field standard cron: minute hour dom month dow
    [minute, hour, dayOfMonth] = parts as [string, string, string, string, string];
  } else {
    return undefined;
  }

  return estimateFromMinuteHourDay(minute, hour, dayOfMonth);
}

function estimateFromMinuteHourDay(
  minute: string,
  hour: string,
  dayOfMonth: string,
): number | undefined {
  // Check minute field first (finest granularity)
  const minuteInterval = parseCronField(minute);
  if (minuteInterval !== undefined) {
    // If minute is *, interval is every minute = 60s
    // If minute is */N, interval is N minutes
    if (minuteInterval === 1 && hour === "*") {
      return 60; // every minute
    }
    if (minuteInterval > 1) {
      return minuteInterval * 60; // every N minutes
    }
  }

  // Minute is a list (e.g., "0,30") — estimate from the count of values per hour
  const minuteListCount = countListValues(minute);
  if (minuteListCount !== undefined && minuteListCount > 1 && hour === "*") {
    return Math.floor(3600 / minuteListCount);
  }

  // Minute is a specific number (e.g., "0") — check hour field
  if (isSpecificNumber(minute)) {
    const hourInterval = parseCronField(hour);
    if (hourInterval !== undefined) {
      if (hourInterval === 1) {
        return 3600; // every hour at specific minute
      }
      if (hourInterval > 1) {
        return hourInterval * 3600; // every N hours
      }
    }

    // Hour is a list (e.g., "0,6,12,18") — estimate from count per day
    const hourListCount = countListValues(hour);
    if (hourListCount !== undefined && hourListCount > 1) {
      return Math.floor(86400 / hourListCount);
    }

    // Hour is specific — check day field
    if (isSpecificNumber(hour)) {
      const dayInterval = parseCronField(dayOfMonth);
      if (dayInterval !== undefined) {
        if (dayInterval === 1) {
          return 86400; // daily
        }
        return dayInterval * 86400;
      }
      // Day is specific number → at most once per month
      if (isSpecificNumber(dayOfMonth)) {
        return 2592000;
      }
    }
  }

  // Cannot determine — safe side, don't flag
  return undefined;
}

// Parses a cron field: "*" returns 1, "*\/N" returns N, otherwise undefined
function parseCronField(field: string): number | undefined {
  if (field === "*") return 1;
  const match = field.match(/^\*\/(\d+)$/);
  if (match) return Number.parseInt(match[1]!, 10);
  return undefined;
}

function isSpecificNumber(field: string): boolean {
  return /^\d+$/.test(field);
}

// Parses a comma-separated list of numbers (e.g., "0,15,30,45"). Returns the count, or undefined.
function countListValues(field: string): number | undefined {
  if (!/^\d+(,\d+)+$/.test(field)) return undefined;
  return field.split(",").length;
}

/**
 * Validates that Schedule Trigger nodes don't fire more frequently than the configured minimum interval.
 *
 * n8n charges by trigger execution count, so overly frequent schedules can cause cost explosions.
 */
export const scheduleTriggerFrequencyRule: Rule = {
  name: "schedule-trigger-frequency",
  description: "Check that Schedule Trigger intervals are not too frequent",
  defaultSeverity: "warning",
  check(
    workflow: Workflow | null,
    _rawJSON: string,
    options?: Record<string, unknown>,
  ): Violation[] {
    if (!workflow) return [];

    const minInterval = (options?.minInterval as MinIntervalLevel) ?? DEFAULT_MIN_INTERVAL;
    const thresholdSeconds = THRESHOLD_SECONDS[minInterval];
    if (thresholdSeconds === undefined) return [];

    const violations: Violation[] = [];

    for (const node of workflow.nodes) {
      if (node.type !== "n8n-nodes-base.scheduleTrigger") continue;

      const rules = node.parameters?.rule as { interval?: IntervalEntry[] } | undefined;
      const intervals = rules?.interval;
      if (!Array.isArray(intervals)) continue;

      for (const entry of intervals) {
        const seconds = intervalToSeconds(entry);
        if (seconds === undefined) continue; // unknown format — safe side

        if (seconds < thresholdSeconds) {
          violations.push({
            rule: "schedule-trigger-frequency",
            severity: "warning",
            message: `Node "${node.name}": schedule interval (${seconds}s) is below minimum threshold (${thresholdSeconds}s, minInterval=${minInterval})`,
          });
        }
      }
    }

    return violations;
  },
};
