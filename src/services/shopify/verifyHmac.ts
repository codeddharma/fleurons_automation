import crypto from "crypto";

/**
 * Verifies the X-Shopify-Hmac-Sha256 header against the raw request body.
 * Must be computed over the raw (unparsed) body - re-serializing JSON before
 * verifying will produce a different byte sequence and always fail.
 */
export function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) {
    return false;
  }

  const computedHmac = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");

  const computedBuffer = Buffer.from(computedHmac, "utf8");
  const headerBuffer = Buffer.from(hmacHeader, "utf8");

  if (computedBuffer.length !== headerBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(computedBuffer, headerBuffer);
}
