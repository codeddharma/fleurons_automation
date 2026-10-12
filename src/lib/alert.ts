import axios from "axios";
import { env } from "../config/env";
import { logger } from "./logger";

/**
 * Fire-and-forget ops alert. Never throws - an alert failure must not take
 * down order processing. Always logs; also sends to Telegram and/or a
 * generic webhook (e.g. Slack) if configured. If neither is set, the log
 * line is the only record - fine for now, but means nobody gets pinged.
 */
export async function sendOpsAlert(message: string, context?: Record<string, unknown>): Promise<void> {
  logger.warn({ context }, `[OPS ALERT] ${message}`);

  await Promise.all([sendTelegramAlert(message, context), sendWebhookAlert(message, context)]);
}

async function sendTelegramAlert(message: string, context?: Record<string, unknown>): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const text = context ? `${message}\n\n${JSON.stringify(context, null, 2)}` : message;

  try {
    await axios.post(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: env.TELEGRAM_CHAT_ID, text },
      { timeout: 5000 }
    );
  } catch (err) {
    logger.error({ err }, "Failed to deliver ops alert to Telegram");
  }
}

async function sendWebhookAlert(message: string, context?: Record<string, unknown>): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return;

  try {
    await axios.post(env.ALERT_WEBHOOK_URL, { text: message, context }, { timeout: 5000 });
  } catch (err) {
    logger.error({ err }, "Failed to deliver ops alert to ALERT_WEBHOOK_URL");
  }
}
