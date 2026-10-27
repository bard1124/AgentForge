import { AuthenticationError, CursorSdkError, NetworkError, RateLimitError } from "@cursor/sdk";

const TRANSIENT_MESSAGE = /fetch failed|network request failed|failed to connect|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|\b50[234]\b|timed? ?out|rate limit|resume attempts made no progress|connection (was interrupted|failed|stalled)/i;

export function isTransientMessage(message: string | undefined): boolean {
  return !!message && TRANSIENT_MESSAGE.test(message);
}

/** The SDK leaves `isRetryable` false on many connection failures, so the class and message are checked too. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof AuthenticationError) return false;
  if (err instanceof CursorSdkError) {
    return err.isRetryable || err instanceof NetworkError || err instanceof RateLimitError || isTransientMessage(err.message);
  }
  return err instanceof Error && isTransientMessage(err.message);
}
