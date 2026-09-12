import { describe, expect, test } from "bun:test";
import { isTriggerPath } from "@/proxy/trigger-path.ts";

describe("isTriggerPath", () => {
  test("matches n8n's default inbound HTTP prefixes, including nested paths", () => {
    expect(isTriggerPath("/webhook")).toBe(true);
    expect(isTriggerPath("/webhook/")).toBe(true);
    expect(isTriggerPath("/webhook/__agent-trigger__/abc")).toBe(true);
    expect(isTriggerPath("/webhook-test/u")).toBe(true);
    expect(isTriggerPath("/webhook-waiting/exec-1")).toBe(true);
    expect(isTriggerPath("/form")).toBe(true);
    expect(isTriggerPath("/form/signup")).toBe(true);
    expect(isTriggerPath("/form-test/signup")).toBe(true);
    expect(isTriggerPath("/form-waiting/exec-1")).toBe(true);
    expect(isTriggerPath("/mcp")).toBe(true);
    expect(isTriggerPath("/mcp/wf-tool")).toBe(true);
    expect(isTriggerPath("/mcp-test")).toBe(true);
    expect(isTriggerPath("/mcp-test/wf-tool")).toBe(true);
  });

  test("does not treat a longer sibling path as a match", () => {
    expect(isTriggerPath("/webhooks")).toBe(false);
    expect(isTriggerPath("/webhook-admin")).toBe(false);
    expect(isTriggerPath("/formx")).toBe(false);
    // Instance MCP is a different surface; `/mcp` must not swallow `/mcp-server`.
    expect(isTriggerPath("/mcp-server")).toBe(false);
    expect(isTriggerPath("/mcp-server/http")).toBe(false);
  });

  test("leaves the public API and probes alone", () => {
    expect(isTriggerPath("/api/v1/workflows")).toBe(false);
    expect(isTriggerPath("/api/v1/workflows/wf-1")).toBe(false);
    expect(isTriggerPath("/healthz")).toBe(false);
    expect(isTriggerPath("/")).toBe(false);
  });
});
