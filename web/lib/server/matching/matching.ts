import type { ComparisonOutcome, Department, GarmentComponent } from "@/lib/contracts";

import type {
  EvidenceRow,
  MaterialClaimRow,
  PriceObservationRow,
  ProductRow,
  ReasonKind,
} from "../store";
import { claimsByComponent, COMPONENT_LABEL, COMPONENTS, naturalShare, normalizeFiber } from "./fibers";
import { classifyGarment, STYLE_LABEL, type GarmentType } from "./garment";
import { comparePrices, describePrice, formatMoney, type PriceComparison } from "./price";

/** Stored facts about one product: its latest capture's evidence and claims, and latest price. */
export type ProductFacts = {
  product: ProductRow;
  evidence: EvidenceRow[];
  claims: MaterialClaimRow[];
  price: PriceObservationRow | null;
};

export type SelectedAssessment =
  | "ready"
  | "unsupported_category"
  | "unknown_department"
  | "missing_composition";

export type Reason = { kind: ReasonKind; code: string; detail: string };
export type MatchedAlternative = { facts: ProductFacts; reasons: Reason[] };

export type RejectionReason =
  | "same_product"
  | "department"
  | "not_knitwear"
  | "different_style"
  | "missing_metadata"
  | "missing_evidence"
  | "no_shared_component";

export type MatchResult = {
  alternatives: MatchedAlternative[];
  rejected: Array<{ productId: string; reason: RejectionReason }>;
};

export const MAX_ALTERNATIVES = 3;
const DETAIL_LIMIT = 300;

const DEPARTMENT_LABEL: Record<Department, string> = {
  mens: "men's",
  womens: "women's",
  unisex: "unisex",
  unknown: "an unknown department",
};

/** Cross-department search: men's and women's look at the other department and unisex. */
export function candidateDepartments(department: Department): Department[] {
  switch (department) {
    case "mens":
      return ["womens", "unisex"];
    case "womens":
      return ["mens", "unisex"];
    case "unisex":
      return ["mens", "womens", "unisex"];
    case "unknown":
      return [];
  }
}

export function assessSelected(selected: ProductFacts): SelectedAssessment {
  if (!classifyGarment(selected.product).knitwear) return "unsupported_category";
  if (selected.product.department === "unknown") return "unknown_department";
  if (selected.claims.length === 0) return "missing_composition";
  return "ready";
}

export function outcomeFor(assessment: SelectedAssessment, alternatives: number): ComparisonOutcome {
  if (assessment === "unknown_department" || assessment === "missing_composition") {
    return "insufficient_information";
  }
  return assessment === "ready" && alternatives > 0 ? "alternatives_found" : "no_suitable_alternative";
}

