import {
  FullAnalysisResponseSchema,
  type Evidence,
  type FullAnalysisResponse,
  type GarmentComponent,
  type MaterialFact,
  type PriceSnapshot,
  type ProductSummary,
  type Warning,
} from "@/lib/contracts";

import type {
  AnalysisStore,
  EvidenceRow,
  MaterialClaimRow,
  PriceObservationRow,
  ProductRow,
  VariantRow,
} from "./store";

const COMPONENT_ORDER: GarmentComponent[] = ["shell", "lining", "trim", "other"];

const toIso = (timestamp: string) => new Date(timestamp).toISOString();

function productSummary(product: ProductRow, variant: VariantRow | null): ProductSummary {
  return {
    id: product.id,
    title: product.title,
    brand: product.brand,
    pageUrl: product.canonical_url,
    imageUrl: product.image_url,
    retailerProductId: product.retailer_product_id,
    variantLabel: variant?.color ?? variant?.description ?? null,
    department: product.department,
    category: product.category,
  };
}

/** Claims from one capture share a timestamp, so order them by content to stay stable. */
function compareClaims(a: MaterialClaimRow, b: MaterialClaimRow): number {
  return (
    COMPONENT_ORDER.indexOf(a.component) - COMPONENT_ORDER.indexOf(b.component) ||
    (b.percent ?? -1) - (a.percent ?? -1) ||
    a.fiber.localeCompare(b.fiber)
  );
}

function materialFacts(claims: MaterialClaimRow[]): MaterialFact[] {
  return [...claims]
    .sort(compareClaims)
    .map((claim) => ({
      id: claim.id,
      component: claim.component,
      fiber: claim.fiber,
      percent: claim.percent,
      rawText: claim.raw_text,
      verification: claim.verification_status,
      evidenceIds: [claim.evidence_id],
    }));
}

/** Evidence cited by the ordered facts comes first, in citation order. */
function evidenceItems(rows: EvidenceRow[], facts: MaterialFact[]): Evidence[] {
  const citationOrder = new Map<string, number>();
  facts.forEach((fact) =>
    fact.evidenceIds.forEach((id) => {
      if (!citationOrder.has(id)) citationOrder.set(id, citationOrder.size);
    }),
  );
  const rank = (row: EvidenceRow) => citationOrder.get(row.id) ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...rows].sort((a, b) => rank(a) - rank(b) || a.excerpt.localeCompare(b.excerpt));
  return ordered.map((row) => ({
    id: row.id,
    productId: row.product_id,
    sourceUrl: row.source_url,
    excerpt: row.excerpt,
    observedAt: toIso(row.captured_at),
  }));
}

function priceSnapshot(price: PriceObservationRow | null): PriceSnapshot {
  if (!price) return { listed: null, regular: null, observedAt: null };
  return {
    listed: { amountMinor: price.listed_amount_minor, currency: price.currency },
    regular:
      price.regular_amount_minor === null
        ? null
        : { amountMinor: price.regular_amount_minor, currency: price.currency },
    observedAt: toIso(price.observed_at),
  };
}

function warningsFor(composition: MaterialFact[], price: PriceSnapshot): Warning[] {
  const warnings: Warning[] = [];
  if (composition.length === 0) {
    warnings.push({
      code: "missing_composition",
      message: "No fiber composition was captured from this page.",
    });
  } else {
    if (composition.some((fact) => fact.percent === null)) {
      warnings.push({
        code: "partial_composition",
        message: "Some fibers were listed without a percentage.",
      });
    }
    if (composition.some((fact) => fact.verification === "extracted")) {
      warnings.push({
        code: "unverified_composition",
        message: "Composition is shown as extracted from the retailer page and has not been verified.",
      });
    }
  }
  if (price.listed === null) {
    warnings.push({ code: "missing_price", message: "No listed price was captured." });
  } else if (price.regular === null) {
    warnings.push({
      code: "missing_regular_price",
      message: "No regular price was listed. This does not indicate whether the item is discounted.",
    });
  }
  warnings.push({
    code: "missing_measurements",
    message: "No garment measurements were captured for this product.",
  });
  return warnings;
}

/**
 * Builds the full analysis from stored rows: the selected product and the evidence, claims,
 * and price from the capture that created the analysis. Returns null when the id is unknown.
 * Throws a ZodError if the stored data cannot form a valid contract response.
 */
export async function readAnalysis(
  store: AnalysisStore,
  analysisId: string,
): Promise<FullAnalysisResponse | null> {
  const analysis = await store.getAnalysis(analysisId);
  if (!analysis) return null;

  const [product, variant] = await Promise.all([
    analysis.selected_product_id ? store.getProduct(analysis.selected_product_id) : null,
    analysis.selected_variant_id ? store.getVariant(analysis.selected_variant_id) : null,
  ]);

  let evidence: EvidenceRow[] = [];
  let claims: MaterialClaimRow[] = [];
  let price: PriceObservationRow | null = null;
  if (product && analysis.captured_at && analysis.extractor_version) {
    const capturedAt = toIso(analysis.captured_at);
    [evidence, price] = await Promise.all([
      store.listCaptureEvidence({
        productId: product.id,
        capturedAt,
        extractorVersion: analysis.extractor_version,
      }),
      store.findPriceObservation(product.id, variant?.id ?? null, capturedAt),
    ]);
    claims = await store.listMaterialClaims(
      product.id,
      evidence.map((item) => item.id),
    );
  }

  const composition = materialFacts(claims);
  const priceView = priceSnapshot(price);

  return FullAnalysisResponseSchema.parse({
    analysisId: analysis.id,
    processingStatus: analysis.processing_status,
    outcome: analysis.outcome,
    submittedPageUrl: analysis.submitted_page_url,
    product: product ? productSummary(product, variant) : null,
    price: priceView,
    composition,
    evidence: evidenceItems(evidence, composition),
    alternatives: [],
    fit: { availability: "unavailable", measurements: [] },
    warnings: product ? warningsFor(composition, priceView) : [],
    failure:
      analysis.processing_status === "failed" && analysis.failure_code && analysis.failure_message
        ? { code: analysis.failure_code, message: analysis.failure_message }
        : null,
  });
}
