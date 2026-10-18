import type { PriceObservationRow } from "../store";

/** Prices observed longer ago than this, relative to processing time, are not treated as current. */
export const STALE_PRICE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PriceComparison =
  | { status: "comparable"; differenceMinor: number; currency: string }
  | { status: "missing" | "currency_mismatch" | "stale"; differenceMinor: null; detail: string };

function fractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "USD 34.99" from integer minor units. */
export function formatMoney(amountMinor: number, currency: string): string {
  const digits = fractionDigits(currency);
  return `${currency} ${(amountMinor / 10 ** digits).toFixed(digits)}`;
}

export const formatDate = (timestamp: string) => new Date(timestamp).toISOString().slice(0, 10);

export function describePrice(price: PriceObservationRow): string {
  return `${formatMoney(price.listed_amount_minor, price.currency)} (observed ${formatDate(price.observed_at)})`;
}

function ageInDays(price: PriceObservationRow, now: Date): number {
  return (now.getTime() - new Date(price.observed_at).getTime()) / DAY_MS;
}

/**
 * Compares listed prices only (never regular prices), alternative minus selected.
 * Arithmetic needs both prices, one currency, and observations no older than STALE_PRICE_DAYS.
 */
export function comparePrices(
  selected: PriceObservationRow | null,
  alternative: PriceObservationRow | null,
  now: Date,
): PriceComparison {
  if (!selected || !alternative) {
    const missing = !selected && !alternative ? "Neither product" : !selected ? "The selected product" : "The alternative";
    return {
      status: "missing",
      differenceMinor: null,
      detail: `${missing} has no stored listed price, so prices were not compared.`,
    };
  }
  if (selected.currency !== alternative.currency) {
    return {
      status: "currency_mismatch",
      differenceMinor: null,
      detail: `Prices are listed in different currencies (${selected.currency} and ${alternative.currency}) and were not converted.`,
    };
  }
  const observations: Array<[string, PriceObservationRow]> = [
    ["selected", selected],
    ["alternative", alternative],
  ];
  const stale = observations.filter(([, price]) => ageInDays(price, now) > STALE_PRICE_DAYS);
  if (stale.length > 0) {
    const which = stale.map(([name, price]) => `the ${name} price was observed ${formatDate(price.observed_at)}`);
    return {
      status: "stale",
      differenceMinor: null,
      detail: `Prices may not be current: ${which.join(" and ")}, more than ${STALE_PRICE_DAYS} days before this comparison.`,
    };
  }
  return {
    status: "comparable",
    differenceMinor: alternative.listed_amount_minor - selected.listed_amount_minor,
    currency: selected.currency,
  };
}
