import { z } from "zod";

import {
  ComparisonOutcomeSchema,
  CurrencyCodeSchema,
  DepartmentSchema,
  GarmentComponentSchema,
  HttpUrlSchema,
  LIMITS,
  MoneySchema,
  ProcessingStatusSchema,
  TimestampSchema,
  VerificationStatusSchema,
} from "./common";

export const EvidenceSchema = z.strictObject({
  id: z.string().uuid(),
  sourceUrl: HttpUrlSchema,
  excerpt: z.string().trim().min(1).max(LIMITS.excerpt),
  observedAt: TimestampSchema,
});

/** One fiber statement tied to stored evidence. Percent null means the page did not give a number. */
export const MaterialFactSchema = z.strictObject({
  id: z.string().uuid(),
  component: GarmentComponentSchema,
  fiber: z.string().trim().min(1).max(LIMITS.fiberName),
  percent: z.number().min(0).max(100).nullable(),
  rawText: z.string().trim().min(1).max(LIMITS.rawText),
  verification: VerificationStatusSchema,
  evidenceIds: z.array(z.string().uuid()).min(1).max(5),
});

export const MeasurementSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  value: z.number().positive(),
  unit: z.enum(["cm", "in"]),
});

/**
 * Only measurements listed on the page appear here. Unknown measurements are absent,
 * never zero or a default. "unavailable" must have an empty list.
 */
export const FitSchema = z
  .strictObject({
    availability: z.enum(["listed", "partial", "unavailable"]),
    measurements: z.array(MeasurementSchema).max(20),
  })
  .superRefine((fit, ctx) => {
    if (fit.availability === "unavailable" && fit.measurements.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "Unavailable fit cannot include measurements.",
        path: ["measurements"],
      });
    }
    if (fit.availability === "listed" && fit.measurements.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Listed fit requires at least one measurement.",
        path: ["measurements"],
      });
    }
  });

/**
 * regular null means no regular price was listed. It is not a discount.
 * observedAt is when these price fields were read. Null listed means no price was shown.
 */
export const PriceSnapshotSchema = z.strictObject({
  listed: MoneySchema.nullable(),
  regular: MoneySchema.nullable(),
  observedAt: TimestampSchema.nullable(),
});

/**
 * alternative listed price minus selected listed price, in minor units.
 * Negative means the alternative's listed price is lower. Null when not calculable.
 */
export const PriceDifferenceSchema = z.strictObject({
  amountMinor: z.number().int(),
  currency: CurrencyCodeSchema,
  comparedField: z.literal("listed_price"),
});

const DetailSchema = z.string().trim().min(1).max(LIMITS.detail);

/** Why this product was considered comparable. Neutral, not a judgment. */
export const ExplanationSchema = z.strictObject({
  code: z.enum(["same_category", "shared_fiber", "same_department", "different_department"]),
  detail: DetailSchema,
});

/** "natural fiber" compares listed percentages only. It is not a durability or quality score. */
export const AdvantageSchema = z.strictObject({
  code: z.enum(["lower_listed_price", "more_listed_natural_fiber"]),
  detail: DetailSchema,
});

export const DisadvantageSchema = z.strictObject({
  code: z.enum(["higher_listed_price", "less_listed_natural_fiber"]),
  detail: DetailSchema,
});

export const UncertaintySchema = z.strictObject({
  code: z.enum([
    "missing_fiber_percent",
    "unverified_composition",
    "different_component_coverage",
    "price_not_comparable",
    "fit_unknown",
  ]),
  detail: DetailSchema,
});

export const WarningSchema = z.strictObject({
  code: z.enum([
    "missing_composition",
    "partial_composition",
    "unverified_composition",
    "missing_price",
    "missing_regular_price",
    "missing_measurements",
    "no_suitable_alternative",
    "insufficient_information",
    "unsupported_page",
    "not_a_quality_or_durability_score",
  ]),
  message: z.string().trim().min(1).max(LIMITS.warningMessage),
});

export const ProductSummarySchema = z.strictObject({
  title: z.string().trim().min(1).max(LIMITS.title).nullable(),
  pageUrl: HttpUrlSchema,
  department: DepartmentSchema,
  category: z.string().trim().min(1).max(LIMITS.category).nullable(),
});

/** Each alternative carries its own advantages, disadvantages, and uncertainties. Any list may be empty. */
export const ComparableProductSchema = z.strictObject({
  product: ProductSummarySchema,
  price: PriceSnapshotSchema,
  composition: z.array(MaterialFactSchema).max(40),
  priceDifference: PriceDifferenceSchema.nullable(),
  explanations: z.array(ExplanationSchema).min(1).max(12),
  advantages: z.array(AdvantageSchema).max(12),
  disadvantages: z.array(DisadvantageSchema).max(12),
  uncertainties: z.array(UncertaintySchema).max(12),
  fit: FitSchema,
});

/** Client-safe failure. The message must not contain stack traces, credentials, or database details. */
export const AnalysisFailureSchema = z.strictObject({
  code: z.enum(["processing_failed"]),
  message: z.string().trim().min(1).max(LIMITS.errorMessage),
});

type Lifecycle = {
  processingStatus: z.infer<typeof ProcessingStatusSchema>;
  outcome: z.infer<typeof ComparisonOutcomeSchema> | null;
};

function checkLifecycle(value: Lifecycle, ctx: z.RefinementCtx) {
  if (value.processingStatus === "completed" && value.outcome === null) {
    ctx.addIssue({
      code: "custom",
      message: "A completed analysis requires an outcome.",
      path: ["outcome"],
    });
  }
  if (value.processingStatus !== "completed" && value.outcome !== null) {
    ctx.addIssue({
      code: "custom",
      message: "Outcome must be null until processing completes.",
      path: ["outcome"],
    });
  }
}

