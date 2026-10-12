import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { sendOpsAlert } from "../lib/alert";
import { findOrderByPetpoojaOrderId, recordOrderEvent, OrderEventType } from "../lib/orderStore";

export const petpoojaCallbackRouter = Router();

/**
 * Maps Petpooja's status vocabulary to our internal event type. Confirm the
 * exact status strings/codes Petpooja sends against their callback docs and
 * adjust this map accordingly.
 */
const PETPOOJA_STATUS_MAP: Record<string, OrderEventType> = {
  accepted: "pos_accepted",
  rejected: "pos_rejected",
};

const callbackBodySchema = z.object({
  petpoojaOrderId: z.string().min(1),
  status: z.string().min(1),
  reason: z.string().optional(),
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

  const { petpoojaOrderId, status, reason } = parsed.data;
  const mappedEvent = PETPOOJA_STATUS_MAP[status.toLowerCase()];

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
    failureReason: mappedEvent === "pos_rejected" ? reason ?? "Rejected by POS" : undefined,
  });

  if (mappedEvent === "pos_rejected") {
    void sendOpsAlert(`Petpooja rejected order #${order.shopifyOrderNumber}`, { petpoojaOrderId, reason });
  }

  logger.info({ petpoojaOrderId, status: mappedEvent }, "Order status updated from Petpooja callback");
  return res.status(200).send("OK");
});
