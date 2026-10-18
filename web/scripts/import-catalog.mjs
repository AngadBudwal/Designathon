// Imports a small, manually reviewed catalog file (see supabase/seed/) into the database.
// Local development only. Usage, from web/:
//   node --env-file=.env.local scripts/import-catalog.mjs ../supabase/seed/<file>.json
// Re-running is safe: products are matched by retailer product id, and a capture that is
// already stored (same product, source, and captured_at) is skipped.
import { readFile } from "node:fs/promises";

import { createClient } from "@supabase/supabase-js";

if (process.env.NODE_ENV === "production" || process.env.ENABLE_DEV_ANALYSIS_WRITE !== "true") {
  console.error("Refusing to import: set ENABLE_DEV_ANALYSIS_WRITE=true outside production.");
  process.exit(1);
}
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Refusing to import: SUPABASE_URL and SUPABASE_SECRET_KEY must be set.");
  process.exit(1);
}
const file = process.argv[2];
if (!file) {
  console.error("Usage: node --env-file=.env.local scripts/import-catalog.mjs <catalog.json>");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { provenance, products } = JSON.parse(await readFile(file, "utf8"));
const capturedAt = new Date(provenance.capturedAt).toISOString();

async function must(query) {
  const { data, error } = await query;
  if (error) throw new Error(`${error.code ?? "error"}: ${error.message}`);
  return data;
}

async function findOrCreateRetailer(domain) {
  const found = await must(db.from("retailers").select("id").eq("domain", domain).maybeSingle());
  if (found) return found.id;
  const created = await must(
    db.from("retailers").insert({ name: provenance.retailer, domain }).select("id").single(),
  );
  return created.id;
}

for (const item of products) {
  const url = new URL(item.url);
  const retailerId = await findOrCreateRetailer(url.hostname.replace(/^www\./, ""));

  let product = await must(
    db.from("products").select("id").eq("retailer_id", retailerId)
      .eq("retailer_product_id", item.retailerProductId).maybeSingle(),
  );
  if (!product) {
    product = await must(
      db.from("products").insert({
        retailer_id: retailerId,
        canonical_url: item.url,
        retailer_product_id: item.retailerProductId,
        title: item.title,
        brand: item.brand,
        department: item.department,
        category: item.category,
        image_url: item.imageUrl,
      }).select("id").single(),
    );
  }

  const existing = await must(
    db.from("product_evidence").select("id").eq("product_id", product.id)
      .eq("source_type", "manual_review").eq("captured_at", capturedAt).limit(1),
  );
  if (existing.length > 0) {
    console.log(`skip  ${item.retailerProductId} (capture already stored) product=${product.id}`);
    continue;
  }

  const excerpts = [item.composition.excerpt, ...item.otherExcerpts];
  const evidence = await must(
    db.from("product_evidence").insert(
      excerpts.map((excerpt) => ({
        product_id: product.id,
        source_type: "manual_review",
        source_url: item.url,
        excerpt,
        captured_at: capturedAt,
      })),
    ).select("id, excerpt"),
  );
  const evidenceId = (excerpt) => evidence.find((row) => row.excerpt === excerpt).id;

  try {
    await must(
      db.from("material_claims").insert(
        item.composition.fibers.map(([fiber, percent]) => ({
          product_id: product.id,
          evidence_id: evidenceId(item.composition.excerpt),
          component: item.composition.component,
          fiber,
          percent,
          raw_text: item.composition.excerpt,
          verification_status: "extracted",
        })),
      ),
    );
    const priceExcerpt = item.otherExcerpts.find((excerpt) => excerpt.startsWith("Price:"));
    await must(
      db.from("price_observations").insert({
        product_id: product.id,
        evidence_id: priceExcerpt ? evidenceId(priceExcerpt) : null,
        listed_amount_minor: item.listedPrice.amountMinor,
        regular_amount_minor: null,
        currency: item.listedPrice.currency,
        observed_at: capturedAt,
      }),
    );
  } catch (error) {
    // Claims cascade with their evidence; remove the partial capture so a re-run can retry it.
    await db.from("price_observations").delete().in("evidence_id", evidence.map((row) => row.id));
    await db.from("product_evidence").delete().in("id", evidence.map((row) => row.id));
    throw error;
  }
  console.log(`added ${item.retailerProductId} ${item.department} "${item.title}" product=${product.id}`);
}
