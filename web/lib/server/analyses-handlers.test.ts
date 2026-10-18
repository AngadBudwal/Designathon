import { describe, expect, it, vi } from "vitest";

import {
  AnalysisCreatedResponseSchema,
  ErrorResponseSchema,
  FullAnalysisResponseSchema,
} from "@/lib/contracts";

import { handleCreateAnalysis, handleGetAnalysis, type AnalysesDeps } from "./analyses-handlers";
import { ServerConfigError } from "./env";
import { StoreError } from "./store";
import { createMemoryStore } from "./testing/memory-store";
import { DEV_ENV, postRequest, requestFixture } from "./testing/requests";

const SECRET = DEV_ENV.SUPABASE_SECRET_KEY;

function setup(env: Record<string, string | undefined> = DEV_ENV) {
  const memory = createMemoryStore();
  let ids = 0;
  const log = vi.fn();
  const deps: AnalysesDeps = {
    env,
    getStore: () => memory.store,
    newId: () => `20000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    log,
  };
  return { memory, deps, log };
}

async function create(deps: AnalysesDeps, body: unknown = requestFixture()) {
  const response = await handleCreateAnalysis(postRequest(body), deps);
  return { response, body: await response.json() };
}

async function read(deps: AnalysesDeps, id: string) {
  const response = await handleGetAnalysis(id, deps);
  return { response, body: await response.json() };
}

describe("POST /api/analyses", () => {
  it("creates a pending analysis and returns the created contract", async () => {
    const { deps } = setup();
    const { response, body } = await create(deps);

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const created = AnalysisCreatedResponseSchema.parse(body);
    expect(created).toEqual({
      analysisId: created.analysisId,
      pageUrl: `http://localhost:3000/analyses/${created.analysisId}`,
      processingStatus: "pending",
      outcome: null,
    });
  });

  it("returns field errors for an invalid request", async () => {
    const { deps, memory } = setup();
    const invalid = { ...requestFixture(), pageUrl: "javascript:alert(1)", verified: true };
    const { response, body } = await create(deps, invalid);

    expect(response.status).toBe(400);
    const error = ErrorResponseSchema.parse(body);
    expect(error.error.code).toBe("validation_error");
    expect(error.error.fields?.map((field) => field.path)).toEqual(
      expect.arrayContaining(["pageUrl"]),
    );
    expect(memory.calls).toHaveLength(0);
  });

  it("rejects extension attempts to submit verified composition", async () => {
    const { deps } = setup();
    const request = requestFixture() as Record<string, unknown>;
    const composition = structuredClone(request.composition) as Array<Record<string, unknown>>;
    composition[0].verification = "verified";
    const { response } = await create(deps, { ...request, composition });
    expect(response.status).toBe(400);
  });

  it("rejects bodies over 64 KB", async () => {
    const { deps, memory } = setup();
    const response = await handleCreateAnalysis(
      postRequest(JSON.stringify({ padding: "x".repeat(70_000) })),
      deps,
    );
    expect(response.status).toBe(413);
    expect(memory.calls).toHaveLength(0);
  });

  it("returns unsupported_page for non-retailer hosts", async () => {
    const { deps } = setup();
    const { response, body } = await create(deps, requestFixture({ pageUrl: "http://192.168.1.10/p" }));
    expect(response.status).toBe(422);
    expect(ErrorResponseSchema.parse(body).error.code).toBe("unsupported_page");
  });

  it("is disabled in production", async () => {
    const { deps, memory } = setup({ ...DEV_ENV, NODE_ENV: "production" });
    const { response, body } = await create(deps);
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("forbidden");
    expect(memory.calls).toHaveLength(0);
  });

  it("returns a generic error without database or credential details", async () => {
    const { deps, memory, log } = setup();
    memory.failOnce(
      "insertAnalysis",
      new StoreError("unknown", "XX000", `connection to ${DEV_ENV.SUPABASE_URL} failed for ${SECRET}`),
    );
    const response = await handleCreateAnalysis(postRequest(requestFixture()), deps);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal_error", message: "The request could not be completed." },
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("supabase");
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });

  it("returns 503 when the database is unreachable", async () => {
    const { deps, memory } = setup();
    memory.failOnce("findRetailerByDomain", new StoreError("unavailable", null, "fetch failed"));
    const { response, body } = await create(deps);
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("service_unavailable");
  });

  it("returns 503 without naming values when configuration is missing", async () => {
    const { deps, log } = setup();
    deps.getStore = () => {
      throw new ServerConfigError("SUPABASE_SECRET_KEY");
    };
    const response = await handleCreateAnalysis(postRequest(requestFixture()), deps);
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toContain("SUPABASE");
    expect(log).toHaveBeenCalledWith("create_analysis_failed", {
      reason: "config",
      variable: "SUPABASE_SECRET_KEY",
    });
  });
});

