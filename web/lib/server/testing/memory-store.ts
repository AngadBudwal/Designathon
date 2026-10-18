import {
  StoreError,
  type AnalysisRow,
  type AnalysisStore,
  type ComparableReasonRow,
  type ComparableRow,
  type EvidenceRow,
  type MaterialClaimRow,
  type NewAnalysis,
  type PriceObservationRow,
  type ProductRow,
  type RetailerRow,
  type VariantRow,
} from "../store";

type StoredAnalysis = NewAnalysis & Omit<AnalysisRow, "captured_at" | "extractor_version">;
type StoredComparable = ComparableRow & { sequence: number };

export type MemoryTables = {
  retailers: RetailerRow[];
  products: ProductRow[];
  variants: VariantRow[];
  evidence: EvidenceRow[];
  claims: MaterialClaimRow[];
  prices: PriceObservationRow[];
  analyses: StoredAnalysis[];
  comparables: StoredComparable[];
  reasons: ComparableReasonRow[];
};

const unique = (detail: string) => new StoreError("unique_violation", "23505", detail);
const foreignKey = (detail: string) => new StoreError("foreign_key_violation", "23503", detail);

/**
 * In-memory AnalysisStore for tests. Enforces the uniqueness, evidence/variant ownership,
 * and cascade rules of the real schema. `failOn` makes the named method throw once.
 */
