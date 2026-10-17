# Shared API contracts

Version: `3.0.0` (`CONTRACT_VERSION` in `web/lib/contracts/common.ts`).

These Zod schemas are the interface between the Chrome extension, the backend, and the website. They do not call a database or an AI service. Website code can import them from `@/lib/contracts`. There is no `server-only` dependency.

Bump `CONTRACT_VERSION` and add a note under Changelog when a field or status changes.

## Status and outcome

An analysis has two separate fields.

`processingStatus` is the lifecycle of the job:

| Value | Meaning |
|---|---|
| `pending` | Accepted. Processing has not finished. |
| `completed` | Processing finished. `outcome` is set. |
| `failed` | Processing stopped. `failure` holds a generic, client-safe message. |

`outcome` is the result. It is `null` while `pending` and when `failed`.

| Value | Meaning |
|---|---|
| `alternatives_found` | One or more comparable products. Each has its own advantages, disadvantages, and uncertainties. |
| `no_suitable_alternative` | Comparison ran. `alternatives` is empty. |
| `insufficient_information` | The page did not include enough composition or price information to compare. |
| `unsupported_page` | The page is not a supported product page. `product` is `null`. |

No outcome ranks garments or scores durability or quality. Extra fields such as `gsm`, `durabilityScore`, or `stack` are rejected.

## Trust boundary

Everything the extension sends is untrusted.

- The request has no verification field. Strict objects reject `verification`, `verified`, or any other unknown key at every level.
- The backend stores extension composition as `extracted`. Only backend processing may later produce `verified`, and a verified claim must still reference stored evidence by id.
- Text fields are trimmed, length-limited, and rejected if they contain HTML tags. Send page text, not markup. A plain `<` such as `<5% elastane` is allowed.
- `brand`, `imageUrl`, `retailerProductId`, and `variantLabel` are extracted page values, not verified facts. The backend does not download or cache images.
- The synthetic fixtures contain no `verified` claims.

## Request: extension payload

Schema: `AnalysisRequestSchema` in `web/lib/contracts/analysis-request.ts`.

| Field | Required | Empty value | Notes |
|---|---|---|---|
| `pageUrl` | yes | — | Retailer page. Absolute `http` or `https`, max 2048 characters. |
| `capturedAt` | yes | — | ISO-8601 with `Z` or a numeric offset. |
| `extractorVersion` | yes | — | Letters, numbers, `.`, `_`, `-`. Max 40 characters. |
| `title` | no | `null` or omit | Max 300 characters. |
| `brand` | no | `null` or omit | Max 120 characters. |
| `imageUrl` | no | `null` or omit | Absolute `http` or `https` image URL shown on the page. Not fetched by the backend. |
| `retailerProductId` | no | `null` or omit | Retailer's own product id or SKU, if shown. Max 120 characters. |
| `variantLabel` | no | `null` or omit | Color or variant shown on the page, such as `Oat`. Max 120 characters. |
| `department` | yes | `unknown` | `womens`, `mens`, `unisex`, or `unknown`. Do not guess. |
| `category` | no | `null` or omit | Max 120 characters. |
| `listedPrice` | no | `null` or omit | Integer minor units plus a 3-letter currency. `8900` USD is $89.00. |
| `regularPrice` | no | `null` or omit | Only when the page lists one. Null does not mean "no discount". |
| `composition` | no | `null`, `[]`, or omit | Up to 8 blocks. |

Each composition block:

| Field | Notes |
|---|---|
| `component` | Required: `shell`, `lining`, `trim`, or `other`. Fibers stay attached to this component. |
| `rawText` | Composition text from the page. Max 2000 characters. |
| `fibers` | Up to 20 `{ name, percent }`. `percent` is `null` when the page gave no number. Values are 0–100 and do not have to total 100. |
| `excerpts` | One to five `{ text }` quotes, max 500 characters each. |

## Response: analysis created

Schema: `AnalysisCreatedResponseSchema`.

| Field | Notes |
|---|---|
| `analysisId` | UUID. |
| `pageUrl` | Absolute website URL for this analysis. Not the retailer URL. |
| `processingStatus` | Normally `pending`. |
| `outcome` | `null` unless `processingStatus` is `completed`. |

## Response: full analysis

Schema: `FullAnalysisResponseSchema`.