/** POST /api/analyses. pageUrl is the absolute website URL, not the retailer page. */
export const AnalysisCreatedResponseSchema = z
  .strictObject({
    analysisId: z.string().uuid(),
    pageUrl: HttpUrlSchema,
    processingStatus: ProcessingStatusSchema,
    outcome: ComparisonOutcomeSchema.nullable(),
  })
  .superRefine(checkLifecycle);

const OUTCOMES_REQUIRING_PRODUCT = new Set(["alternatives_found", "no_suitable_alternative"]);

/**
 * GET /api/analyses/:id. Structured fields only.
 * submittedPageUrl is the retailer URL the extension sent. product is null when nothing
 * reliable was captured, such as pending, failed, or unsupported pages.
 */
export const FullAnalysisResponseSchema = z
  .strictObject({
    analysisId: z.string().uuid(),
    processingStatus: ProcessingStatusSchema,
    outcome: ComparisonOutcomeSchema.nullable(),
    submittedPageUrl: HttpUrlSchema,
    product: ProductSummarySchema.nullable(),
    price: PriceSnapshotSchema,
    composition: z.array(MaterialFactSchema).max(40),
    evidence: z.array(EvidenceSchema).max(40),
    alternatives: z.array(ComparableProductSchema).max(12),
    fit: FitSchema,
    warnings: z.array(WarningSchema).max(20),
    failure: AnalysisFailureSchema.nullable(),
  })
  .superRefine((analysis, ctx) => {
    checkLifecycle(analysis, ctx);

    if ((analysis.processingStatus === "failed") !== (analysis.failure !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "failure is required when processing failed, and null otherwise.",
        path: ["failure"],
      });
    }

    if (analysis.outcome === "alternatives_found" && analysis.alternatives.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "alternatives_found requires at least one alternative.",
        path: ["alternatives"],
      });
    }
    if (analysis.outcome !== "alternatives_found" && analysis.alternatives.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "Only alternatives_found may include alternatives.",
        path: ["alternatives"],
      });
    }

    if (
      analysis.outcome !== null &&
      OUTCOMES_REQUIRING_PRODUCT.has(analysis.outcome) &&
      analysis.product === null
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${analysis.outcome} requires the selected product.`,
        path: ["product"],
      });
    }

    const evidenceIds = new Set(analysis.evidence.map((item) => item.id));
    const claims = [
      ...analysis.composition.map((claim, index) => ({ claim, path: ["composition", index] })),
      ...analysis.alternatives.flatMap((alternative, alternativeIndex) =>
        alternative.composition.map((claim, claimIndex) => ({
          claim,
          path: ["alternatives", alternativeIndex, "composition", claimIndex],
        })),
      ),
    ];
    for (const { claim, path } of claims) {
      for (const evidenceId of claim.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          ctx.addIssue({
            code: "custom",
            message: "Material claim references evidence that is not on this analysis.",
            path: [...path, "evidenceIds"],
          });
        }
      }
    }

    analysis.alternatives.forEach((alternative, index) => {
      const selected = analysis.price.listed;
      const other = alternative.price.listed;
      const difference = alternative.priceDifference;
      const canCompare =
        selected !== null && other !== null && selected.currency === other.currency;

      if (!canCompare && difference !== null) {
        ctx.addIssue({
          code: "custom",
          message: "Price difference requires two listed prices in the same currency.",
          path: ["alternatives", index, "priceDifference"],
        });
      }
      if (canCompare) {
        const expected = other.amountMinor - selected.amountMinor;
        if (
          difference === null ||
          difference.amountMinor !== expected ||
          difference.currency !== selected.currency
        ) {
          ctx.addIssue({
            code: "custom",
            message:
              "Price difference must be the alternative listed price minus the selected listed price.",
            path: ["alternatives", index, "priceDifference"],
          });
        }
      }

      const amount = difference?.amountMinor ?? null;
      if (
        alternative.advantages.some((item) => item.code === "lower_listed_price") &&
        (amount === null || amount >= 0)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "lower_listed_price requires a negative price difference.",
          path: ["alternatives", index, "advantages"],
        });
      }
      if (
        alternative.disadvantages.some((item) => item.code === "higher_listed_price") &&
        (amount === null || amount <= 0)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "higher_listed_price requires a positive price difference.",
          path: ["alternatives", index, "disadvantages"],
        });
      }
    });
  });

export type Evidence = z.infer<typeof EvidenceSchema>;
export type MaterialFact = z.infer<typeof MaterialFactSchema>;
export type Measurement = z.infer<typeof MeasurementSchema>;
export type Fit = z.infer<typeof FitSchema>;
export type PriceSnapshot = z.infer<typeof PriceSnapshotSchema>;
export type PriceDifference = z.infer<typeof PriceDifferenceSchema>;
export type Explanation = z.infer<typeof ExplanationSchema>;
export type Advantage = z.infer<typeof AdvantageSchema>;
export type Disadvantage = z.infer<typeof DisadvantageSchema>;
export type Uncertainty = z.infer<typeof UncertaintySchema>;
export type Warning = z.infer<typeof WarningSchema>;
export type ProductSummary = z.infer<typeof ProductSummarySchema>;
export type ComparableProduct = z.infer<typeof ComparableProductSchema>;
export type AnalysisFailure = z.infer<typeof AnalysisFailureSchema>;
export type AnalysisCreatedResponse = z.infer<typeof AnalysisCreatedResponseSchema>;
export type FullAnalysisResponse = z.infer<typeof FullAnalysisResponseSchema>;
