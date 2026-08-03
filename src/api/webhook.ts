import { runClientPipeline } from "@/middleware/client-pipeline.ts";
import type { ClientMiddleware } from "@/middleware/types.ts";

/** Options for a single webhook call. */
export interface WebhookCallOptions {
  method: string;
  /** JSON-serialized as the request body. Omit for a bodyless call. */
  data?: unknown;
  timeoutMs: number;
  /** Extra request headers, applied before the middleware chain runs. */
  headers?: Record<string, string>;
  /**
   * Egress middlewares, in order.
   *
   * Webhook calls do not go through `Client` — the URL lives outside
   * `/api/v1` — but they leave the machine through the same door, so they need
   * the same credentials. Without this, pointing `N8N_API_URL` at an
   * authenticating gateway would leave every webhook call as the one
   * unauthenticated request the CLI makes, rejected at the edge.
   */
  clientMiddlewares?: ClientMiddleware[];
}

/** Raw outcome of a webhook call. Status is reported, never interpreted. */
export interface WebhookCallResult {
  status: number;
  body: string;
}

/** POSTs (or GETs, ...) a webhook URL, applying the egress middleware chain. */
export async function callWebhook(
  url: string,
  opts: WebhookCallOptions,
): Promise<WebhookCallResult> {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(opts.headers ?? {}),
  });

  const chain = opts.clientMiddlewares ?? [];
  if (chain.length > 0) {
    await runClientPipeline(chain, headers, {
      method: opts.method,
      pathname: new URL(url).pathname,
      upstreamUrl: url,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const resp = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.data !== undefined ? JSON.stringify(opts.data) : undefined,
      signal: controller.signal,
    });
    return { status: resp.status, body: await resp.text() };
  } catch (e) {
    throw new Error(`webhook request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}
