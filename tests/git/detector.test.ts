import { describe, expect, it } from "bun:test";
import { Detector, filterJSONFiles, filterWorkflowRelatedFiles } from "../../src/git/detector.ts";

describe("filterJSONFiles", () => {
  it("empty list returns empty", () => {
    expect(filterJSONFiles([])).toEqual([]);
  });

  it("filters only .json files", () => {
    const input = ["file1.json", "file2.txt", "file3.json", "file4.md"];
    const result = filterJSONFiles(input);
    expect(result).toEqual(["file1.json", "file3.json"]);
  });

  it("case insensitive filtering", () => {
    const input = ["file1.JSON", "file2.Json", "file3.TXT"];
    const result = filterJSONFiles(input);
    expect(result).toEqual(["file1.JSON", "file2.Json"]);
  });

  it("handles paths with directories", () => {
    const input = [
      "definitions/workflow.json",
      "definitions/README.md",
      "definitions/sub/workflow2.json",
    ];
    const result = filterJSONFiles(input);
    expect(result).toEqual(["definitions/workflow.json", "definitions/sub/workflow2.json"]);
  });

  it("no json files returns empty", () => {
    expect(filterJSONFiles(["file1.txt", "file2.md"])).toEqual([]);
  });
});

describe("filterWorkflowRelatedFiles", () => {
  it("empty list returns empty", () => {
    expect(filterWorkflowRelatedFiles([])).toEqual([]);
  });

  it("filters .json files", () => {
    const input = ["file1.json", "file2.txt", "file3.md"];
    const result = filterWorkflowRelatedFiles(input);
    expect(result).toEqual(["file1.json"]);
  });

  it("includes _subfiles external files", () => {
    const input = [
      "definitions/workflow.json",
      "definitions/_subfiles/my-workflow__abc123/code.js",
      "definitions/_subfiles/my-workflow__abc123/query.sql",
      "definitions/README.md",
    ];
    const result = filterWorkflowRelatedFiles(input);
    expect(result).toEqual([
      "definitions/workflow.json",
      "definitions/_subfiles/my-workflow__abc123/code.js",
      "definitions/_subfiles/my-workflow__abc123/query.sql",
    ]);
  });

  it("case insensitive for workflow files", () => {
    const input = ["file1.JSON", "definitions/_subfiles/test__id/file.JS"];
    const result = filterWorkflowRelatedFiles(input);
    expect(result).toEqual(["file1.JSON", "definitions/_subfiles/test__id/file.JS"]);
  });

  it("excludes non-workflow files outside _subfiles", () => {
    const input = ["definitions/workflow.json", "definitions/notes.md", "cli/main.go"];
    const result = filterWorkflowRelatedFiles(input);
    expect(result).toEqual(["definitions/workflow.json"]);
  });

  it("handles nested _subfiles directories", () => {
    const input = [
      "definitions/example-project/_subfiles/test__xyz/code.js",
      "definitions/example-project/workflow.json",
    ];
    const result = filterWorkflowRelatedFiles(input);
    expect(result).toEqual([
      "definitions/example-project/_subfiles/test__xyz/code.js",
      "definitions/example-project/workflow.json",
    ]);
  });
});

/** Check whether the repository has at least one commit. */
async function hasCommits(): Promise<boolean> {
  const proc = Bun.spawn(["git", "rev-parse", "--verify", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode === 0;
}

describe("Detector", () => {
  it("getRepoRoot returns a non-empty path", async () => {
    const d = new Detector();
    const root = await d.getRepoRoot();
    expect(root).toBeTruthy();
    expect(root.length).toBeGreaterThan(0);
  });

  it("getChangedFiles with valid diff spec does not throw", async () => {
    if (!(await hasCommits())) {
      console.log("skipping: no commits in repository");
      return;
    }
    const d = new Detector();
    const files = await d.getChangedFiles("HEAD~0..HEAD", "");
    // All files should be workflow-related
    for (const file of files) {
      const ext = file.toLowerCase().split(".").pop() ?? "";
      const isWorkflowFile = ext === "json" || ext === "yaml" || ext === "yml";
      const isSubfile = file.includes("/_subfiles/");
      expect(isWorkflowFile || isSubfile).toBe(true);
    }
  });

  it("getChangedFiles with invalid diff spec throws", async () => {
    if (!(await hasCommits())) {
      console.log("skipping: no commits in repository");
      return;
    }
    const d = new Detector();
    await expect(d.getChangedFiles("invalid-ref..HEAD", "")).rejects.toThrow("git diff failed");
  });
});
