import { describe, expect, it } from "vitest";

import type { Department, GarmentComponent } from "@/lib/contracts";

import { naturalShare, normalizeFiber } from "./fibers";
import { classifyGarment } from "./garment";
import { assessSelected, candidateDepartments, findAlternatives, outcomeFor, type ProductFacts } from "./matching";
import { comparePrices } from "./price";

// Synthetic products for unit tests only. Not retailer data.
const NOW = new Date("2026-10-17T12:00:00.000Z");
const RECENT = "2026-10-10T12:00:00.000Z";

let counter = 0;
const nextId = () => `10000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

type Spec = {
  department?: Department;
  title?: string | null;
  category?: string | null;
  brand?: string | null;
  components?: Array<{ component: GarmentComponent; fibers: Array<[string, number | null]> }>;
  price?: { amountMinor: number; currency?: string; observedAt?: string } | null;
  capturedAt?: string;
  verification?: "extracted" | "verified";
};

function facts(spec: Spec = {}): ProductFacts {
  const productId = nextId();
  const capturedAt = spec.capturedAt ?? RECENT;
  const components = spec.components ?? [{ component: "shell", fibers: [["wool", 100]] }];
  const evidence = components.map(({ component, fibers }) => ({
    id: nextId(),
    product_id: productId,
    source_type: "manual_review" as const,
    source_url: `https://shop.example.com/${productId}`,
    excerpt: `${component}: ${fibers.map(([name, percent]) => `${percent ?? "?"}% ${name}`).join(", ")}`,
    captured_at: capturedAt,
    extractor_version: null,
  }));
  const claims = components.flatMap(({ component, fibers }, index) =>
    fibers.map(([fiber, percent]) => ({
      id: nextId(),
      product_id: productId,
      evidence_id: evidence[index]!.id,
      component,
      fiber,
      percent,
      raw_text: evidence[index]!.excerpt,
      verification_status: spec.verification ?? ("extracted" as const),
    })),
  );
  const price =
    spec.price === null
      ? null
      : {
          id: nextId(),
          product_id: productId,
          variant_id: null,
          evidence_id: null,
          listed_amount_minor: spec.price?.amountMinor ?? 5000,
          regular_amount_minor: null,
          currency: spec.price?.currency ?? "USD",
          observed_at: spec.price?.observedAt ?? RECENT,
        };
  return {
    product: {
      id: productId,
      retailer_id: "retailer",
      canonical_url: `https://shop.example.com/${productId}`,
      retailer_product_id: null,
      title: spec.title === undefined ? "Fine-Knit Sweater" : spec.title,
      brand: spec.brand === undefined ? "Example" : spec.brand,
      department: spec.department ?? "mens",
      category: spec.category === undefined ? "sweater" : spec.category,
      image_url: null,
    },
    evidence,
    claims,
    price,
  };
}

const codes = (alternative: { reasons: Array<{ kind: string; code: string }> }, kind: string) =>
  alternative.reasons.filter((reason) => reason.kind === kind).map((reason) => reason.code);
const detail = (alternative: { reasons: Array<{ code: string; detail: string }> }, code: string) =>
  alternative.reasons.find((reason) => reason.code === code)?.detail;

describe("fiber and garment helpers", () => {
  it("normalizes retailer fiber names without merging different fibers", () => {
    expect(normalizeFiber("Spandex")).toBe("elastane");
    expect(normalizeFiber("Polyamide")).toBe("nylon");
    expect(normalizeFiber("Recycled polyester")).toBe("polyester");
    expect(normalizeFiber("Merino")).toBe("merino wool");
    expect(normalizeFiber("wool")).toBe("wool");
  });

  it("returns no natural share when any percentage is missing or the total is not 100", () => {
    const claim = (fiber: string, percent: number | null) => ({ fiber, percent });
    expect(naturalShare([claim("wool", 7), claim("polyester", 93)] as never)).toBe(7);
    expect(naturalShare([claim("wool", null), claim("polyester", 93)] as never)).toBeNull();
    expect(naturalShare([claim("wool", 50)] as never)).toBeNull();
  });

  it("classifies knitwear and explicit styles only from stored text", () => {
    const product = (title: string, category: string | null) => facts({ title, category }).product;
    expect(classifyGarment(product("Regular Fit Fine-Knit Sweater", null))).toEqual({ knitwear: true, style: null });
    expect(classifyGarment(product("Wool Cardigan", "knitwear")).style).toBe("cardigan");
    expect(classifyGarment(product("Half-Zip Sweater", "sweater")).style).toBe("half_zip");
    expect(classifyGarment(product("Slim Jeans", "jeans")).knitwear).toBe(false);
  });

  it("searches the other department and unisex, and never for unknown", () => {
    expect(candidateDepartments("mens")).toEqual(["womens", "unisex"]);
    expect(candidateDepartments("womens")).toEqual(["mens", "unisex"]);
    expect(candidateDepartments("unknown")).toEqual([]);
  });
});

