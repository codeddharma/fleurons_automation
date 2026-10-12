# Fleurons Automation — Shopify → Petpooja Integration Plan (Phase 1)

## 1. Problem

Orders placed on the Shopify storefront (fleurons.in) don't reach Petpooja POS automatically.
Staff currently re-key every website order by hand — slow and error-prone.

## 2. Goal & Scope

Build a middleware service that listens for Shopify order events and pushes them into Petpooja
at the correct outlet automatically, with zero manual re-entry.

**In scope:**
- Receive and validate Shopify `orders/create` webhooks.
- Map the order to the correct Petpooja outlet.
- Push **every** order into Petpooja via the Save Order API, tagged as a "Website" order so staff
  can tell it apart from Zomato/Swiggy — this includes Pan-India/standard-shipped orders (Gift
  Hampers, some Cookies), not just hyperlocal Cakes/Cookies. Staff need every order visible in the
  POS regardless of fulfilment method; only the *automatic Shiprocket delivery booking* (Phase 2)
  is limited to the hyperlocal category.
- Handle Petpooja's status callback (accepted / rejected / etc.) to keep our own record in sync.
- Idempotency, retries, and ops alerting on failures.

**Out of scope (for now):** Shiprocket delivery automation, Shopify fulfilment write-back,
customer notifications, any dashboard UI. These can be layered on later without reworking this
core.

## 3. Architecture

```
Customer -> Shopify (fleurons.in)
                |  orders/create webhook (HMAC signed)
                v
   +-----------------------------+
   |   Integration Middleware     |
   |   Node.js + TypeScript +     |
   |   Express                    |
   |                               |
   |  Webhook Ingestion +          |
   |  HMAC verify + dedupe         |
   |            |                  |
   |            v                  |
   |  Outlet Resolver              |
   |  (static config, one outlet   |
   |   today; explicit-key hook    |
   |   for future multi-outlet)    |
   |            |                  |
   |            v                  |
   |  Order Transformer +          |
   |  Petpooja Connector  ---------+---> Petpooja POS (Save Order API)
   |            |                  |         |
   |            v                  |         | status callback
   |  Order Fallback Log      <----+---------+ (accept/reject/...)
   |  (data/orders.jsonl)          |
   +-----------------------------+
```

## 4. Tech Stack

- **Runtime:** Node.js (LTS) + TypeScript
- **Framework:** Express
- **Storage:** no database. Shopify and Petpooja are the real systems of record for order data, so
  the middleware keeps its own state as a local append-only JSON-lines file
  (`data/orders.jsonl`) — one line per order lifecycle event — purely as a fallback audit trail and
  for idempotency checks. Outlet/item-map config is a static TypeScript file
  (`src/config/outlets.ts`), since there's currently only one outlet.
- **Retry:** in-process exponential backoff for failed Petpooja calls (no external queue needed at
  this volume — can add BullMQ + Redis later if needed)
- **Validation:** zod for webhook payload + config validation
- **HTTP client:** axios (Petpooja / Shopify calls)
- **Process manager:** PM2 on the VPS
- **Logging:** pino (structured logs) + Telegram (primary) / a generic alert webhook for ops
  alerts on failures
- **Env config:** dotenv + a typed config module that fails fast on missing vars

## 5. Project Structure

```
fleurons_automation/
├── src/
│   ├── config/
│   │   ├── env.ts                 # typed env loader, fails fast on missing vars
│   │   └── outlets.ts             # static outlet/item-map config (no DB)
│   ├── routes/
│   │   ├── shopify.webhook.ts     # POST /webhooks/shopify/orders-create
│   │   └── petpooja.callback.ts   # POST /webhooks/petpooja/status
│   ├── services/
│   │   ├── shopify/
│   │   │   └── verifyHmac.ts
│   │   ├── petpooja/
│   │   │   ├── petpoojaClient.ts  # Save Order API call
│   │   │   └── mapOrderPayload.ts # Shopify order → Petpooja order shape
│   │   ├── outlet/
│   │   │   └── outletRegistry.ts  # outlet resolution + delivery-area extraction
│   │   └── orders/
│   │       └── processShopifyOrder.ts  # orchestrates the whole pipeline
│   ├── jobs/
│   │   └── retryFailedPush.ts     # backoff retry for failed Petpooja pushes
│   ├── lib/
│   │   ├── logger.ts
│   │   ├── alert.ts               # ops alert (Telegram / generic webhook)
│   │   ├── errors.ts
│   │   └── orderStore.ts          # JSON-lines fallback log + idempotency index
│   ├── app.ts                     # express app, middleware, routes
│   └── server.ts                  # entrypoint
├── scripts/
│   ├── sendTestOrder.ts           # fires a signed fake order at a running server
│   └── localSmokeTest.ts          # zero-setup end-to-end test (npm run smoke-test)
├── data/                          # gitignored - orders.jsonl lives here at runtime
├── .env.example
├── tsconfig.json
├── package.json
└── PLAN.md
```

