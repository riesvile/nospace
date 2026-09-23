/** Bound server-directed backoff; a missing/invalid value uses two seconds. */
export function boundedRetryDelay(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1000, Math.min(86400000, value)) : 2000;
}

export function retryDelay(header: string | null): number {
  const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN;
  const date = header ? Date.parse(header) : NaN;
  return boundedRetryDelay(Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : undefined);
}
