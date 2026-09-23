import type { Config, ModelConfig } from './router.ts';

/** One provider quota window. `resetsAt` is epoch milliseconds, or null when the provider omits it. */
export type UsageWindow = { usedPercent: number; resetsAt: number | null };
/**
 * Parsed provider response. `windows` go to Jev for every model in the pool; `named` holds optional
 * per-model windows selected by `usage.modelWindow`; `models` holds provider availability flags by bare model ID.
 */
export type UsageSnapshot = { windows: Record<string, UsageWindow>; named: Record<string, UsageWindow>; models: Record<string, boolean> };
/** A resolved request. `identity` distinguishes accounts so a cached value never crosses logins. */
export type UsageRequest = { identity: string; url: string; headers: Record<string, string> };
export type UsageContext = {
  available: { provider: string; id: string; api?: string; baseUrl?: string }[];
  registry: { getProviderAuth?(provider: string): Promise<{ auth?: { apiKey?: unknown; baseUrl?: unknown } } | undefined> };
};
/** Provider-specific credential lookup and response parsing. Fetching, caching and failure handling live here. */
export type UsageSource = {
  request(ctx: UsageContext): Promise<UsageRequest | undefined>;
  parse(body: unknown): UsageSnapshot | undefined;
};
/** What Jev sees per execution option. `unknown` means no data, never an empty quota. */
export type UsageReport = {
  status: 'ok' | 'stale' | 'unknown';
  pool?: string;
  ageMinutes?: number;
  windows?: Record<string, { remainingPercent: number; resetsInMinutes: number | null }>;
  modelAvailable?: boolean;
};

const DEFAULT_CACHE_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 3000;
// Older data is more misleading than helpful for routing, so it becomes unknown.
const MAX_STALE_MS = 30 * 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

type Entry = { identity?: string; snapshot?: UsageSnapshot; fetchedAt?: number; retryAt: number };
// Process-wide, keyed by source. Every model in a pool shares one account quota and one fetch.
const cache = new Map<string, Entry>();

/** Test hook: the cache otherwise lives for the Pi process. */
export function clearUsageCache(): void { cache.clear(); }

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * Fetch (or reuse) usage for the configured sources of `modelIds`, then report per model.
 * Never throws: every failure degrades to a stale or unknown report so usage cannot block routing.
 */
export async function collectUsage(c: Config, modelIds: string[], sources: Record<string, UsageSource>, ctx: UsageContext,
  signal?: AbortSignal, fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<Record<string, UsageReport>> {
  const cacheMs = (c.usage?.cacheSeconds ?? DEFAULT_CACHE_SECONDS) * 1000;
  const timeoutMs = c.usage?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const models = c.models.filter(m => modelIds.includes(m.id) && m.usage && m.usage.source !== 'none');
  const pools = [...new Set(models.map(m => m.usage!.source))];
  await Promise.all(pools.map(pool => {
    const entry = cache.get(pool) ?? { retryAt: 0 };
    cache.set(pool, entry);
    // Within the cache period (or a provider Retry-After), reuse what we have instead of refetching.
    if (now() < entry.retryAt || !sources[pool]) return;
    return refresh(entry, sources[pool], ctx, cacheMs, timeoutMs, signal, fetcher, now);
  }));
  return Object.fromEntries(models.map(m => [m.id, report(m, cache.get(m.usage!.source), cacheMs, now())]));
}

/** One bounded attempt. Keeps the previous snapshot on transient failures and drops it on auth failures. */
async function refresh(entry: Entry, source: UsageSource, ctx: UsageContext, cacheMs: number, timeoutMs: number,
  signal: AbortSignal | undefined, fetcher: typeof fetch, now: () => number): Promise<void> {
  // Success or failure, the next attempt waits one cache period, so a dead endpoint adds latency at most once per period.
  entry.retryAt = now() + cacheMs;
  try {
    const deadline = AbortSignal.timeout(timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    // Pi's auth lookup cannot be cancelled, so stop waiting for it at the deadline.
    const request = await abortable(source.request(ctx), bounded);
    if (!request) return forget(entry);
    if (request.identity !== entry.identity) forget(entry);
    entry.identity = request.identity;
    const response = await fetcher(request.url, { headers: request.headers, redirect: 'error', signal: bounded });
    if (!response.ok) void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) return forget(entry);
    if (response.status === 429) entry.retryAt = now() + retryAfter(response.headers.get('retry-after'), cacheMs, now());
    if (!response.ok) return;
    const snapshot = source.parse(await response.json());
    if (snapshot) Object.assign(entry, { snapshot, fetchedAt: now() });
  } catch {
    // Errors can carry request details, so they are dropped rather than surfaced. A caller
    // cancellation says nothing about the endpoint, so the next call may try again immediately.
    if (signal?.aborted) entry.retryAt = 0;
  }
}

function forget(entry: Entry): void {
  entry.identity = undefined;
  entry.snapshot = undefined;
  entry.fetchedAt = undefined;
}

/** Convert a cached snapshot to relative, Jev-readable values. Jev has no clock, so reset times are minutes from now. */
function report(m: ModelConfig, entry: Entry | undefined, cacheMs: number, now: number): UsageReport {
  const pool = m.usage!.source;
  const snapshot = entry?.snapshot;
  const age = now - (entry?.fetchedAt ?? 0);
  if (!snapshot || age > MAX_STALE_MS) return { status: 'unknown', pool };
  const windows = { ...snapshot.windows };
  const extra = m.usage!.modelWindow;
  if (extra && snapshot.named[extra]) windows[extra] = snapshot.named[extra];
  const result: UsageReport = {
    status: age <= cacheMs ? 'ok' : 'stale',
    pool,
    windows: Object.fromEntries(Object.entries(windows).map(([name, w]) => [name, {
      remainingPercent: Math.round(100 - w.usedPercent),
      resetsInMinutes: w.resetsAt === null ? null : Math.max(0, Math.round((w.resetsAt - now) / 60_000)),
    }])),
  };
  if (result.status === 'stale') result.ageMinutes = Math.round(age / 60_000);
  // Provider flags use bare model IDs, without the Pi provider prefix.
  const available = snapshot.models[m.id.slice(m.id.indexOf('/') + 1)];
  if (available !== undefined) result.modelAvailable = available;
  return result;
}

/** Retry-After may be seconds or an HTTP date. Never retry sooner than the cache period, nor wait over an hour. */
function retryAfter(value: string | null, minimumMs: number, now: number): number {
  if (!value) return minimumMs;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(minimumMs, delay)) : minimumMs;
}

/** Reject when `signal` aborts even if `promise` never settles. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