describe("findAlternatives", () => {
  const selected = () =>
    facts({
      department: "mens",
      title: "Regular Fit Fine-Knit Sweater",
      components: [{ component: "other", fibers: [["polyester", 53], ["polyamide", 24], ["acrylic", 13], ["wool", 7], ["spandex", 3]] }],
      price: { amountMinor: 3499 },
    });
  const womensMerino = () =>
    facts({
      department: "womens",
      title: "Merino Wool Sweater",
      components: [{ component: "other", fibers: [["wool", 100]] }],
      price: { amountMinor: 5999 },
    });

  it("finds a cross-department alternative with correct material and price numbers", () => {
    const alternative = womensMerino();
    const { alternatives } = findAlternatives(selected(), [alternative], NOW);
    expect(alternatives).toHaveLength(1);
    const [match] = alternatives;
    expect(match!.facts.product.id).toBe(alternative.product.id);
    expect(codes(match!, "explanation")).toEqual(["same_category", "different_department", "shared_fiber"]);
    expect(detail(match!, "shared_fiber")).toContain("wool 100% in the alternative vs 7% in the selected (+93 percentage points)");
    expect(codes(match!, "advantage")).toEqual(["more_listed_natural_fiber"]);
    expect(detail(match!, "more_listed_natural_fiber")).toContain("100% natural fiber and the selected lists 7% (+93 percentage points)");
    expect(detail(match!, "more_listed_natural_fiber")).toContain("not quality or durability");
    expect(codes(match!, "disadvantage")).toEqual(["higher_listed_price"]);
    expect(detail(match!, "higher_listed_price")).toContain("USD 25.00 higher");
    expect(codes(match!, "uncertainty")).toEqual(["unverified_composition", "fit_unknown"]);
    expect(detail(match!, "same_category")).toContain("style compatibility is unverified");
    for (const reason of match!.reasons) expect(reason.detail.length).toBeLessThanOrEqual(300);
  });

  it("rejects the same department, the same product, and non-knitwear", () => {
    const base = selected();
    const result = findAlternatives(
      base,
      [base, facts({ department: "mens" }), facts({ department: "womens", title: "Wide Jeans", category: "jeans" })],
      NOW,
    );
    expect(result.alternatives).toEqual([]);
    expect(result.rejected.map((item) => item.reason)).toEqual(["same_product", "department", "not_knitwear"]);
  });

  it("does not treat cardigans, hoodies, and half-zips as interchangeable", () => {
    const crew = facts({ title: "Crewneck Sweater", components: [{ component: "shell", fibers: [["wool", 100]] }] });
    const result = findAlternatives(
      crew,
      [
        facts({ department: "womens", title: "Wool Cardigan" }),
        facts({ department: "womens", title: "Knit Hoodie" }),
        facts({ department: "womens", title: "Half-Zip Sweater" }),
      ],
      NOW,
    );
    expect(result.alternatives).toEqual([]);
    expect(result.rejected.every((item) => item.reason === "different_style")).toBe(true);
  });

  it("compares only matching components and reports different coverage", () => {
    const shellAndLining = facts({
      components: [
        { component: "shell", fibers: [["wool", 70], ["polyester", 30]] },
        { component: "lining", fibers: [["cotton", 100]] },
      ],
    });
    const shellOnly = facts({ department: "womens", components: [{ component: "shell", fibers: [["wool", 50], ["nylon", 50]] }] });
    const liningOnly = facts({ department: "womens", components: [{ component: "lining", fibers: [["wool", 100]] }] });
    const unlabeled = facts({ department: "womens", components: [{ component: "other", fibers: [["wool", 100]] }] });

    const result = findAlternatives(shellAndLining, [shellOnly, unlabeled], NOW);
    expect(result.alternatives.map((item) => item.facts.product.id)).toEqual([shellOnly.product.id]);
    expect(result.rejected).toEqual([{ productId: unlabeled.product.id, reason: "no_shared_component" }]);
    const [match] = result.alternatives;
    expect(detail(match!, "shared_fiber")).toBe("shell: wool 50% in the alternative vs 70% in the selected (-20 percentage points).");
    expect(codes(match!, "disadvantage")).toContain("less_listed_natural_fiber");
    expect(detail(match!, "different_component_coverage")).toContain("Only shell was compared");

    const liningMatch = findAlternatives(shellAndLining, [liningOnly], NOW).alternatives[0]!;
    // Cotton lining vs wool lining: no fiber in common, and neither is reported as 0%.
    expect(detail(liningMatch, "shared_fiber")).toBeUndefined();
    expect(codes(liningMatch, "advantage")).toEqual([]);
  });

  it("never treats a missing percentage as zero", () => {
    const partial = facts({
      department: "womens",
      components: [{ component: "other", fibers: [["wool", null], ["polyester", null]] }],
    });
    const [match] = findAlternatives(selected(), [partial], NOW).alternatives;
    expect(detail(match!, "shared_fiber")).toContain("without a percentage for the alternative");
    expect(codes(match!, "uncertainty")).toContain("missing_fiber_percent");
    expect(codes(match!, "advantage")).not.toContain("more_listed_natural_fiber");
    expect(codes(match!, "disadvantage")).not.toContain("less_listed_natural_fiber");
  });

  it("does not compare prices across currencies or with stale observations", () => {
    const euro = facts({ department: "womens", price: { amountMinor: 3000, currency: "EUR" } });
    const stale = facts({ department: "womens", price: { amountMinor: 3000, observedAt: "2026-08-01T00:00:00.000Z" } });
    const missing = facts({ department: "womens", price: null });
    const base = facts({ price: { amountMinor: 4000 } });
    for (const candidate of [euro, stale, missing]) {
      const [match] = findAlternatives(base, [candidate], NOW).alternatives;
      expect(codes(match!, "advantage")).not.toContain("lower_listed_price");
      expect(codes(match!, "uncertainty")).toContain("price_not_comparable");
    }
    expect(comparePrices(base.price, euro.price, NOW).status).toBe("currency_mismatch");
    expect(comparePrices(base.price, stale.price, NOW)).toMatchObject({ status: "stale", differenceMinor: null });
  });

  it("ranks explicit style, then brand, then comparable price, then id", () => {
    const base = facts({ title: "Crewneck Sweater", brand: "Example" });
    const otherBrand = facts({ department: "womens", title: "Crewneck Sweater", brand: "Other" });
    const sameBrandUnknownStyle = facts({ department: "womens", title: "Sweater", brand: "Example" });
    const sameBrandCrew = facts({ department: "womens", title: "Crewneck Sweater", brand: "Example" });
    const noPrice = facts({ department: "unisex", title: "Crewneck Sweater", brand: "Example", price: null });
    const order = findAlternatives(base, [sameBrandUnknownStyle, otherBrand, noPrice, sameBrandCrew], NOW, 4)
      .alternatives.map((item) => item.facts.product.id);
    expect(order).toEqual([
      sameBrandCrew.product.id,
      noPrice.product.id,
      otherBrand.product.id,
      sameBrandUnknownStyle.product.id,
    ]);
  });

  it("returns at most three alternatives", () => {
    const candidates = Array.from({ length: 5 }, () => facts({ department: "womens" }));
    expect(findAlternatives(facts(), candidates, NOW).alternatives).toHaveLength(3);
  });
});

describe("assessSelected and outcomeFor", () => {
  it("reports insufficient information for unknown departments and missing composition", () => {
    expect(assessSelected(facts({ department: "unknown" }))).toBe("unknown_department");
    expect(assessSelected(facts({ components: [] }))).toBe("missing_composition");
    expect(assessSelected(facts({ title: "Slim Jeans", category: "jeans" }))).toBe("unsupported_category");
    expect(outcomeFor("unknown_department", 0)).toBe("insufficient_information");
    expect(outcomeFor("missing_composition", 0)).toBe("insufficient_information");
    expect(outcomeFor("unsupported_category", 0)).toBe("no_suitable_alternative");
    expect(outcomeFor("ready", 0)).toBe("no_suitable_alternative");
    expect(outcomeFor("ready", 2)).toBe("alternatives_found");
  });
});
