import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { getRuleOptions, loadLintConfig } from "@/lint/config.ts";
import {
  estimateCronIntervalSeconds,
  intervalToSeconds,
  scheduleTriggerFrequencyRule,
} from "@/lint/rules/schedule-trigger-frequency.ts";

function makeWorkflow(intervals: unknown[]): Workflow {
  return {
    name: "Test",
    active: true,
    nodes: [
      {
        id: "1",
        name: "Schedule",
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          rule: { interval: intervals },
        },
      },
    ],
    connections: {},
  };
}

describe("schedule-trigger-frequency rule", () => {
  test("name is schedule-trigger-frequency", () => {
    expect(scheduleTriggerFrequencyRule.name).toBe("schedule-trigger-frequency");
  });

  test("null workflow returns no violations", () => {
    expect(scheduleTriggerFrequencyRule.check(null, "").length).toBe(0);
  });

  test("no scheduleTrigger nodes returns no violations", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
        },
      ],
      connections: {},
    };
    expect(scheduleTriggerFrequencyRule.check(wf, "").length).toBe(0);
  });

  test("hours=1 with minInterval=hourly → OK (boundary)", () => {
    const wf = makeWorkflow([{ field: "hours", hoursInterval: 1 }]);
    const violations = scheduleTriggerFrequencyRule.check(wf, "", { minInterval: "hourly" });
    expect(violations.length).toBe(0);
  });

  test("minutes=59 with minInterval=hourly → violation", () => {
    const wf = makeWorkflow([{ field: "minutes", minutesInterval: 59 }]);
    const violations = scheduleTriggerFrequencyRule.check(wf, "", { minInterval: "hourly" });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("3540s");
  });

  test("minutes=60 with minInterval=hourly → OK (60min = 1 hour)", () => {
    const wf = makeWorkflow([{ field: "minutes", minutesInterval: 60 }]);
    const violations = scheduleTriggerFrequencyRule.check(wf, "", { minInterval: "hourly" });
    expect(violations.length).toBe(0);
  });

  test("seconds=59 with minInterval=minutes → violation", () => {
    const wf = makeWorkflow([{ field: "seconds", secondsInterval: 59 }]);
    const violations = scheduleTriggerFrequencyRule.check(wf, "", { minInterval: "minutes" });
    expect(violations.length).toBe(1);
  });

  test("seconds=60 with minInterval=minutes → OK", () => {
    const wf = makeWorkflow([{ field: "seconds", secondsInterval: 60 }]);
    const violations = scheduleTriggerFrequencyRule.check(wf, "", { minInterval: "minutes" });
    expect(violations.length).toBe(0);
  });

  test("days=1 with minInterval=hourly → OK", () => {
    const wf = makeWorkflow([{ field: "days", daysInterval: 1 }]);
    const violations = scheduleTriggerFrequencyRule.check(wf, "", { minInterval: "hourly" });
    expect(violations.length).toBe(0);
  });

  test("default options uses hourly", () => {
    const wf = makeWorkflow([{ field: "minutes", minutesInterval: 30 }]);
    // No options → defaults to hourly (3600s threshold)
    const violations = scheduleTriggerFrequencyRule.check(wf, "");
    expect(violations.length).toBe(1);
  });

  test("multiple interval entries → each checked individually", () => {
    const wf = makeWorkflow([
      { field: "hours", hoursInterval: 2 },
      { field: "minutes", minutesInterval: 5 },
    ]);
    const violations = scheduleTriggerFrequencyRule.check(wf, "", { minInterval: "hourly" });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("300s");
  });
});

describe("intervalToSeconds", () => {
  test("seconds field", () => {
    expect(intervalToSeconds({ field: "seconds", secondsInterval: 30 })).toBe(30);
  });

  test("minutes field", () => {
    expect(intervalToSeconds({ field: "minutes", minutesInterval: 5 })).toBe(300);
  });

  test("hours field", () => {
    expect(intervalToSeconds({ field: "hours", hoursInterval: 2 })).toBe(7200);
  });

  test("days field", () => {
    expect(intervalToSeconds({ field: "days", daysInterval: 1 })).toBe(86400);
  });

  test("weeks field", () => {
    expect(intervalToSeconds({ field: "weeks", weeksInterval: 1 })).toBe(604800);
  });

  test("months field", () => {
    expect(intervalToSeconds({ field: "months", monthsInterval: 1 })).toBe(2592000);
  });

  test("unknown field returns undefined", () => {
    expect(intervalToSeconds({ field: "unknown" })).toBeUndefined();
  });
});

