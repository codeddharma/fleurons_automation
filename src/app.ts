import express from "express";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { shopifyWebhookRouter } from "./routes/shopify.webhook";
import { petpoojaCallbackRouter } from "./routes/petpooja.callback";

export const app = express();

app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Note: shopifyWebhookRouter parses its own raw body per-route (required for
// HMAC verification) - do not mount a global express.json() ahead of it.
app.use("/webhooks/shopify", shopifyWebhookRouter);

app.use("/webhooks/petpooja", express.json(), petpoojaCallbackRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "Unhandled error in request pipeline");
  res.status(500).send("Internal Server Error");
});
