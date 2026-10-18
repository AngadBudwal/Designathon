import type { GarmentComponent } from "@/lib/contracts";

import type { MaterialClaimRow } from "../store";

export type FiberOrigin = "natural" | "regenerated" | "synthetic";

const SYNONYMS: Record<string, string> = {
  spandex: "elastane",
  lycra: "elastane",
  polyamide: "nylon",
  rayon: "viscose",
  merino: "merino wool",
  "lambs wool": "lambswool",
  "lamb's wool": "lambswool",
  "camel hair": "camel",
  flax: "linen",
  tencel: "lyocell",
};

const ORIGINS: Record<string, FiberOrigin> = {
  wool: "natural",
  "merino wool": "natural",
  lambswool: "natural",
  cashmere: "natural",
  alpaca: "natural",
  mohair: "natural",
  camel: "natural",
  yak: "natural",
  angora: "natural",
  silk: "natural",
  cotton: "natural",
  linen: "natural",
  hemp: "natural",
  ramie: "natural",
  viscose: "regenerated",
  modal: "regenerated",
  lyocell: "regenerated",
  cupro: "regenerated",
  acetate: "regenerated",
  polyester: "synthetic",
  nylon: "synthetic",
  acrylic: "synthetic",
  elastane: "synthetic",
  polypropylene: "synthetic",
  metallic: "synthetic",
};

/** Lowercase name without "recycled"/"organic" qualifiers, with common synonyms merged. */
export function normalizeFiber(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/\b(recycled|organic)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return SYNONYMS[base] ?? base;
}

export function fiberOrigin(name: string): FiberOrigin | null {
  return ORIGINS[normalizeFiber(name)] ?? null;
}

export const COMPONENTS: GarmentComponent[] = ["shell", "other", "lining", "trim"];

export const COMPONENT_LABEL: Record<GarmentComponent, string> = {
  shell: "shell",
  other: "unlabeled composition",
  lining: "lining",
  trim: "trim",
};

export function claimsByComponent(claims: MaterialClaimRow[]) {
  const grouped = new Map<GarmentComponent, MaterialClaimRow[]>();
  for (const claim of claims) {
    grouped.set(claim.component, [...(grouped.get(claim.component) ?? []), claim]);
  }
  return grouped;
}

/**
 * Listed natural-fiber percentage for one component, or null when it cannot be computed
 * honestly: a percentage is missing, a fiber is unclassified, or percentages do not total 100.
 * Missing percentages are never treated as zero.
 */
export function naturalShare(claims: MaterialClaimRow[]): number | null {
  if (claims.length === 0) return null;
  let total = 0;
  let natural = 0;
  for (const claim of claims) {
    const origin = fiberOrigin(claim.fiber);
    if (claim.percent === null || origin === null) return null;
    total += claim.percent;
    if (origin === "natural") natural += claim.percent;
  }
  return Math.abs(total - 100) <= 0.5 ? Math.round(natural * 100) / 100 : null;
}
