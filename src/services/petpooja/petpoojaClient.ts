import axios from "axios";
import { env } from "../../config/env";
import { PetpoojaPushError } from "../../lib/errors";
import { logger } from "../../lib/logger";

interface SaveOrderPayload {
  orderinfo: {
    OrderInfo: {
      Order: {
        details: {
          orderID: string;
          [key: string]: unknown;
        };
      };
      [key: string]: unknown;
    };
  };
  [key: string]: unknown;
}

/** Shape confirmed against the real sandbox response, 2026-10-12 - not what
 * the "API Guide" PDF implies. `orderID` is Petpooja's own id and may come
 * back empty on acceptance (seemingly populated later); `clientOrderID`
 * echoes the orderID we sent. */
interface SaveOrderResponse {
  success: string;
  message?: string;
  restID?: string;
  clientOrderID?: string;
  orderID?: string;
  code?: number;
}

/**
 * Calls Petpooja's Save Order API for a single outlet. Per Petpooja's API
 * guide, authentication (app_key/app_secret/access_token) travels inside the
 * JSON body alongside the order data, not as headers - and the endpoint is a
 * single fixed URL shared across sandbox and production accounts. The body
 * itself must use Petpooja's nested orderinfo.OrderInfo.* shape - see the
 * comment in mapOrderPayload.ts for how that was confirmed.
 */
export async function saveOrderToPetpooja(payload: SaveOrderPayload): Promise<SaveOrderResponse> {
  const orderID = payload.orderinfo.OrderInfo.Order.details.orderID;

  if (env.PETPOOJA_MOCK_MODE) {
    logger.info({ payload }, "[MOCK] Would push order to Petpooja Save Order API");
    return {
      success: "1",
      message: "[MOCK] Your order is saved.",
      clientOrderID: orderID,
      orderID: `MOCK-${orderID}`,
    };
  }

  try {
    const response = await axios.post<SaveOrderResponse>(env.PETPOOJA_SAVE_ORDER_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15_000,
    });

    if (!response.data || response.data.success !== "1") {
      throw new PetpoojaPushError(response.data?.message ?? "Petpooja rejected the order");
    }

    return response.data;
  } catch (err) {
    if (err instanceof PetpoojaPushError) {
      throw err;
    }
    throw new PetpoojaPushError("Failed to reach Petpooja Save Order API", err);
  }
}
