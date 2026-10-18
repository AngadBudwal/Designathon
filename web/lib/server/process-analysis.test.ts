import { describe, expect, it, vi } from "vitest";

import { FullAnalysisResponseSchema, type FullAnalysisResponse } from "@/lib/contracts";

import {
  handleCreateAnalysis,
  handleGetAnalysis,
  handleProcessAnalysis,
  type AnalysesDeps,
} from "./analyses-handlers";
import { StoreError } from "./store";
import { seedCatalogProduct, type CatalogSeed } from "./testing/catalog";
import { createMemoryStore } from "./testing/memory-store";
import { DEV_ENV, postRequest, requestFixture } from "./testing/requests";

// Synthetic catalog for tests only. The selected product is the synthetic extension fixture
// (women's sweater, shell 70% merino wool / 30% polyester, lining 100% cotton, USD 89.00).
const NOW = new Date("2026-10-18T00:00:00.000Z");

const mensMerino: CatalogSeed = {
  url: "https://shop.example.com/products/mens-merino-sweater",
  title: "Merino Crew Sweater",
  brand: "Hearth & Hem",
  department: "mens",
  category: "sweater",
  composition: [{ component: "shell", rawText: "Shell: 100% merino wool", fibers: [["merino wool", 100]] }],
  price: { amountMinor: 7900, currency: "USD", observedAt: "2026-10-16T09:00:00.000Z" },
  capturedAt: "2026-10-16T09:00:00.000Z",
};

function setup(env: Record<string, string | undefined> = DEV_ENV) {
  const memory = createMemoryStore();
  let ids = 0;
  const deps: AnalysesDeps = {
    env,
    getStore: () => memory.store,
    newId: () => `20000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    now: () => NOW,
    log: vi.fn(),
  };
  return { memory, deps };
}

async function createAnalysis(deps: AnalysesDeps, body = requestFixture()): Promise<string> {
  const response = await handleCreateAnalysis(postRequest(body), deps);
  expect(response.status).toBe(201);
  return (await response.json()).analysisId;
}

async function process(deps: AnalysesDeps, id: string, headers: Record<string, string> = {}) {
  const response = await handleProcessAnalysis(
    postRequest("", headers, `http://localhost:3000/api/analyses/${id}/process`),
    id,
    deps,
  );
  return { response, body: await response.json() };
}

async function read(deps: AnalysesDeps, id: string) {
  const response = await handleGetAnalysis(id, deps);
  return { response, body: await response.json() };
}

const codes = (items: Array<{ code: string }>) => items.map((item) => item.code);