## 6. Data Shapes

**Outlet config** (`src/config/outlets.ts`, static array — see also §11):
```ts
{
  outletKey: string;
  name: string;
  petpoojaRestId: string;
  isActive: boolean;
  isDefault: boolean;          // only one outlet today, always the default
  itemMap: {
    shopifySku?: string;
    shopifyVariantId?: string; // fallback when SKU is blank (common in the real catalog)
    shopifyProductId?: string; // second fallback
    petpoojaItemId: string;
  }[];
}
```

**Order fallback log** (`data/orders.jsonl`, one JSON object per line, append-only):
```ts
{
  timestamp: string;
  event: "received" | "sent_to_pos" | "pos_accepted" | "pos_rejected" | "failed";
  shopifyOrderId: string;
  shopifyOrderNumber: string;
  outletKey?: string;
  petpoojaOrderId?: string;
  failureReason?: string;
  // plus ad-hoc context: items, customer, deliveryCity/deliveryArea, rawShopifyPayload, etc.
}
```
An order's current status is whatever its most recent line says. Idempotency and
petpoojaOrderId→order lookups are backed by in-memory indexes rebuilt from this file at startup.

## 7. Core Flow

1. Customer places order on Shopify. No outlet picker exists on checkout yet - some products
   (Cakes) show a per-product delivery-details widget capturing City/Area/Date/Slot as line item
   properties; others (Gift Hampers, some Cookies) don't, since they ship nationwide by courier.
2. Shopify fires `orders/create` (via Settings → Notifications → Webhooks, no app needed) →
   `POST /webhooks/shopify/orders-create`.
3. Verify `X-Shopify-Hmac-Sha256` against the raw body using the webhook signing secret. Reject
   (401) on mismatch.
4. Check the order fallback log's in-memory index for this Shopify order id — if already
   processed, return 200 immediately (idempotent).
5. Resolve the outlet: use an explicit outlet key if the order carries one (line item property
   named `Outlet` - nothing sets this yet), otherwise the outlet flagged `isDefault: true` (today
   there's only one outlet, so this is always the default). Applies to every order, regardless of
   whether it has hyperlocal delivery details.
   - If not found/closed → mark order `failed`, fire ops alert, return 200 (Shopify webhooks must
     ack fast; don't retry Shopify's webhook, retry our own push instead).
6. Map Shopify line items → Petpooja item IDs via the outlet's `itemMap` (tries SKU, then
   `variant_id`, then `product_id` - see §11).
   - If none resolve → mark `failed`, alert ops (don't push a partial/wrong order).
7. Build the Petpooja Save Order payload (restID, order source tag = "Website", customer, items,
   totals) and call the Petpooja Save Order API.
8. On success: append a `sent_to_pos` event with the `petpoojaOrderId`. On failure: retry with
   backoff (e.g. 3 attempts, 5s/30s/2min), then append `failed` + alert ops.
9. Petpooja calls back our `POST /webhooks/petpooja/status` on accept/reject → append the
   corresponding event, looked up by `petpoojaOrderId`.

## 8. External API Integration Notes

- **Shopify:** no custom app needed for Phase 1. Orders are received via **Settings → Notifications
  → Webhooks** — a direct webhook subscription on the `orders/create` topic that requires no Admin
  API access token or scopes at all, since we only ever receive data, never call back into
  Shopify's API. HMAC verification uses the **signing secret** shown on that same page (not an
  app's client secret). Confirmed against a live order that customer PII (name/phone/address via
  `shipping_address`) comes through intact on this store — no Protected Customer Data restriction
  blocking it. An Admin API access token (i.e. a real custom app) is only needed later if/when we
  need to write fulfilment status back into Shopify.
