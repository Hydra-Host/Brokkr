// Shared bounded-reconnect budget for the SPA's streaming transports: retry up to MAX_STREAM_RETRIES
// with exponential backoff; only a connection open at least STREAM_STABLE_MS before dropping refreshes the budget.
export const MAX_STREAM_RETRIES = 5;
export const STREAM_STABLE_MS = 4000;
