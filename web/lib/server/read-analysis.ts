import {
  FullAnalysisResponseSchema,
  type ComparableProduct,
  type Evidence,
  type FullAnalysisResponse,
  type GarmentComponent,
  type MaterialFact,
  type PriceDifference,
  type PriceSnapshot,
  type ProductSummary,
  type Warning,
} from "@/lib/contracts";

import { loadCatalogFacts, loadSelectedCapture } from "./catalog";
import { assessSelected, type ProductFacts } from "./matching/matching";
import type {
  AnalysisRow,
  AnalysisStore,
  EvidenceRow,
  MaterialClaimRow,
  PriceObservationRow,
  ProductRow,
  ReasonKind,
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

const unavailableFit = () => ({ availability: "unavailable" as const, measurements: [] });

function outcomeWarning(analysis: AnalysisRow, selected: ProductFacts | null): Warning | null {
  switch (analysis.outcome) {
    case "alternatives_found":
      return {
        code: "not_a_quality_or_durability_score",
        message:
          "Comparisons use listed fiber percentages and listed prices only. They are not quality or durability ratings.",
      };
    case "no_suitable_alternative":
      return {
        code: "no_suitable_alternative",
        message:
          selected && assessSelected(selected) === "unsupported_category"
            ? "Comparison currently covers sweaters and knitwear only, so no catalog search was run for this product."
            : "No comparable product was found in our current catalog. This search covers only products stored in our database, not every retailer.",
      };
    case "insufficient_information": {
      const assessment = selected ? assessSelected(selected) : null;
      return {
        code: "insufficient_information",
        message:
          assessment === "unknown_department"
            ? "The listing did not state a department, so a cross-department comparison was not attempted."
            : assessment === "missing_composition"
              ? "No fiber composition was captured, so materials could not be compared."
              : "Not enough product information was captured to compare.",
      };
    }
    default:
      return null;
  }
}

function citedEvidence(rows: EvidenceRow[], composition: MaterialFact[]): EvidenceRow[] {
  const cited = new Set(composition.flatMap((fact) => fact.evidenceIds));
  return rows.filter((row) => cited.has(row.id));
}

function priceDifference(selected: PriceSnapshot, alternative: PriceSnapshot): PriceDifference | null {
  const a = selected.listed;
  const b = alternative.listed;
  if (!a || !b || a.currency !== b.currency) return null;
  return { amountMinor: b.amountMinor - a.amountMinor, currency: a.currency, comparedField: "listed_price" };
}

async function loadAlternatives(
  store: AnalysisStore,
  analysis: AnalysisRow,
  selectedPrice: PriceSnapshot,
): Promise<{ alternatives: ComparableProduct[]; evidence: EvidenceRow[] }> {
  const [comparables, reasons] = await Promise.all([
    store.listComparables(analysis.id),
    store.listComparableReasons(analysis.id),
  ]);
  if (comparables.length === 0 || !analysis.finished_at) return { alternatives: [], evidence: [] };

  const products = await store.listProductsByIds(comparables.map((row) => row.product_id));
  const ordered = comparables
    .map((row) => products.find((product) => product.id === row.product_id))
    .filter((product): product is ProductRow => product !== undefined);
  const facts = await loadCatalogFacts(store, ordered, toIso(analysis.finished_at));

  const evidence: EvidenceRow[] = [];
  const alternatives = facts.map((item): ComparableProduct => {
    const composition = materialFacts(item.claims);
    evidence.push(...citedEvidence(item.evidence, composition));
    const price = priceSnapshot(item.price);
    const own = reasons.filter((reason) => reason.product_id === item.product.id);
    const ofKind = (kind: ReasonKind) =>
      own.filter((reason) => reason.kind === kind).map(({ code, detail }) => ({ code, detail }));
    return {
      product: productSummary(item.product, null),
      price,
      composition,
      priceDifference: priceDifference(selectedPrice, price),
      explanations: ofKind("explanation"),
      advantages: ofKind("advantage"),
      disadvantages: ofKind("disadvantage"),
      uncertainties: ofKind("uncertainty"),
      fit: unavailableFit(),
    } as ComparableProduct;
  });
  return { alternatives, evidence };
}

/**
 * Builds the full analysis from stored rows. Read-only.
 *
 * The selected product uses the evidence, claims, and price from the capture that created the
 * analysis. Completed analyses with alternatives add the stored comparables, each with its latest
 * capture and price at or before `finished_at`, and the stored reasons.
 * Returns null when the id is unknown. Throws a ZodError if stored data cannot form a valid
 * contract response.
 */
export async function readAnalysis(
  store: AnalysisStore,
  analysisId: string,
): Promise<FullAnalysisResponse | null> {
  const analysis = await store.getAnalysis(analysisId);
  if (!analysis) return null;

  const { facts: selected, variant } = await loadSelectedCapture(store, analysis);
  const composition = materialFacts(selected?.claims ?? []);
  const priceView = priceSnapshot(selected?.price ?? null);

  const { alternatives, evidence: alternativeEvidence } =
    analysis.processing_status === "completed" && analysis.outcome === "alternatives_found"
      ? await loadAlternatives(store, analysis, priceView)
      : { alternatives: [], evidence: [] };

  const warnings = selected ? warningsFor(composition, priceView) : [];
  const extra = outcomeWarning(analysis, selected);
  if (extra) warnings.push(extra);

  return FullAnalysisResponseSchema.parse({
    analysisId: analysis.id,
    processingStatus: analysis.processing_status,
    outcome: analysis.outcome,
    submittedPageUrl: analysis.submitted_page_url,
    product: selected ? productSummary(selected.product, variant) : null,
    price: priceView,
    composition,
    evidence: [
      ...evidenceItems(selected?.evidence ?? [], composition),
      ...evidenceItems(
        alternativeEvidence,
        alternatives.flatMap((alternative) => alternative.composition),
      ),
    ],
    alternatives,
    fit: unavailableFit(),
    warnings,
    failure:
      analysis.processing_status === "failed" && analysis.failure_code && analysis.failure_message
        ? { code: analysis.failure_code, message: analysis.failure_message }
        : null,
  });
}
