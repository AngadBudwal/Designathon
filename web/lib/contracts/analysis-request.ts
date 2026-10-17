import { z } from "zod";

import {
  DepartmentSchema,
  GarmentComponentSchema,
  HttpUrlSchema,
  LIMITS,
  MoneySchema,
  plainText,
  TimestampSchema,
} from "./common";

/** A fiber named on the page. Percent is null when the page did not give a number. */
export const FiberReadingSchema = z.strictObject({
  name: plainText(LIMITS.fiberName),
  percent: z.number().min(0).max(100).nullable(),
});

export const SourceExcerptSchema = z.strictObject({
  text: plainText(LIMITS.excerpt),
});

/**
 * One composition block from the product page, as extracted by the extension.
 * Always treated as an extracted claim. There is no verification field, and strict
 * objects reject one if sent.
 * Percents are not required to total 100, and they are not a durability score.
 */
export const CompositionClaimSchema = z.strictObject({
  component: GarmentComponentSchema,
  rawText: plainText(LIMITS.rawText),
  fibers: z.array(FiberReadingSchema).max(20),
  excerpts: z.array(SourceExcerptSchema).min(1).max(5),
});

const OptionalTextSchema = (max: number) => plainText(max).nullable().optional();

/**
 * Untrusted payload from the Chrome extension.
 * Unknown keys are rejected. Omit a field or send null when the page did not show it.
 * Department is required; use "unknown" instead of guessing.
 * regularPrice null means no regular price was listed. It does not mean the item is undiscounted.
 * brand, imageUrl, retailerProductId, and variantLabel are extracted from the page, not verified.
 * The backend stores imageUrl as given and does not fetch it.
 */
export const AnalysisRequestSchema = z.strictObject({
  pageUrl: HttpUrlSchema,
  capturedAt: TimestampSchema,
  extractorVersion: z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.extractorVersion)
    .regex(/^[A-Za-z0-9._-]+$/),
  title: OptionalTextSchema(LIMITS.title),
  brand: OptionalTextSchema(LIMITS.brand),
  imageUrl: HttpUrlSchema.nullable().optional(),
  retailerProductId: OptionalTextSchema(LIMITS.retailerProductId),
  variantLabel: OptionalTextSchema(LIMITS.variantLabel),
  department: DepartmentSchema,
  category: OptionalTextSchema(LIMITS.category),
  listedPrice: MoneySchema.nullable().optional(),
  regularPrice: MoneySchema.nullable().optional(),
  composition: z.array(CompositionClaimSchema).max(8).nullable().optional(),
});

export type FiberReading = z.infer<typeof FiberReadingSchema>;
export type SourceExcerpt = z.infer<typeof SourceExcerptSchema>;
export type CompositionClaim = z.infer<typeof CompositionClaimSchema>;
export type AnalysisRequest = z.infer<typeof AnalysisRequestSchema>;
