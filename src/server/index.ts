import type { NoSpaceProvider } from '../types.js';
import { analyze, correct, type JevLunaOptions } from './providers.js';

export { ProviderError } from './providers.js';
export type { JevLunaOptions } from './providers.js';
export { createRequestHandlers } from './http.js';
export type { RequestHandlerOptions } from './http.js';

/** SERVER ONLY. Read credentials from your host's secret store and pass them here. */
export function createJevLunaProvider(options: JevLunaOptions): NoSpaceProvider {
  if (typeof window !== 'undefined') throw new Error('Create the Jev/Luna provider on your server, never in a browser.');
  const config = { ...options };
  return {
    analyze: (input, signal) => analyze(input, config, signal),
    ...(config.openaiKey ? { correct: (input, signal) => correct(input, config, signal) } satisfies Pick<NoSpaceProvider, 'correct'> : {})
  };
}