describe("GET /api/analyses/:id", () => {
  it("returns the stored analysis as a valid pending full response", async () => {
    const { deps } = setup();
    const { body: created } = await create(deps);
    const { response, body } = await read(deps, created.analysisId);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const analysis = FullAnalysisResponseSchema.parse(body);
    expect(analysis).toMatchObject({
      analysisId: created.analysisId,
      processingStatus: "pending",
      outcome: null,
      submittedPageUrl: requestFixture().pageUrl,
      alternatives: [],
      failure: null,
      fit: { availability: "unavailable", measurements: [] },
      price: {
        listed: { amountMinor: 8900, currency: "USD" },
        regular: null,
        observedAt: "2026-10-17T22:15:00.000Z",
      },
    });
    expect(analysis.product).toMatchObject({
      title: "Hearth & Hem Crew Sweater",
      variantLabel: "Oat",
      department: "womens",
      retailerProductId: "HH-1042",
    });
    expect(analysis.composition.map((fact) => [fact.component, fact.fiber, fact.percent])).toEqual([
      ["shell", "merino wool", 70],
      ["shell", "polyester", 30],
      ["lining", "cotton", 100],
    ]);
    expect(analysis.composition.every((fact) => fact.verification === "extracted")).toBe(true);
    expect(analysis.evidence.every((item) => item.productId === analysis.product?.id)).toBe(true);
    expect(analysis.warnings.map((warning) => warning.code)).toEqual([
      "unverified_composition",
      "missing_regular_price",
      "missing_measurements",
    ]);
  });

  it("returns warnings instead of invented values when price and composition are missing", async () => {
    const { deps } = setup();
    const { body: created } = await create(
      deps,
      requestFixture({ listedPrice: null, regularPrice: null, composition: [] }),
    );
    const analysis = FullAnalysisResponseSchema.parse((await read(deps, created.analysisId)).body);

    expect(analysis.price).toEqual({ listed: null, regular: null, observedAt: null });
    expect(analysis.composition).toEqual([]);
    expect(analysis.evidence).toEqual([]);
    expect(analysis.warnings.map((warning) => warning.code)).toEqual([
      "missing_composition",
      "missing_price",
      "missing_measurements",
    ]);
  });

  it("returns only the capture that created each analysis", async () => {
    const { deps } = setup();
    const { body: first } = await create(deps);
    const { body: second } = await create(
      deps,
      requestFixture({
        capturedAt: "2026-10-24T22:15:00.000Z",
        listedPrice: { amountMinor: 6900, currency: "USD" },
      }),
    );

    const earlier = FullAnalysisResponseSchema.parse((await read(deps, first.analysisId)).body);
    const later = FullAnalysisResponseSchema.parse((await read(deps, second.analysisId)).body);
    expect(later.product?.id).toBe(earlier.product?.id);
    expect(earlier.price.listed?.amountMinor).toBe(8900);
    expect(later.price.listed?.amountMinor).toBe(6900);
    const earlierIds = new Set(earlier.evidence.map((item) => item.id));
    expect(later.evidence.some((item) => earlierIds.has(item.id))).toBe(false);
  });

  it("orders facts and evidence the same way regardless of storage order", async () => {
    const { deps, memory } = setup();
    const { body: created } = await create(deps);
    const before = FullAnalysisResponseSchema.parse((await read(deps, created.analysisId)).body);
    memory.tables.claims.reverse();
    memory.tables.evidence.reverse();
    const after = FullAnalysisResponseSchema.parse((await read(deps, created.analysisId)).body);

    expect(after.composition).toEqual(before.composition);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.evidence.map((item) => item.excerpt)).toEqual([
      "Shell: 70% merino wool, 30% polyester",
      "Lining: 100% cotton",
    ]);
  });

  it.each(["not-a-uuid", "1234", "20000000-0000-4000-8000-00000000000Z", ""])(
    "rejects the invalid id %j",
    async (id) => {
      const { deps, memory } = setup();
      const { response, body } = await read(deps, id);
      expect(response.status).toBe(400);
      expect(ErrorResponseSchema.parse(body).error.code).toBe("validation_error");
      expect(memory.calls).toHaveLength(0);
    },
  );

  it("returns not_found for an unknown id", async () => {
    const { deps } = setup();
    const { response, body } = await read(deps, "30000000-0000-4000-8000-000000000001");
    expect(response.status).toBe(404);
    expect(ErrorResponseSchema.parse(body)).toEqual({
      error: { code: "not_found", message: "Analysis not found." },
    });
  });

  it("returns a generic error when the database read fails", async () => {
    const { deps, memory } = setup();
    const { body: created } = await create(deps);
    memory.failOnce("listMaterialClaims", new StoreError("unknown", "42501", `denied ${SECRET}`));
    const response = await handleGetAnalysis(created.analysisId, deps);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("42501");
  });

  it("returns a generic error when stored data cannot satisfy the contract", async () => {
    const { deps, memory, log } = setup();
    const { body: created } = await create(deps);
    memory.tables.products[0].canonical_url = "not a url";
    const { response, body } = await read(deps, created.analysisId);
    expect(response.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(log).toHaveBeenCalledWith("read_analysis_failed", expect.objectContaining({ reason: "contract" }));
  });
});