export function createMemoryStore() {
  const tables: MemoryTables = {
    retailers: [],
    products: [],
    variants: [],
    evidence: [],
    claims: [],
    prices: [],
    analyses: [],
    comparables: [],
    reasons: [],
  };
  const failures = new Map<keyof AnalysisStore, StoreError>();
  const calls: string[] = [];
  let sequence = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;

  function guard(method: keyof AnalysisStore) {
    calls.push(method);
    const failure = failures.get(method);
    if (failure) {
      failures.delete(method);
      throw failure;
    }
  }

  const evidenceOwnedBy = (productId: string, evidenceId: string | null) =>
    evidenceId === null ||
    tables.evidence.some((item) => item.id === evidenceId && item.product_id === productId);
  const variantOwnedBy = (productId: string, variantId: string | null) =>
    variantId === null ||
    tables.variants.some((item) => item.id === variantId && item.product_id === productId);

  function removeEvidence(ids: Set<string>) {
    tables.evidence = tables.evidence.filter((item) => !ids.has(item.id));
    tables.claims = tables.claims.filter((claim) => !ids.has(claim.evidence_id));
  }

  const store: AnalysisStore = {
    async findRetailerByDomain(domain) {
      guard("findRetailerByDomain");
      return tables.retailers.find((item) => item.domain === domain) ?? null;
    },
    async insertRetailer(values) {
      guard("insertRetailer");
      if (tables.retailers.some((item) => item.domain === values.domain)) throw unique("retailers.domain");
      const created = { id: nextId(), ...values };
      tables.retailers.push(created);
      return created;
    },
    async deleteRetailer(id) {
      guard("deleteRetailer");
      if (tables.products.some((item) => item.retailer_id === id)) throw foreignKey("products.retailer_id");
      tables.retailers = tables.retailers.filter((item) => item.id !== id);
    },

    async getProduct(id) {
      guard("getProduct");
      return tables.products.find((item) => item.id === id) ?? null;
    },
    async findProductByRetailerProductId(retailerId, retailerProductId) {
      guard("findProductByRetailerProductId");
      return (
        tables.products.find(
          (item) => item.retailer_id === retailerId && item.retailer_product_id === retailerProductId,
        ) ?? null
      );
    },
    async findProductByCanonicalUrl(retailerId, canonicalUrl) {
      guard("findProductByCanonicalUrl");
      return (
        tables.products.find(
          (item) => item.retailer_id === retailerId && item.canonical_url === canonicalUrl,
        ) ?? null
      );
    },
    async insertProduct(values) {
      guard("insertProduct");
      if (!tables.retailers.some((item) => item.id === values.retailer_id)) {
        throw foreignKey("products.retailer_id");
      }
      const duplicate = tables.products.some(
        (item) =>
          item.retailer_id === values.retailer_id &&
          (item.canonical_url === values.canonical_url ||
            (values.retailer_product_id !== null &&
              item.retailer_product_id === values.retailer_product_id)),
      );
      if (duplicate) throw unique("products");
      const created = { id: nextId(), ...values };
      tables.products.push(created);
      return created;
    },
    async updateProduct(id, patch) {
      guard("updateProduct");
      const product = tables.products.find((item) => item.id === id);
      if (!product) throw new StoreError("unknown", "PGRST116", "no row");
      Object.assign(product, patch);
      return { ...product };
    },
    async deleteProduct(id) {
      guard("deleteProduct");
      if (
        tables.analyses.some((item) => item.selected_product_id === id) ||
        tables.comparables.some((item) => item.product_id === id)
      ) {
        throw foreignKey("product referenced by an analysis");
      }
      const evidenceIds = new Set(
        tables.evidence.filter((item) => item.product_id === id).map((item) => item.id),
      );
      removeEvidence(evidenceIds);
      tables.prices = tables.prices.filter((item) => item.product_id !== id);
      tables.variants = tables.variants.filter((item) => item.product_id !== id);
      tables.products = tables.products.filter((item) => item.id !== id);
    },

    async getVariant(id) {
      guard("getVariant");
      return tables.variants.find((item) => item.id === id) ?? null;
    },
    async findVariantByDescription(productId, description) {
      guard("findVariantByDescription");
      return (
        tables.variants.find(
          (item) =>
            item.product_id === productId &&
            item.retailer_variant_id === null &&
            item.color === null &&
            item.size_label === null &&
            item.description === description,
        ) ?? null
      );
    },
    async insertVariant(values) {
      guard("insertVariant");
      if (!tables.products.some((item) => item.id === values.product_id)) {
        throw foreignKey("product_variants.product_id");
      }
      const created: VariantRow = {
        id: nextId(),
        retailer_variant_id: null,
        color: null,
        size_label: null,
        ...values,
      };
      tables.variants.push(created);
      return created;
    },
    async deleteVariant(id) {
      guard("deleteVariant");
      if (tables.prices.some((item) => item.variant_id === id)) throw foreignKey("price_observations.variant_id");
      tables.variants = tables.variants.filter((item) => item.id !== id);
    },

    async listCaptureEvidence({ productId, capturedAt, extractorVersion }) {
      guard("listCaptureEvidence");
      return tables.evidence.filter(
        (item) =>
          item.product_id === productId &&
          item.source_type === "extension_capture" &&
          new Date(item.captured_at).getTime() === new Date(capturedAt).getTime() &&
          item.extractor_version === extractorVersion,
      );
    },
    async insertEvidence(values) {
      guard("insertEvidence");
      for (const item of values) {
        if (!tables.products.some((product) => product.id === item.product_id)) {
          throw foreignKey("product_evidence.product_id");
        }
      }
      tables.evidence.push(...values.map((item) => ({ ...item })));
    },
    async deleteEvidence(ids) {
      guard("deleteEvidence");
      removeEvidence(new Set(ids));
    },

    async listMaterialClaims(productId, evidenceIds) {
      guard("listMaterialClaims");
      return tables.claims.filter(
        (claim) => claim.product_id === productId && evidenceIds.includes(claim.evidence_id),
      );
    },
    async insertMaterialClaims(values) {
      guard("insertMaterialClaims");
      for (const claim of values) {
        if (!evidenceOwnedBy(claim.product_id, claim.evidence_id)) {
          throw foreignKey("material_claims (product_id, evidence_id)");
        }
        const duplicate = [...tables.claims, ...values.filter((other) => other !== claim)].some(
          (other) =>
            other.evidence_id === claim.evidence_id &&
            other.component === claim.component &&
            other.fiber === claim.fiber,
        );
        if (duplicate) throw unique("material_claims (evidence_id, component, fiber)");
      }
      tables.claims.push(...values.map((item) => ({ ...item })));
    },

    async findPriceObservation(productId, variantId, observedAt) {
      guard("findPriceObservation");
      const matches = tables.prices.filter(
        (item) =>
          item.product_id === productId &&
          item.variant_id === variantId &&
          new Date(item.observed_at).getTime() === new Date(observedAt).getTime(),
      );
      return matches.at(-1) ?? null;
    },
    async insertPriceObservation(values) {
      guard("insertPriceObservation");
      if (!variantOwnedBy(values.product_id, values.variant_id)) {
        throw foreignKey("price_observations (product_id, variant_id)");
      }
      if (!evidenceOwnedBy(values.product_id, values.evidence_id)) {
        throw foreignKey("price_observations (product_id, evidence_id)");
      }
      tables.prices.push({ ...values });
    },
    async deletePriceObservation(id) {
      guard("deletePriceObservation");
      tables.prices = tables.prices.filter((item) => item.id !== id);
    },

    async getAnalysis(id) {
      guard("getAnalysis");
      const found = tables.analyses.find((item) => item.id === id);
      if (!found) return null;
      const payload = found.request_payload as { capturedAt?: string; extractorVersion?: string };
      return {
        id: found.id,
        submitted_page_url: found.submitted_page_url,
        selected_product_id: found.selected_product_id,
        selected_variant_id: found.selected_variant_id,
        processing_status: found.processing_status,
        outcome: found.outcome,
        failure_code: found.failure_code,
        failure_message: found.failure_message,
        finished_at: found.finished_at,
        captured_at: payload.capturedAt ?? null,
        extractor_version: payload.extractorVersion ?? null,
      };
    },
    async insertAnalysis(values) {
      guard("insertAnalysis");
      if (!variantOwnedBy(values.selected_product_id, values.selected_variant_id)) {
        throw foreignKey("analyses (selected_product_id, selected_variant_id)");
      }
      tables.analyses.push({
        ...structuredClone(values),
        processing_status: "pending",
        outcome: null,
        failure_code: null,
        failure_message: null,
        finished_at: null,
      });
    },
    async completeAnalysis(id, outcome, finishedAt) {
      guard("completeAnalysis");
      const found = tables.analyses.find((item) => item.id === id && item.processing_status === "pending");
      if (!found) return false;
      if ((outcome === "alternatives_found" || outcome === "no_suitable_alternative") && !found.selected_product_id) {
        throw new StoreError("check_violation", "23514", "analyses_outcome_requires_product");
      }
      Object.assign(found, { processing_status: "completed", outcome, finished_at: finishedAt });
      return true;
    },

    async listProductsByIds(ids) {
      guard("listProductsByIds");
      return tables.products.filter((item) => ids.includes(item.id));
    },
    async listCandidateProducts(departments, excludeProductId) {
      guard("listCandidateProducts");
      return tables.products.filter(
        (item) => departments.includes(item.department) && item.id !== excludeProductId,
      );
    },
    async listEvidenceForProducts(productIds, capturedAtOrBefore) {
      guard("listEvidenceForProducts");
      const cutoff = new Date(capturedAtOrBefore).getTime();
      return tables.evidence.filter(
        (item) => productIds.includes(item.product_id) && new Date(item.captured_at).getTime() <= cutoff,
      );
    },
    async listClaimsForEvidence(evidenceIds) {
      guard("listClaimsForEvidence");
      return tables.claims.filter((claim) => evidenceIds.includes(claim.evidence_id));
    },
    async listPricesForProducts(productIds, observedAtOrBefore) {
      guard("listPricesForProducts");
      const cutoff = new Date(observedAtOrBefore).getTime();
      return tables.prices.filter(
        (item) => productIds.includes(item.product_id) && new Date(item.observed_at).getTime() <= cutoff,
      );
    },

    async listComparables(analysisId) {
      guard("listComparables");
      return tables.comparables
        .filter((item) => item.analysis_id === analysisId)
        .sort((a, b) => a.sequence - b.sequence)
        .map(({ analysis_id, product_id, variant_id }) => ({ analysis_id, product_id, variant_id }));
    },
    async listComparableReasons(analysisId) {
      guard("listComparableReasons");
      return tables.reasons
        .filter((item) => item.analysis_id === analysisId)
        .sort(
          (a, b) =>
            a.product_id.localeCompare(b.product_id) ||
            a.kind.localeCompare(b.kind) ||
            a.code.localeCompare(b.code),
        );
    },
    async deleteComparables(analysisId) {
      guard("deleteComparables");
      tables.comparables = tables.comparables.filter((item) => item.analysis_id !== analysisId);
      tables.reasons = tables.reasons.filter((item) => item.analysis_id !== analysisId);
    },
    async insertComparable(values) {
      guard("insertComparable");
      const duplicate = tables.comparables.some(
        (item) => item.analysis_id === values.analysis_id && item.product_id === values.product_id,
      );
      if (duplicate) throw unique("analysis_comparables_pkey");
      if (!tables.products.some((item) => item.id === values.product_id)) {
        throw foreignKey("analysis_comparables.product_id");
      }
      tables.comparables.push({ ...values, sequence: ++sequence });
    },
    async insertComparableReasons(values) {
      guard("insertComparableReasons");
      for (const reason of values) {
        const parent = tables.comparables.some(
          (item) => item.analysis_id === reason.analysis_id && item.product_id === reason.product_id,
        );
        if (!parent) throw foreignKey("analysis_comparable_reasons (analysis_id, product_id)");
        const duplicate = [...tables.reasons, ...values.filter((other) => other !== reason)].some(
          (other) =>
            other.analysis_id === reason.analysis_id &&
            other.product_id === reason.product_id &&
            other.kind === reason.kind &&
            other.code === reason.code,
        );
        if (duplicate) throw unique("analysis_comparable_reasons (analysis_id, product_id, kind, code)");
      }
      tables.reasons.push(...values.map((item) => ({ ...item })));
    },
  };

  return {
    store,
    tables,
    calls,
    failOnce(method: keyof AnalysisStore, error = new StoreError("unknown", "XX000", "injected failure")) {
      failures.set(method, error);
    },
  };
}
