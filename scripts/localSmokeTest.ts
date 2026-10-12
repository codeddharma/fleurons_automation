import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Zero-setup end-to-end smoke test: starts the real Express app (Petpooja in
 * mock mode, order log pointed at a throwaway temp directory), points the
 * one configured outlet at test item mappings, fires a signed fake Shopify
 * order at the webhook route, and prints the resulting order history.
 *
 * No real Shopify store or Petpooja credentials needed.
 * Run with: npm run smoke-test
 */
async function main() {
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleurons-smoke-test-"));

  // These must be set before src/config/env.ts is imported (it reads
  // process.env at import time), so dynamic-import everything after this.
  process.env.DATA_DIR = tempDataDir;
  process.env.PORT = "4111";
  process.env.SHOPIFY_SHOP_DOMAIN = "fleurons.myshopify.com";
  process.env.SHOPIFY_WEBHOOK_SECRET = "dummy_webhook_secret";
  process.env.PETPOOJA_APP_KEY = "dummy";
  process.env.PETPOOJA_APP_SECRET = "dummy";
  process.env.PETPOOJA_ACCESS_TOKEN = "dummy";
  process.env.PETPOOJA_MOCK_MODE = "true";

  const { env } = await import("../src/config/env");
  const { app } = await import("../src/app");
  const { outlets } = await import("../src/config/outlets");
  const { getOrderHistory } = await import("../src/lib/orderStore");
  const axios = (await import("axios")).default;

  const defaultOutlet = outlets.find((o) => o.isDefault);
  if (!defaultOutlet) throw new Error("No default outlet configured in src/config/outlets.ts");
  defaultOutlet.petpoojaRestId = "TEST-REST-ID";
  defaultOutlet.itemMap = [
    { shopifySku: "CAKE-001", petpoojaItemId: "PP-ITEM-CAKE-001" },
    // No SKU here on purpose - proves the variant_id fallback works when a
    // product has no SKU set, which is common in the real catalog.
    { shopifyVariantId: "999888777", petpoojaItemId: "PP-ITEM-COOKIE-001" },
  ];
  console.log("[1/4] Outlet configured with test item mappings");

  const server = app.listen(Number(env.PORT));
  console.log(`[2/4] Server listening on port ${env.PORT}`);

  const order = {
    id: Date.now(),
    order_number: Math.floor(Date.now() / 1000),
    line_items: [
      {
        sku: "CAKE-001",
        name: "Chocolate Truffle Cake (1kg)",
        quantity: 1,
        price: "899.00",
        properties: [
          { name: "City", value: "Delhi" },
          { name: "Area", value: "Dwarka Sec 11" },
        ],
      },
      {
        // sku deliberately null - matches real catalog data where many
        // products (e.g. packaged cookies) have no SKU set.
        sku: null,
        variant_id: 999888777,
        product_id: 111222333,
        name: "Choco Mocha Chunk Cookie - Pack of 3",
        quantity: 1,
        price: "240.00",
        properties: [],
      },
    ],
    customer: { first_name: "Test", last_name: "Customer", phone: null, email: "test@example.com" },
    shipping_address: {
      first_name: "Test",
      last_name: "Customer",
      phone: "+919999999999",
      address1: "123 MG Road",
      city: "New Delhi",
      province: "Delhi",
      zip: "110001",
    },
    total_price: "1139.00",
  };

  const rawBody = JSON.stringify(order);
  const hmac = crypto.createHmac("sha256", env.SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest("base64");

  const response = await axios.post(`http://localhost:${env.PORT}/webhooks/shopify/orders-create`, rawBody, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Webhook-Id": crypto.randomUUID(),
      "X-Shopify-Shop-Domain": env.SHOPIFY_SHOP_DOMAIN,
    },
  });
  console.log("[3/4] Webhook response:", response.status, response.data);

  // Processing happens after the HTTP response is sent - give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const history = getOrderHistory(String(order.id));
  console.log("[4/4] Order history from the fallback log:");
  console.log(JSON.stringify(history, null, 2));

  const latestStatus = history[history.length - 1]?.event;
  if (latestStatus === "sent_to_pos") {
    console.log("\n✅ SMOKE TEST PASSED - order flowed through webhook -> outlet mapping -> mock Petpooja push.");
  } else {
    console.log(`\n❌ SMOKE TEST FAILED - unexpected final status: ${latestStatus}`);
    process.exitCode = 1;
  }

  server.close();
  fs.rmSync(tempDataDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
