import type { TraceResult } from "../types.ts";

/** Format trace result as JSON string */
export function formatTraceJSON(result: TraceResult): string {
  return JSON.stringify(result, null, 2);
}
