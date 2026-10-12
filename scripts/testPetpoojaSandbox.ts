/**
 * One-off real connectivity test against the Petpooja sandbox Save Order
 * API - bypasses PETPOOJA_MOCK_MODE regardless of what .env says, so this
 * always makes a real HTTP call. Uses a placeholder item id since we don't
 * have the real Petpooja item catalog yet - the goal here is just to confirm
 * auth (app_key/app_secret/access_token) + restID are accepted, not to place
 * a fully valid order.
 *
 * Run with: npx tsx scripts/testPetpoojaSandbox.ts
 */
process.env.PETPOOJA_MOCK_MODE = "false";
if (!process.env.PUBLIC_BASE_URL) {
  // Placeholder so buildPetpoojaSaveOrderPayload doesn't just warn - callback
  // delivery won't work with this, but that's not what we're testing here.
  process.env.PUBLIC_BASE_URL = "https://example.com";
}

async function main() {
  const { outlets } = await import("../src/config/outlets");
  const { buildPetpoojaSaveOrderPayload, mapLineItems } = await import("../src/services/petpooja/mapOrderPayload");
  const { saveOrderToPetpooja } = await import("../src/services/petpooja/petpoojaClient");

  const outlet = outlets.find((o) => o.isDefault);
  if (!outlet) throw new Error("No default outlet configured");

  // Temporarily add a placeholder item mapping so mapLineItems succeeds -
  // this item id almost certainly doesn't exist in the real sandbox menu,
  // so expect Petpooja to reject on that specifically if everything else
  // (auth, restID) is accepted.
  outlet.itemMap = [{ shopifySku: "TEST-SKU", petpoojaItemId: "1" }];

  const fakeOrder = {
    id: Date.now(),
    order_number: Math.floor(Date.now() / 1000),
    line_items: [
      {
        sku: "TEST-SKU",
        variant_id: null,
        product_id: null,
        name: "Sandbox Connectivity Test Item",
        quantity: 1,
        price: "100.00",
        tax_lines: [],
      },
    ],
    customer: { first_name: "Sandbox", last_name: "Test", phone: null, email: "sandbox@example.com" },
    shipping_address: {
      first_name: "Sandbox",
      last_name: "Test",
      phone: "9876543210",
      address1: "Test Address",
      city: "Delhi",
      province: "Delhi",
      zip: "110001",
    },
    total_price: "100.00",
    total_tax: "0",
    taxes_included: false,
    created_at: new Date().toISOString(),
    payment_gateway_names: ["online"],
  };

  const items = mapLineItems(fakeOrder, outlet);
  const payload = buildPetpoojaSaveOrderPayload(fakeOrder, outlet, items);

  console.log("Payload being sent:");
  console.log(JSON.stringify(payload, null, 2));
  console.log("\nSending to Petpooja sandbox...\n");

  try {
    const result = await saveOrderToPetpooja(payload);
    console.log("SUCCESS:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("FAILED:");
    console.error(err);
  }
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
