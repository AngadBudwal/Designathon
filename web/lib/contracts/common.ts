import { z } from "zod";

/** Bump this when a contract field or status changes, and note it in lib/contracts/README.md. */
export const CONTRACT_VERSION = "2.0.0";

export const LIMITS = {
  url: 2048,
  title: 300,
  category: 120,
  extractorVersion: 40,
  rawText: 2000,
  excerpt: 500,
  fiberName: 80,
  detail: 300,
  warningMessage: 400,
  errorMessage: 500,
  fieldPath: 200,
  fieldCode: 80,
  fieldMessage: 300,
} as const;

/** Absolute http(s) URL. Rejects javascript:, data:, and other schemes. */
export const HttpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.url)
  .url()
  .refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
    message: "URL must use http or https",
  });

const MARKUP_PATTERN = /<\s*[a-zA-Z!/?]/;

/** Trimmed, length-limited text that rejects HTML tags, so pages cannot be submitted as markup. */
export function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !MARKUP_PATTERN.test(value), {
      message: "Text must not contain HTML markup",
    });
}

/** ISO-8601 timestamp with a timezone offset or Z. Naive local times are rejected. */
export const TimestampSchema = z.string().datetime({ offset: true });

/** Three-letter currency code. This checks the shape, not the full ISO list. */
export const CurrencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code");

/**
 * Money in integer minor units (cents for USD).
 * 8900 with currency USD means $89.00. Floating prices are rejected.
 */
export const MoneySchema = z.strictObject({
  amountMinor: z.number().int().nonnegative(),
  currency: CurrencyCodeSchema,
});

export const DepartmentSchema = z.enum(["womens", "mens", "unisex", "unknown"]);

export const GarmentComponentSchema = z.enum(["shell", "lining", "trim", "other"]);

/**
 * Response-only. The extension request has no verification field.
 * Only backend processing may set "verified", and only with linked stored evidence.
 */
export const VerificationStatusSchema = z.enum(["extracted", "verified"]);

/** Lifecycle of the analysis job. */
export const ProcessingStatusSchema = z.enum(["pending", "completed", "failed"]);

/**
 * Result of a completed analysis. Null while pending and when failed.
 * None of these values is a durability or quality ranking.
 */
export const ComparisonOutcomeSchema = z.enum([
  "alternatives_found",
  "no_suitable_alternative",
  "insufficient_information",
  "unsupported_page",
]);

export type Money = z.infer<typeof MoneySchema>;
export type Department = z.infer<typeof DepartmentSchema>;
export type GarmentComponent = z.infer<typeof GarmentComponentSchema>;
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;
export type ProcessingStatus = z.infer<typeof ProcessingStatusSchema>;
export type ComparisonOutcome = z.infer<typeof ComparisonOutcomeSchema>;
