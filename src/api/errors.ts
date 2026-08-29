/** ErrorCode represents an error code */
export const ErrorCode = {
  AUTH_ERROR: "AUTH_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT_ERROR: "CONFLICT_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT_ERROR: "TIMEOUT_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SERVER_ERROR: "SERVER_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** APIError represents an error from the n8n API */
export class APIError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode: number, hint = "") {
    super(message);
    this.name = "APIError";
    this.code = code;
    this.statusCode = statusCode;
    this.hint = hint;
  }
}

/** NetworkError represents a network-related error */
export class NetworkError extends Error {
  override readonly cause: Error;

  constructor(cause: Error) {
    super(`network error: ${cause.message}`);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/** parseAPIError parses an API error from the response */
export function parseAPIError(statusCode: number, body: string): APIError {
  let message = "";

  // Try to parse the error response
  try {
    const errResp = JSON.parse(body) as { message?: string; code?: number };
    if (errResp.message) {
      message = errResp.message;
    }
  } catch {
    // Ignore parse errors
  }

  switch (statusCode) {
    case 401:
      return new APIError(
        ErrorCode.AUTH_ERROR,
        message || "Authentication failed",
        statusCode,
        "Please check your API key. Set N8N_API_KEY environment variable or use --api-key flag",
      );
    case 404:
      return new APIError(ErrorCode.NOT_FOUND, message || "Resource not found", statusCode);
    case 400:
      return new APIError(ErrorCode.VALIDATION_ERROR, message || "Invalid request", statusCode);
    case 409:
      return new APIError(
        ErrorCode.CONFLICT_ERROR,
        message || "Resource already exists",
        statusCode,
      );
    case 429:
      return new APIError(
        ErrorCode.SERVER_ERROR,
        message || "Rate limit exceeded",
        statusCode,
        "Please wait before making more requests",
      );
    default:
      if (statusCode >= 500) {
        return new APIError(
          ErrorCode.SERVER_ERROR,
          message || `Server error (status ${statusCode})`,
          statusCode,
        );
      }
      return new APIError(
        ErrorCode.UNKNOWN_ERROR,
        message || `Unexpected error (status ${statusCode})`,
        statusCode,
      );
  }
}

/** IsNotFoundError checks if the error is a not found error */
export function isNotFoundError(err: unknown): boolean {
  return err instanceof APIError && err.code === ErrorCode.NOT_FOUND;
}

/** IsAuthError checks if the error is an authentication error */
export function isAuthError(err: unknown): boolean {
  return err instanceof APIError && err.code === ErrorCode.AUTH_ERROR;
}

/** IsConflictError checks if the error is a conflict error (409) */
export function isConflictError(err: unknown): boolean {
  return err instanceof APIError && err.code === ErrorCode.CONFLICT_ERROR;
}

/**
 * IsValidationError checks if the error is a request-validation error (400).
 */
export function isValidationError(err: unknown): boolean {
  return err instanceof APIError && err.code === ErrorCode.VALIDATION_ERROR;
}

/**
 * IsAlreadyOwnedError checks if the error indicates a workflow is already in the target project.
 * This error can be returned as either 409 Conflict or 400 Bad Request depending on n8n version.
 */
export function isAlreadyOwnedError(err: unknown): boolean {
  if (err instanceof APIError) {
    return (
      err.message.includes("already owning it") ||
      err.message.includes("already belongs to") ||
      err.message.includes("same destination")
    );
  }
  return false;
}