| Field | Empty value | Notes |
|---|---|---|
| `analysisId` | — | UUID. |
| `processingStatus` | — | See above. |
| `outcome` | `null` | See above. |
| `submittedPageUrl` | — | The retailer URL the extension sent. Always present. |
| `product` | `null` | See "Product summary" below. Required for `alternatives_found` and `no_suitable_alternative`. `null` for pending, failed, and unsupported pages. |
| `price.listed` | `null` | No listed price was on the page. |
| `price.regular` | `null` | No regular price was listed. Do not render a discount. |
| `price.observedAt` | `null` | When the price fields were read. |
| `composition` | `[]` | `{ id, component, fiber, percent, rawText, verification, evidenceIds }`. |
| `evidence` | `[]` | `{ id, productId, sourceUrl, excerpt, observedAt }` for the selected product and every alternative. See "Evidence ownership". |
| `alternatives` | `[]` | Only non-empty when `outcome` is `alternatives_found`. |
| `fit` | `availability: "unavailable"`, `measurements: []` | See "Fit" below. |
| `warnings` | `[]` | `{ code, message }`. |
| `failure` | `null` | `{ code: "processing_failed", message }` only when `failed`. |

Each alternative has:

- `product`, `price`, `composition`, and `fit`, in the same shapes as the selected product.
- `explanations`: why it was compared (`same_category`, `shared_fiber`, `same_department`, `different_department`). At least one.
- `advantages`: `lower_listed_price`, `more_listed_natural_fiber`.
- `disadvantages`: `higher_listed_price`, `less_listed_natural_fiber`.
- `uncertainties`: `missing_fiber_percent`, `unverified_composition`, `different_component_coverage`, `price_not_comparable`, `fit_unknown`.
- `priceDifference`: alternative listed price minus selected listed price, in minor units. Negative means the alternative is listed lower. `null` when either listed price is missing or the currencies differ. The schema checks the arithmetic, and `lower_listed_price` / `higher_listed_price` must match its sign.

`advantages`, `disadvantages`, and `uncertainties` may each be empty. "Natural fiber" compares listed percentages only. It is not a durability or quality score.

### Product summary

The selected product and every alternative use the same shape.

| Field | Empty value | Notes |
|---|---|---|
| `id` | — | Backend-assigned UUID. Unique within an analysis. |
| `title` | `null` | Max 300 characters. |
| `brand` | `null` | Max 120 characters. |
| `pageUrl` | — | Retailer product page. |
| `imageUrl` | `null` | Image URL from the page. Not downloaded or cached. Show a placeholder when `null`. |
| `retailerProductId` | `null` | Retailer's own id or SKU. |
| `variantLabel` | `null` | Color or variant, such as `Oat`. |
| `department` | — | `unknown` when the page did not say. |
| `category` | `null` | Max 120 characters. |

### Evidence ownership

Each evidence item has a `productId`. A material claim may only cite evidence whose `productId` is the product that claim describes: the selected `product.id` for top-level `composition`, or that alternative's `product.id`. The schema also rejects evidence for a product that is not in the analysis, and duplicate product ids. This matches a future `evidence.product_id` foreign key.

### Fit

`fit` is `{ availability, measurements }`. Each measurement is:

| Field | Notes |
|---|---|
| `name` | Such as `chest` or `length`. |
| `value` | Positive number. Never zero or a placeholder. |
| `unit` | `cm` or `in`. |
| `sizeLabel` | Retailer size label, such as `M` or `8`, or `null` if the page did not tie the measurement to a size. |
| `basis` | `garment_flat`, `garment_circumference`, `body`, or `unknown`. Use `unknown` when the page did not say. |

- Only measurements listed on the page appear. Unknown measurements are omitted.
- `availability: "unavailable"` must have no measurements. `listed` must have at least one.
- Size labels are retailer strings. A women's `M` and a men's `M` are not the same size, and the contract has no size-conversion field. Compare fit only through listed measurements with the same `basis` and `unit`.

## Error

Schema: `ErrorResponseSchema` in `web/lib/contracts/error.ts`.

```json
{
  "error": {
    "code": "validation_error",
    "message": "The request is invalid.",
    "fields": [{ "path": "pageUrl", "code": "invalid_format", "message": "Invalid URL" }]
  }
}
```

