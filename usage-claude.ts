import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPercent, record, type UsageSource, type UsageWindow } from './usage.ts';

// Claude Code refreshes tokens it is about to use. A token this close to expiry is left alone.
const EXPIRY_MARGIN_MS = 60_000;

function parseWindow(utilization: unknown, resetsAt: unknown): UsageWindow | undefined {
  if (!isPercent(utilization)) return undefined;
  const time = typeof resetsAt === 'string' ? Date.parse(resetsAt) : NaN;
  return { usedPercent: utilization, resetsAt: Number.isFinite(time) ? time : null };
}

/**
 * Claude plan usage via the endpoint Claude Code's /usage command calls. pi-claude-bridge runs on the
 * same Claude Code login, so this is the bridge's quota. The credential file is read only; this never
 * refreshes or writes tokens, because Claude Code owns rotation.
 */
export const claudeUsage: UsageSource = {
  async request() {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    let oauth: Record<string, unknown> | undefined;
    try { oauth = record(record(JSON.parse(await readFile(join(dir, '.credentials.json'), 'utf8')))?.claudeAiOauth); }
    catch { return undefined; } // Missing (e.g. macOS keychain) or unreadable: usage is unknown.
    const token = oauth?.accessToken;
    if (typeof token !== 'string' || !token || typeof oauth!.expiresAt !== 'number' ||
        oauth!.expiresAt <= Date.now() + EXPIRY_MARGIN_MS) return undefined;
    // The usage endpoint requires the profile scope. Files without a scopes list are tried anyway;
    // a 401/403 then clears the cache, costing one request.
    if (Array.isArray(oauth!.scopes) && !oauth!.scopes.includes('user:profile')) return undefined;
    return {
      identity: `token:${createHash('sha256').update(token).digest('hex')}`,
      url: 'https://api.anthropic.com/api/oauth/usage',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
    };
  },

  parse(body) {
    const b = record(body);
    if (!b) return undefined;
    // Every top-level window (five_hour, seven_day, seven_day_opus, ...) is selectable by key.
    const named: Record<string, UsageWindow> = {};
    for (const [key, value] of Object.entries(b)) {
      const window = parseWindow(record(value)?.utilization, record(value)?.resets_at);
      if (window) named[key] = window;
    }
    // Model-scoped weekly limits appear in limits[] under their display name, e.g. "Fable".
    for (const raw of Array.isArray(b.limits) ? b.limits : []) {
      const limit = record(raw);
      const name = record(record(limit?.scope)?.model)?.display_name;
      const window = parseWindow(limit?.percent, limit?.resets_at);
      if (typeof name === 'string' && name.trim() && window) named[name] = window;
    }
    const windows: Record<string, UsageWindow> = {};
    if (named.five_hour) windows['5h'] = named.five_hour;
    if (named.seven_day) windows['7d'] = named.seven_day;
    return Object.keys(windows).length ? { windows, named, models: {} } : undefined;
  },
};
