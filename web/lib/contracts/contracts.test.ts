import { describe, expect, it } from "vitest";

import {
  AnalysisCreatedResponseSchema,
  AnalysisRequestSchema,
  ErrorResponseSchema,
  FullAnalysisResponseSchema,
  type AnalysisCreatedResponse,
  type AnalysisRequest,
  type FullAnalysisResponse,
  zodErrorToErrorResponse,
} from "./index";
import alternativesFound from "./fixtures/analysis-alternatives-found.json";
import created from "./fixtures/analysis-created.json";
import failed from "./fixtures/analysis-failed.json";
import insufficient from "./fixtures/analysis-insufficient.json";
import noAlternative from "./fixtures/analysis-no-alternative.json";
import pending from "./fixtures/analysis-pending.json";
import unsupported from "./fixtures/analysis-unsupported.json";
import extensionRequest from "./fixtures/extension-request.json";

const ALL_FIXTURES = [
  extensionRequest,
  created,
  pending,
  alternativesFound,
  noAlternative,
  insufficient,
  unsupported,
  failed,
];

function requestFixture(): AnalysisRequest {
  return structuredClone(AnalysisRequestSchema.parse(extensionRequest.data));
}

function createdFixture(): AnalysisCreatedResponse {
  return structuredClone(AnalysisCreatedResponseSchema.parse(created.data));
}

function analysisFixture(fixture: { data: unknown }): FullAnalysisResponse {
  return structuredClone(FullAnalysisResponseSchema.parse(fixture.data));
}

