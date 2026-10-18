import type { Department, GarmentComponent } from "@/lib/contracts";

import type { AnalysisStore, ProductRow } from "../store";

export type CatalogSeed = {
  domain?: string;
  url: string;
  title: string;
  department: Department;
  category: string | null;
  brand?: string | null;
  composition: Array<{ component: GarmentComponent; rawText: string; fibers: Array<[string, number | null]> }>;
  price: { amountMinor: number; currency: string; observedAt: string } | null;
  capturedAt: string;
};

let counter = 0;
const nextId = () => `30000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

/** Stores a synthetic catalog product as manual-review evidence, for tests only. */
export async function seedCatalogProduct(store: AnalysisStore, seed: CatalogSeed): Promise<ProductRow> {
  const domain = seed.domain ?? "shop.example.com";
  const retailer =
    (await store.findRetailerByDomain(domain)) ?? (await store.insertRetailer({ name: domain, domain }));
  const product = await store.insertProduct({
    retailer_id: retailer.id,
    canonical_url: seed.url,
    retailer_product_id: null,
    title: seed.title,
    brand: seed.brand ?? null,
    department: seed.department,
    category: seed.category,
    image_url: null,
  });
  const evidence = seed.composition.map((block) => ({
    id: nextId(),
    product_id: product.id,
    source_type: "manual_review" as const,
    source_url: seed.url,
    excerpt: block.rawText,
    captured_at: seed.capturedAt,
    extractor_version: null,
  }));
  await store.insertEvidence(evidence);
  await store.insertMaterialClaims(
    seed.composition.flatMap((block, index) =>
      block.fibers.map(([fiber, percent]) => ({
        id: nextId(),
        product_id: product.id,
        evidence_id: evidence[index]!.id,
        component: block.component,
        fiber,
        percent,
        raw_text: block.rawText,
        verification_status: "extracted" as const,
      })),
    ),
  );
  if (seed.price) {
    await store.insertPriceObservation({
      id: nextId(),
      product_id: product.id,
      variant_id: null,
      evidence_id: null,
      listed_amount_minor: seed.price.amountMinor,
      regular_amount_minor: null,
      currency: seed.price.currency,
      observed_at: seed.price.observedAt,
    });
  }
  return product;
}
