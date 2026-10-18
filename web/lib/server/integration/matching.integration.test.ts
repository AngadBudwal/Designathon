import { describe, expect, it } from "vitest";

import { AnalysisCreatedResponseSchema, FullAnalysisResponseSchema, type AnalysisRequest } from "@/lib/contracts";

// Live check against a local dev server and the real catalog imported from
// supabase/seed/hm-knitwear-2026-10-18.json. Skipped unless INTEGRATION_BASE_URL is set:
//   INTEGRATION_BASE_URL=http://localhost:3000 npx vitest run lib/server/integration
const BASE_URL = process.env.INTEGRATION_BASE_URL;

// Values copied from the public H&M US page, as recorded in the seed file.
const selectedRequest: AnalysisRequest = {
  pageUrl: "https://www2.hm.com/en_us/productpage.1232050001.html",
  capturedAt: "2026-10-18T02:30:00.000Z",
  extractorVersion: "manual-0.1.0",
  title: "Regular Fit Fine-Knit Sweater",
  brand: "H&M",
  imageUrl: "https://image.hm.com/assets/hm/d4/3b/d43b9223cdecf24b387966857ac927b43d1720aa.jpg?imwidth=1260",
  retailerProductId: "1232050001",
  variantLabel: "Cream",
  department: "mens",
  category: "sweater",
  listedPrice: { amountMinor: 3499, currency: "USD" },
  regularPrice: null,
  composition: [
    {
      component: "other",
      rawText: "Polyester 53%, Polyamide 24%, Acrylic 13%, Wool 7%, Spandex 3%",
      fibers: [
        { name: "polyester", percent: 53 },
        { name: "polyamide", percent: 24 },
        { name: "acrylic", percent: 13 },
        { name: "wool", percent: 7 },
        { name: "spandex", percent: 3 },
      ],
      excerpts: [{ text: "Composition: Polyester 53%, Polyamide 24%, Acrylic 13%, Wool 7%, Spandex 3%" }],
    },
  ],
};

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  return { status: response.status, body: await response.json() };
}

describe.skipIf(!BASE_URL)("live cross-department matching", () => {
  it("matches the men's blend sweater to the stored women's merino sweater", async () => {
    const created = await call("/api/analyses", { method: "POST", body: JSON.stringify(selectedRequest) });
    expect(created.status).toBe(201);
    const { analysisId } = AnalysisCreatedResponseSchema.parse(created.body);

    const processed = await call(`/api/analyses/${analysisId}/process`, { method: "POST" });
    expect(processed.status).toBe(200);
    const fetched = await call(`/api/analyses/${analysisId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(processed.body);

    const analysis = FullAnalysisResponseSchema.parse(fetched.body);
    expect(analysis.outcome).toBe("alternatives_found");
    expect(analysis.product).toMatchObject({ department: "mens", retailerProductId: "1232050001" });
    expect(analysis.price.listed).toEqual({ amountMinor: 3499, currency: "USD" });
    expect(analysis.alternatives).toHaveLength(1);

    const [alternative] = analysis.alternatives;
    expect(alternative!.product).toMatchObject({
      department: "womens",
      retailerProductId: "1324110003",
      title: "Merino Wool Sweater",
    });
    expect(alternative!.price.listed).toEqual({ amountMinor: 5999, currency: "USD" });
    expect(alternative!.priceDifference).toEqual({ amountMinor: 2500, currency: "USD", comparedField: "listed_price" });
    expect(alternative!.disadvantages.map((item) => item.code)).toEqual(["higher_listed_price"]);
    expect(alternative!.advantages.map((item) => item.code)).toEqual(["more_listed_natural_fiber"]);
    expect(alternative!.explanations.find((item) => item.code === "shared_fiber")?.detail).toBe(
      "unlabeled composition: wool 100% in the alternative vs 7% in the selected (+93 percentage points).",
    );
    expect(alternative!.uncertainties.map((item) => item.code)).toContain("fit_unknown");
    expect(alternative!.fit.availability).toBe("unavailable");

    const ownEvidence = analysis.evidence.filter((item) => item.productId === alternative!.product.id);
    expect(ownEvidence.map((item) => item.excerpt)).toEqual(["Composition: Wool 100%"]);
    expect(ownEvidence[0]!.sourceUrl).toBe("https://www2.hm.com/en_us/productpage.1324110003.html");

    const again = await call(`/api/analyses/${analysisId}/process`, { method: "POST" });
    expect(again.body).toEqual(processed.body);

    console.log(JSON.stringify({ analysisId, alternative: alternative!.product.id, analysis }, null, 2));
  }, 60_000);
});
