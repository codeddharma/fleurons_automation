import { outlets, Outlet } from "../../config/outlets";
import { DefaultOutletNotConfiguredError, OutletClosedError, OutletNotFoundError } from "../../lib/errors";

interface ShopifyLineItemProperty {
  name: string;
  value: string;
}

interface ShopifyLineItemLike {
  properties?: ShopifyLineItemProperty[];
}

interface ShopifyOrderLike {
  line_items: ShopifyLineItemLike[];
}

export interface DeliveryArea {
  city?: string;
  area: string;
}

function findProperty(properties: ShopifyLineItemProperty[] | undefined, name: string): string | undefined {
  const match = properties?.find((p) => p.name.toLowerCase() === name.toLowerCase());
  return match?.value?.trim() || undefined;
}

/**
 * Looks for the delivery City/Area captured by the storefront's per-product
 * delivery-details widget (line_items[].properties). Not every order has
 * this - orders for Pan-India/standard-shipped items (Gift Hampers, some
 * Cookies) never show it, since they're shipped by courier rather than
 * fulfilled from a specific kitchen. Returns null for those - it's an
 * expected, non-error case, not a missing-data problem.
 */
export function extractDeliveryArea(shopifyOrder: ShopifyOrderLike): DeliveryArea | null {
  for (const lineItem of shopifyOrder.line_items) {
    const area = findProperty(lineItem.properties, "Area");
    if (area) {
      return { area, city: findProperty(lineItem.properties, "City") };
    }
  }
  return null;
}

/**
 * Looks for an explicit outlet selection on the order (a line item property
 * named "Outlet"). Nothing on the storefront sets this today - it's a hook
 * for when real per-outlet selection is built, so that code path works
 * without further changes here.
 */
export function extractExplicitOutletKey(shopifyOrder: ShopifyOrderLike): string | undefined {
  for (const lineItem of shopifyOrder.line_items) {
    const outletKey = findProperty(lineItem.properties, "Outlet");
    if (outletKey) return outletKey;
  }
  return undefined;
}

/**
 * Resolves the outlet an order should be routed to: an explicit outlet key
 * if the order carries one, otherwise whichever Outlet is flagged as the
 * default (today, that's the only outlet that exists).
 */
export function resolveOutlet(explicitOutletKey?: string): Outlet {
  const outlet = explicitOutletKey
    ? outlets.find((o) => o.outletKey === explicitOutletKey)
    : outlets.find((o) => o.isDefault);

  if (!outlet) {
    throw explicitOutletKey ? new OutletNotFoundError(explicitOutletKey) : new DefaultOutletNotConfiguredError();
  }

  if (!outlet.isActive) {
    throw new OutletClosedError(outlet.outletKey);
  }

  return outlet;
}
