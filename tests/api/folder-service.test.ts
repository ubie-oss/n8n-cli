import { describe, expect, it, mock } from "bun:test";
import { Client } from "../../src/api/client.ts";
import { FolderService, folderPathOf } from "../../src/api/folder-service.ts";
import type { Folder } from "../../src/api/types.ts";

/** Records every request the service makes and answers with canned bodies. */
function stubClient(bodies: string[]): {
  client: Client;
  calls: Array<{ method: string; url: string; body: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let index = 0;

  const original = globalThis.fetch;
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const body = bodies[Math.min(index++, bodies.length - 1)] ?? "{}";
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;

  // Restored by the caller's `finally`; kept on the object so each test can do
  // it without threading the original through.
  (calls as unknown as { restore: () => void }).restore = () => {
    globalThis.fetch = original;
  };

  return { client: new Client("https://n8n.test", "key"), calls };
}

function restore(calls: unknown): void {
  (calls as { restore: () => void }).restore();
}

describe("FolderService", () => {
  it("lists folders under the project path, selecting the parent chain", async () => {
    const { client, calls } = stubClient([JSON.stringify({ count: 0, data: [] })]);
    try {
      await new FolderService(client).listFolders("proj-1");

      const url = new URL(calls[0]!.url);
      expect(url.pathname).toBe("/api/v1/projects/proj-1/folders");
      // Without parentFolder in `select`, the response carries no link to the
      // enclosing folder and paths cannot be built.
      expect(JSON.parse(url.searchParams.get("select")!)).toContain("parentFolder");
    } finally {
      restore(calls);
    }
  });

  it("encodes a project ID that needs escaping", async () => {
    const { client, calls } = stubClient([JSON.stringify({ count: 0, data: [] })]);
    try {
      await new FolderService(client).getFolder("a/b", "f 1");
      expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/projects/a%2Fb/folders/f%201");
    } finally {
      restore(calls);
    }
  });

  it("sends filters as a single JSON query parameter", async () => {
    const { client, calls } = stubClient([JSON.stringify({ count: 0, data: [] })]);
    try {
      await new FolderService(client).listFolders("p", { parentFolderId: "f1", name: "bill" });
      const filter = JSON.parse(new URL(calls[0]!.url).searchParams.get("filter")!);
      expect(filter).toEqual({ parentFolderId: "f1", name: "bill" });
    } finally {
      restore(calls);
    }
  });

  it("omits the filter parameter entirely when nothing is filtered", async () => {
    const { client, calls } = stubClient([JSON.stringify({ count: 0, data: [] })]);
    try {
      await new FolderService(client).listFolders("p");
      expect(new URL(calls[0]!.url).searchParams.has("filter")).toBe(false);
    } finally {
      restore(calls);
    }
  });

  it("pages with skip/take until a short page arrives", async () => {
    const page = (n: number, from: number) =>
      JSON.stringify({
        count: 3,
        data: Array.from({ length: n }, (_, i) => ({ id: `f${from + i}`, name: `f${from + i}` })),
      });
    const { client, calls } = stubClient([page(2, 0), page(1, 2)]);

    try {
      const folders = await new FolderService(client).listAllFolders("p", { take: 2 });
      expect(folders.map((f) => f.id)).toEqual(["f0", "f1", "f2"]);
      expect(new URL(calls[0]!.url).searchParams.get("skip")).toBe("0");
      expect(new URL(calls[1]!.url).searchParams.get("skip")).toBe("2");
    } finally {
      restore(calls);
    }
  });

  it("stops paging once count is reached, even on a full page", async () => {
    const full = JSON.stringify({
      count: 2,
      data: [
        { id: "a", name: "a" },
        { id: "b", name: "b" },
      ],
    });
    const { client, calls } = stubClient([full]);

    try {
      const folders = await new FolderService(client).listAllFolders("p", { take: 2 });
      expect(folders).toHaveLength(2);
      expect(calls).toHaveLength(1);
    } finally {
      restore(calls);
    }
  });

  it("creates a folder with POST", async () => {
    const { client, calls } = stubClient([JSON.stringify({ id: "new", name: "Ops" })]);
    try {
      const folder = await new FolderService(client).createFolder("p", { name: "Ops" });
      expect(folder.id).toBe("new");
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.body).toEqual({ name: "Ops" });
    } finally {
      restore(calls);
    }
  });

  it("updates a folder with PATCH", async () => {
    const { client, calls } = stubClient([JSON.stringify({ id: "f1", name: "Renamed" })]);
    try {
      await new FolderService(client).updateFolder("p", "f1", { name: "Renamed" });
      expect(calls[0]!.method).toBe("PATCH");
      expect(calls[0]!.body).toEqual({ name: "Renamed" });
    } finally {
      restore(calls);
    }
  });

  it("passes transferToFolderId when deleting", async () => {
    const { client, calls } = stubClient(["{}"]);
    try {
      await new FolderService(client).deleteFolder("p", "f1", "f2");
      expect(calls[0]!.method).toBe("DELETE");
      expect(new URL(calls[0]!.url).searchParams.get("transferToFolderId")).toBe("f2");
    } finally {
      restore(calls);
    }
  });

  it("omits the transfer parameter when none is given", async () => {
    const { client, calls } = stubClient(["{}"]);
    try {
      await new FolderService(client).deleteFolder("p", "f1");
      expect(calls[0]!.url).not.toContain("transferToFolderId");
    } finally {
      restore(calls);
    }
  });
});

describe("folderPathOf", () => {
  it("joins the ancestor chain outermost first", () => {
    const folder: Folder = {
      id: "f3",
      name: "Billing",
      parentFolder: { id: "f2", name: "Ops", parentFolder: { id: "f1", name: "Team" } },
    };
    expect(folderPathOf(folder)).toBe("Team/Ops/Billing");
  });

  it("returns the bare name when no chain was requested", () => {
    expect(folderPathOf({ id: "f1", name: "Ops" })).toBe("Ops");
  });

  it("terminates on a cyclic chain rather than hanging", () => {
    const a: Folder = { id: "a", name: "A" };
    a.parentFolder = { id: "a", name: "A", parentFolder: a.parentFolder };
    // Self-referential by construction: the server should never produce this,
    // but the walk must be bounded regardless.
    (a.parentFolder as { parentFolder?: unknown }).parentFolder = a.parentFolder;
    expect(folderPathOf(a).endsWith("A")).toBe(true);
  });
});
