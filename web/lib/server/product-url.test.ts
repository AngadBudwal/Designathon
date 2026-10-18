import { describe, expect, it } from "vitest";

import { parseRetailerPage } from "./product-url";

describe("parseRetailerPage", () => {
  it("derives the retailer domain without www", () => {
    expect(parseRetailerPage("https://www.Shop.Example.com/products/crew")).toEqual({
      domain: "shop.example.com",
      canonicalUrl: "https://www.shop.example.com/products/crew",
    });
  });

  it("removes tracking parameters, fragments, and trailing slashes", () => {
    const page = parseRetailerPage(
      "https://shop.example.com/products/crew/?utm_source=mail&size=M&gclid=abc&color=oat#reviews",
    );
    expect(page?.canonicalUrl).toBe("https://shop.example.com/products/crew?color=oat&size=M");
  });

  it("drops an empty query after removing tracking parameters", () => {
    expect(parseRetailerPage("https://shop.example.com/p/1?utm_campaign=x")?.canonicalUrl).toBe(
      "https://shop.example.com/p/1",
    );
  });

  it.each([
    "http://localhost:3000/products/1",
    "http://127.0.0.1/products/1",
    "http://[::1]/products/1",
    "https://intranet/products/1",
    "https://shop.internal/products/1",
    "https://user:pass@shop.example.com/products/1",
    "ftp://shop.example.com/products/1",
    "not a url",
  ])("rejects %s", (url) => {
    expect(parseRetailerPage(url)).toBeNull();
  });
});
