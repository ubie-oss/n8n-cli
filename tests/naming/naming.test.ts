import { describe, expect, test } from "bun:test";
import {
  extractWorkflowIDFromDirname,
  extractWorkflowIDFromFilename,
  generateDirnameWithID,
  generateFilenameWithID,
} from "@/naming/naming.ts";

describe("extractWorkflowIDFromFilename", () => {
  const cases: { name: string; filename: string; wantID: string; wantOk: boolean }[] = [
    {
      name: "new format with json extension",
      filename: "日次レポート__abc123def456.json",
      wantID: "abc123def456",
      wantOk: true,
    },
    {
      name: "new format with path",
      filename: "definitions/example-project/サンプル処理__xyz789.json",
      wantID: "xyz789",
      wantOk: true,
    },
    {
      name: "old format without ID",
      filename: "workflow-name.json",
      wantID: "",
      wantOk: false,
    },
    {
      name: "old format with hyphen ID",
      filename: "workflow-name-abc123.json",
      wantID: "",
      wantOk: false,
    },
    {
      name: "name with hyphens and new format ID",
      filename: "my-workflow-name__abc123.json",
      wantID: "abc123",
      wantOk: true,
    },
    {
      name: "name with double underscore in name",
      filename: "my__special__name__id123.json",
      wantID: "id123",
      wantOk: true,
    },
    {
      name: "empty ID after separator",
      filename: "workflow__.json",
      wantID: "",
      wantOk: false,
    },
    {
      name: "no extension",
      filename: "workflow__abc123",
      wantID: "abc123",
      wantOk: true,
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      const [gotID, gotOk] = extractWorkflowIDFromFilename(tc.filename);
      expect(gotID).toBe(tc.wantID);
      expect(gotOk).toBe(tc.wantOk);
    });
  }
});

describe("generateFilenameWithID", () => {
  const cases: {
    name: string;
    sanitizedName: string;
    workflowID: string;
    ext: string;
    want: string;
  }[] = [
    {
      name: "json extension",
      sanitizedName: "日次レポート",
      workflowID: "abc123def456",
      ext: ".json",
      want: "日次レポート__abc123def456.json",
    },
    {
      name: "name with hyphens",
      sanitizedName: "my-workflow-name",
      workflowID: "id123",
      ext: ".json",
      want: "my-workflow-name__id123.json",
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      const got = generateFilenameWithID(tc.sanitizedName, tc.workflowID, tc.ext);
      expect(got).toBe(tc.want);
    });
  }
});

describe("extractWorkflowIDFromDirname", () => {
  const cases: { name: string; dirname: string; wantID: string; wantOk: boolean }[] = [
    {
      name: "new format directory",
      dirname: "日次レポート__abc123def456",
      wantID: "abc123def456",
      wantOk: true,
    },
    {
      name: "new format with path",
      dirname: "definitions/workflow__xyz789",
      wantID: "xyz789",
      wantOk: true,
    },
    {
      name: "old format directory",
      dirname: "abc123def456",
      wantID: "",
      wantOk: false,
    },
    {
      name: "empty ID after separator",
      dirname: "workflow__",
      wantID: "",
      wantOk: false,
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      const [gotID, gotOk] = extractWorkflowIDFromDirname(tc.dirname);
      expect(gotID).toBe(tc.wantID);
      expect(gotOk).toBe(tc.wantOk);
    });
  }
});

describe("generateDirnameWithID", () => {
  const cases: { name: string; sanitizedName: string; workflowID: string; want: string }[] = [
    {
      name: "basic directory",
      sanitizedName: "日次レポート",
      workflowID: "abc123def456",
      want: "日次レポート__abc123def456",
    },
    {
      name: "name with hyphens",
      sanitizedName: "my-workflow",
      workflowID: "id123",
      want: "my-workflow__id123",
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      const got = generateDirnameWithID(tc.sanitizedName, tc.workflowID);
      expect(got).toBe(tc.want);
    });
  }
});
