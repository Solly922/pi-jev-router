import { createHash } from 'node:crypto';
import { isPercent, record, type UsageSource, type UsageWindow } from './usage.ts';

const ORIGIN = 'https://chatgpt.com';

/** Models and auth can be proxied through models.json. Only send the ChatGPT token back to ChatGPT. */
function isNative(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === ORIGIN && !parsed.username && !parsed.password;
  } catch { return false; }
}

/** Unverified JWT decoding, used only to key the cache and route the request, never for authorization. */
function accountId(token: string): string | undefined {
  try {
    const payload = record(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')));
    const id = record(payload?.['https://api.openai.com/auth'])?.chatgpt_account_id;
    return typeof id === 'string' && /^[\w-]{1,256}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

/** Label by duration, not position: the primary window is weekly on some plans and 5-hour on others. */
function windowLabel(seconds: number): string {
  if (seconds === 18_000) return '5h';
  if (seconds === 604_800) return '7d';
  return `${Math.round(seconds / 3600)}h`;
}

/** ChatGPT subscription usage, shared by every openai-codex model. Uses Pi's own provider auth. */
export const codexUsage: UsageSource = {
  async request({ available, registry }) {
    const models = available.filter(m => m.provider === 'openai-codex');
    if (!models.length || models.some(m => m.api !== 'openai-codex-responses' || !isNative(m.baseUrl)) ||
        typeof registry.getProviderAuth !== 'function') return undefined;
    const auth = (await registry.getProviderAuth('openai-codex'))?.auth;
    // Native OAuth omits baseUrl. A present, foreign baseUrl means requests are proxied elsewhere.
    if (typeof auth?.apiKey !== 'string' || !auth.apiKey || (auth.baseUrl !== undefined && !isNative(auth.baseUrl))) return undefined;
    const account = accountId(auth.apiKey);
    return {
      identity: account ? `account:${account}` : `token:${createHash('sha256').update(auth.apiKey).digest('hex')}`,
      url: `${ORIGIN}/backend-api/wham/usage`,
      headers: {
        Authorization: `Bearer ${auth.apiKey}`, Accept: 'application/json', originator: 'pi',
        ...(account ? { 'ChatGPT-Account-Id': account } : {}),
      },
    };
  },

  parse(body) {
    const limits = record(record(body)?.rate_limit);
    if (!limits) return undefined;
    const windows: Record<string, UsageWindow> = {};
    for (const raw of [limits.primary_window, limits.secondary_window]) {
      const w = record(raw);
      const seconds = w?.limit_window_seconds;
      if (!w || !isPercent(w.used_percent) || typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0) continue;
      const resetsAt = typeof w.reset_at === 'number' && Number.isFinite(w.reset_at) ? w.reset_at * 1000 : null;
      windows[windowLabel(seconds)] = { usedPercent: w.used_percent, resetsAt };
    }
    if (!Object.keys(windows).length) return undefined;
    // model_usage reports per-model availability, e.g. { "gpt-6-astra": { "available": true } }.
    const models: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(record(record(body)?.model_usage) ?? {})) {
      const available = record(value)?.available;
      if (typeof available === 'boolean') models[id] = available;
    }
    return { windows, named: {}, models };
  },
};
