import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { sendOpsAlert } from "../lib/alert";
import { findOrderByPetpoojaOrderId, recordOrderEvent, OrderEventType } from "../lib/orderStore";

export const petpoojaCallbackRouter = Router();

/**
 * Maps Petpooja's real status codes (confirmed empirically against the
 * sandbox, 2026-10-16 - not documented anywhere) to our internal event type.
 * "1" = Accepted is confirmed from a real callback payload. Food
 * Ready/Rejected codes are still unconfirmed - add them here once seen.
 */
const PETPOOJA_STATUS_MAP: Record<string, OrderEventType> = {
  "1": "pos_accepted",
};

/**
 * Petpooja's real callback shape (confirmed empirically, 2026-10-16) - NOT
 * what was originally assumed. Example:
 * {"restID":"qicp50k27a","orderID":"SHOPIFY-TEST-...","status":"1",
 *  "rider_phone_number":"","cancel_reason":"","is_modified":"No",
 *  "minimum_delivery_time":30,"minimum_prep_time":30}
 */
const callbackBodySchema = z.object({
  restID: z.string().optional(),
  orderID: z.string().min(1),
  status: z.string().min(1),
  cancel_reason: z.string().optional(),
  rider_phone_number: z.string().optional(),
  is_modified: z.string().optional(),
  minimum_delivery_time: z.number().optional(),
  minimum_prep_time: z.number().optional(),
});

petpoojaCallbackRouter.post("/status", (req, res) => {
  if (env.PETPOOJA_CALLBACK_SECRET) {
    const providedSecret = req.get("X-Callback-Secret");
    if (providedSecret !== env.PETPOOJA_CALLBACK_SECRET) {
      logger.warn("Petpooja callback received with invalid/missing shared secret");
      return res.status(401).send("Unauthorized");
    }
  }

  const parsed = callbackBodySchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.flatten() }, "Petpooja callback payload failed validation");
    return res.status(400).send("Invalid payload");
  }

  const { orderID: petpoojaOrderId, status, cancel_reason: reason } = parsed.data;
  const mappedEvent = PETPOOJA_STATUS_MAP[status];

  if (!mappedEvent) {
    logger.warn({ status }, "Received unrecognized Petpooja status");
    return res.status(200).send("OK"); // ack anyway, don't make Petpooja retry a status we don't handle yet
  }

  const order = findOrderByPetpoojaOrderId(petpoojaOrderId);
  if (!order) {
    logger.warn({ petpoojaOrderId }, "Petpooja callback for unknown order");
    return res.status(200).send("OK");
  }

  recordOrderEvent({
    event: mappedEvent,
    shopifyOrderId: order.shopifyOrderId,
    shopifyOrderNumber: order.shopifyOrderNumber,
    petpoojaOrderId,
    failureReason: mappedEvent === "pos_rejected" ? reason || "Rejected by POS" : undefined,
  });

  if (mappedEvent === "pos_rejected") {
    void sendOpsAlert(`Petpooja rejected order #${order.shopifyOrderNumber}`, { petpoojaOrderId, reason });
  }

  logger.info({ petpoojaOrderId, status: mappedEvent }, "Order status updated from Petpooja callback");
  return res.status(200).send("OK");
});
