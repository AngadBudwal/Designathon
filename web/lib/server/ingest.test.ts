import { beforeEach, describe, expect, it } from "vitest";

import { checkIngestionRules, ingestAnalysis, UnsupportedPageError } from "./ingest";
import { StoreError } from "./store";
import { createMemoryStore } from "./testing/memory-store";
import { requestFixture } from "./testing/requests";

let ids = 0;
const deps = { newId: () => `10000000-0000-4000-8000-${String(++ids).padStart(12, "0")}` };

beforeEach(() => {
  ids = 0;
});

describe("ingestAnalysis", () => {
  it("stores the product, variant, evidence, extracted claims, price, and a pending analysis", async () => {
    const { store, tables } = createMemoryStore();
    const result = await ingestAnalysis(store, requestFixture(), deps);

    expect(tables.retailers).toEqual([
      expect.objectContaining({ domain: "shop.example.com", name: "shop.example.com" }),
    ]);
    expect(tables.products).toEqual([
      expect.objectContaining({
        id: result.productId,
        canonical_url: "https://shop.example.com/products/hearth-hem-crew-sweater",
        retailer_product_id: "HH-1042",
        title: "Hearth & Hem Crew Sweater",
        brand: "Hearth & Hem",
        department: "womens",
        category: "sweater",
        image_url: "https://images.example.com/products/hearth-hem-crew-sweater-oat.jpg",
      }),
    ]);
    expect(tables.variants).toEqual([
      expect.objectContaining({ id: result.variantId, description: "Oat", color: null }),
    ]);
    expect(tables.evidence.map((item) => item.excerpt)).toEqual([
      "Shell: 70% merino wool, 30% polyester",
      "Lining: 100% cotton",
    ]);
    expect(tables.claims.map((claim) => [claim.component, claim.fiber, claim.percent])).toEqual([
      ["shell", "merino wool", 70],
      ["shell", "polyester", 30],
      ["lining", "cotton", 100],
    ]);
    expect(tables.claims.every((claim) => claim.verification_status === "extracted")).toBe(true);
    expect(tables.prices).toEqual([
      expect.objectContaining({
        product_id: result.productId,
        variant_id: result.variantId,
        listed_amount_minor: 8900,
        regular_amount_minor: null,
        currency: "USD",
        observed_at: "2026-10-17T22:15:00.000Z",
      }),
    ]);
    expect(tables.analyses).toEqual([
      expect.objectContaining({
        id: result.analysisId,
        selected_product_id: result.productId,
        processing_status: "pending",
        outcome: null,
      }),
    ]);
  });

  it("keeps every claim on evidence from its own product and component block", async () => {
    const { store, tables } = createMemoryStore();
    await ingestAnalysis(store, requestFixture(), deps);
    const second = requestFixture({
      pageUrl: "https://shop.example.com/products/other-crew",
      retailerProductId: "HH-2000",
    });
    await ingestAnalysis(store, second, deps);

    for (const claim of tables.claims) {
      const evidence = tables.evidence.find((item) => item.id === claim.evidence_id);
      expect(evidence?.product_id).toBe(claim.product_id);
      expect(claim.raw_text.startsWith(evidence!.excerpt.split(":")[0])).toBe(true);
    }
    expect(new Set(tables.products.map((item) => item.id)).size).toBe(2);
  });

  it("stores an analysis with no price and no composition", async () => {
    const { store, tables } = createMemoryStore();
    const request = requestFixture({ listedPrice: null, regularPrice: null, composition: null });
    const result = await ingestAnalysis(store, request, deps);

    expect(result).toMatchObject({ storedEvidence: false, storedPrice: false });
    expect(tables.evidence).toHaveLength(0);
    expect(tables.claims).toHaveLength(0);
    expect(tables.prices).toHaveLength(0);
    expect(tables.analyses).toHaveLength(1);
  });

  it("keeps fibers without a percentage as null rather than inventing one", async () => {
    const { store, tables } = createMemoryStore();
    const request = requestFixture({
      composition: [
        {
          component: "shell",
          rawText: "Shell: wool, cashmere",
          fibers: [
            { name: "wool", percent: null },
            { name: "cashmere", percent: null },
          ],
          excerpts: [{ text: "Shell: wool, cashmere" }],
        },
      ],
    });
    await ingestAnalysis(store, request, deps);
    expect(tables.claims.map((claim) => claim.percent)).toEqual([null, null]);
  });

  it("stores trim and other components separately", async () => {
    const { store, tables } = createMemoryStore();
    const request = requestFixture({
      composition: [
        ...requestFixture().composition!,
        {
          component: "trim",
          rawText: "Rib trim: 95% cotton, 5% elastane",
          fibers: [
            { name: "cotton", percent: 95 },
            { name: "elastane", percent: 5 },
          ],
          excerpts: [{ text: "Rib trim: 95% cotton, 5% elastane" }, { text: "Trim: cotton blend" }],
        },
      ],
    });
    await ingestAnalysis(store, request, deps);
    expect(tables.evidence).toHaveLength(4);
    expect(tables.claims.filter((claim) => claim.component === "trim")).toHaveLength(2);
    const lining = tables.claims.find((claim) => claim.component === "lining");
    const trimCotton = tables.claims.find((c) => c.component === "trim" && c.fiber === "cotton");
    expect(lining?.evidence_id).not.toBe(trimCotton?.evidence_id);
  });

  it("reuses the product for duplicate submissions and does not duplicate the same capture", async () => {
    const { store, tables } = createMemoryStore();
    const first = await ingestAnalysis(store, requestFixture(), deps);
    const second = await ingestAnalysis(store, requestFixture(), deps);

    expect(second.productId).toBe(first.productId);
    expect(second.variantId).toBe(first.variantId);
    expect(second).toMatchObject({ storedEvidence: false, storedPrice: false });
    expect(second.analysisId).not.toBe(first.analysisId);
    expect(tables.products).toHaveLength(1);
    expect(tables.evidence).toHaveLength(2);
    expect(tables.prices).toHaveLength(1);
    expect(tables.analyses).toHaveLength(2);
  });

  it("matches a product by canonical URL when the retailer id is missing", async () => {
    const { store, tables } = createMemoryStore();
    const first = await ingestAnalysis(store, requestFixture({ retailerProductId: null }), deps);
    const second = await ingestAnalysis(
      store,
      requestFixture({
        pageUrl: "https://shop.example.com/products/hearth-hem-crew-sweater/?utm_source=mail#top",
        capturedAt: "2026-10-18T09:00:00.000Z",
      }),
      deps,
    );
    expect(second.productId).toBe(first.productId);
    expect(tables.products[0].retailer_product_id).toBe("HH-1042");
  });

  it("appends a new price observation for each new capture without overwriting history", async () => {
    const { store, tables } = createMemoryStore();
    await ingestAnalysis(store, requestFixture(), deps);
    await ingestAnalysis(
      store,
      requestFixture({
        capturedAt: "2026-10-24T22:15:00.000Z",
        listedPrice: { amountMinor: 6900, currency: "USD" },
        regularPrice: { amountMinor: 8900, currency: "USD" },
      }),
      deps,
    );
    expect(
      tables.prices.map((price) => [price.observed_at, price.listed_amount_minor, price.regular_amount_minor]),
    ).toEqual([
      ["2026-10-17T22:15:00.000Z", 8900, null],
      ["2026-10-24T22:15:00.000Z", 6900, 8900],
    ]);
  });

  it("does not overwrite stored product fields with a later capture", async () => {
    const { store, tables } = createMemoryStore();
    await ingestAnalysis(store, requestFixture({ brand: null, department: "unknown" }), deps);
    await ingestAnalysis(
      store,
      requestFixture({ title: "Renamed", brand: "Hearth & Hem", capturedAt: "2026-10-18T00:00:00Z" }),
      deps,
    );
    expect(tables.products[0]).toMatchObject({
      title: "Hearth & Hem Crew Sweater",
      brand: "Hearth & Hem",
      department: "womens",
    });
  });

  it("rejects unsupported page URLs before writing", async () => {
    const { store, calls } = createMemoryStore();
    await expect(
      ingestAnalysis(store, requestFixture({ pageUrl: "http://localhost:3000/x" }), deps),
    ).rejects.toBeInstanceOf(UnsupportedPageError);
    expect(calls).toHaveLength(0);
  });

  it("removes rows it created when a later write fails", async () => {
    const memory = createMemoryStore();
    memory.failOnce("insertAnalysis");
    await expect(ingestAnalysis(memory.store, requestFixture(), deps)).rejects.toBeInstanceOf(StoreError);

    const { tables } = memory;
    expect(tables.retailers).toHaveLength(0);
    expect(tables.products).toHaveLength(0);
    expect(tables.variants).toHaveLength(0);
    expect(tables.evidence).toHaveLength(0);
    expect(tables.claims).toHaveLength(0);
    expect(tables.prices).toHaveLength(0);
    expect(tables.analyses).toHaveLength(0);
  });

  it("keeps pre-existing rows when a later submission fails", async () => {
    const memory = createMemoryStore();
    await ingestAnalysis(memory.store, requestFixture(), deps);
    memory.failOnce("insertMaterialClaims");
    await expect(
      ingestAnalysis(memory.store, requestFixture({ capturedAt: "2026-10-20T00:00:00Z" }), deps),
    ).rejects.toBeInstanceOf(StoreError);

    expect(memory.tables.products).toHaveLength(1);
    expect(memory.tables.evidence).toHaveLength(2);
    expect(memory.tables.claims).toHaveLength(3);
    expect(memory.tables.prices).toHaveLength(1);
    expect(memory.tables.analyses).toHaveLength(1);
  });
});

describe("checkIngestionRules", () => {
  it("accepts the fixture", () => {
    expect(checkIngestionRules(requestFixture())).toEqual([]);
  });

  it("rejects a fiber repeated within one block", () => {
    const request = requestFixture();
    request.composition![0].fibers.push({ name: "Merino Wool", percent: 10 });
    expect(checkIngestionRules(request)).toEqual([
      expect.objectContaining({ path: "composition.0.fibers.2.name", code: "duplicate_fiber" }),
    ]);
  });

  it("rejects more fibers than the response contract can return", () => {
    const fibers = Array.from({ length: 20 }, (_, i) => ({ name: `fiber ${i}`, percent: null }));
    const block = { component: "other" as const, rawText: "Many fibers", fibers, excerpts: [{ text: "x" }] };
    const request = requestFixture({ composition: [block, block, block] });
    expect(checkIngestionRules(request).map((issue) => issue.code)).toContain("too_many_fibers");
  });

  it("rejects listed and regular prices in different currencies", () => {
    const request = requestFixture({ regularPrice: { amountMinor: 9900, currency: "EUR" } });
    expect(checkIngestionRules(request).map((issue) => issue.code)).toEqual(["currency_mismatch"]);
  });
});
