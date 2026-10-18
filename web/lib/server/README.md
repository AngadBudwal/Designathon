# Backend server code

This code runs on the server only. Route handlers in `app/api/` call these modules. Nothing here may be imported from client components. `supabase.ts`, `supabase-store.ts`, and `deps.ts` import `server-only`, so importing them from client code fails the build.

| File | Purpose |
|---|---|
| `env.ts` | Reads server environment variables. Errors name the missing variable, never its value. |
| `supabase.ts` | Supabase client using the secret key, with no session persistence and a 10 s request timeout. |
| `store.ts` | `AnalysisStore` interface and row types, using the migration's table and column names. |
| `supabase-store.ts` | `AnalysisStore` backed by Supabase. |
| `ingest.ts` | Stores one extension capture and creates a pending analysis. |
| `read-analysis.ts` | Builds a `FullAnalysisResponse` from stored rows and validates it. Read-only. |
| `catalog.ts` | Loads the selected capture, and each catalog product's latest capture and price at a cutoff time. |
| `process-analysis.ts` | Runs matching for a pending analysis, stores comparables and reasons, then completes it. |
| `matching/` | Pure, deterministic matching: garment type (`garment.ts`), fiber names (`fibers.ts`), prices (`price.ts`), eligibility, ranking, and reasons (`matching.ts`). |
| `request-guard.ts` | Local-development write guard, size-limited JSON body reader. |
| `product-url.ts` | Retailer domain and canonical URL from the submitted page URL. Never fetches it. |
| `analyses-handlers.ts` | Request handling for both endpoints, with injectable dependencies for tests. |
| `testing/` | In-memory store, synthetic catalog seeding, and request helpers for unit tests. |
| `integration/` | Live test against a local dev server and the real seed catalog. Skipped unless `INTEGRATION_BASE_URL` is set. |

## Local setup

1. Copy `web/.env.example` to `web/.env.local`. Fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from the Supabase dashboard (Project Settings → API Keys). Set `ENABLE_DEV_ANALYSIS_WRITE=true` to accept writes.
2. Start the dev server bound to loopback, so other machines on the network cannot reach it:

   ```sh
   npm run dev -- --hostname 127.0.0.1
   ```

`.env.local` is git-ignored. Never commit it, paste it, or log its values.

## Endpoints

### `POST /api/analyses`

Accepts an `AnalysisRequestSchema` body from the extension and returns an `AnalysisCreatedResponse` with status `201`, for example:

```json
{
  "analysisId": "…",
  "pageUrl": "http://localhost:3000/analyses/…",
  "processingStatus": "pending",
  "outcome": null
}
```

The analysis stays `pending` until `POST /api/analyses/:id/process` is called.

Processing order:

1. **Write guard.** All of these must hold, or the response is `403 forbidden`:
   - `NODE_ENV` is not `production`.
   - `ENABLE_DEV_ANALYSIS_WRITE` is exactly `true`.
   - `APP_BASE_URL` is a loopback address.
   - The `Host` header is a loopback host on the same port as `APP_BASE_URL`.
   - `Origin`, if sent, is a `chrome-extension://` origin or that same local origin.
2. **Body.** `Content-Type` must be `application/json` (otherwise `415`). The body is read up to 64 KB, even if `Content-Length` is missing or wrong (otherwise `413`).
3. **Validation.** The body is parsed with `AnalysisRequestSchema` (otherwise `400 validation_error` with field paths). Further rules, also `400`:
   - No fiber may repeat within a composition block.
   - At most 40 fibers in total, the response contract's limit.
   - A regular price must use the listed price's currency.
4. **Retailer.**
   - The retailer is the page hostname, lowercased and without a leading `www.`.
   - IP addresses, `localhost`, single-label hosts, internal suffixes, and URLs containing credentials are rejected with `422 unsupported_page`.
   - The URL is never fetched.
5. **Product.**
   - Matched by `(retailer, retailerProductId)`, then by `(retailer, canonical URL)`. The canonical URL drops tracking parameters, the fragment, and any trailing slash.
   - A new listing creates a product. An existing product only has empty fields filled in. Existing values are never overwritten, and a known department never changes.
   - `variantLabel` becomes a `product_variants` row with `description` set. The label might not be a color, so `color` stays empty.
6. **Evidence and claims.**
   - Each composition excerpt becomes a `product_evidence` row (`extension_capture`, canonical URL, `capturedAt`, `extractorVersion`).
   - Each fiber becomes a `material_claims` row with `verification_status = 'extracted'`, citing the first excerpt of its block. The same product id is written on the claim and its evidence, so the composite foreign key also enforces ownership in the database.
   - A fiber with no percentage is stored with `percent` null. Measurements are not captured, and nothing is inferred.
7. **Price.** `listedPrice` and `regularPrice` become one `price_observations` row in integer minor units, observed at `capturedAt`. Each new capture adds a row, and existing rows are never updated. A request with only a regular price stores no price row, because the schema requires a listed price.
8. **Analysis.** An `analyses` row is created with status `pending`, the validated request in `request_payload`, and the selected product and variant.

