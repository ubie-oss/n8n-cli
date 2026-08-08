import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CredentialService } from "@/api/credential-service.ts";
import type { Credential } from "@/api/types.ts";
import { importCredentials } from "@/credentials/importer.ts";
import { scanCredentialDirectory } from "@/credentials/scanner.ts";

/**
 * `credential import` scaffolds definition files; it does not sync them.
 *
 * The distinction matters because the API never returns credential values, so
 * the local file is the only record of them. Overwriting an existing file would
 * destroy the secret references it holds and replace them with an empty block,
 * with no way to get them back.
 */

function mockService(credentials: Credential[]): CredentialService {
  return { listAllCredentials: async () => credentials } as unknown as CredentialService;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-cred-import-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("importCredentials", () => {
  const remote: Credential[] = [
    { id: "c1", name: "Slack Bot", type: "slackApi" },
    { id: "c2", name: "GitHub", type: "githubApi" },
  ];

  test("writes a scaffold per credential, named with its ID", async () => {
    const result = await importCredentials(mockService(remote), {
      directory: dir,
      dryRun: false,
      ids: [],
    });

    expect(result.created).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(["github.c2.yaml", "slack-bot.c1.yaml"]);
  });

  test("the scaffold parses back as a valid definition with no values", async () => {
    await importCredentials(mockService(remote), { directory: dir, dryRun: false, ids: [] });

    const files = scanCredentialDirectory(dir);
    const slack = files.find((f) => f.definition?.id === "c1")!;
    expect(slack.error).toBeUndefined();
    expect(slack.definition).toEqual({ id: "c1", name: "Slack Bot", type: "slackApi", data: {} });
  });

  test("the scaffold documents the secret reference syntax", async () => {
    await importCredentials(mockService(remote), { directory: dir, dryRun: false, ids: [] });

    const text = fs.readFileSync(path.join(dir, "slack-bot.c1.yaml"), "utf-8");
    expect(text).toContain("gcp-sm://");
    expect(text).toContain("env://");
  });

  test("never overwrites a definition that already exists locally", async () => {
    const existing = path.join(dir, "hand-written.yaml");
    fs.writeFileSync(
      existing,
      'id: "c1"\nname: Slack Bot\ntype: slackApi\ndata:\n  token: env://T\n',
    );

    const result = await importCredentials(mockService(remote), {
      directory: dir,
      dryRun: false,
      ids: [],
    });

    expect(result.skipped).toBe(1);
    expect(fs.readFileSync(existing, "utf-8")).toContain("env://T");
    expect(fs.existsSync(path.join(dir, "slack-bot.c1.yaml"))).toBe(false);
  });

  test("--ids restricts the import", async () => {
    await importCredentials(mockService(remote), { directory: dir, dryRun: false, ids: ["c2"] });
    expect(fs.readdirSync(dir)).toEqual(["github.c2.yaml"]);
  });

  test("a dry run reports without writing", async () => {
    const result = await importCredentials(mockService(remote), {
      directory: dir,
      dryRun: true,
      ids: [],
    });

    expect(result.created).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
