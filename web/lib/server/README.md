# Backend server code

This code runs on the server only. Route handlers in `app/api/` call these modules. Nothing here may be imported from client components. `supabase.ts`, `supabase-store.ts`, and `deps.ts` import `server-only`, so importing them from client code fails the build.

| File | Purpose |
|---|---|
| `env.ts` | Reads server environment variables. Errors name the missing variable, never its value. |
| `supabase.ts` | Supabase client using the secret key, with no session persistence and a 10 s request timeout. |
| `store.ts` | `AnalysisStore` interface and row types, using the migration's table and column names. |
| `supabase-store.ts` | `AnalysisStore` backed by Supabase. |
| `ingest.ts` | Stores one extension capture and creates a pending analysis. |
| `read-analysis.ts` | Builds a `FullAnalysisResponse` from stored rows and validates it. |
| `request-guard.ts` | Local-development write guard, size-limited JSON body reader. |
| `product-url.ts` | Retailer domain and canonical URL from the submitted page URL. Never fetches it. |
| `analyses-handlers.ts` | Request handling for both endpoints, with injectable dependencies for tests. |
| `testing/` | In-memory store and request helpers for unit tests. |

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

There is no matching engine yet, so every analysis stays `pending`.

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
- A database function running the whole ingestion in a single transaction would make this fully atomic.

### `GET /api/analyses/:id`

Returns a `FullAnalysisResponse`, validated with `FullAnalysisResponseSchema` before it is sent. The response is built from live data on every request (`Cache-Control: no-store`), never at build time.

- `product` is the selected product, and `variantLabel` comes from its variant.
- `evidence`, `composition`, and `price` come from the capture that created this analysis, not from later captures of the same product.
- Composition is ordered by component (shell, lining, trim, other), then by highest percentage, then by fiber name.
- `processingStatus` and `outcome` are read from the database: `pending` and `null` for now.
- `alternatives` is `[]`, and `fit` is `unavailable`.
- `warnings` flag missing or partial composition, unverified composition, missing prices, and missing measurements.
- The contracts README says `product` is `null` while pending. This endpoint returns the captured product during pending instead. The schema allows both.

Errors:

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` | The id is not a UUID. |
| 404 | `not_found` | No analysis has that id. |
| 500 | `internal_error` | Database error, or stored data that cannot form a valid contract response. |
| 503 | `service_unavailable` | Database unreachable, or server configuration missing. |

### Errors and logging

- Error bodies use the `ErrorResponseSchema` shape: `{ error: { code, message, fields? } }`.
- `forbidden`, `internal_error`, and `service_unavailable` are server-only codes, not yet in contract 3.0.0. Adding them to `ErrorCodeSchema` would be a contract change.
- Messages are generic. They never include database errors, SQL state, URLs, environment variable names, or keys.
- Server logs record an event name plus the failure kind, SQL state, or the missing variable's name. They never record values.
- No CORS headers are sent, so other websites cannot read the responses. A Chrome extension with host permission for the local server can still call the API.

## Before public deployment

Writes are disabled when `NODE_ENV=production`, and must stay that way until all of the following exist:

- Authentication for the extension and the website, such as signed extension tokens or user sessions, instead of the local-only guard.
- Rate limiting and abuse controls on `POST /api/analyses`.
- An explicit allowlist of extension origins.
- A decision on whether `GET /api/analyses/:id` needs authorization. Today, anyone who has an analysis UUID can read it.

The `Host` and `Origin` checks stop browser-based cross-site requests and DNS-rebinding requests. They are not authentication: any client that can reach the port can set those headers. Binding the dev server to `127.0.0.1` is part of the boundary.

## Tests

`npm test` covers all of this with an in-memory store that enforces the schema's uniqueness, ownership, and cascade rules. The tests make no network calls and need no credentials. The secret-shaped strings in the tests are fake.