`code` is `validation_error`, `unsupported_page`, `not_found`, or `insufficient_information`. `fields` is optional. Never include stack traces, credentials, environment variables, or database errors. `zodErrorToErrorResponse` maps a Zod error into this shape.

## Chrome extension integration

The extension lives in `extension/` and is not part of the Next.js build, so it cannot import `@/lib/contracts`. It sends and receives plain JSON in the shapes above. Use the fixtures as the reference. Do not add a shared package for this yet.

The routes below are not implemented yet. This is the agreed flow:

1. The extension builds a JSON body matching `lib/contracts/fixtures/extension-request.json` → `data`, and sends it:

   ```js
   const response = await fetch(`${WEB_ORIGIN}/api/analyses`, {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify(payload),
   });
   ```

   `WEB_ORIGIN` is the website origin, such as `http://localhost:3000` during development.

2. The backend runs `AnalysisRequestSchema.safeParse(body)`. On failure it returns an `ErrorResponse` with `code: "validation_error"` and field paths. On success it stores the composition as `extracted` claims.

3. The backend returns an `AnalysisCreatedResponse`, for example `lib/contracts/fixtures/analysis-created.json` → `data`.

4. The extension opens `pageUrl` in a new tab:

   ```js
   const created = await response.json();
   if (new URL(created.pageUrl).origin === WEB_ORIGIN) {
     chrome.tabs.create({ url: created.pageUrl });
   }
   ```

   Only open URLs on the website origin.

5. The website page loads `GET /api/analyses/:id`, runs `FullAnalysisResponseSchema.parse`, and renders by `processingStatus` and then `outcome`. While `pending`, it can poll the same URL.

## Fixtures

Paths are relative to `web/`. Each file is wrapped:

```json
{ "synthetic": true, "disclaimer": "Synthetic fixture ...", "data": {} }
```

Use `data`, not the wrapper. All products, brands, images, and retailer ids are fictional and use `example.com`. The image URLs do not resolve.

| File | Shape | Scenario |
|---|---|---|
| `lib/contracts/fixtures/extension-request.json` | Request | Sweater with brand, image, retailer id, variant, shell, and lining |
| `lib/contracts/fixtures/analysis-created.json` | Created | `pending` |
| `lib/contracts/fixtures/analysis-pending.json` | Full | `pending`, no product yet |
| `lib/contracts/fixtures/analysis-alternatives-found.json` | Full | Two alternatives with different advantages and uncertainties. One lists a size-M flat chest measurement; one has no image, retailer id, or variant. |
| `lib/contracts/fixtures/analysis-no-alternative.json` | Full | `completed`, `no_suitable_alternative` |
| `lib/contracts/fixtures/analysis-insufficient.json` | Full | `completed`, `insufficient_information` |
| `lib/contracts/fixtures/analysis-unsupported.json` | Full | `completed`, `unsupported_page`, `product: null` |
| `lib/contracts/fixtures/analysis-failed.json` | Full | `failed` with a generic message |

## Website usage

```ts
import { FullAnalysisResponseSchema, type FullAnalysisResponse } from "@/lib/contracts";
import fixture from "@/lib/contracts/fixtures/analysis-alternatives-found.json";

const analysis: FullAnalysisResponse = FullAnalysisResponseSchema.parse(fixture.data);
```

Use the same `parse` call on a future `GET /api/analyses/:id` body. When mocking, show the fixture's `synthetic` label in the UI.

## Changelog

- `3.0.0` — Breaking. Product summaries now require `id`, `brand`, `imageUrl`, `retailerProductId`, and `variantLabel` (nullable except `id`). Evidence now requires `productId`, and claims may only cite their own product's evidence. Measurements now require `sizeLabel` (nullable) and `basis`. The request accepts optional `brand`, `imageUrl`, `retailerProductId`, and `variantLabel`.
- `2.0.0` — Split `status` into `processingStatus` and `outcome`. Added `failed` with a client-safe `failure`. Replaced per-alternative `tradeoffs` with `advantages`, `disadvantages`, and `uncertainties`. Added `submittedPageUrl` and made `product` nullable. Rejected HTML in request text. Replaced the `analysis-with-alternative` and `analysis-alternative-found` fixtures with `analysis-alternatives-found`, and added `analysis-pending` and `analysis-failed`.
- `1.0.0` — Initial request, created response, full analysis, and error contracts.