describe("analysis request", () => {
  it("accepts the synthetic extension fixture", () => {
    const parsed = AnalysisRequestSchema.parse(requestFixture());
    expect(parsed.title).toBe("Hearth & Hem Crew Sweater");
    expect(parsed.listedPrice).toEqual({ amountMinor: 8900, currency: "USD" });
    expect(parsed.regularPrice).toBeNull();
    expect(parsed).not.toHaveProperty("discount");
    const components = parsed.composition?.map((part) => part.component);
    expect(components).toEqual(["shell", "lining"]);
  });

  it("rejects an invalid url", () => {
    const request = requestFixture();
    request.pageUrl = "javascript:alert(1)";
    const result = AnalysisRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
    if (!result.success) {
      const response = zodErrorToErrorResponse(result.error);
      expect(response.error.code).toBe("validation_error");
      expect(response.error.fields?.[0]?.path).toBe("pageUrl");
      expect(response).not.toHaveProperty("stack");
      expect(JSON.stringify(response)).not.toContain("stack");
    }
  });

  it("rejects a non-http url", () => {
    const request = requestFixture();
    request.pageUrl = "ftp://shop.example.com/products/sweater";
    expect(AnalysisRequestSchema.safeParse(request).success).toBe(false);
  });

  it("accepts missing composition", () => {
    const request = requestFixture();
    request.composition = null;
    expect(AnalysisRequestSchema.safeParse(request).success).toBe(true);

    const omitted = requestFixture() as Record<string, unknown>;
    delete omitted.composition;
    expect(AnalysisRequestSchema.safeParse(omitted).success).toBe(true);
  });

  it("accepts a missing listed price without implying a discount", () => {
    const request = requestFixture();
    request.listedPrice = null;
    request.regularPrice = null;
    const parsed = AnalysisRequestSchema.parse(request);
    expect(parsed.listedPrice).toBeNull();
    expect(parsed.regularPrice).toBeNull();
    expect(parsed).not.toHaveProperty("discount");
  });

  it("accepts partial fiber percentages that do not total 100", () => {
    const request = requestFixture();
    request.composition = [
      {
        component: "shell",
        rawText: "Shell: 60% wool",
        fibers: [{ name: "wool", percent: 60 }],
        excerpts: [{ text: "Shell: 60% wool" }],
      },
    ];
    expect(AnalysisRequestSchema.safeParse(request).success).toBe(true);

    request.composition[0].fibers = [
      { name: "wool", percent: 80 },
      { name: "nylon", percent: 50 },
    ];
    request.composition[0].rawText = "Shell: 80% wool, 50% nylon";
    expect(AnalysisRequestSchema.safeParse(request).success).toBe(true);
  });

  it("accepts a fiber name with no percentage", () => {
    const request = requestFixture();
    request.composition = [
      {
        component: "trim",
        rawText: "Trim: cashmere",
        fibers: [{ name: "cashmere", percent: null }],
        excerpts: [{ text: "Trim: cashmere" }],
      },
    ];
    expect(AnalysisRequestSchema.safeParse(request).success).toBe(true);
  });

  it("requires every composition block to name its garment component", () => {
    const request = requestFixture() as { composition: Record<string, unknown>[] };
    delete request.composition[0].component;
    expect(AnalysisRequestSchema.safeParse(request).success).toBe(false);
  });

  it("requires integer minor units for prices", () => {
    const request = requestFixture();
    request.listedPrice = { amountMinor: 19.99, currency: "USD" };
    expect(AnalysisRequestSchema.safeParse(request).success).toBe(false);

    request.listedPrice = { amountMinor: 8900, currency: "USD" };
    expect(AnalysisRequestSchema.safeParse(request).success).toBe(true);
  });

  it("rejects invented quality fields such as gsm", () => {
    const request = requestFixture() as Record<string, unknown>;
    request.gsm = 180;
    expect(AnalysisRequestSchema.safeParse(request).success).toBe(false);
  });

  it("does not let the extension mark a claim as verified", () => {
    const onBlock = requestFixture() as { composition: Record<string, unknown>[] };
    onBlock.composition[0].verification = "verified";
    expect(AnalysisRequestSchema.safeParse(onBlock).success).toBe(false);

    const onFiber = requestFixture() as {
      composition: { fibers: Record<string, unknown>[] }[];
    };
    onFiber.composition[0].fibers[0].verified = true;
    expect(AnalysisRequestSchema.safeParse(onFiber).success).toBe(false);

    const onRoot = requestFixture() as Record<string, unknown>;
    onRoot.verification = "verified";
    expect(AnalysisRequestSchema.safeParse(onRoot).success).toBe(false);
  });

  it("rejects html markup and oversized text", () => {
    const html = requestFixture();
    if (html.composition) {
      html.composition[0].rawText = "<div class=\"composition\">70% wool</div>";
    }
    expect(AnalysisRequestSchema.safeParse(html).success).toBe(false);

    const lessThan = requestFixture();
    if (lessThan.composition) {
      lessThan.composition[0].rawText = "95% wool, <5% elastane";
    }
    expect(AnalysisRequestSchema.safeParse(lessThan).success).toBe(true);

    const oversized = requestFixture();
    if (oversized.composition) {
      oversized.composition[0].excerpts = [{ text: "wool ".repeat(200) }];
    }
    expect(AnalysisRequestSchema.safeParse(oversized).success).toBe(false);
  });

  it("accepts optional product identity fields and rejects unsafe image urls", () => {
    const parsed = AnalysisRequestSchema.parse(requestFixture());
    expect(parsed.brand).toBe("Hearth & Hem");
    expect(parsed.retailerProductId).toBe("HH-1042");

    const missing = requestFixture() as Record<string, unknown>;
    delete missing.brand;
    delete missing.imageUrl;
    missing.retailerProductId = null;
    missing.variantLabel = null;
    expect(AnalysisRequestSchema.safeParse(missing).success).toBe(true);

    const unsafe = requestFixture();
    unsafe.imageUrl = "javascript:alert(1)";
    expect(AnalysisRequestSchema.safeParse(unsafe).success).toBe(false);
  });

  it("does not accept the fixture wrapper as a request", () => {
    expect(AnalysisRequestSchema.safeParse(extensionRequest).success).toBe(false);
  });
});

