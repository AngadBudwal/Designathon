import type { ProductRow } from "../store";

export type GarmentStyle =
  | "cardigan"
  | "hoodie"
  | "half_zip"
  | "turtleneck"
  | "mock_neck"
  | "polo"
  | "v_neck"
  | "crewneck";

export const STYLE_LABEL: Record<GarmentStyle, string> = {
  cardigan: "cardigan",
  hoodie: "hoodie",
  half_zip: "half-zip",
  turtleneck: "turtleneck",
  mock_neck: "mock neck",
  polo: "knit polo",
  v_neck: "V-neck",
  crewneck: "crewneck",
};

const KNITWEAR = /\b(sweaters?|jumpers?|pullovers?|knitwear|knits?|cardigans?|turtlenecks?)\b/;

/** Checked in order: "polo neck" is a turtleneck, so it is matched before "polo". */
const STYLE_PATTERNS: Array<[GarmentStyle, RegExp]> = [
  ["cardigan", /\bcardigans?\b/],
  ["hoodie", /\bhood(ie|ed|y)?s?\b/],
  ["half_zip", /\b(half|quarter|1\/4|1\/2)[- ]?zip\b/],
  ["turtleneck", /\b(turtle|roll|polo)[- ]?necks?\b/],
  ["mock_neck", /\bmock[- ]?necks?\b/],
  ["polo", /\bpolos?\b/],
  ["v_neck", /\bv[- ]?necks?\b/],
  ["crewneck", /\b(crew[- ]?necks?|crew|round[- ]?necks?)\b/],
];

export type GarmentType = { knitwear: boolean; style: GarmentStyle | null };

/**
 * Garment type from the stored category and title text only. Never inferred from images.
 * Style is null when the text does not state one.
 */
export function classifyGarment(product: Pick<ProductRow, "category" | "title">): GarmentType {
  const category = (product.category ?? "").toLowerCase();
  const title = (product.title ?? "").toLowerCase();
  const knitwear = KNITWEAR.test(category) || (!category && KNITWEAR.test(title));
  const text = `${category} ${title}`;
  const style = STYLE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
  return { knitwear, style };
}
