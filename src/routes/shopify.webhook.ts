import { Router } from "express";
import express from "express";
import { env } from "../config/env";
import { verifyShopifyHmac } from "../services/shopify/verifyHmac";
import { processShopifyOrder } from "../services/orders/processShopifyOrder";
import { logger } from "../lib/logger";
import { ShopifyOrderForMapping } from "../services/petpooja/mapOrderPayload";

export const shopifyWebhookRouter = Router();

// Raw body is required to verify the HMAC signature - must run before any JSON body parser.
shopifyWebhookRouter.post(
  "/orders-create",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const rawBody = req.body as Buffer;
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const shopDomain = req.get("X-Shopify-Shop-Domain");

    if (shopDomain && shopDomain !== env.SHOPIFY_SHOP_DOMAIN) {
      logger.warn({ shopDomain }, "Webhook received from unexpected shop domain");
      return res.status(401).send("Unrecognized shop domain");
    }

    if (!verifyShopifyHmac(rawBody, hmacHeader, env.SHOPIFY_WEBHOOK_SECRET)) {
      logger.warn("Shopify webhook HMAC verification failed");
      return res.status(401).send("Invalid HMAC signature");
    }

    let order: ShopifyOrderForMapping;
    try {
      order = JSON.parse(rawBody.toString("utf8"));
    } catch (err) {
      logger.error({ err }, "Failed to parse Shopify webhook body as JSON");
      return res.status(400).send("Invalid JSON body");
    }

    // Ack Shopify immediately - it expects a fast response and will retry on
    // timeout/5xx. The actual Petpooja push happens after we respond, with
    // its own retry/alerting so failures there don't trigger duplicate
    // Shopify webhook retries.
    res.status(200).send("OK");

    try {
      await processShopifyOrder(order);
    } catch (err) {
      logger.error({ err, shopifyOrderId: order.id }, "Unhandled error while processing Shopify order");
    }
    return;
  }
);