describe("estimateCronIntervalSeconds", () => {
  test("every minute: * * * * *", () => {
    expect(estimateCronIntervalSeconds("* * * * *")).toBe(60);
  });

  test("every hour: 0 * * * *", () => {
    expect(estimateCronIntervalSeconds("0 * * * *")).toBe(3600);
  });

  test("every 5 minutes: */5 * * * *", () => {
    expect(estimateCronIntervalSeconds("*/5 * * * *")).toBe(300);
  });

  test("daily: 0 0 * * *", () => {
    expect(estimateCronIntervalSeconds("0 0 * * *")).toBe(86400);
  });

  test("monthly (specific day): 0 0 1 * *", () => {
    expect(estimateCronIntervalSeconds("0 0 1 * *")).toBe(2592000);
  });

  test("invalid cron (wrong number of fields) returns undefined", () => {
    expect(estimateCronIntervalSeconds("* * *")).toBeUndefined();
  });

  test("every 2 hours: 0 */2 * * *", () => {
    expect(estimateCronIntervalSeconds("0 */2 * * *")).toBe(7200);
  });
});

describe("cron-based schedule trigger", () => {
  test("cron every minute with minInterval=hourly → violation", () => {
    const wf = makeWorkflow([{ field: "cronExpression", cronExpression: "* * * * *" }]);
    const violations = scheduleTriggerFrequencyRule.check(wf, "", { minInterval: "hourly" });
    expect(violations.length).toBe(1);
  });

  test("cron every hour with minInterval=hourly → OK", () => {
    const wf = makeWorkflow([{ field: "cronExpression", cronExpression: "0 * * * *" }]);
    const violations = scheduleTriggerFrequencyRule.check(wf, "", { minInterval: "hourly" });
    expect(violations.length).toBe(0);
  });

  test("cron every 5 minutes with minInterval=hourly → violation", () => {
    const wf = makeWorkflow([{ field: "cronExpression", cronExpression: "*/5 * * * *" }]);
    const violations = scheduleTriggerFrequencyRule.check(wf, "", { minInterval: "hourly" });
    expect(violations.length).toBe(1);
  });
});

describe("config array format parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("array format [severity, options] is parsed correctly", () => {
    const configPath = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "schedule-trigger-frequency": ["warning", { minInterval: "daily" }],
        },
      }),
    );
    const config = loadLintConfig(configPath);
    const rc = config.rulesConfig.get("schedule-trigger-frequency");
    expect(rc).toBeDefined();
    expect(rc!.enabled).toBe(true);
    expect(rc!.severity).toBe("warning");
    expect(rc!.options).toEqual({ minInterval: "daily" });

    const options = getRuleOptions(config, "schedule-trigger-frequency");
    expect(options).toEqual({ minInterval: "daily" });
  });

  test("string format still works (backward compatibility)", () => {
    const configPath = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "schedule-trigger-frequency": "error",
        },
      }),
    );
    const config = loadLintConfig(configPath);
    const rc = config.rulesConfig.get("schedule-trigger-frequency");
    expect(rc).toBeDefined();
    expect(rc!.enabled).toBe(true);
    expect(rc!.severity).toBe("error");
    expect(rc!.options).toBeUndefined();
  });

  test("boolean format still works (backward compatibility)", () => {
    const configPath = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "schedule-trigger-frequency": false,
        },
      }),
    );
    const config = loadLintConfig(configPath);
    const rc = config.rulesConfig.get("schedule-trigger-frequency");
    expect(rc).toBeDefined();
    expect(rc!.enabled).toBe(false);
  });

  test("array format with 'off' disables the rule", () => {
    const configPath = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "schedule-trigger-frequency": ["off"],
        },
      }),
    );
    const config = loadLintConfig(configPath);
    const rc = config.rulesConfig.get("schedule-trigger-frequency");
    expect(rc).toBeDefined();
    expect(rc!.enabled).toBe(false);
  });
});
