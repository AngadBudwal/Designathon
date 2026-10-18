import type { ProductFacts } from "./matching/matching";
import type {
  AnalysisRow,
  AnalysisStore,
  EvidenceRow,
  MaterialClaimRow,
  PriceObservationRow,
  ProductRow,
  VariantRow,
} from "./store";

const toIso = (timestamp: string) => new Date(timestamp).toISOString();

export type SelectedCapture = { facts: ProductFacts | null; variant: VariantRow | null };

/** The selected product with the evidence, claims, and price from the capture that created the analysis. */
export async function loadSelectedCapture(
  store: AnalysisStore,
  analysis: AnalysisRow,
): Promise<SelectedCapture> {
  const [product, variant] = await Promise.all([
    analysis.selected_product_id ? store.getProduct(analysis.selected_product_id) : null,
    analysis.selected_variant_id ? store.getVariant(analysis.selected_variant_id) : null,
  ]);
  if (!product) return { facts: null, variant };

  let evidence: EvidenceRow[] = [];
  let claims: MaterialClaimRow[] = [];
  let price: PriceObservationRow | null = null;
  if (analysis.captured_at && analysis.extractor_version) {
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
  return { facts: { product, evidence, claims, price }, variant };
}

/**
 * For each product: the evidence and claims of its most recent capture, and its most recent
 * listed price, both at or before `cutoff`. Products without stored rows keep empty lists.
 */
export async function loadCatalogFacts(
  store: AnalysisStore,
  products: ProductRow[],
  cutoff: string,
): Promise<ProductFacts[]> {
  const ids = products.map((product) => product.id);
  const [evidence, prices] = await Promise.all([
    store.listEvidenceForProducts(ids, cutoff),
    store.listPricesForProducts(ids, cutoff),
  ]);

  const latestCapture = new Map<string, number>();
  for (const item of evidence) {
    const time = new Date(item.captured_at).getTime();
    if ((latestCapture.get(item.product_id) ?? -Infinity) < time) latestCapture.set(item.product_id, time);
  }
  const captureEvidence = evidence.filter(
    (item) => new Date(item.captured_at).getTime() === latestCapture.get(item.product_id),
  );
  const claims = await store.listClaimsForEvidence(captureEvidence.map((item) => item.id));

  const latestPrice = new Map<string, PriceObservationRow>();
  for (const price of prices) {
    const current = latestPrice.get(price.product_id);
    if (!current || new Date(price.observed_at) > new Date(current.observed_at)) {
      latestPrice.set(price.product_id, price);
    }
  }

  return products.map((product) => ({
    product,
    evidence: captureEvidence.filter((item) => item.product_id === product.id),
    claims: claims.filter((claim) => claim.product_id === product.id),
    price: latestPrice.get(product.id) ?? null,
  }));
}
