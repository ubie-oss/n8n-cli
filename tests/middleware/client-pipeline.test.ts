import { describe, expect, test } from "bun:test";
import { runClientPipeline } from "@/middleware/client-pipeline.ts";
import type { ClientMiddleware } from "@/middleware/types.ts";

const baseCtx = {
  request: new Request("http://proxy.local/api/v1/workflows"),
  method: "GET",
  pathname: "/api/v1/workflows",
  upstreamUrl: "http://upstream.local/api/v1/workflows",
};

function setter(name: string, key: string, value: string): ClientMiddleware {
  return {
    name,
    apply(headers) {
      headers.set(key, value);
    },
  };
}

function thrower(name: string, message: string): ClientMiddleware {
  return {
    name,
    apply() {
      throw new Error(message);
    },
  };
}

describe("runClientPipeline", () => {
  test("empty chain leaves headers untouched", async () => {
    const headers = new Headers({ "x-original": "1" });
    await runClientPipeline([], headers, baseCtx);
    expect(headers.get("x-original")).toBe("1");
    expect([...headers.keys()]).toEqual(["x-original"]);
  });

  test("each middleware can mutate headers", async () => {
    const headers = new Headers();
    await runClientPipeline(
      [setter("a", "X-One", "1"), setter("b", "X-Two", "2")],
      headers,
      baseCtx,
    );
    expect(headers.get("X-One")).toBe("1");
    expect(headers.get("X-Two")).toBe("2");
  });

  test("later middleware can override earlier middleware's headers", async () => {
    const headers = new Headers();
    await runClientPipeline(
      [setter("a", "X-Key", "first"), setter("b", "X-Key", "second")],
      headers,
      baseCtx,
    );
    expect(headers.get("X-Key")).toBe("second");
  });

  test("a throwing middleware aborts the pipeline", async () => {
    const headers = new Headers();
    let bRan = false;
    const after: ClientMiddleware = {
      name: "after",
      apply() {
        bRan = true;
      },
    };
    await expect(
      runClientPipeline([thrower("bad", "boom"), after], headers, baseCtx),
    ).rejects.toThrow("boom");
    expect(bRan).toBe(false);
  });

  test("async middleware is awaited", async () => {
    const headers = new Headers();
    const mw: ClientMiddleware = {
      name: "async",
      async apply(h) {
        await new Promise((r) => setTimeout(r, 1));
        h.set("X-Async", "ok");
      },
    };
    await runClientPipeline([mw], headers, baseCtx);
    expect(headers.get("X-Async")).toBe("ok");
  });
});
