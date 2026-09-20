# Scale × Shopify

Optional, read-only spatial discovery. No Shopify keys, carts, orders, payments, catalog writes,
new meshes, or schema changes. Nothing is deployed by this change.

## Demo

Run the existing Worker and XR app locally (`npm run dev` in `workers` and `apps/xr`, in separate
terminals). The XR dev proxy already targets the Worker on port 8787. No environment edits are
required for Shopify discovery. Open the XR page and click **Shopify: find something that fits**
under Listings, or **Find similar on Shopify** on a listing. Direct entry: `/shopify.html`.

1. Select **Terrazzo Switch Table** as the reference.
2. Enter **side table** as the query.
3. Choose **Reference image + text** (or Text).
4. Enter **50** for width: this is a 50 cm demonstration constraint, not a measurement of the room.
   Use the actual measured gap when judging a real space. Height/depth are optional limits.
5. Click **Find on Shopify**. The comparison identifies the smallest physical miss and a verified
   fitting option; each card names the merchant, live price and exact variant under its evidence.
6. **Preview Scale catalog mesh in XR** appears only when the exact product has matching dimensions
   and an existing ready mesh in D1, and XR is already in live mode. It opens the existing XR flow
   in another tab (`?object=...&room=...`). No mesh generation is triggered. Appearance may differ
   by finish. This does not place into the current headset session automatically.
7. **Buy on Shopify** opens Shopify's returned variant checkout URL only on a deliberate click.
   **View on Shopify** is the real product-page fallback. Stop before buying during a demo.

Read-only verification on 2026-09-20 returned Bend Goods' Terrazzo Switch Table at 45.72 cm wide
and Terrazzo Side Table at 50.8 cm wide: 4.28 cm clearance versus 0.8 cm too wide for that constraint.
These are observed live results, not fixtures loaded into the feature. Inventory and search order
can change. No checkout URL was fetched, followed, or purchased during implementation.

## Boundary and guarantees

- `GET /v1/shopify/references`: eligible entries from Paul's existing prebake manifest.
- `POST /v1/shopify/search`: optional query, reference image, or Global Catalog product ID.
  Invokes only `search_catalog` and `lookup_catalog`. Image search resizes an existing reference
  in browser memory; it adds no capture flow and uploads no assets to Scale storage.
- Global similarity matches retain Shopify's order. A separately labelled group looks up related
  existing Scale catalog URLs through Shopify for fresh merchant/variant/price/checkout data.
  It does not claim those lookups are Shopify similarity-ranked results.
- Shopify's inferred descriptions/specifications are never used for dimensions. A dimension join
  requires exact canonical merchant product URL, unflagged existing `api`/`page` extraction with
  confidence at least 0.8, and a `spec_block`/`body_html` source. A public merchant `.js` GET must
  confirm both product ID and variant membership. Multiple variants are accepted only for strictly
  cosmetic color/finish options; size/configuration changes or ambiguity stay **SIZE UNVERIFIED**.
- `assessShopify` calls the existing XR `fitsNeed` predicate unchanged. **FITS** means only the
  entered width/height/depth limits in the stated orientation. It is not a full-room, doorway,
  walkway, rotation, or placement guarantee. The existing room-fit service and solver are untouched.
- Unknown size, merchant verification failure, and missing mesh never prevent commerce discovery.
  12-second overall discovery deadline, 1-second optional D1 preview lookup, 16-second UI request
  deadline; no retries. All discovery responses are `no-store`; no products or images are persisted.
- Shopify always returns real data, including when the existing app is in stub mode. Stub mode
  disables the preview link to prevent the existing Object stub from substituting its fixture mesh.
- Default search, listing selection, fit, SSE, capture and generation paths do not call Shopify.

## Access

Internet access to `catalog.shopify.com`, merchant public product JSON, and merchant image CDNs.
The hackathon uses Shopify's officially hosted public test agent profile (no API key or secrets).
For a production integration, replace the demo profile with a published profile owned by Scale;
that is deliberately outside this change. Image-CDN CORS failure is visible; text search remains usable.
Ready-mesh preview also needs the existing D1 data/R2 assets and XR live mode. The committed
production XR configuration already enables live mode. No environment values were changed.

Official references, checked 2026-09-20:
- https://shopify.dev/docs/agents/catalog/global-catalog
- https://shopify.dev/docs/agents/catalog/global-catalog-extension
- https://shopify.dev/docs/agents/profiles

## Local verification

Use Node 24 (existing Worker tests require `node:module.registerHooks`).

```text
cd workers
node --experimental-transform-types --test tests/*.test.mjs
npm run typecheck

cd ../apps/xr
node --test src/*.test.ts
npm run build

cd ../..
python -m pytest services/fit/tests/test_fit.py -q
python -m pytest services/search/tests -q
git diff --check
```

New tests cover transport success/errors/timeouts/empty/malformed/SSE responses, real variant
identity, exact dimension provenance, size-changing variants, checkout fallback, fit and failure
explanations, read-only preview lookup, and existing stub behavior with Shopify completely offline.
Browser smoke testing used an isolated local server, the production XR build and headless Chrome:
live text and image+text discovery, responsive layout, changing constraints, empty/error/malformed
responses and timeout all passed with no uncaught exceptions or checkout navigation.

The full Python solver suite could not collect because this machine lacks `ortools`; its untouched
fit validator and search suites passed. No physical Quest hardware session was available. Preview
eligibility and link construction were checked locally; ready mesh rendering remains the existing XR path.
