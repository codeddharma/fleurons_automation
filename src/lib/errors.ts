export class OutletNotFoundError extends Error {
  constructor(outletKey: string) {
    super(`No outlet registered for key "${outletKey}"`);
    this.name = "OutletNotFoundError";
  }
}

export class OutletClosedError extends Error {
  constructor(outletKey: string) {
    super(`Outlet "${outletKey}" is not currently active`);
    this.name = "OutletClosedError";
  }
}

export class DefaultOutletNotConfiguredError extends Error {
  constructor() {
    super("No default outlet is configured - exactly one Outlet document must have isDefault: true");
    this.name = "DefaultOutletNotConfiguredError";
  }
}

export class ItemNotMappedError extends Error {
  constructor(sku: string, outletKey: string) {
    super(`SKU "${sku}" has no Petpooja item mapping for outlet "${outletKey}"`);
    this.name = "ItemNotMappedError";
  }
}

export class PetpoojaPushError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PetpoojaPushError";
  }
}
