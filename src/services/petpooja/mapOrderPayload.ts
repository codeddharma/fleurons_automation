import { Outlet } from "../../config/outlets";
import { ItemNotMappedError } from "../../lib/errors";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";

interface ShopifyTaxLine {
  title: string;
  price: string;
  rate: number;
}

interface ShopifyLineItem {
  sku: string | null;
  variant_id: number | string | null;
  product_id: number | string | null;
  name: string;
  quantity: number;
  price: string;
  properties?: { name: string; value: string }[];
  tax_lines?: ShopifyTaxLine[];
}

interface ShopifyCustomer {
  first_name?: string;
  last_name?: string;
  phone?: string | null;
  email?: string;
}

interface ShopifyAddress {
  name?: string;
  first_name?: string;
  last_name?: string;
  phone?: string | null;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  latitude?: number | null;
  longitude?: number | null;
}

interface ShopifyMoneySet {
  shop_money: { amount: string };
}

export interface ShopifyOrderForMapping {
  id: number | string;
  order_number: number | string;
  line_items: ShopifyLineItem[];
  customer?: ShopifyCustomer;
  email?: string;
  contact_email?: string;
  shipping_address?: ShopifyAddress;
  billing_address?: ShopifyAddress;
  total_price: string;
  total_tax?: string;
  taxes_included?: boolean;
  total_shipping_price_set?: ShopifyMoneySet;
  financial_status?: string;
  payment_gateway_names?: string[];
  created_at?: string;
  note?: string | null;
}

function firstNonEmpty(...values: (string | undefined | null)[]): string | undefined {
  return values.find((v) => typeof v === "string" && v.trim().length > 0)?.trim();
}

function formatAddress(address?: ShopifyAddress): string {
  if (!address) return "";
  return [address.address1, address.address2, address.city, address.province, address.zip]
    .filter(Boolean)
    .join(", ");
}

/**
 * Resolves the actual deliverable contact for the order. In practice
 * `customer.phone`/`customer.email` are frequently null on guest checkouts -
 * `shipping_address` (falling back to `billing_address`) is where the real
 * delivery name/phone reliably show up, confirmed against a live Fleurons
 * order payload.
 */
export function resolveCustomerContact(shopifyOrder: ShopifyOrderForMapping) {
  const address = shopifyOrder.shipping_address ?? shopifyOrder.billing_address;
  const addressFullName = [address?.first_name, address?.last_name].filter(Boolean).join(" ");
  const customerFullName = [shopifyOrder.customer?.first_name, shopifyOrder.customer?.last_name]
    .filter(Boolean)
    .join(" ");

  return {
    name: firstNonEmpty(address?.name, addressFullName, customerFullName) ?? "Website Customer",
    phone: firstNonEmpty(address?.phone, shopifyOrder.customer?.phone),
    email: firstNonEmpty(shopifyOrder.email, shopifyOrder.contact_email, shopifyOrder.customer?.email),
    address: formatAddress(address),
    latitude: address?.latitude ?? undefined,
    longitude: address?.longitude ?? undefined,
  };
}

export interface MappedOrderItem {
  sku: string | null;
  name: string;
  quantity: number;
  price: number;
  petpoojaItemId: string;
  taxLines: ShopifyTaxLine[];
}

/**
 * Finds this line item's Petpooja mapping. SKU is tried first since it's the
 * clearest identifier when present, but plenty of Shopify products don't
 * have one set - variant id, then product id, are reliable fallbacks that
 * Shopify always populates, so a blank SKU alone doesn't block the order.
 */
function findItemMapping(outlet: Outlet, lineItem: ShopifyLineItem) {
  if (lineItem.sku) {
    const bySku = outlet.itemMap.find((entry) => entry.shopifySku === lineItem.sku);
    if (bySku) return bySku;
  }
  if (lineItem.variant_id != null) {
    const byVariant = outlet.itemMap.find((entry) => entry.shopifyVariantId === String(lineItem.variant_id));
    if (byVariant) return byVariant;
  }
  if (lineItem.product_id != null) {
    const byProduct = outlet.itemMap.find((entry) => entry.shopifyProductId === String(lineItem.product_id));
    if (byProduct) return byProduct;
  }
  return undefined;
}

/**
 * Maps Shopify line items to Petpooja item IDs via the outlet's itemMap.
 * Throws if none of SKU/variant id/product id resolve a mapping - a
 * partially-mapped order must never be pushed to the POS, since staff would
 * prepare the wrong thing.
 */
export function mapLineItems(shopifyOrder: ShopifyOrderForMapping, outlet: Outlet): MappedOrderItem[] {
  return shopifyOrder.line_items.map((lineItem) => {
    const mapping = findItemMapping(outlet, lineItem);

    if (!mapping) {
      const identifier =
        lineItem.sku ??
        (lineItem.variant_id != null ? `variant:${lineItem.variant_id}` : undefined) ??
        (lineItem.product_id != null ? `product:${lineItem.product_id}` : undefined) ??
        "(no identifier)";
      throw new ItemNotMappedError(identifier, outlet.outletKey);
    }

    return {
      sku: lineItem.sku,
      name: lineItem.name,
      quantity: lineItem.quantity,
      price: Number(lineItem.price),
      petpoojaItemId: mapping.petpoojaItemId,
      taxLines: lineItem.tax_lines ?? [],
    };
  });
}

/** Splits a Shopify ISO timestamp (already in the store's local offset, e.g.
 * "2026-09-05T13:09:56+05:30") into Petpooja's expected date/time strings,
 * without any timezone conversion - the local wall-clock values are exactly
 * what's embedded before the offset. */