function clip(text: string): string {
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT - 1).trimEnd()}…`;
}

const formatNumber = (value: number) => String(Math.round(value * 100) / 100);
const signed = (value: number) => (value > 0 ? `+${formatNumber(value)}` : formatNumber(value));

function sameText(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function sharedComponents(selected: ProductFacts, alternative: ProductFacts): GarmentComponent[] {
  const a = claimsByComponent(selected.claims);
  const b = claimsByComponent(alternative.claims);
  return COMPONENTS.filter((component) => a.has(component) && b.has(component));
}

function rejectionFor(
  selected: ProductFacts,
  selectedType: GarmentType,
  candidate: ProductFacts,
): RejectionReason | null {
  const product = candidate.product;
  if (product.id === selected.product.id) return "same_product";
  if (!candidateDepartments(selected.product.department).includes(product.department)) return "department";
  const type = classifyGarment(product);
  if (!type.knitwear) return "not_knitwear";
  if (selectedType.style && type.style && selectedType.style !== type.style) return "different_style";
  if (!product.title) return "missing_metadata";
  if (candidate.evidence.length === 0 || candidate.claims.length === 0) return "missing_evidence";
  if (sharedComponents(selected, candidate).length === 0) return "no_shared_component";
  return null;
}

function categoryReason(selected: ProductFacts, alternative: ProductFacts): Reason {
  const a = classifyGarment(selected.product);
  const b = classifyGarment(alternative.product);
  const parts: string[] = [];
  if (a.style && b.style) {
    parts.push(`Both are listed as ${STYLE_LABEL[a.style]} knitwear.`);
  } else {
    const missing = !a.style && !b.style ? "either listing" : !a.style ? "the selected listing" : "the alternative";
    parts.push(
      `Both are listed as knitwear (${selected.product.category ?? "knitwear"} and ${alternative.product.category ?? "knitwear"}). ` +
        `The stored title and category do not state a neckline or style for ${missing}, so style compatibility is unverified.`,
    );
  }
  const brandA = selected.product.brand;
  const brandB = alternative.product.brand;
  if (sameText(brandA, brandB)) parts.push(`Both are sold under ${brandB}.`);
  else if (brandA && brandB) parts.push(`Brands differ: ${brandA} and ${brandB}.`);
  return { kind: "explanation", code: "same_category", detail: clip(parts.join(" ")) };
}

function departmentReason(selected: ProductFacts, alternative: ProductFacts): Reason {
  const a = selected.product.department;
  const b = alternative.product.department;
  if (a === b) {
    return { kind: "explanation", code: "same_department", detail: `Both are listed as ${DEPARTMENT_LABEL[a]}.` };
  }
  return {
    kind: "explanation",
    code: "different_department",
    detail: `The selected product is listed in ${DEPARTMENT_LABEL[a]} and the alternative in ${DEPARTMENT_LABEL[b]}.`,
  };
}

function fiberReasons(selected: ProductFacts, alternative: ProductFacts): Reason[] {
  const reasons: Reason[] = [];
  const a = claimsByComponent(selected.claims);
  const b = claimsByComponent(alternative.claims);
  const shared = sharedComponents(selected, alternative);

  const statements: string[] = [];
  for (const component of shared) {
    for (const claimB of b.get(component)!) {
      const claimA = a.get(component)!.find((claim) => normalizeFiber(claim.fiber) === normalizeFiber(claimB.fiber));
      if (!claimA) continue;
      const fiber = normalizeFiber(claimB.fiber);
      if (claimA.percent !== null && claimB.percent !== null) {
        statements.push(
          `${COMPONENT_LABEL[component]}: ${fiber} ${formatNumber(claimB.percent)}% in the alternative vs ` +
            `${formatNumber(claimA.percent)}% in the selected (${signed(claimB.percent - claimA.percent)} percentage points)`,
        );
      } else {
        const side = claimA.percent === null && claimB.percent === null ? "both" : claimA.percent === null ? "the selected" : "the alternative";
        statements.push(`${COMPONENT_LABEL[component]}: ${fiber} listed in both, without a percentage for ${side}`);
      }
    }
  }
  if (statements.length > 0) {
    reasons.push({ kind: "explanation", code: "shared_fiber", detail: clip(`${statements.join("; ")}.`) });
  }

  const primary = shared[0];
  if (primary) {
    const shareA = naturalShare(a.get(primary)!);
    const shareB = naturalShare(b.get(primary)!);
    if (shareA !== null && shareB !== null && shareA !== shareB) {
      const detail = clip(
        `In the ${COMPONENT_LABEL[primary]}, the alternative lists ${formatNumber(shareB)}% natural fiber and the ` +
          `selected lists ${formatNumber(shareA)}% (${signed(shareB - shareA)} percentage points). ` +
          "This compares listed percentages only, not quality or durability.",
      );
      reasons.push(
        shareB > shareA
          ? { kind: "advantage", code: "more_listed_natural_fiber", detail }
          : { kind: "disadvantage", code: "less_listed_natural_fiber", detail },
      );
    }
  }

  const compared = shared.flatMap((component) => [...a.get(component)!, ...b.get(component)!]);
  if (compared.some((claim) => claim.percent === null)) {
    reasons.push({
      kind: "uncertainty",
      code: "missing_fiber_percent",
      detail: "Some compared fibers are listed without a percentage. Their share is unknown and was not treated as zero.",
    });
  }

  const componentsA = COMPONENTS.filter((component) => a.has(component));
  const componentsB = COMPONENTS.filter((component) => b.has(component));
  if (componentsA.join() !== componentsB.join()) {
    const list = (items: GarmentComponent[]) => items.map((item) => COMPONENT_LABEL[item]).join(", ");
    reasons.push({
      kind: "uncertainty",
      code: "different_component_coverage",
      detail: clip(
        `The listings disclose different components (selected: ${list(componentsA)}; alternative: ${list(componentsB)}). ` +
          `Only ${list(shared)} was compared.`,
      ),
    });
  }

  const unverified = [selected, alternative].filter((facts) =>
    facts.claims.some((claim) => claim.verification_status === "extracted"),
  );
  if (unverified.length > 0) {
    reasons.push({
      kind: "uncertainty",
      code: "unverified_composition",
      detail:
        unverified.length === 2
          ? "Both compositions are as listed by the retailer and have not been independently verified."
          : `The ${unverified[0] === selected ? "selected" : "alternative"} composition is as listed by the retailer and has not been independently verified.`,
    });
  }
  return reasons;
}

function priceReasons(selected: ProductFacts, alternative: ProductFacts, comparison: PriceComparison): Reason[] {
  if (comparison.status !== "comparable") {
    return [{ kind: "uncertainty", code: "price_not_comparable", detail: clip(comparison.detail) }];
  }
  const difference = comparison.differenceMinor;
  if (difference === 0) return [];
  const amount = formatMoney(Math.abs(difference), comparison.currency);
  const detail = clip(
    `The alternative is listed at ${describePrice(alternative.price!)}, ${amount} ${difference < 0 ? "lower" : "higher"} ` +
      `than the selected product at ${describePrice(selected.price!)}. Listed prices only; no discount is implied.`,
  );
  return difference < 0
    ? [{ kind: "advantage", code: "lower_listed_price", detail }]
    : [{ kind: "disadvantage", code: "higher_listed_price", detail }];
}

const FIT_UNKNOWN: Reason = {
  kind: "uncertainty",
  code: "fit_unknown",
  detail:
    "No garment measurements are stored for these products. Cross-department fit has not been verified, " +
    "and size labels are not comparable between departments.",
};

export function explainAlternative(selected: ProductFacts, alternative: ProductFacts, now: Date): Reason[] {
  return [
    categoryReason(selected, alternative),
    departmentReason(selected, alternative),
    ...fiberReasons(selected, alternative),
    ...priceReasons(selected, alternative, comparePrices(selected.price, alternative.price, now)),
    FIT_UNKNOWN,
  ];
}

/** Higher is better, compared left to right. Every entry comes from stored listing data. */
function rankKey(selected: ProductFacts, candidate: ProductFacts, now: Date): number[] {
  const a = classifyGarment(selected.product);
  const b = classifyGarment(candidate.product);
  const style = a.style && b.style && a.style === b.style ? 1 : 0;
  const brand = sameText(selected.product.brand, candidate.product.brand) ? 1 : 0;
  const price = comparePrices(selected.price, candidate.price, now).status === "comparable" ? 1 : 0;
  const shared = new Set(sharedComponents(selected, candidate));
  const completeness = [
    candidate.product.brand !== null,
    candidate.product.image_url !== null,
    candidate.price !== null,
    candidate.claims.filter((claim) => shared.has(claim.component)).every((claim) => claim.percent !== null),
  ].filter(Boolean).length;
  const recency = Math.max(
    0,
    ...candidate.evidence.map((item) => new Date(item.captured_at).getTime()),
    candidate.price ? new Date(candidate.price.observed_at).getTime() : 0,
  );
  return [style, brand, price, completeness, recency];
}

function compareKeys(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

/**
 * Filters stored candidates to comparable knitwear in another department, ranks them,
 * and explains the top results. Pure and deterministic for a given `now`.
 */
export function findAlternatives(
  selected: ProductFacts,
  candidates: ProductFacts[],
  now: Date,
  limit = MAX_ALTERNATIVES,
): MatchResult {
  const selectedType = classifyGarment(selected.product);
  const rejected: MatchResult["rejected"] = [];
  const eligible: Array<{ facts: ProductFacts; key: number[] }> = [];

  for (const candidate of candidates) {
    const reason = rejectionFor(selected, selectedType, candidate);
    if (reason) rejected.push({ productId: candidate.product.id, reason });
    else eligible.push({ facts: candidate, key: rankKey(selected, candidate, now) });
  }

  eligible.sort(
    (a, b) => compareKeys(a.key, b.key) || a.facts.product.id.localeCompare(b.facts.product.id),
  );

  return {
    alternatives: eligible.slice(0, limit).map(({ facts }) => ({
      facts,
      reasons: explainAlternative(selected, facts, now),
    })),
    rejected,
  };
}