describe("analysis response", () => {
  it("accepts the created-analysis fixture", () => {
    const parsed = AnalysisCreatedResponseSchema.parse(createdFixture());
    expect(parsed.processingStatus).toBe("pending");
    expect(parsed.outcome).toBeNull();
    expect(parsed.pageUrl).toMatch(/^https:\/\//);
  });

  it("keeps outcome null until processing completes", () => {
    const early = { ...createdFixture(), outcome: "alternatives_found" };
    expect(AnalysisCreatedResponseSchema.safeParse(early).success).toBe(false);

    const missing = analysisFixture(noAlternative);
    missing.outcome = null;
    expect(FullAnalysisResponseSchema.safeParse(missing).success).toBe(false);
  });

  it("accepts a pending analysis with no product details", () => {
    const parsed = analysisFixture(pending);
    expect(parsed.processingStatus).toBe("pending");
    expect(parsed.outcome).toBeNull();
    expect(parsed.product).toBeNull();
  });

  it("accepts alternatives with independent advantages and uncertainties", () => {
    const parsed = analysisFixture(alternativesFound);
    expect(parsed.outcome).toBe("alternatives_found");
    expect(parsed.alternatives).toHaveLength(2);

    const [mens, unisex] = parsed.alternatives;
    expect(mens?.priceDifference?.amountMinor).toBe(3900);
    expect(mens?.disadvantages.map((item) => item.code)).toEqual(["higher_listed_price"]);
    expect(unisex?.priceDifference?.amountMinor).toBe(-1500);
    expect(unisex?.advantages.map((item) => item.code)).toEqual(["lower_listed_price"]);
    expect(unisex?.disadvantages).toEqual([]);
    expect(unisex?.composition.every((claim) => claim.percent === null)).toBe(true);
  });

  it("keeps fiber claims attached to their component", () => {
    const parsed = analysisFixture(alternativesFound);
    const lining = parsed.composition.filter((claim) => claim.component === "lining");
    expect(lining.map((claim) => claim.fiber)).toEqual(["cotton"]);

    const invalid = structuredClone(alternativesFound.data) as {
      composition: Record<string, unknown>[];
    };
    delete invalid.composition[0].component;
    expect(FullAnalysisResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts completed analyses with no alternatives, insufficient data, or unsupported pages", () => {
    expect(analysisFixture(noAlternative).alternatives).toEqual([]);
    expect(analysisFixture(insufficient).outcome).toBe("insufficient_information");

    const page = analysisFixture(unsupported);
    expect(page.outcome).toBe("unsupported_page");
    expect(page.product).toBeNull();
  });

  it("requires a selected product when alternatives were compared", () => {
    const invalid = analysisFixture(noAlternative);
    invalid.product = null;
    expect(FullAnalysisResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts a failed analysis with only a client-safe failure", () => {
    const parsed = analysisFixture(failed);
    expect(parsed.outcome).toBeNull();
    expect(parsed.failure?.code).toBe("processing_failed");

    const leaky = structuredClone(failed.data) as { failure: Record<string, unknown> };
    leaky.failure.stack = "Error: connect ECONNREFUSED postgres://user:pass@db";
    expect(FullAnalysisResponseSchema.safeParse(leaky).success).toBe(false);

    const missing = analysisFixture(failed);
    missing.failure = null;
    expect(FullAnalysisResponseSchema.safeParse(missing).success).toBe(false);
  });

  it("only allows alternatives on alternatives_found", () => {
    const empty = analysisFixture(alternativesFound);
    empty.alternatives = [];
    expect(FullAnalysisResponseSchema.safeParse(empty).success).toBe(false);

    const extra = analysisFixture(alternativesFound);
    extra.outcome = "no_suitable_alternative";
    expect(FullAnalysisResponseSchema.safeParse(extra).success).toBe(false);
  });

  it("accepts missing fit measurements and rejects invented ones", () => {
    const parsed = analysisFixture(noAlternative);
    expect(parsed.fit).toEqual({ availability: "unavailable", measurements: [] });

    const invented = analysisFixture(noAlternative);
    invented.fit = {
      availability: "unavailable",
      measurements: [{ name: "chest", value: 96, unit: "cm", sizeLabel: null, basis: "unknown" }],
    };
    expect(FullAnalysisResponseSchema.safeParse(invented).success).toBe(false);

    const placeholder = structuredClone(noAlternative.data) as { fit: unknown };
    placeholder.fit = {
      availability: "partial",
      measurements: [{ name: "chest", value: null, unit: "cm", sizeLabel: "M", basis: "unknown" }],
    };
    expect(FullAnalysisResponseSchema.safeParse(placeholder).success).toBe(false);
  });

  it("ties each measurement to a size label and measurement basis", () => {
    const parsed = analysisFixture(alternativesFound);
    expect(parsed.alternatives[0]?.fit.measurements).toEqual([
      { name: "chest", value: 56, unit: "cm", sizeLabel: "M", basis: "garment_flat" },
    ]);

    const noSize = analysisFixture(alternativesFound);
    const measurement = noSize.alternatives[0]?.fit.measurements[0];
    if (measurement) {
      measurement.sizeLabel = null;
      measurement.basis = "unknown";
    }
    expect(FullAnalysisResponseSchema.safeParse(noSize).success).toBe(true);

    const raw = () =>
      structuredClone(alternativesFound.data) as {
        alternatives: { fit: { measurements: Record<string, unknown>[] } }[];
      };

    const missingBasis = raw();
    delete missingBasis.alternatives[0].fit.measurements[0].basis;
    expect(FullAnalysisResponseSchema.safeParse(missingBasis).success).toBe(false);

    const badBasis = raw();
    badBasis.alternatives[0].fit.measurements[0].basis = "estimated";
    expect(FullAnalysisResponseSchema.safeParse(badBasis).success).toBe(false);

    const sizeMapping = raw();
    sizeMapping.alternatives[0].fit.measurements[0].womensEquivalentSize = "L";
    expect(FullAnalysisResponseSchema.safeParse(sizeMapping).success).toBe(false);
  });

  it("validates product identity fields and keeps missing ones null", () => {
    const parsed = analysisFixture(alternativesFound);
    expect(parsed.product?.brand).toBe("Hearth & Hem");
    const commons = parsed.alternatives[1]?.product;
    expect(commons?.imageUrl).toBeNull();
    expect(commons?.retailerProductId).toBeNull();
    expect(commons?.variantLabel).toBeNull();

    const badImage = analysisFixture(alternativesFound);
    if (badImage.product) badImage.product.imageUrl = "data:image/png;base64,AAAA";
    expect(FullAnalysisResponseSchema.safeParse(badImage).success).toBe(false);

    const badId = analysisFixture(alternativesFound);
    if (badId.product) badId.product.id = "product-1";
    expect(FullAnalysisResponseSchema.safeParse(badId).success).toBe(false);
  });

  it("rejects material claims that cite another product's evidence", () => {
    const crossed = analysisFixture(alternativesFound);
    const selectedEvidenceId = crossed.composition[0]?.evidenceIds[0];
    const commonsClaim = crossed.alternatives[1]?.composition[0];
    if (commonsClaim && selectedEvidenceId) {
      commonsClaim.evidenceIds = [selectedEvidenceId];
    }
    const result = FullAnalysisResponseSchema.safeParse(crossed);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "Material claim references evidence from a different product.",
      );
    }

    const orphan = analysisFixture(alternativesFound);
    if (orphan.evidence[0]) orphan.evidence[0].productId = "40000000-0000-4000-8000-000000000099";
    expect(FullAnalysisResponseSchema.safeParse(orphan).success).toBe(false);

    const duplicate = analysisFixture(alternativesFound);
    const selectedId = duplicate.product?.id;
    if (duplicate.alternatives[0] && selectedId) duplicate.alternatives[0].product.id = selectedId;
    expect(FullAnalysisResponseSchema.safeParse(duplicate).success).toBe(false);
  });

  it("rejects price differences that are invented or cross currencies", () => {
    const noSelectedPrice = analysisFixture(alternativesFound);
    noSelectedPrice.price.listed = null;
    expect(FullAnalysisResponseSchema.safeParse(noSelectedPrice).success).toBe(false);

    const wrongAmount = analysisFixture(alternativesFound);
    if (wrongAmount.alternatives[0]?.priceDifference) {
      wrongAmount.alternatives[0].priceDifference.amountMinor = 1;
    }
    expect(FullAnalysisResponseSchema.safeParse(wrongAmount).success).toBe(false);

    const otherCurrency = analysisFixture(alternativesFound);
    for (const alternative of otherCurrency.alternatives) {
      alternative.price.listed = { amountMinor: 9000, currency: "EUR" };
    }
    expect(FullAnalysisResponseSchema.safeParse(otherCurrency).success).toBe(false);

    for (const alternative of otherCurrency.alternatives) {
      alternative.priceDifference = null;
      alternative.advantages = [];
      alternative.disadvantages = [];
    }
    expect(FullAnalysisResponseSchema.safeParse(otherCurrency).success).toBe(true);
  });

  it("rejects price advantages that contradict the price difference", () => {
    const invalid = analysisFixture(alternativesFound);
    if (invalid.alternatives[0]) {
      invalid.alternatives[0].advantages = [
        { code: "lower_listed_price", detail: "Claims a lower price." },
      ];
    }
    expect(FullAnalysisResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects unknown response fields such as a durability score", () => {
    const invalid = analysisFixture(noAlternative) as Record<string, unknown>;
    invalid.durabilityScore = 80;
    expect(FullAnalysisResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects an error payload that includes a stack trace", () => {
    const result = AnalysisRequestSchema.safeParse({
      ...requestFixture(),
      pageUrl: "not a url",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const response = zodErrorToErrorResponse(result.error);
      expect(JSON.stringify(response)).not.toContain("stack");
      expect(
        ErrorResponseSchema.safeParse({ ...response, stack: "Error: secret database url" }).success,
      ).toBe(false);
    }
  });
});

describe("fixtures", () => {
  it("are all labeled synthetic and contain no verified claims", () => {
    for (const fixture of ALL_FIXTURES) {
      expect(fixture.synthetic).toBe(true);
      expect(fixture.disclaimer).toMatch(/^Synthetic fixture/);
      expect(JSON.stringify(fixture.data)).not.toContain('"verified"');
    }
  });
});
