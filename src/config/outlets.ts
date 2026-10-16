export interface ItemMapEntry {
  // At least one of these three should be set. SKU is preferred when
  // present, but many products don't have one set in Shopify, so
  // variant/product id are here as fallbacks - see mapLineItems.
  shopifySku?: string;
  shopifyVariantId?: string;
  shopifyProductId?: string;
  petpoojaItemId: string;
}

export interface Outlet {
  outletKey: string;
  name: string;
  petpoojaRestId: string;
  isActive: boolean;
  // Only one outlet exists today, so every order routes here unless the
  // order carries an explicit outlet key. Once the storefront gains real
  // per-outlet selection, add more entries below (isDefault: false on the
  // rest) and whatever attribute/property carries the chosen outletKey.
  isDefault: boolean;
  itemMap: ItemMapEntry[];
}

// TODO: itemMap still needs the real Shopify -> Petpooja item mapping -
// restID below is the sandbox "Menu sharing code" from Petpooja's Configuration page.
export const outlets: Outlet[] = [
  {
    outletKey: "default",
    name: "Fleurons (default outlet)",
    petpoojaRestId: "qicp50k27a",
    isActive: true,
    isDefault: true,
    itemMap: [
      { shopifyVariantId: "44289163886775", petpoojaItemId: "29331" },
      { shopifyVariantId: "44289163952311", petpoojaItemId: "29331" },
    ],
  },
];
