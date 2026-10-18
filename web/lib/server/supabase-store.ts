import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  StoreError,
  type AnalysisRow,
  type AnalysisStore,
  type EvidenceRow,
  type MaterialClaimRow,
  type PriceObservationRow,
  type ProductRow,
  type RetailerRow,
  type StoreErrorKind,
  type VariantRow,
} from "./store";

const RETAILER_COLUMNS = "id, name, domain";
const PRODUCT_COLUMNS =
  "id, retailer_id, canonical_url, retailer_product_id, title, brand, department, category, image_url";
const VARIANT_COLUMNS = "id, product_id, retailer_variant_id, color, size_label, description";
const EVIDENCE_COLUMNS = "id, product_id, source_type, source_url, excerpt, captured_at, extractor_version";
const CLAIM_COLUMNS =
  "id, product_id, evidence_id, component, fiber, percent, raw_text, verification_status";
const PRICE_COLUMNS =
  "id, product_id, variant_id, evidence_id, listed_amount_minor, regular_amount_minor, currency, observed_at";
const ANALYSIS_COLUMNS =
  "id, submitted_page_url, selected_product_id, selected_variant_id, processing_status, outcome, " +
  "failure_code, failure_message, captured_at:request_payload->>capturedAt, " +
  "extractor_version:request_payload->>extractorVersion";

type PostgrestFailure = { code?: string | null; message?: string | null };

const SQLSTATE_KINDS: Record<string, StoreErrorKind> = {
  "23505": "unique_violation",
  "23503": "foreign_key_violation",
  "23514": "check_violation",
};

function toStoreError(error: PostgrestFailure): StoreError {
  const code = error.code || null;
  const kind: StoreErrorKind = code ? (SQLSTATE_KINDS[code] ?? "unknown") : "unavailable";
  return new StoreError(kind, code, String(error.message ?? "").slice(0, 300));
}

type Result<T> = { data: T | null; error: PostgrestFailure | null };

function rows<T>({ data, error }: Result<unknown>): T[] {
  if (error) throw toStoreError(error);
  return (data ?? []) as T[];
}

function row<T>({ data, error }: Result<unknown>): T | null {
  if (error) throw toStoreError(error);
  return (data ?? null) as T | null;
}

function required<T>(result: Result<unknown>): T {
  const value = row<T>(result);
  if (value === null) throw new StoreError("unknown", null, "Expected a row to be returned");
  return value;
}

function ok({ error }: { error: PostgrestFailure | null }): void {
  if (error) throw toStoreError(error);
}

function asClaim(value: MaterialClaimRow): MaterialClaimRow {
  return { ...value, percent: value.percent === null ? null : Number(value.percent) };
}

function asPrice(value: PriceObservationRow): PriceObservationRow {
  return {
    ...value,
    listed_amount_minor: Number(value.listed_amount_minor),
    regular_amount_minor:
      value.regular_amount_minor === null ? null : Number(value.regular_amount_minor),
  };
}