describe("POST /api/analyses/:id/process", () => {
  it("finds a stored cross-department alternative and returns it with its own evidence", async () => {
    const { memory, deps } = setup();
    const stored = await seedCatalogProduct(memory.store, mensMerino);
    const id = await createAnalysis(deps);

    const { response, body } = await process(deps, id);
    expect(response.status).toBe(200);
    const analysis: FullAnalysisResponse = FullAnalysisResponseSchema.parse(body);
    expect(analysis.processingStatus).toBe("completed");
    expect(analysis.outcome).toBe("alternatives_found");
    expect(analysis.product?.department).toBe("womens");
    expect(analysis.alternatives).toHaveLength(1);

    const [alternative] = analysis.alternatives;
    expect(alternative!.product).toMatchObject({ id: stored.id, department: "mens", title: "Merino Crew Sweater" });
    expect(alternative!.priceDifference).toEqual({ amountMinor: -1000, currency: "USD", comparedField: "listed_price" });
    // Stored reasons are returned ordered by code within each kind.
    expect(codes(alternative!.advantages)).toEqual(["lower_listed_price", "more_listed_natural_fiber"]);
    expect(alternative!.advantages[1]!.detail).toContain("100% natural fiber and the selected lists 70% (+30 percentage points)");
    expect(alternative!.advantages[0]!.detail).toContain("USD 10.00 lower");
    expect(codes(alternative!.explanations)).toEqual(["different_department", "same_category", "shared_fiber"]);
    expect(alternative!.explanations[2]!.detail).toBe(
      "shell: merino wool 100% in the alternative vs 70% in the selected (+30 percentage points).",
    );
    expect(codes(alternative!.uncertainties)).toEqual([
      "different_component_coverage",
      "fit_unknown",
      "unverified_composition",
    ]);
    expect(alternative!.fit).toEqual({ availability: "unavailable", measurements: [] });
    expect(alternative!.composition.map((fact) => [fact.component, fact.fiber, fact.percent])).toEqual([
      ["shell", "merino wool", 100],
    ]);

    const alternativeEvidence = analysis.evidence.filter((item) => item.productId === stored.id);
    expect(alternativeEvidence.map((item) => item.excerpt)).toEqual(["Shell: 100% merino wool"]);
    expect(alternative!.composition[0]!.evidenceIds).toEqual([alternativeEvidence[0]!.id]);
    expect(codes(analysis.warnings)).toContain("not_a_quality_or_durability_score");

    const fetched = await read(deps, id);
    expect(fetched.response.status).toBe(200);
    expect(fetched.body).toEqual(body);
  });

  it("does not duplicate comparables when processing is repeated", async () => {
    const { memory, deps } = setup();
    await seedCatalogProduct(memory.store, mensMerino);
    const id = await createAnalysis(deps);

    const first = await process(deps, id);
    const reasonsAfterFirst = memory.tables.reasons.length;
    const second = await process(deps, id);
    expect(second.response.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(memory.tables.comparables).toHaveLength(1);
    expect(memory.tables.reasons).toHaveLength(reasonsAfterFirst);
    expect(memory.calls.filter((call) => call === "completeAnalysis")).toHaveLength(1);
  });

  it("reports no suitable alternative in the current catalog when nothing is stored", async () => {
    const { deps } = setup();
    const id = await createAnalysis(deps);
    const analysis = FullAnalysisResponseSchema.parse((await process(deps, id)).body);
    expect(analysis.outcome).toBe("no_suitable_alternative");
    expect(analysis.alternatives).toEqual([]);
    const warning = analysis.warnings.find((item) => item.code === "no_suitable_alternative");
    expect(warning?.message).toContain("current catalog");
    expect(warning?.message).toContain("not every retailer");
  });

  it("ignores incompatible categories and same-department products", async () => {
    const { memory, deps } = setup();
    await seedCatalogProduct(memory.store, { ...mensMerino, title: "Slim Jeans", category: "jeans", url: "https://shop.example.com/jeans" });
    await seedCatalogProduct(memory.store, { ...mensMerino, department: "womens", url: "https://shop.example.com/womens" });
    const id = await createAnalysis(deps);
    const analysis = FullAnalysisResponseSchema.parse((await process(deps, id)).body);
    expect(analysis.outcome).toBe("no_suitable_alternative");
    expect(memory.tables.comparables).toEqual([]);
  });

  it("returns insufficient information for an unknown department without searching", async () => {
    const { memory, deps } = setup();
    await seedCatalogProduct(memory.store, mensMerino);
    const id = await createAnalysis(deps, requestFixture({ department: "unknown" }));
    const analysis = FullAnalysisResponseSchema.parse((await process(deps, id)).body);
    expect(analysis.outcome).toBe("insufficient_information");
    expect(analysis.warnings.find((item) => item.code === "insufficient_information")?.message).toContain(
      "did not state a department",
    );
    expect(memory.calls).not.toContain("listCandidateProducts");
  });

  it("returns insufficient information when no composition was captured", async () => {
    const { memory, deps } = setup();
    await seedCatalogProduct(memory.store, mensMerino);
    const id = await createAnalysis(deps, requestFixture({ composition: [] }));
    const analysis = FullAnalysisResponseSchema.parse((await process(deps, id)).body);
    expect(analysis.outcome).toBe("insufficient_information");
  });

  it("does not compute a price difference across currencies", async () => {
    const { memory, deps } = setup();
    await seedCatalogProduct(memory.store, {
      ...mensMerino,
      price: { amountMinor: 7900, currency: "EUR", observedAt: "2026-10-16T09:00:00.000Z" },
    });
    const id = await createAnalysis(deps);
    const [alternative] = FullAnalysisResponseSchema.parse((await process(deps, id)).body).alternatives;
    expect(alternative!.priceDifference).toBeNull();
    expect(codes(alternative!.advantages)).not.toContain("lower_listed_price");
    expect(codes(alternative!.uncertainties)).toContain("price_not_comparable");
  });

  it("flags stale prices instead of claiming a price advantage", async () => {
    const { memory, deps } = setup();
    await seedCatalogProduct(memory.store, {
      ...mensMerino,
      price: { amountMinor: 7900, currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" },
    });
    const id = await createAnalysis(deps);
    const [alternative] = FullAnalysisResponseSchema.parse((await process(deps, id)).body).alternatives;
    // Contract 3.0.0 requires the arithmetic difference whenever both prices share a currency.
    expect(alternative!.priceDifference?.amountMinor).toBe(-1000);
    expect(codes(alternative!.advantages)).toEqual(["more_listed_natural_fiber"]);
    const uncertainty = alternative!.uncertainties.find((item) => item.code === "price_not_comparable");
    expect(uncertainty?.detail).toContain("2026-08-01");
  });

  it("keeps partial compositions partial", async () => {
    const { memory, deps } = setup();
    await seedCatalogProduct(memory.store, {
      ...mensMerino,
      composition: [{ component: "shell", rawText: "Shell: merino wool, polyester", fibers: [["merino wool", null], ["polyester", null]] }],
    });
    const id = await createAnalysis(deps);
    const [alternative] = FullAnalysisResponseSchema.parse((await process(deps, id)).body).alternatives;
    expect(alternative!.composition.every((fact) => fact.percent === null)).toBe(true);
    expect(codes(alternative!.uncertainties)).toContain("missing_fiber_percent");
    expect(codes(alternative!.advantages)).toEqual(["lower_listed_price"]);
  });

  it("does not compare different components", async () => {
    const { memory, deps } = setup();
    await seedCatalogProduct(memory.store, {
      ...mensMerino,
      composition: [{ component: "trim", rawText: "Trim: 100% wool", fibers: [["wool", 100]] }],
    });
    const id = await createAnalysis(deps);
    const analysis = FullAnalysisResponseSchema.parse((await process(deps, id)).body);
    expect(analysis.outcome).toBe("no_suitable_alternative");
  });

  it("leaves the analysis pending when a write fails, and a retry succeeds without duplicates", async () => {
    const { memory, deps } = setup();
    await seedCatalogProduct(memory.store, mensMerino);
    const id = await createAnalysis(deps);

    memory.failOnce("insertComparableReasons");
    const failed = await process(deps, id);
    expect(failed.response.status).toBe(500);
    expect(failed.body.error.code).toBe("internal_error");
    expect(JSON.stringify(failed.body)).not.toContain("injected");
    expect(memory.tables.analyses[0]!.processing_status).toBe("pending");

    memory.failOnce("completeAnalysis", new StoreError("unavailable", null, "fetch failed"));
    expect((await process(deps, id)).response.status).toBe(503);
    expect(memory.tables.analyses[0]!.processing_status).toBe("pending");
    expect(FullAnalysisResponseSchema.parse((await read(deps, id)).body).alternatives).toEqual([]);

    const retried = await process(deps, id);
    expect(retried.response.status).toBe(200);
    expect(memory.tables.comparables).toHaveLength(1);
    expect(FullAnalysisResponseSchema.parse(retried.body).outcome).toBe("alternatives_found");
  });

  it("is disabled in production and when the write flag is off", async () => {
    const { deps: production } = setup({ ...DEV_ENV, NODE_ENV: "production" });
    const id = "20000000-0000-4000-8000-000000000001";
    expect((await process(production, id)).response.status).toBe(403);
    const { deps: disabled } = setup({ ...DEV_ENV, ENABLE_DEV_ANALYSIS_WRITE: "false" });
    expect((await process(disabled, id)).response.status).toBe(403);
  });

  it("rejects foreign origins, invalid ids, and unknown analyses", async () => {
    const { deps } = setup();
    const id = await createAnalysis(deps);
    expect((await process(deps, id, { origin: "https://evil.example" })).response.status).toBe(403);
    const invalid = await process(deps, "not-a-uuid");
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error.code).toBe("validation_error");
    const missing = await process(deps, "20000000-0000-4000-8000-0000000000ff");
    expect(missing.response.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
  });
});

describe("GET /api/analyses/:id after processing", () => {
  it("does not write", async () => {
    const { memory, deps } = setup();
    await seedCatalogProduct(memory.store, mensMerino);
    const id = await createAnalysis(deps);
    await process(deps, id);
    memory.calls.length = 0;
    await read(deps, id);
    expect(memory.calls.filter((call) => /^(insert|update|delete|complete)/.test(call))).toEqual([]);
  });
});
