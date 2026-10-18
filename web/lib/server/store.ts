import type {
  ComparisonOutcome,
  Department,
  GarmentComponent,
  ProcessingStatus,
  VerificationStatus,
} from "@/lib/contracts";

/** Rows use the column names in supabase/migrations/20261017235500_initial_schema.sql. */
export type RetailerRow = { id: string; name: string; domain: string };

export type ProductRow = {
  id: string;
  retailer_id: string;
  canonical_url: string;
  retailer_product_id: string | null;
  title: string | null;
  brand: string | null;
  department: Department;
  category: string | null;
  image_url: string | null;
};

export type ProductPatch = Partial<
  Pick<ProductRow, "retailer_product_id" | "title" | "brand" | "department" | "category" | "image_url">
>;

export type VariantRow = {
  id: string;
  product_id: string;
  retailer_variant_id: string | null;
  color: string | null;
  size_label: string | null;
  description: string | null;
};

export type EvidenceRow = {
  id: string;
  product_id: string;
  source_type: "extension_capture" | "manual_review" | "retailer_feed";
  source_url: string;
  excerpt: string;
  captured_at: string;
  extractor_version: string | null;
};

export type MaterialClaimRow = {
  id: string;
  product_id: string;
  evidence_id: string;
  component: GarmentComponent;
  fiber: string;
  percent: number | null;
  raw_text: string;
  verification_status: VerificationStatus;
};

export type PriceObservationRow = {
  id: string;
  product_id: string;
  variant_id: string | null;
  evidence_id: string | null;
  listed_amount_minor: number;
  regular_amount_minor: number | null;
  currency: string;
  observed_at: string;
};

export type NewAnalysis = {
  id: string;
  submitted_page_url: string;
  request_payload: Record<string, unknown>;
  selected_product_id: string;
  selected_variant_id: string | null;
};

export type AnalysisRow = {
  id: string;
  submitted_page_url: string;
  selected_product_id: string | null;
  selected_variant_id: string | null;
  processing_status: ProcessingStatus;
  outcome: ComparisonOutcome | null;
  failure_code: "processing_failed" | null;
  failure_message: string | null;
  finished_at: string | null;
  /** capturedAt and extractorVersion from request_payload. */
  captured_at: string | null;
  extractor_version: string | null;
};

export type ReasonKind = "explanation" | "advantage" | "disadvantage" | "uncertainty";

export type ComparableRow = { analysis_id: string; product_id: string; variant_id: string | null };

export type ComparableReasonRow = {
  analysis_id: string;
  product_id: string;
  kind: ReasonKind;
  code: string;
  detail: string;
};

/** One capture is the evidence an extension submission stored for a product. */
export type CaptureKey = { productId: string; capturedAt: string; extractorVersion: string };

/** Narrow data access used by ingestion and retrieval. Implemented by Supabase and by tests. */
export interface AnalysisStore {
  findRetailerByDomain(domain: string): Promise<RetailerRow | null>;
  insertRetailer(row: { name: string; domain: string }): Promise<RetailerRow>;
  deleteRetailer(id: string): Promise<void>;

  getProduct(id: string): Promise<ProductRow | null>;
  findProductByRetailerProductId(retailerId: string, retailerProductId: string): Promise<ProductRow | null>;
  findProductByCanonicalUrl(retailerId: string, canonicalUrl: string): Promise<ProductRow | null>;
  insertProduct(row: Omit<ProductRow, "id">): Promise<ProductRow>;
  updateProduct(id: string, patch: ProductPatch): Promise<ProductRow>;
  deleteProduct(id: string): Promise<void>;

  getVariant(id: string): Promise<VariantRow | null>;
  findVariantByDescription(productId: string, description: string): Promise<VariantRow | null>;
  insertVariant(row: { product_id: string; description: string }): Promise<VariantRow>;
  deleteVariant(id: string): Promise<void>;

  listCaptureEvidence(capture: CaptureKey): Promise<EvidenceRow[]>;
  insertEvidence(rows: EvidenceRow[]): Promise<void>;
  deleteEvidence(ids: string[]): Promise<void>;

  listMaterialClaims(productId: string, evidenceIds: string[]): Promise<MaterialClaimRow[]>;
  insertMaterialClaims(rows: MaterialClaimRow[]): Promise<void>;

  findPriceObservation(
    productId: string,
    variantId: string | null,
    observedAt: string,
  ): Promise<PriceObservationRow | null>;
  insertPriceObservation(row: PriceObservationRow): Promise<void>;
  deletePriceObservation(id: string): Promise<void>;

  getAnalysis(id: string): Promise<AnalysisRow | null>;
  insertAnalysis(row: NewAnalysis): Promise<void>;
  /** Sets completed only if the analysis is still pending. Returns false otherwise. */
  completeAnalysis(id: string, outcome: ComparisonOutcome, finishedAt: string): Promise<boolean>;

  /** Catalog reads used by matching. Results are capped; the catalog is small for now. */
  listProductsByIds(ids: string[]): Promise<ProductRow[]>;
  listCandidateProducts(departments: Department[], excludeProductId: string): Promise<ProductRow[]>;
  listEvidenceForProducts(productIds: string[], capturedAtOrBefore: string): Promise<EvidenceRow[]>;
  listClaimsForEvidence(evidenceIds: string[]): Promise<MaterialClaimRow[]>;
  listPricesForProducts(productIds: string[], observedAtOrBefore: string): Promise<PriceObservationRow[]>;

  /** Comparables in insertion order, which is ranking order. */
  listComparables(analysisId: string): Promise<ComparableRow[]>;
  listComparableReasons(analysisId: string): Promise<ComparableReasonRow[]>;
  deleteComparables(analysisId: string): Promise<void>;
  insertComparable(row: ComparableRow): Promise<void>;
  insertComparableReasons(rows: ComparableReasonRow[]): Promise<void>;
}

export type StoreErrorKind =
  | "unique_violation"
  | "foreign_key_violation"
  | "check_violation"
  | "unavailable"
  | "unknown";

/** Database failure. `detail` is for server logs only and is never sent to clients. */
export class StoreError extends Error {
  constructor(
    readonly kind: StoreErrorKind,
    readonly code: string | null,
    readonly detail: string,
  ) {
    super(`Database operation failed (${kind})`);
    this.name = "StoreError";
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof StoreError && error.kind === "unique_violation";
}