Duplicate submissions:
- A capture is identified by the product, `capturedAt`, and `extractorVersion`. Resending the same capture creates a new analysis but reuses the stored evidence and price.
- A capture with a new `capturedAt` adds new evidence and a new price observation.

Partial failure:
- Supabase's HTTP API cannot run several table writes in one transaction.
- If a step fails, the rows this request created are deleted in reverse order, best effort, and the error is returned.
- Fields filled in on a pre-existing product are not reverted.
- Running the whole ingestion in a single transaction (a database function) is **required before public deployment**. Until then, a crash mid-request can leave orphaned rows.

### `POST /api/analyses/:id/process`

Local development only, behind the same write guard as `POST /api/analyses` (`403 forbidden` otherwise). No request body. Returns `200` with the `FullAnalysisResponse`, identical to the following GET.

Nothing runs this automatically. There is no background worker or queue: the website, or another orchestration layer, must call it after creating an analysis.

Lifecycle:

1. Load the analysis. Unknown id → `404 not_found`. If it is no longer `pending`, return it unchanged, with no writes.
2. Assess the selected product from the capture that created the analysis (see "Matching" below).
3. If the product is knitwear in men's, women's, or unisex, with captured composition, load candidates from the catalog and match them.
4. Delete any comparables left by an earlier failed attempt, insert the accepted comparables one at a time in rank order, then insert their reasons.
5. Set `processing_status = 'completed'`, the `outcome`, and `finished_at`, with a conditional update that only applies while the row is still `pending`.

The analysis is completed only after its comparables are stored. If any step fails, it stays `pending`, the error is returned (`500` or `503`), and calling the endpoint again redoes the work without duplicating rows. The `(analysis_id, product_id)` primary key and the reason unique key also reject duplicates. `failed` is never set: every failure here is retryable.

Outcomes:

| Outcome | When |
|---|---|
| `alternatives_found` | At least one catalog product passed every eligibility rule. |
| `no_suitable_alternative` | Nothing in the current catalog passed, or the product is not knitwear (the only category supported). The warning says only stored products were searched. |
| `insufficient_information` | The department is unknown, no composition was captured, or there is no selected product. No search is run. |

### Matching

Pure and deterministic for a given processing time (`matching/matching.ts`). It reads only stored rows. It never fetches retailer pages, uses images, or invents values.

Each catalog product contributes its latest capture (all its evidence with the newest `captured_at`, and those claims) and its latest price observation, both at or before processing time. The selected product contributes the capture that created the analysis.

Eligibility, all required:

- A different product.
- Department: men's looks in women's and unisex, women's in men's and unisex, unisex in all three. Unknown is never searched.
- Knitwear, from the stored category (or the title when there is no category): sweater, jumper, pullover, knit, cardigan, turtleneck.
- Style: cardigan, hoodie, half-zip, turtleneck, mock neck, knit polo, V-neck, and crewneck are only detected from the category and title text. Two different detected styles are never matched. When either style is unknown, the product is matched as general knitwear and the explanation says style compatibility is unverified.
- A title, evidence, and at least one composition claim.
- At least one composition component in common with the selected product. Shell, lining, trim, and unlabeled (`other`) are compared only with the same component.

Ranking, compared in order, with ties broken by product id. At most 3 alternatives.

1. Same detected style.
2. Same brand.
3. Prices comparable (both present, same currency, not stale).
4. Completeness: brand, image, price, and percentages for every compared fiber.
5. Most recent evidence or price.

Shopper material preferences are not ranked: the request contract has no field for them. The schema has no silhouette or neckline column, so style comes only from category and title text.

Reasons stored per alternative, each code at most once:

- `same_category`: the knitwear and style statement, plus brand.
- `same_department` or `different_department`.
- `shared_fiber`: per component, each fiber listed by both, with both percentages and the difference in percentage points (alternative minus selected). Fibers without a percentage are named as such and never treated as zero. Fiber names are normalized (for example spandex → elastane, polyamide → nylon) only to find the same fiber.
- `more_listed_natural_fiber` / `less_listed_natural_fiber`: the listed natural-fiber share of the first shared component, in percentage points. Only when both sides list every percentage, every fiber is classified, and each totals 100. It is not a quality or durability claim, and the text says so.
- `lower_listed_price` / `higher_listed_price`: listed prices only, alternative minus selected, same currency, both observed within 30 days of processing. No claim when the prices are equal. Regular prices are never compared, and no discount is implied.
- Uncertainties: `missing_fiber_percent`, `different_component_coverage`, `unverified_composition`, `price_not_comparable` (missing, different currencies, or stale, with dates), and always `fit_unknown`. No measurements are stored, and size labels are never treated as equivalent across departments.

No GSM, staple length, pilling, thickness, durability, or overall quality score is computed.

### `GET /api/analyses/:id`

Returns a `FullAnalysisResponse`, validated with `FullAnalysisResponseSchema` before it is sent. The response is built from live data on every request (`Cache-Control: no-store`), never at build time. It never writes.