- **Petpooja:** confirmed against Petpooja's real "API Guide for Placing Orders" and Sandbox Guide
  (sandbox dev access obtained 2026-10-12), then against the **live sandbox endpoint itself**,
  since the guide turned out not to match reality. Key facts:
  - **The request body is NOT flat**, despite how the guide presents the fields. Sending the
    fields flat (`restID`, `orderID`, `order_items`, etc. at the top level) gets
    `{"success":"0","message":"Invalid order relay payload"}` every time - confirmed by testing
    directly against the sandbox. The body must use Petpooja's standard aggregator-API nesting:
    `orderinfo.OrderInfo.{Restaurant,Customer,Order,OrderItem,Tax,Discount}`, each wrapped in a
    `details` key (e.g. `orderinfo.OrderInfo.Restaurant.details.restID`). Confirmed working
    (`{"success":"1","message":"Your order is saved."}`) against the real sandbox on 2026-10-12.
  - `app_key`/`app_secret`/`access_token` travel **inside the JSON body** (top level, alongside
    `orderinfo`), not as headers.
  - The item fields table lists a `tax_percentage` field directly on each order item, separate
    from the nested `item_tax` array - both are expected.
  - The response's own `orderID` can come back **empty** even on success (`"success":"1"`) -
    `clientOrderID` reliably echoes the orderID we sent, so that's what we key on until/unless a
    real callback shows Petpooja's own id populated.
  - The Save Order endpoint is one **fixed URL** shared across sandbox and production:
    `https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order` — account
    identity comes entirely from the three auth fields above, not the URL.
  - `restID` is the "Menu sharing code" (from the sandbox dashboard's Menu Management section, or
    the alphanumeric code Petpooja gives directly) — this is the per-outlet identifier.
  - `callback_url` is a **required** field on every order — Petpooja calls it back with
    accept/reject/Food Ready updates, so it must be a real reachable HTTPS URL (built from
    `PUBLIC_BASE_URL` + `/webhooks/petpooja/status`). Without a deployed public URL, Save Order
    calls can still succeed, but callbacks silently won't arrive.
  - Several required fields are genuine *business* decisions, not API-shape guesses — flagged as
    `TODO` directly in `mapOrderPayload.ts`: GST % on delivery/packing charges, COD-vs-ONLINE
    detection accuracy, `enable_delivery` (0=third-party rider, which fits since Shiprocket is
    Phase 2), and `gst_liability` (vendor vs restaurant).
  - Petpooja can also **push their menu to us** (a `pushmenu` webhook, configured via the sandbox
    dashboard's Base URL field) — this would hand us real Petpooja item IDs directly instead of
    needing a manually-built mapping. Not implemented yet; worth doing once sandbox testing
    confirms Save Order works, since it directly solves the item-mapping dependency below.

## 9. Reliability

- **Idempotency:** an order id already present in the fallback log is skipped on reprocessing.
- **Retries:** exponential backoff on transient Petpooja failures; after max attempts, log
  `failed` and alert ops rather than silently dropping the order.
- **Ops alerts:** Telegram (bot token + chat id) as the primary channel, with a generic webhook
  URL (e.g. Slack) as an alternative — on: outlet closed, POS reject, item unmapped, max retries
  hit. No dashboard needed — alerts are enough for this scope.
- **Audit log:** `data/orders.jsonl` is the full record of every order this middleware has seen and
  what happened to it, independent of Shopify/Petpooja's own records.

## 10. Environment Variables (draft)

```
PORT=
DATA_DIR=                       # optional, defaults to ./data
SHOPIFY_SHOP_DOMAIN=
SHOPIFY_WEBHOOK_SECRET=
PETPOOJA_SAVE_ORDER_URL=        # fixed per Petpooja's docs, has a working default
PETPOOJA_APP_KEY=
PETPOOJA_APP_SECRET=
PETPOOJA_ACCESS_TOKEN=
PETPOOJA_CALLBACK_SECRET=       # if Petpooja signs its callbacks
PETPOOJA_MOCK_MODE=             # "true" logs instead of calling Petpooja - use until creds arrive
PUBLIC_BASE_URL=                # this server's public HTTPS origin - required for real calls, builds callback_url
TELEGRAM_BOT_TOKEN=             # ops alerts, optional
TELEGRAM_CHAT_ID=
ALERT_WEBHOOK_URL=              # generic alternative to Telegram, optional
```

## 11. Open Items / Dependencies (needed before go-live)

1. ~~Shopify custom app + admin token~~ — **not needed for Phase 1**, resolved by using the
   Notifications-based webhook instead (see §8).
2. ~~Outlet selection / mapping~~ — **resolved for now**: only one Shopify Location/outlet
   currently exists, so every order routes to the single entry in `src/config/outlets.ts` flagged
   `isDefault: true`. Order resolution also checks for an explicit outlet key first (a line item
   property named `Outlet`) — nothing sets this today, but it means no code changes are needed
   later when real multi-outlet selection is added to the storefront; just add more entries and
   wire that property up. Separately, `line_items[].properties.City`/`Area` (captured by the
   existing per-product delivery-details widget) is still recorded for reference, but no longer
   gates whether an order is pushed to Petpooja — every order goes, per §2.
3. ~~Petpooja API access~~ — **done (2026-10-12)**: sandbox `app_key`/`app_secret`/`access_token`
   are in `.env`, `restID` (`qicp50k27a`) is in `src/config/outlets.ts`, and a real Save Order call
   against the sandbox has been confirmed working end-to-end
   (`npx tsx scripts/testPetpoojaSandbox.ts`).
4. **Item mapping:** the real catalog's SKU/variant/product → Petpooja item ID list. Many Shopify
   products don't have a SKU set (confirmed from live order data), so mapping falls back to
   `variant_id`/`product_id` when SKU is blank — but *some* identifier still needs to be mapped for
   every product for the push to succeed. The sandbox's Menu Management section (or the `pushmenu`
   webhook, see §8) can supply the authoritative Petpooja item IDs to map against.
