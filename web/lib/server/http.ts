import type { ErrorCode, FieldError } from "@/lib/contracts";

/**
 * Contract error codes plus server-only codes for failures the contract does not cover yet.
 * The response shape matches ErrorResponseSchema.
 */
export type ServerErrorCode = ErrorCode | "forbidden" | "internal_error" | "service_unavailable";

export type ServerErrorBody = {
  error: { code: ServerErrorCode; message: string; fields?: FieldError[] };
};

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: BASE_HEADERS });
}

export function errorResponse(
  status: number,
  code: ServerErrorCode,
  message: string,
  fields?: FieldError[],
): Response {
  const body: ServerErrorBody = { error: { code, message, ...(fields ? { fields } : {}) } };
  return jsonResponse(body, status);
}

export const internalErrorResponse = () =>
  errorResponse(500, "internal_error", "The request could not be completed.");

export const unavailableResponse = () =>
  errorResponse(503, "service_unavailable", "The service is temporarily unavailable.");
