import "dotenv/config";
import { z } from "zod";

// dotenv parses a blank `KEY=` line as an empty string, not undefined - which
// would defeat `?? fallback` checks (`"" ?? x` is still `""`, not `x`). This
// normalizes blank optional env vars to actually-undefined.
const optionalString = () =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined));

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Where the order fallback log (data/orders.jsonl) lives. Overridable so
  // tests can point it at a throwaway directory instead of the real one.
  DATA_DIR: optionalString(),

  SHOPIFY_SHOP_DOMAIN: z.string().min(1, "SHOPIFY_SHOP_DOMAIN is required"),
  // Not required for Phase 1: we receive orders via a Settings -> Notifications
  // webhook subscription, which needs no Admin API access token at all. Only
  // needed later if/when we call back into Shopify's API (e.g. fulfilment write-back).
  SHOPIFY_ADMIN_ACCESS_TOKEN: optionalString(),
  // The webhook "signing secret" from Settings -> Notifications -> Webhooks
  // (not an app's client secret - this project isn't using a custom app).
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1, "SHOPIFY_WEBHOOK_SECRET is required"),

  // Fixed Save Order endpoint per Petpooja's API guide - same URL for sandbox
  // and production, account identity comes from app_key/app_secret/access_token.
  PETPOOJA_SAVE_ORDER_URL: z
    .string()
    .min(1)
    .default("https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order"),
  PETPOOJA_APP_KEY: z.string().min(1, "PETPOOJA_APP_KEY is required"),
  PETPOOJA_APP_SECRET: z.string().min(1, "PETPOOJA_APP_SECRET is required"),
  PETPOOJA_ACCESS_TOKEN: z.string().min(1, "PETPOOJA_ACCESS_TOKEN is required"),
  PETPOOJA_CALLBACK_SECRET: optionalString(),
  // When "true", the Petpooja client logs the outbound payload instead of
  // calling the real API - lets the rest of the pipeline be exercised before
  // real Petpooja credentials/API access are in hand.
  PETPOOJA_MOCK_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  // This server's own public HTTPS origin (e.g. https://fleurons-automation.example.com),
  // used to build the callback_url Petpooja calls back on order status changes.
  // Required for any real (non-mock) Petpooja call.
  PUBLIC_BASE_URL: optionalString(),

  // Generic alert webhook (e.g. Slack incoming webhook). Optional.
  ALERT_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  // Telegram alerting - create a bot via @BotFather for the token, and message
  // the bot once to find your chat id (e.g. via the getUpdates API). Optional -
  // if either is unset, alerts just log instead.
  TELEGRAM_BOT_TOKEN: optionalString(),
  TELEGRAM_CHAT_ID: optionalString(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