function splitShopifyTimestamp(iso: string): { date: string; time: string } {
  const match = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (!match) throw new Error(`Unexpected Shopify timestamp format: ${iso}`);
  return { date: match[1], time: match[2] };
}

/** Best-effort COD vs online mapping from Shopify's payment gateway names. */
function resolvePaymentType(shopifyOrder: ShopifyOrderForMapping): "COD" | "ONLINE" {
  const gateways = (shopifyOrder.payment_gateway_names ?? []).map((g) => g.toLowerCase());
  const isCod = gateways.some((g) => g.includes("cod") || g.includes("cash on delivery"));
  return isCod ? "COD" : "ONLINE";
}

function buildItemTax(taxLines: ShopifyTaxLine[]) {
  return taxLines.map((line, index) => ({
    id: String(index + 1),
    name: line.title,
    tax_percentage: String(Number(line.rate) * 100),
    amount: line.price,
  }));
}

/**
 * Builds the Petpooja Save Order API request body.
 *
 * IMPORTANT: Petpooja's "API Guide for Placing Orders" PDF describes the
 * fields but shows them as a flat structure - that's NOT what the live
 * endpoint actually accepts. Confirmed empirically against the sandbox
 * (2026-10-12): a flat body gets `{"success":"0","message":"Invalid order
 * relay payload"}` every time, while wrapping the same fields in Petpooja's
 * standard aggregator-API shape - `orderinfo.OrderInfo.{Restaurant,Customer,
 * Order,OrderItem,Tax}`, each with a `details` wrapper - returns
 * `{"success":"1","message":"Your order is saved."}`. Keep this nesting.
 *
 * Fields flagged TODO below are business decisions (not guesses at the API
 * shape itself) that should be confirmed with Fleurons ops / the Petpooja
 * account manager once real orders are flowing - defaults here are safe
 * placeholders, not the final answer.
 */
export function buildPetpoojaSaveOrderPayload(
  shopifyOrder: ShopifyOrderForMapping,
  outlet: Outlet,
  items: MappedOrderItem[]
) {
  const contact = resolveCustomerContact(shopifyOrder);
  const { date: preorder_date, time: preorder_time } = splitShopifyTimestamp(
    shopifyOrder.created_at ?? new Date().toISOString()
  );
  const created_on = `${preorder_date} ${preorder_time}`;

  if (!env.PUBLIC_BASE_URL && !env.PETPOOJA_MOCK_MODE) {
    logger.warn(
      "PUBLIC_BASE_URL is not set - the callback_url sent to Petpooja won't be reachable, so order status updates (accept/reject/Food Ready) won't arrive"
    );
  }
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`;

  const taxInclusive = shopifyOrder.taxes_included ?? false;

  return {
    app_key: env.PETPOOJA_APP_KEY,
    app_secret: env.PETPOOJA_APP_SECRET,
    access_token: env.PETPOOJA_ACCESS_TOKEN,

    orderinfo: {
      OrderInfo: {
        Restaurant: {
          details: {
            restID: outlet.petpoojaRestId,
          },
        },

        Customer: {
          details: {
            name: contact.name,
            address: contact.address,
            phone: contact.phone ?? "",
            email: contact.email ?? "",
            latitude: contact.latitude != null ? String(contact.latitude) : "",
            longitude: contact.longitude != null ? String(contact.longitude) : "",
          },
        },

        Order: {
          details: {
            orderID: `SHOPIFY-${shopifyOrder.order_number}`,
            preorder_date,
            preorder_time,
            advanced_order: "N" as const, // TODO: derive "Y" from a future delivery Date property once scheduled orders matter
            order_type: "H" as const, // Home Delivery - website orders are always delivery today
            total: shopifyOrder.total_price,
            discount_total: "0",
            discount_type: "F" as const,
            tax_total: shopifyOrder.total_tax ?? "0",
            description: shopifyOrder.note ?? "",
            created_on,
            dc_tax_percentage: "0", // TODO: confirm actual GST rate on delivery charges with Petpooja/Fleurons accounts
            pc_tax_percentage: "0", // TODO: confirm actual GST rate on packing charges
            payment_type: resolvePaymentType(shopifyOrder), // TODO: confirm gateway-name heuristic covers all real payment methods used
            delivery_charges: shopifyOrder.total_shipping_price_set?.shop_money.amount ?? "0",
            enable_delivery: 0 as const, // 0 = third-party rider - TODO: confirm with Fleurons ops once delivery automation (Phase 2) is decided
            callback_url: `${publicBaseUrl}/webhooks/petpooja/status`,
            packing_charges: "0",
            service_charge: "0",
          },
        },

        OrderItem: {
          details: items.map((item) => ({
            id: item.petpoojaItemId,
            name: item.name,
            tax_inclusive: taxInclusive,
            tax_percentage: String(
              item.taxLines.reduce((sum, line) => sum + Number(line.rate) * 100, 0)
            ),
            item_discount: "",
            price: item.price.toFixed(2),
            final_price: item.price.toFixed(2),
            quantity: String(item.quantity),
            gst_liability: "restaurant" as const, // TODO: confirm with Petpooja account setup
            item_tax: buildItemTax(item.taxLines),
            variation_name: "",
            variation_id: "",
            addon_items: [] as { id: string; name: string; price: string; quantity: string }[],
          })),
        },

        Tax: {
          details: items.flatMap((item) =>
            item.taxLines.map((line, index) => ({
              id: `${item.petpoojaItemId}-${index + 1}`,
              title: line.title,
              type: "P" as const,
              price: `${Number(line.rate) * 100}%`,
              tax: line.price,
              restaurant_liable_amt: line.price, // TODO: confirm vendor vs restaurant liability split
            }))
          ),
        },

        Discount: { details: [] as unknown[] },
      },
    },
  };
}
