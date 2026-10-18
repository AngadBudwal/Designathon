import type { AnalysisRequest, FieldError } from "@/lib/contracts";

import { parseRetailerPage, type RetailerPage } from "./product-url";
import {
  isUniqueViolation,
  type AnalysisStore,
  type EvidenceRow,
  type MaterialClaimRow,
  type ProductPatch,
  type ProductRow,
  type RetailerRow,
  type VariantRow,
} from "./store";

/** FullAnalysisResponseSchema allows at most 40 composition facts. */
export const MAX_FIBERS_PER_REQUEST = 40;

export class UnsupportedPageError extends Error {
  constructor() {
    super("The submitted URL is not a supported retailer page.");
    this.name = "UnsupportedPageError";
  }
}

/** Rules the database or response contract needs beyond AnalysisRequestSchema. */
export function checkIngestionRules(request: AnalysisRequest): FieldError[] {
  const issues: FieldError[] = [];
  const blocks = request.composition ?? [];

  blocks.forEach((block, blockIndex) => {
    const seen = new Set<string>();
    block.fibers.forEach((fiber, fiberIndex) => {
      const key = fiber.name.toLowerCase();
      if (seen.has(key)) {
        issues.push({
          path: `composition.${blockIndex}.fibers.${fiberIndex}.name`,
          code: "duplicate_fiber",
          message: "Each fiber may appear once per composition block.",
        });
      }
      seen.add(key);
    });
  });

  const fiberCount = blocks.reduce((total, block) => total + block.fibers.length, 0);
  if (fiberCount > MAX_FIBERS_PER_REQUEST) {
    issues.push({
      path: "composition",
      code: "too_many_fibers",
      message: `At most ${MAX_FIBERS_PER_REQUEST} fibers may be submitted in total.`,
    });
  }

  const { listedPrice, regularPrice } = request;
  if (listedPrice && regularPrice && listedPrice.currency !== regularPrice.currency) {
    issues.push({
      path: "regularPrice.currency",
      code: "currency_mismatch",
      message: "Regular price must use the same currency as the listed price.",
    });
  }

  return issues;
}

export type IngestDeps = { newId: () => string };

export type IngestResult = {
  analysisId: string;
  productId: string;
  variantId: string | null;
  /** False when this exact capture was already stored and was reused. */
  storedEvidence: boolean;
  storedPrice: boolean;
};

type Undo = Array<() => Promise<void>>;

async function findOrCreateRetailer(store: AnalysisStore, page: RetailerPage, undo: Undo) {
  const existing = await store.findRetailerByDomain(page.domain);
  if (existing) return existing;
  try {
    const created = await store.insertRetailer({ name: page.domain.slice(0, 120), domain: page.domain });
    undo.push(() => store.deleteRetailer(created.id));
    return created;
  } catch (error) {
    const raced = isUniqueViolation(error) ? await store.findRetailerByDomain(page.domain) : null;
    if (raced) return raced;
    throw error;
  }
}

async function findProduct(
  store: AnalysisStore,
  retailerId: string,
  canonicalUrl: string,
  retailerProductId: string | null,
) {
  if (retailerProductId) {
    const byId = await store.findProductByRetailerProductId(retailerId, retailerProductId);
    if (byId) return byId;
  }
  return store.findProductByCanonicalUrl(retailerId, canonicalUrl);
}

/** Fills fields the stored product is missing. Existing values are never overwritten. */
function missingFields(product: ProductRow, request: AnalysisRequest): ProductPatch {
  const patch: ProductPatch = {};
  if (product.title === null && request.title) patch.title = request.title;
  if (product.brand === null && request.brand) patch.brand = request.brand;
  if (product.category === null && request.category) patch.category = request.category;
  if (product.image_url === null && request.imageUrl) patch.image_url = request.imageUrl;
  if (product.retailer_product_id === null && request.retailerProductId) {
    patch.retailer_product_id = request.retailerProductId;
  }
  if (product.department === "unknown" && request.department !== "unknown") {
    patch.department = request.department;
  }
  return patch;
}

async function findOrCreateProduct(
  store: AnalysisStore,
  retailer: RetailerRow,
  page: RetailerPage,
  request: AnalysisRequest,
  undo: Undo,
): Promise<ProductRow> {
  const retailerProductId = request.retailerProductId ?? null;
  let product = await findProduct(store, retailer.id, page.canonicalUrl, retailerProductId);

  if (!product) {
    try {
      product = await store.insertProduct({
        retailer_id: retailer.id,
        canonical_url: page.canonicalUrl,
        retailer_product_id: retailerProductId,
        title: request.title ?? null,
        brand: request.brand ?? null,
        department: request.department,
        category: request.category ?? null,
        image_url: request.imageUrl ?? null,
      });
      const createdId = product.id;
      undo.push(() => store.deleteProduct(createdId));
      return product;
    } catch (error) {
      product = isUniqueViolation(error)
        ? await findProduct(store, retailer.id, page.canonicalUrl, retailerProductId)
        : null;
      if (!product) throw error;
    }
  }

  const patch = missingFields(product, request);
  return Object.keys(patch).length > 0 ? store.updateProduct(product.id, patch) : product;
}

