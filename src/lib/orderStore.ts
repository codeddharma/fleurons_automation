import fs from "fs";
import path from "path";
import { env } from "../config/env";

/**
 * Local fallback record of every order this middleware has seen, as an
 * append-only JSON-lines log - one line per lifecycle event. Shopify and
 * (soon) Petpooja are the real systems of record, so this isn't a database:
 * it exists purely so we have our own durable audit trail (what came in,
 * what happened to it, why) without running a separate database service.
 *
 * An order's "current" status is whatever its most recent line says - fine
 * for an audit log, not meant for high-volume querying.
 */

export type OrderEventType = "received" | "sent_to_pos" | "pos_accepted" | "pos_rejected" | "failed";

// Split from OrderEvent so recordOrderEvent's parameter type doesn't have to
// be derived via Omit<OrderEvent, "timestamp"> - Omit collapses precision on
// interfaces with an index signature, turning every named field into `unknown`.
export interface OrderEventFields {
  event: OrderEventType;
  shopifyOrderId: string;
  shopifyOrderNumber: string;
  outletKey?: string;
  petpoojaOrderId?: string;
  failureReason?: string;
  [key: string]: unknown;
}

export interface OrderEvent extends OrderEventFields {
  timestamp: string;
}

const DATA_DIR = env.DATA_DIR ?? path.join(process.cwd(), "data");
const ORDERS_LOG_PATH = path.join(DATA_DIR, "orders.jsonl");

interface OrderIdentity {
  shopifyOrderId: string;
  shopifyOrderNumber: string;
}

// In-memory indexes rebuilt from the log file at startup, so repeated lookups
// don't require re-scanning the whole file.
const seenOrderIds = new Set<string>();
const petpoojaOrderIdToOrder = new Map<string, OrderIdentity>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ORDERS_LOG_PATH)) return;

  const lines = fs.readFileSync(ORDERS_LOG_PATH, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as OrderEvent;
      seenOrderIds.add(entry.shopifyOrderId);
      if (entry.petpoojaOrderId) {
        petpoojaOrderIdToOrder.set(entry.petpoojaOrderId, {
          shopifyOrderId: entry.shopifyOrderId,
          shopifyOrderNumber: entry.shopifyOrderNumber,
        });
      }
    } catch {
      // Skip malformed lines rather than fail startup over one bad entry.
    }
  }
}

export function hasBeenProcessed(shopifyOrderId: string): boolean {
  ensureLoaded();
  return seenOrderIds.has(shopifyOrderId);
}

export function findOrderByPetpoojaOrderId(petpoojaOrderId: string): OrderIdentity | undefined {
  ensureLoaded();
  return petpoojaOrderIdToOrder.get(petpoojaOrderId);
}

/**
 * Returns every logged event for one order, oldest first - its last entry is
 * the order's current status. Reads the file directly rather than the
 * in-memory index, since that index only tracks ids, not full event bodies.
 */
export function getOrderHistory(shopifyOrderId: string): OrderEvent[] {
  ensureLoaded();
  if (!fs.existsSync(ORDERS_LOG_PATH)) return [];

  const lines = fs.readFileSync(ORDERS_LOG_PATH, "utf8").split("\n").filter(Boolean);
  const history: OrderEvent[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as OrderEvent;
      if (entry.shopifyOrderId === shopifyOrderId) history.push(entry);
    } catch {
      // Skip malformed lines.
    }
  }
  return history;
}

export function recordOrderEvent(entry: OrderEventFields): void {
  ensureLoaded();

  const fullEntry: OrderEvent = { ...entry, timestamp: new Date().toISOString() };
  fs.appendFileSync(ORDERS_LOG_PATH, JSON.stringify(fullEntry) + "\n");

  seenOrderIds.add(entry.shopifyOrderId);
  if (entry.petpoojaOrderId) {
    petpoojaOrderIdToOrder.set(entry.petpoojaOrderId, {
      shopifyOrderId: entry.shopifyOrderId,
      shopifyOrderNumber: entry.shopifyOrderNumber,
    });
  }
}
