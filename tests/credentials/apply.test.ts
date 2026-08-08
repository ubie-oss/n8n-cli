import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CredentialService } from "@/api/credential-service.ts";
import { APIError, ErrorCode } from "@/api/errors.ts";
import type { Credential, CredentialInput } from "@/api/types.ts";
import { CredentialApplyExecutor } from "@/credentials/executor.ts";
import { patchJSONID, patchYamlID } from "@/credentials/local-file.ts";
import { scanCredentialDirectory } from "@/credentials/scanner.ts";
import { defaultCredentialApplyOptions } from "@/credentials/types.ts";
import { EnvSecretResolver } from "@/secrets/env.ts";

/**
 * Credential apply, and the constraint that shapes it: the n8n public API marks
 * credential data write-only, so there is no remote copy of the values to
 * compare against. Everything here is about not destroying values the CLI
 * cannot see — a definition that withholds `data` must never clear it, and a
 * dry run must never even fetch the secrets it would write.
 */

interface Recorded {
  creates: CredentialInput[];
  updates: Array<{ id: string; input: Partial<CredentialInput> }>;
}

function mockService(existing: Credential[] = []): {
  service: CredentialService;
  recorded: Recorded;
} {
  const recorded: Recorded = { creates: [], updates: [] };
  const service = {
    listAllCredentials: async () => existing,
    getCredential: async (id: string) => {
      const found = existing.find((c) => c.id === id);
      if (!found) throw new APIError(ErrorCode.NOT_FOUND, "not found", 404);
      return found;
    },
    createCredential: async (input: CredentialInput) => {
      recorded.creates.push(input);
      return { ...input, id: "new-id" } as Credential;
    },
    updateCredential: async (id: string, input: Partial<CredentialInput>) => {
      recorded.updates.push({ id, input });
      return { id, name: input.name ?? "", type: input.type ?? "" } as Credential;
    },
  } as unknown as CredentialService;
  return { service, recorded };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-cred-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeDefinition(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

function executor(
  service: CredentialService,
  env: NodeJS.ProcessEnv = {},
  overrides: Partial<ReturnType<typeof defaultCredentialApplyOptions>> = {},
): CredentialApplyExecutor {
  const opts = { ...defaultCredentialApplyOptions(), directory: dir, ...overrides };
  return new CredentialApplyExecutor(service, [new EnvSecretResolver(env)], opts);
}

describe("scanning", () => {
  test("reads YAML and JSON definitions alike", () => {
    writeDefinition("a.yaml", "name: A\ntype: slackApi\n");
    writeDefinition("b.json", JSON.stringify({ name: "B", type: "githubApi" }));

    const files = scanCredentialDirectory(dir);
    expect(files.map((f) => f.definition?.name)).toEqual(["A", "B"]);
  });

  test("returns an empty list for a directory that does not exist", () => {
    expect(scanCredentialDirectory(path.join(dir, "nope"))).toEqual([]);
  });

  test("records a parse failure against the file instead of aborting the scan", () => {
    writeDefinition("bad.yaml", "name: [unclosed\n");
    writeDefinition("good.yaml", "name: Good\ntype: slackApi\n");

    const files = scanCredentialDirectory(dir);
    expect(files.find((f) => f.path.endsWith("bad.yaml"))?.error).toBeDefined();
    expect(files.find((f) => f.path.endsWith("good.yaml"))?.definition?.name).toBe("Good");
  });

  test("rejects a definition missing name or type", () => {
    writeDefinition("a.yaml", "type: slackApi\n");
    expect(scanCredentialDirectory(dir)[0]?.error?.message).toMatch(/non-empty `name`/);
  });
});

describe("create", () => {
  test("creates a credential and writes the new ID back to the file", async () => {
    const { service, recorded } = mockService();
    const file = writeDefinition(
      "slack.yaml",
      "name: Slack\ntype: slackApi\ndata:\n  token: abc\n",
    );

    const result = await executor(service).execute();

    expect(result.createCount).toBe(1);
    expect(recorded.creates[0]).toEqual({
      name: "Slack",
      type: "slackApi",
      data: { token: "abc" },
    });
    // Without the stamp, the next apply would create a second credential.
    expect(fs.readFileSync(file, "utf-8")).toContain('id: "new-id"');
  });

  test("resolves secret references before sending them", async () => {
    const { service, recorded } = mockService();
    writeDefinition(
      "slack.yaml",
      "name: Slack\ntype: slackApi\ndata:\n  token: env://SLACK_TOKEN\n",
    );

    await executor(service, { SLACK_TOKEN: "xoxb-real" }).execute();

    expect(recorded.creates[0]?.data).toEqual({ token: "xoxb-real" });
  });

  test("does not write the resolved secret back into the definition file", async () => {
    const { service } = mockService();
    const file = writeDefinition(
      "slack.yaml",
      "name: Slack\ntype: slackApi\ndata:\n  token: env://SLACK_TOKEN\n",
    );

    await executor(service, { SLACK_TOKEN: "xoxb-real" }).execute();

    const written = fs.readFileSync(file, "utf-8");
    expect(written).toContain("env://SLACK_TOKEN");
    expect(written).not.toContain("xoxb-real");
  });

  test("refuses a name that already exists upstream", async () => {
    const { service, recorded } = mockService([{ id: "old", name: "Slack", type: "slackApi" }]);
    writeDefinition("slack.yaml", "name: Slack\ntype: slackApi\n");

    const result = await executor(service).execute();

    expect(result.errorCount).toBe(1);
    expect(result.operations[0]?.error?.message).toMatch(/id: old/);
    expect(recorded.creates).toEqual([]);
  });

  test("creates the duplicate anyway under --force, and warns", async () => {
    const { service, recorded } = mockService([{ id: "old", name: "Slack", type: "slackApi" }]);
    writeDefinition("slack.yaml", "name: Slack\ntype: slackApi\n");

    const result = await executor(service, {}, { force: true }).execute();

    expect(recorded.creates).toHaveLength(1);
    expect(result.warningCount).toBe(1);
  });
});

describe("update", () => {
  const existing: Credential[] = [{ id: "c1", name: "Slack", type: "slackApi" }];

  test("sends name, type and data when the definition carries values", async () => {
    const { service, recorded } = mockService(existing);
    writeDefinition(
      "slack.yaml",
      'id: "c1"\nname: Slack Renamed\ntype: slackApi\ndata:\n  token: abc\n',
    );

    await executor(service).execute();

    expect(recorded.updates[0]).toEqual({
      id: "c1",
      input: { name: "Slack Renamed", type: "slackApi", data: { token: "abc" } },
    });
  });

  test("sends only the name when the definition carries no data", async () => {
    const { service, recorded } = mockService(existing);
    writeDefinition("slack.yaml", 'id: "c1"\nname: Slack Renamed\ntype: slackApi\n');

    await executor(service).execute();

    // Sending `data: {}` here would wipe the credential's real values, which
    // this CLI has no way to read back and therefore no way to restore.
    expect(recorded.updates[0]?.input).toEqual({ name: "Slack Renamed" });
  });

  test("clears the values only when the definition says so explicitly", async () => {
    const { service, recorded } = mockService(existing);
    writeDefinition("slack.yaml", 'id: "c1"\nname: Slack\ntype: slackApi\ndata: {}\n');

    await executor(service).execute();

    expect(recorded.updates[0]?.input.data).toEqual({});
  });

  test("explains an ID that belongs to a different server", async () => {
    const { service, recorded } = mockService(existing);
    writeDefinition("slack.yaml", 'id: "from-staging"\nname: Slack\ntype: slackApi\n');

    const result = await executor(service).execute();

    expect(result.operations[0]?.error?.message).toMatch(/does not exist on this server/);
    expect(recorded.updates).toEqual([]);
  });
});

describe("dry run", () => {
  test("reports the references it would read without reading them", async () => {
    const { service, recorded } = mockService();
    writeDefinition(
      "slack.yaml",
      "name: Slack\ntype: slackApi\ndata:\n  token: env://ABSENT_VARIABLE\n",
    );

    // The variable is deliberately unset: a dry run that resolved secrets would
    // fail here, and in the real world would be charging for vault reads.
    const result = await executor(service, {}, { dryRun: true }).execute();

    expect(result.createCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.operations[0]?.secretRefs).toEqual([
      { path: "token", scheme: "env", raw: "env://ABSENT_VARIABLE" },
    ]);
    expect(recorded.creates).toEqual([]);
  });

  test("writes nothing to the local file", async () => {
    const { service } = mockService();
    const file = writeDefinition("slack.yaml", "name: Slack\ntype: slackApi\n");
    const before = fs.readFileSync(file, "utf-8");

    await executor(service, {}, { dryRun: true }).execute();

    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });
});

describe("selection", () => {
  test("--ids matches an ID or a file basename", async () => {
    const { service, recorded } = mockService();
    writeDefinition("slack.yaml", "name: Slack\ntype: slackApi\n");
    writeDefinition("github.yaml", "name: GitHub\ntype: githubApi\n");

    await executor(service, {}, { ids: ["github"] }).execute();

    expect(recorded.creates.map((c) => c.name)).toEqual(["GitHub"]);
  });
});

describe("ID stamping", () => {
  test("adds an id to YAML without disturbing the rest of the file", () => {
    const text = "# a comment worth keeping\nname: Slack\ntype: slackApi\n";
    expect(patchYamlID(text, "abc")).toBe(`id: "abc"\n${text}`);
  });

  test("replaces an existing id rather than adding a duplicate key", () => {
    // A duplicate mapping key makes the whole file fail to parse.
    const patched = patchYamlID('id: "old"\nname: Slack\n', "new");
    expect(patched).toBe('id: "new"\nname: Slack\n');
  });

  test("replaces a quoted id key too", () => {
    expect(patchYamlID('"id": old\nname: Slack\n', "new")).toBe('id: "new"\nname: Slack\n');
  });

  test("puts the id first in JSON and keeps every other field", () => {
    const patched = patchJSONID(JSON.stringify({ name: "Slack", type: "slackApi" }), "abc");
    expect(JSON.parse(patched!)).toEqual({ id: "abc", name: "Slack", type: "slackApi" });
    expect(patched!.indexOf('"id"')).toBeLessThan(patched!.indexOf('"name"'));
  });

  test("declines to patch a JSON file that is not an object", () => {
    expect(patchJSONID("[1, 2]", "abc")).toBeNull();
    expect(patchJSONID("not json", "abc")).toBeNull();
  });
});
