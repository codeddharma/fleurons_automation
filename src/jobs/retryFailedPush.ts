import { logger } from "../lib/logger";

export interface RetryOptions {
  retries?: number;
  delaysMs?: number[];
}

const DEFAULT_DELAYS_MS = [5_000, 30_000, 120_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async operation with a fixed backoff schedule. Throws the last
 * error if all attempts are exhausted so the caller can mark the order failed
 * and alert ops - failures must never be swallowed silently.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  { delaysMs = DEFAULT_DELAYS_MS }: RetryOptions = {}
): Promise<T> {
  const maxAttempts = delaysMs.length + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === maxAttempts;
      logger.warn(
        { attempt, maxAttempts, err },
        isLastAttempt ? "Operation failed on final attempt" : "Operation failed, will retry"
      );
      if (!isLastAttempt) {
        await sleep(delaysMs[attempt - 1]);
      }
    }
  }

  throw lastError;
}