async function findOrCreateVariant(
  store: AnalysisStore,
  productId: string,
  label: string,
  undo: Undo,
): Promise<VariantRow> {
  const existing = await store.findVariantByDescription(productId, label);
  if (existing) return existing;
  try {
    const created = await store.insertVariant({ product_id: productId, description: label });
    undo.push(() => store.deleteVariant(created.id));
    return created;
  } catch (error) {
    const raced = isUniqueViolation(error)
      ? await store.findVariantByDescription(productId, label)
      : null;
    if (raced) return raced;
    throw error;
  }
}

function buildCapture(
  request: AnalysisRequest,
  product: ProductRow,
  page: RetailerPage,
  capturedAt: string,
  newId: () => string,
) {
  const evidence: EvidenceRow[] = [];
  const claims: MaterialClaimRow[] = [];

  for (const block of request.composition ?? []) {
    const evidenceIds = block.excerpts.map((excerpt) => {
      const id = newId();
      evidence.push({
        id,
        product_id: product.id,
        source_type: "extension_capture",
        source_url: page.canonicalUrl,
        excerpt: excerpt.text,
        captured_at: capturedAt,
        extractor_version: request.extractorVersion,
      });
      return id;
    });

    for (const fiber of block.fibers) {
      claims.push({
        id: newId(),
        product_id: product.id,
        evidence_id: evidenceIds[0],
        component: block.component,
        fiber: fiber.name,
        percent: fiber.percent,
        raw_text: block.rawText,
        verification_status: "extracted",
      });
    }
  }

  return { evidence, claims };
}

/**
 * Stores one extension capture and creates a pending analysis for it.
 *
 * Writes run in dependency order. If a later write fails, rows created by this call are
 * deleted in reverse order before the error is rethrown. Resubmitting the same capture
 * (same product, capturedAt, and extractorVersion) reuses the stored evidence and price.
 */
export async function ingestAnalysis(
  store: AnalysisStore,
  request: AnalysisRequest,
  deps: IngestDeps,
): Promise<IngestResult> {
  const page = parseRetailerPage(request.pageUrl);
  if (!page) throw new UnsupportedPageError();

  const undo: Undo = [];
  try {
    const retailer = await findOrCreateRetailer(store, page, undo);
    const product = await findOrCreateProduct(store, retailer, page, request, undo);
    const variant = request.variantLabel
      ? await findOrCreateVariant(store, product.id, request.variantLabel, undo)
      : null;
    const variantId = variant?.id ?? null;
    const capturedAt = new Date(request.capturedAt).toISOString();

    const capture = buildCapture(request, product, page, capturedAt, deps.newId);
    let storedEvidence = false;
    if (capture.evidence.length > 0) {
      const existing = await store.listCaptureEvidence({
        productId: product.id,
        capturedAt,
        extractorVersion: request.extractorVersion,
      });
      if (existing.length === 0) {
        const evidenceIds = capture.evidence.map((item) => item.id);
        await store.insertEvidence(capture.evidence);
        undo.push(() => store.deleteEvidence(evidenceIds));
        await store.insertMaterialClaims(capture.claims);
        storedEvidence = true;
      }
    }

    let storedPrice = false;
    if (request.listedPrice) {
      const existing = await store.findPriceObservation(product.id, variantId, capturedAt);
      if (!existing) {
        const priceId = deps.newId();
        await store.insertPriceObservation({
          id: priceId,
          product_id: product.id,
          variant_id: variantId,
          evidence_id: null,
          listed_amount_minor: request.listedPrice.amountMinor,
          regular_amount_minor: request.regularPrice?.amountMinor ?? null,
          currency: request.listedPrice.currency,
          observed_at: capturedAt,
        });
        undo.push(() => store.deletePriceObservation(priceId));
        storedPrice = true;
      }
    }

    const analysisId = deps.newId();
    await store.insertAnalysis({
      id: analysisId,
      submitted_page_url: request.pageUrl,
      request_payload: request,
      selected_product_id: product.id,
      selected_variant_id: variantId,
    });

    return { analysisId, productId: product.id, variantId, storedEvidence, storedPrice };
  } catch (error) {
    for (const step of undo.reverse()) {
      await step().catch(() => undefined);
    }
    throw error;
  }
}
