import crypto from "crypto";
import axios from "axios";
import { env } from "../src/config/env";

/**
 * Builds a fake Shopify orders/create payload, signs it exactly the way
 * Shopify would, and POSTs it to the locally running server - so the full
 * webhook -> outlet mapping -> Petpooja push pipeline can be exercised
 * without a real Shopify store. The SKU below (CAKE-001) must exist in the
 * default outlet's itemMap in src/config/outlets.ts for mapping to succeed.
 *
 * Run with: npm run test:webhook (the dev server must already be running)
 */
async function main() {
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
          { name: "Date", value: "2026-09-10" },
          { name: "Slot", value: "12 PM - 9 PM" },
        ],
      },
    ],
    customer: {
      first_name: "Test",
      last_name: "Customer",
      phone: null,
      email: "test.customer@example.com",
    },
    shipping_address: {
      first_name: "Test",
      last_name: "Customer",
      phone: "+919999999999",
      address1: "123 MG Road",
      city: "New Delhi",
      province: "Delhi",
      zip: "110001",
    },
    total_price: "899.00",
  };

  const rawBody = JSON.stringify(order);
  const hmac = crypto.createHmac("sha256", env.SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest("base64");

  const url = `http://localhost:${env.PORT}/webhooks/shopify/orders-create`;

  console.log("POSTing fake order to", url);
  const response = await axios.post(url, rawBody, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Webhook-Id": crypto.randomUUID(),
      "X-Shopify-Shop-Domain": env.SHOPIFY_SHOP_DOMAIN,
    },
  });

  console.log("Response:", response.status, response.data);
  console.log("Check the server logs for the [MOCK] Petpooja push, and inspect data/orders.jsonl.");
}

main().catch((err) => {
  if (axios.isAxiosError(err)) {
    console.error("Request failed:", err.response?.status, err.response?.data ?? err.message);
  } else {
    console.error("Failed to send test order:", err);
  }
  process.exit(1);
});
