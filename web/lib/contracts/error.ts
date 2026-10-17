import { z } from "zod";

import { LIMITS } from "./common";

export const ErrorCodeSchema = z.enum([
  "validation_error",
  "unsupported_page",
  "not_found",
  "insufficient_information",
]);

export const FieldErrorSchema = z.strictObject({
  path: z.string().trim().min(1).max(LIMITS.fieldPath),
  code: z.string().trim().min(1).max(LIMITS.fieldCode),
  message: z.string().trim().min(1).max(LIMITS.fieldMessage),
});

/** Client-safe error. No stack traces, secrets, or database details. */
export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string().trim().min(1).max(LIMITS.errorMessage),
    fields: z.array(FieldErrorSchema).max(50).optional(),
  }),
});

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type FieldError = z.infer<typeof FieldErrorSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export function zodErrorToErrorResponse(
  error: z.ZodError,
  message = "The request is invalid.",
): ErrorResponse {
  return ErrorResponseSchema.parse({
    error: {
      code: "validation_error",
      message,
      fields: error.issues.slice(0, 50).map((issue) => ({
        path: (issue.path.join(".") || "(root)").slice(0, LIMITS.fieldPath),
        code: String(issue.code).slice(0, LIMITS.fieldCode),
        message: issue.message.slice(0, LIMITS.fieldMessage),
      })),
    },
  });
}
