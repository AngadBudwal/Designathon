export type RetailerPage = {
  /** Lowercase hostname without a leading "www.". Matches retailers.domain. */
  domain: string;
  /** Submitted URL without tracking parameters, fragment, or trailing slash. */
  canonicalUrl: string;
};

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const NON_PUBLIC_SUFFIXES = ["localhost", "local", "internal", "lan", "home", "arpa", "test", "invalid", "onion"];
const TRACKING_PARAM = /^(utm_[a-z_]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|yclid|srsltid)$/i;

/**
 * Derives the retailer and canonical product URL from the submitted page URL.
 * Parses only; never fetches. Returns null for hosts that cannot be a retailer site.
 */
export function parseRetailerPage(pageUrl: string): RetailerPage | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;

  const host = url.hostname.replace(/\.$/, "");
  if (host.length > 253 || IPV4_PATTERN.test(host) || !DOMAIN_PATTERN.test(host)) return null;
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (NON_PUBLIC_SUFFIXES.includes(tld)) return null;

  url.hostname = host;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }

  const canonicalUrl = url.toString();
  if (canonicalUrl.length > 2048) return null;

  return { domain: host.startsWith("www.") ? host.slice(4) : host, canonicalUrl };
}