5. Hosting + `PUBLIC_BASE_URL`: a server to deploy the middleware on, with a real public HTTPS
   URL — needed both to point the Shopify webhook at (currently pointed at a test endpoint) and to
   receive Petpooja's required `callback_url`. Since there's no database, this can be a simple
   platform (Railway/Render) or a VPS - either works. A temporary tunnel (ngrok) could unblock
   sandbox testing before a real deployment exists.

## 12. Milestones

| Milestone | Deliverable |
|---|---|
| M1 | Repo scaffold, env config, Shopify webhook endpoint + HMAC verify + idempotency |
| M2 | Outlet config + item mapping, Petpooja Save Order connector, end-to-end test order lands in Petpooja tagged "Website" |
| M3 | Petpooja status callback endpoint, retry/backoff, ops alerts |
| M4 | UAT with real test orders, deployment, docs/runbook, handover |

## 13. Testing Approach

- `npm run smoke-test` — zero-setup end-to-end test (no real Shopify/Petpooja/server needed),
  proves the full webhook → outlet resolution → item mapping → mock Petpooja push pipeline.
- `npm run test:webhook` — fires a signed fake order at a locally running dev server.
- `npx tsx scripts/testPetpoojaSandbox.ts` — bypasses mock mode and item-mapping requirements to
  call the **real** sandbox Save Order API directly with a placeholder item id. Used to confirm
  auth/connectivity/payload shape independent of the rest of the pipeline - this is how the
  flat-vs-nested body issue (§8) was diagnosed and fixed.
- Petpooja sandbox/test outlet for Save Order + callback round-trip before touching a live outlet.
- End-to-end dry run: place a real test order → confirm it appears correctly tagged in Petpooja
  before going live on a real outlet.

## Later (not now, kept for reference)

Shiprocket Quick delivery automation on Food Ready + Shopify fulfilment write-back +
customer notifications — this was in the original proposal's scope but is deliberately deferred
until Phase 1 is live and stable.
