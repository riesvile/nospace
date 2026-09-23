import { ProviderError } from './providers.js';

export type ModelRoute = 'analyze' | 'correct' | 'review';

/** Throw from a host quota reservation to return HTTP 429 and Retry-After. */
export class RateLimitError extends ProviderError {
  readonly retryAfter: number;
  constructor(retryAfterSeconds = 2, message = 'Automatic fixes are paused briefly; you can keep typing.') {
    const seconds = Number.isFinite(retryAfterSeconds) ? Math.max(1, Math.min(86400, Math.ceil(retryAfterSeconds))) : 2;
    super(message, 429, seconds * 1000);
    this.retryAfter = seconds;
    this.name = 'RateLimitError';
  }
}
