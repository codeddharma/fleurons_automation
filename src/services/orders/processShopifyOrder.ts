import { extractDeliveryArea, extractExplicitOutletKey, resolveOutlet } from "../outlet/outletRegistry";
import {
  mapLineItems,
  buildPetpoojaSaveOrderPayload,
  resolveCustomerContact,
  ShopifyOrderForMapping,
} from "../petpooja/mapOrderPayload";
import { saveOrderToPetpooja } from "../petpooja/petpoojaClient";
import { withRetry } from "../../jobs/retryFailedPush";
import { sendOpsAlert } from "../../lib/alert";
import { logger } from "../../lib/logger";
import { hasBeenProcessed, recordOrderEvent } from "../../lib/orderStore";

/**
 * Full Phase 1 pipeline for a single Shopify order: every order gets pushed
 * to Petpooja (staff need every order visible in the POS, even ones that
 * ship standard/Pan-India rather than getting hyperlocal delivery). Resolves
 * the outlet, maps items, records the order, and pushes it into Petpooja
 * with retries. Called after the webhook route has already ack'd Shopify,
 * so failures here are handled by updating order state + alerting ops
 * rather than an HTTP error.
 */
export async function processShopifyOrder(shopifyOrder: ShopifyOrderForMapping): Promise<void> {
  const shopifyOrderId = String(shopifyOrder.id);
  const shopifyOrderNumber = String(shopifyOrder.order_number);

  if (hasBeenProcessed(shopifyOrderId)) {
    logger.info({ shopifyOrderId }, "Order already recorded, skipping re-processing");
    return;
  }

  // Present only for orders with a per-product delivery-details widget
  // (hyperlocal Cakes/Cookies) - recorded for reference even though it no
  // longer gates whether the order is pushed to Petpooja.
  const deliveryArea = extractDeliveryArea(shopifyOrder);
  const explicitOutletKey = extractExplicitOutletKey(shopifyOrder);

  let outlet;
  try {
    outlet = resolveOutlet(explicitOutletKey);
  } catch (err) {
    recordFailure(shopifyOrder, deliveryArea, undefined, (err as Error).message);
    return;
  }

  let items;
  try {
    items = mapLineItems(shopifyOrder, outlet);
  } catch (err) {
    recordFailure(shopifyOrder, deliveryArea, outlet.outletKey, (err as Error).message);
    return;
  }

  const contact = resolveCustomerContact(shopifyOrder);

  recordOrderEvent({
    event: "received",
    shopifyOrderId,
    shopifyOrderNumber,
    outletKey: outlet.outletKey,
    deliveryCity: deliveryArea?.city,
    deliveryArea: deliveryArea?.area,
    items,
    customer: contact,
    rawShopifyPayload: shopifyOrder,
  });

  const payload = buildPetpoojaSaveOrderPayload(shopifyOrder, outlet, items);

  try {
    const result = await withRetry(() => saveOrderToPetpooja(payload));
    // Petpooja's own orderID can come back empty on acceptance (seems to
    // populate later); clientOrderID reliably echoes what we sent.
    const petpoojaOrderId = result.orderID || result.clientOrderID;
    recordOrderEvent({
      event: "sent_to_pos",
      shopifyOrderId,
      shopifyOrderNumber,
      outletKey: outlet.outletKey,
      petpoojaOrderId,
    });
    logger.info({ shopifyOrderId, petpoojaOrderId }, "Order pushed to Petpooja");
  } catch (err) {
    recordOrderEvent({
      event: "failed",
      shopifyOrderId,
      shopifyOrderNumber,
      outletKey: outlet.outletKey,
      failureReason: (err as Error).message,
    });
    await sendOpsAlert(`Failed to push Shopify order #${shopifyOrderNumber} to Petpooja`, {
      shopifyOrderId,
      outletKey: outlet.outletKey,
      error: (err as Error).message,
    });
  }
}

function recordFailure(
  shopifyOrder: ShopifyOrderForMapping,
  deliveryArea: { city?: string; area: string } | null,
  outletKey: string | undefined,
  reason: string
): void {
  const shopifyOrderId = String(shopifyOrder.id);
  const shopifyOrderNumber = String(shopifyOrder.order_number);

  recordOrderEvent({
    event: "failed",
    shopifyOrderId,
    shopifyOrderNumber,
    outletKey,
    deliveryCity: deliveryArea?.city,
    deliveryArea: deliveryArea?.area,
    failureReason: reason,
    rawShopifyPayload: shopifyOrder,
  });

  void sendOpsAlert(`Shopify order #${shopifyOrderNumber} could not be routed to Petpooja`, {
    shopifyOrderId,
    deliveryArea,
    reason,
  });
}
