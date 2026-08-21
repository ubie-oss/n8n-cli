import { describe, expect, test } from "bun:test";
import { LOGGER_NAME, type LogEntry, Logger, resolveLogIdentity } from "@/proxy/logging.ts";

function capture(format: "json" | "text" = "json"): { lines: string[]; logger: Logger } {
  const lines: string[] = [];
  const logger = new Logger(format, (line) => lines.push(line));
  return { lines, logger };
}

function parse(line: string): LogEntry {
  return JSON.parse(line) as LogEntry;
}

describe("Logger: json format", () => {
  test("every line carries the fixed logger marker and a derived level", () => {
    const { lines, logger } = capture("json");
    logger.log({ action: "forward", method: "GET", path: "/api/v1/workflows", status: 200 });
    const entry = parse(lines[0]!);
    expect(entry.logger).toBe(LOGGER_NAME);
    expect(entry.event).toBe("request");
    expect(entry.level).toBe("info");
  });

  test("level follows action: warn -> warn, block/error -> error", () => {
    const { lines, logger } = capture("json");
    logger.log({ action: "warn", status: 200 });
    logger.log({ action: "block", status: 422 });
    logger.log({ action: "error", status: 502 });
    logger.log({ action: "pass", status: 200 });
    expect(parse(lines[0]!).level).toBe("warn");
    expect(parse(lines[1]!).level).toBe("error");
    expect(parse(lines[2]!).level).toBe("error");
    expect(parse(lines[3]!).level).toBe("info");
  });

  test("child pins shared fields onto every line and can override event", () => {
    const { lines, logger } = capture("json");
    const req = logger.child({
      requestId: "req-1",
      surface: "mcp",
      method: "POST",
      path: "/mcp-server/http",
    });
    req.log({ action: "forward", status: 200 });
    req.log({ action: "warn", status: 200, event: "policy", message: "withheld 1 tool(s)" });

    const forward = parse(lines[0]!);
    expect(forward.requestId).toBe("req-1");
    expect(forward.surface).toBe("mcp");
    expect(forward.method).toBe("POST");
    expect(forward.path).toBe("/mcp-server/http");
    expect(forward.event).toBe("request");

    const policy = parse(lines[1]!);
    expect(policy.requestId).toBe("req-1");
    expect(policy.event).toBe("policy");
  });

  test("ts is ISO-8601 and identity fields round-trip when supplied", () => {
    const { lines, logger } = capture("json");
    logger.log({
      action: "block",
      status: 401,
      identity: "user@example.com",
      identitySource: "oauth-verify",
      identityVerified: true,
    });
    const entry = parse(lines[0]!);
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.identity).toBe("user@example.com");
    expect(entry.identitySource).toBe("oauth-verify");
    expect(entry.identityVerified).toBe(true);
  });
});

describe("Logger: text format", () => {
  test("renders a compact key=value line with the new fields", () => {
    const { lines, logger } = capture("text");
    logger.child({ requestId: "req-1", surface: "rest-write", operation: "create" }).log({
      action: "pass",
      method: "POST",
      path: "/api/v1/workflows",
      status: 200,
      upstreamMs: 3,
      workflowName: "wf",
    });
    expect(lines[0]).toContain("PASS POST /api/v1/workflows 200");
    expect(lines[0]).toContain("surface=rest-write");
    expect(lines[0]).toContain("operation=create");
    expect(lines[0]).toContain("requestId=req-1");
    expect(lines[0]).toContain("upstreamMs=3");
    expect(lines[0]).toContain('workflow="wf"');
  });
});

describe("resolveLogIdentity", () => {
  function requestWith(headers: Record<string, string>): Request {
    return new Request("http://localhost/x", { headers });
  }

  test("verified bearer identity wins over everything", () => {
    const req = requestWith({
      "x-goog-authenticated-user-email": "accounts.google.com:other@example.com",
    });
    const got = resolveLogIdentity(req, {
      identity: "ctx@example.com",
      auth: { effective: { email: "bearer@example.com", layer: "bearer" } },
    });
    expect(got).toEqual({
      identity: "bearer@example.com",
      identitySource: "oauth-verify",
      identityVerified: true,
    });
  });

  test("impersonator effective identity is labelled accordingly", () => {
    const got = resolveLogIdentity(requestWith({}), {
      auth: { effective: { email: "human@example.com", layer: "impersonator" } },
    });
    expect(got).toEqual({
      identity: "human@example.com",
      identitySource: "impersonator-verify",
      identityVerified: true,
    });
  });

  test("a bare middleware identity is kept with verified=false", () => {
    const got = resolveLogIdentity(requestWith({}), { identity: "ctx@example.com" });
    expect(got).toEqual({
      identity: "ctx@example.com",
      identitySource: "middleware",
      identityVerified: false,
    });
  });

  test("the ambient IAP header is used as a fallback", () => {
    const got = resolveLogIdentity(
      requestWith({ "x-goog-authenticated-user-email": "accounts.google.com:user@example.com" }),
    );
    expect(got).toEqual({
      identity: "user@example.com",
      identitySource: "iap-header",
      identityVerified: false,
    });
  });

  test("an IAP header without the accounts.google.com: prefix is kept as-is", () => {
    const got = resolveLogIdentity(
      requestWith({ "x-goog-authenticated-user-email": "user@example.com" }),
    );
    expect(got?.identity).toBe("user@example.com");
  });

  test("returns undefined when nothing is resolvable", () => {
    expect(resolveLogIdentity(requestWith({}))).toBeUndefined();
    expect(resolveLogIdentity(undefined)).toBeUndefined();
    expect(resolveLogIdentity(requestWith({}), { auth: {} })).toBeUndefined();
  });
});