- `product` is the selected product, and `variantLabel` comes from its variant.
- `evidence`, `composition`, and `price` come from the capture that created this analysis, not from later captures of the same product.
- Composition is ordered by component (shell, lining, trim, other), then by highest percentage, then by fiber name.
- `processingStatus` and `outcome` are read from the database.
- `alternatives` is filled only for `completed` analyses with `alternatives_found`, in stored rank order. Each one has its product, its latest capture's composition and its latest price at or before `finished_at`, and its stored reasons, ordered by code within each kind. Its cited evidence is added to the top-level `evidence` after the selected product's.
- `priceDifference` is alternative minus selected whenever both listed prices share a currency, as contract 3.0.0 requires, even when a price is stale. In that case there is no price advantage or disadvantage, and `price_not_comparable` explains why.
- `fit` is always `unavailable`.
- `warnings` flag missing or partial composition, unverified composition, missing prices, and missing measurements. Completed analyses add `not_a_quality_or_durability_score`, `no_suitable_alternative` (current catalog only), or `insufficient_information` with the reason.
- `product` is the captured product while pending too. The contracts README notes that clients must also handle `null`.

Errors:

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` | The id is not a UUID. |
| 404 | `not_found` | No analysis has that id. |
| 500 | `internal_error` | Database error, or stored data that cannot form a valid contract response. |
| 503 | `service_unavailable` | Database unreachable, or server configuration missing. |

All error codes as implemented:

| Status | Code | Endpoints |
|---|---|---|
| 400 | `validation_error` | All. Invalid body, or an id that is not a UUID. |
| 403 | `forbidden` | Both POST endpoints. Writes disabled, or the request failed the local guard. |
| 404 | `not_found` | GET and process. |
| 413 | `validation_error` | `POST /api/analyses`. Body over 64 KB. |
| 415 | `validation_error` | `POST /api/analyses`. Not JSON. |
| 422 | `unsupported_page` | `POST /api/analyses`. Not a public retailer URL. |
| 500 | `internal_error` | All. Database error or stored data that cannot form a valid contract response. |
| 503 | `service_unavailable` | All. Database unreachable or configuration missing. |

## Catalog import (development only)

Matching only searches products already in the database. `web/scripts/import-catalog.mjs` loads a small, manually reviewed JSON file from `supabase/seed/` as `manual_review` evidence with `extracted` claims and one price observation per product. It refuses to run in production or unless `ENABLE_DEV_ANALYSIS_WRITE=true`, and it is safe to re-run.

```sh
node --env-file=.env.local scripts/import-catalog.mjs ../supabase/seed/hm-knitwear-2026-10-18.json
```

`supabase/seed/hm-knitwear-2026-10-18.json` holds three real H&M US listings, copied by hand from their public pages, with provenance notes. It is not a crawler. Synthetic test data lives only in the tests and the contract fixtures.

To run the live integration test, start the dev server on `127.0.0.1`, import the seed, then:

```sh
INTEGRATION_BASE_URL=http://localhost:3000 npx vitest run lib/server/integration
```

Each run creates one more analysis for the same capture.

### Errors and logging

- Error bodies use the `ErrorResponseSchema` shape: `{ error: { code, message, fields? } }`.
- `forbidden`, `internal_error`, and `service_unavailable` are server-only codes, not yet in contract 3.0.0. Adding them to `ErrorCodeSchema` would be a contract change.
- Messages are generic. They never include database errors, SQL state, URLs, environment variable names, or keys.
- Server logs record an event name plus the failure kind, SQL state, or the missing variable's name. They never record values.
- No CORS headers are sent, so other websites cannot read the responses. A Chrome extension with host permission for the local server can still call the API.

## Before public deployment

Writes are disabled when `NODE_ENV=production`, and must stay that way until all of the following exist:

- Authentication for the extension and the website, such as signed extension tokens or user sessions, instead of the local-only guard.
- Rate limiting and abuse controls on `POST /api/analyses` and `POST /api/analyses/:id/process`.
- An explicit allowlist of extension origins.
- Atomic ingestion and processing, each in one database transaction.
- A decision on whether `GET /api/analyses/:id` needs authorization. Today it has no authentication: anyone who has an analysis UUID can read it.

## Known limitations

- Knitwear only. Style is detected from category and title text; there is no neckline or silhouette column, so most matches say style compatibility is unverified.
- Shopper material preferences are not part of the request contract, so they are not ranked.
- Candidates are capped at 100 per search and evidence, claims, and price reads at 1,000 rows. The catalog is small for now.
- The selected product's price staleness is measured against processing time, so an old capture can produce `price_not_comparable`.
- An alternative shown by GET uses its latest capture at or before `finished_at`. A capture imported later with an earlier `captured_at` would change what GET shows.
- `failed` is never set; failures leave the analysis `pending` for a retry.

The `Host` and `Origin` checks stop browser-based cross-site requests and DNS-rebinding requests. They are not authentication: any client that can reach the port can set those headers. Binding the dev server to `127.0.0.1` is part of the boundary.

## Tests

`npm test` covers all of this with an in-memory store that enforces the schema's uniqueness, ownership, and cascade rules. The tests make no network calls and need no credentials. The secret-shaped strings in the tests are fake.