export function createSupabaseStore(db: SupabaseClient): AnalysisStore {
  return {
    async findRetailerByDomain(domain) {
      return row<RetailerRow>(
        await db.from("retailers").select(RETAILER_COLUMNS).eq("domain", domain).maybeSingle(),
      );
    },
    async insertRetailer(values) {
      return required<RetailerRow>(
        await db.from("retailers").insert(values).select(RETAILER_COLUMNS).single(),
      );
    },
    async deleteRetailer(id) {
      ok(await db.from("retailers").delete().eq("id", id));
    },

    async getProduct(id) {
      return row<ProductRow>(
        await db.from("products").select(PRODUCT_COLUMNS).eq("id", id).maybeSingle(),
      );
    },
    async findProductByRetailerProductId(retailerId, retailerProductId) {
      return row<ProductRow>(
        await db
          .from("products")
          .select(PRODUCT_COLUMNS)
          .eq("retailer_id", retailerId)
          .eq("retailer_product_id", retailerProductId)
          .maybeSingle(),
      );
    },
    async findProductByCanonicalUrl(retailerId, canonicalUrl) {
      return row<ProductRow>(
        await db
          .from("products")
          .select(PRODUCT_COLUMNS)
          .eq("retailer_id", retailerId)
          .eq("canonical_url", canonicalUrl)
          .maybeSingle(),
      );
    },
    async insertProduct(values) {
      return required<ProductRow>(
        await db.from("products").insert(values).select(PRODUCT_COLUMNS).single(),
      );
    },
    async updateProduct(id, patch) {
      return required<ProductRow>(
        await db.from("products").update(patch).eq("id", id).select(PRODUCT_COLUMNS).single(),
      );
    },
    async deleteProduct(id) {
      ok(await db.from("products").delete().eq("id", id));
    },

    async getVariant(id) {
      return row<VariantRow>(
        await db.from("product_variants").select(VARIANT_COLUMNS).eq("id", id).maybeSingle(),
      );
    },
    async findVariantByDescription(productId, description) {
      return row<VariantRow>(
        await db
          .from("product_variants")
          .select(VARIANT_COLUMNS)
          .eq("product_id", productId)
          .is("retailer_variant_id", null)
          .is("color", null)
          .is("size_label", null)
          .eq("description", description)
          .maybeSingle(),
      );
    },
    async insertVariant(values) {
      return required<VariantRow>(
        await db.from("product_variants").insert(values).select(VARIANT_COLUMNS).single(),
      );
    },
    async deleteVariant(id) {
      ok(await db.from("product_variants").delete().eq("id", id));
    },

    async listCaptureEvidence({ productId, capturedAt, extractorVersion }) {
      return rows<EvidenceRow>(
        await db
          .from("product_evidence")
          .select(EVIDENCE_COLUMNS)
          .eq("product_id", productId)
          .eq("source_type", "extension_capture")
          .eq("captured_at", capturedAt)
          .eq("extractor_version", extractorVersion)
          .order("created_at")
          .order("id")
          .limit(40),
      );
    },
    async insertEvidence(values) {
      ok(await db.from("product_evidence").insert(values));
    },
    async deleteEvidence(ids) {
      if (ids.length === 0) return;
      ok(await db.from("product_evidence").delete().in("id", ids));
    },

    async listMaterialClaims(productId, evidenceIds) {
      if (evidenceIds.length === 0) return [];
      return rows<MaterialClaimRow>(
        await db
          .from("material_claims")
          .select(CLAIM_COLUMNS)
          .eq("product_id", productId)
          .in("evidence_id", evidenceIds)
          .order("created_at")
          .order("id")
          .limit(40),
      ).map(asClaim);
    },
    async insertMaterialClaims(values) {
      if (values.length === 0) return;
      ok(await db.from("material_claims").insert(values));
    },

    async findPriceObservation(productId, variantId, observedAt) {
      let query = db
        .from("price_observations")
        .select(PRICE_COLUMNS)
        .eq("product_id", productId)
        .eq("observed_at", observedAt);
      query = variantId === null ? query.is("variant_id", null) : query.eq("variant_id", variantId);
      const found = row<PriceObservationRow>(
        await query.order("created_at", { ascending: false }).limit(1).maybeSingle(),
      );
      return found && asPrice(found);
    },
    async insertPriceObservation(values) {
      ok(await db.from("price_observations").insert(values));
    },
    async deletePriceObservation(id) {
      ok(await db.from("price_observations").delete().eq("id", id));
    },

    async getAnalysis(id) {
      return row<AnalysisRow>(
        await db.from("analyses").select(ANALYSIS_COLUMNS).eq("id", id).maybeSingle(),
      );
    },
    async insertAnalysis(values) {
      ok(await db.from("analyses").insert(values));
    },
  };
}
