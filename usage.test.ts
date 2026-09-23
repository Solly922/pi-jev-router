import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { route, validateConfig, type Config } from './router.ts';
import { clearUsageCache, collectUsage, type UsageContext, type UsageSource } from './usage.ts';
import { claudeUsage } from './usage-claude.ts';
import { codexUsage } from './usage-codex.ts';

const MINUTE = 60_000;
const model = (id: string, usage?: unknown) => ({ id, tier: 't', strengths: ['s'], weaknesses: ['w'],
  thinking: { supported: ['low', 'high'], default: 'low' }, routing: { preferWhen: [], avoidWhen: [] },
  benchmarks: { artificialAnalysis: { intelligenceIndex: null, costPerTask: null } }, ...(usage ? { usage } : {}) });
const config = (): Config => validateConfig({
  timeoutMs: 1000, usage: { cacheSeconds: 60, timeoutMs: 100 },
  models: [model('openai-codex/gpt-6-sol', { source: 'codex' }), model('claude-bridge/opus', { source: 'claude', modelWindow: 'seven_day_opus' }),
    model('meta/muse', { source: 'none' })],
  agents: [{ name: 'Explore', definition: 'Explore.md' }],
});
const ctx: UsageContext = { available: [], registry: {} };
const ids = ['openai-codex/gpt-6-sol', 'claude-bridge/opus', 'meta/muse'];

/** A fake source with a fixed snapshot, so collectUsage's cache and failure handling are tested in isolation. */
function fakeSource(identity = 'account:a'): UsageSource {
  return {
    request: async () => ({ identity, url: 'https://usage.test/', headers: { Authorization: 'Bearer secret-token' } }),
    parse: body => (body as any)?.ok ? { windows: { '7d': { usedPercent: 25, resetsAt: 10 * MINUTE } }, named: {}, models: { 'gpt-6-sol': false } } : undefined,
  };
}
const okFetch = (counter: { calls: number }): typeof fetch => async () => { counter.calls++; return Response.json({ ok: true }); };

test('Codex parser labels windows by duration and keeps per-model availability', () => {
  // Shape from a live wham/usage response on a weekly-only plan.
  const snapshot = codexUsage.parse({ rate_limit: { primary_window: { used_percent: 62, limit_window_seconds: 604800, reset_at: 1790610189 },
    secondary_window: null }, model_usage: { 'gpt-6-astra': { available: true } } });
  assert.deepEqual(snapshot, { windows: { '7d': { usedPercent: 62, resetsAt: 1790610189000 } }, named: {}, models: { 'gpt-6-astra': true } });
  const both = codexUsage.parse({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 101, limit_window_seconds: 604800 } } });
  assert.deepEqual(Object.keys(both!.windows), ['5h'], 'Out-of-range percentages are dropped');
  for (const bad of [null, {}, { rate_limit: {} }, { rate_limit: { primary_window: { used_percent: 5 } } }]) {
    assert.equal(codexUsage.parse(bad), undefined);
  }
});

test('Claude parser reads plan windows, named windows and model-scoped limits', () => {
  // Trimmed from a live /api/oauth/usage response.
  const snapshot = claudeUsage.parse({
    five_hour: { utilization: 8, resets_at: '2026-09-23T22:59:59.540653+00:00' },
    seven_day: { utilization: 1, resets_at: '2026-09-28T05:59:59.540674+00:00' },
    seven_day_opus: { utilization: 40, resets_at: null }, seven_day_sonnet: null,
    extra_usage: { is_enabled: false, utilization: null },
    limits: [{ kind: 'weekly_model', percent: 70, resets_at: null, scope: { model: { display_name: 'Fable' } } }],
  })!;
  assert.deepEqual(snapshot.windows['5h'], { usedPercent: 8, resetsAt: Date.parse('2026-09-23T22:59:59.540653+00:00') });
  assert.equal(snapshot.windows['7d'].usedPercent, 1);
  assert.deepEqual(snapshot.named.seven_day_opus, { usedPercent: 40, resetsAt: null });
  assert.equal(snapshot.named.Fable.usedPercent, 70);
  assert.equal(snapshot.named.extra_usage, undefined);
  assert.equal(claudeUsage.parse({ seven_day_opus: { utilization: 3 } }), undefined, 'Needs a plan window');
});

test('Claude request reads credentials read-only and skips expired or unscoped tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-claude-'));
  const original = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const write = (oauth: object) => writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  try {
    assert.equal(await claudeUsage.request(ctx), undefined, 'Missing file');
    await write({ accessToken: 'claude-secret', expiresAt: Date.now() - 1, scopes: ['user:profile'] });
    assert.equal(await claudeUsage.request(ctx), undefined, 'Expired');
    await write({ accessToken: 'claude-secret', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'] });
    assert.equal(await claudeUsage.request(ctx), undefined, 'No profile scope');
    await write({ accessToken: 'claude-secret', expiresAt: Date.now() + 3_600_000, scopes: ['user:profile'] });
    const request = (await claudeUsage.request(ctx))!;
    assert.equal(request.url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(request.headers.Authorization, 'Bearer claude-secret');
    assert.equal(request.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.ok(!request.identity.includes('claude-secret'));
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Codex request only sends the token to native ChatGPT routes', async () => {
  const jwt = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url')}.y`;
  let lookups = 0;
  const registry = { getProviderAuth: async () => { lookups++; return { auth: { apiKey: jwt } }; } };
  const native = { provider: 'openai-codex', id: 'gpt-6-sol', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' };
  for (const baseUrl of ['https://proxy.test', 'https://user:pass@chatgpt.com/backend-api', 'http://chatgpt.com', 'https://chatgpt.com.evil.test']) {
    assert.equal(await codexUsage.request({ available: [{ ...native, baseUrl }], registry }), undefined, baseUrl);
  }
  assert.equal(lookups, 0, 'A proxied route must not even resolve the token');
  const request = (await codexUsage.request({ available: [native], registry }))!;
  assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(request.headers['ChatGPT-Account-Id'], 'acct-1');
  assert.equal(request.identity, 'account:acct-1');
  const proxiedAuth = { getProviderAuth: async () => ({ auth: { apiKey: jwt, baseUrl: 'https://proxy.test' } }) };
  assert.equal(await codexUsage.request({ available: [native], registry: proxiedAuth }), undefined);
});

test('usage is fetched once per pool, cached, then reported stale and finally unknown', async () => {
  clearUsageCache();
  let time = 0;
  const counter = { calls: 0 };
  const sources = { codex: fakeSource(), claude: fakeSource() };
  const first = await collectUsage(config(), ids, sources, ctx, undefined, okFetch(counter), () => time);
  assert.equal(counter.calls, 2, 'One request per pool; none for source none');
  assert.deepEqual(first['openai-codex/gpt-6-sol'], { status: 'ok', pool: 'codex',
    windows: { '7d': { remainingPercent: 75, resetsInMinutes: 10 } }, modelAvailable: false });
  assert.equal(first['meta/muse'], undefined);

  time = 30_000;
  await collectUsage(config(), ids, sources, ctx, undefined, okFetch(counter), () => time);
  assert.equal(counter.calls, 2, 'Cache hit');

  time = 5 * MINUTE;
  const failing: typeof fetch = async () => { counter.calls++; return new Response('', { status: 500 }); };
  const stale = await collectUsage(config(), ids, sources, ctx, undefined, failing, () => time);
  assert.equal(stale['openai-codex/gpt-6-sol'].status, 'stale');
  assert.equal(stale['openai-codex/gpt-6-sol'].ageMinutes, 5);
  assert.equal(stale['openai-codex/gpt-6-sol'].windows!['7d'].resetsInMinutes, 5, 'Reset time stays relative to now');

  time = 31 * MINUTE;
  const old = await collectUsage(config(), ids, sources, ctx, undefined, failing, () => time);
  assert.deepEqual(old['openai-codex/gpt-6-sol'], { status: 'unknown', pool: 'codex' });
});

test('auth failures and account changes drop cached usage; 429 honors Retry-After', async () => {
  clearUsageCache();
  let time = 0;
  const counter = { calls: 0 };
  await collectUsage(config(), ids, { codex: fakeSource(), claude: fakeSource() }, ctx, undefined, okFetch(counter), () => time);
  time = 2 * MINUTE;
  const denied: typeof fetch = async () => new Response('', { status: 401 });
  const afterDenied = await collectUsage(config(), ids, { codex: fakeSource(), claude: fakeSource() }, ctx, undefined, denied, () => time);
  assert.equal(afterDenied['openai-codex/gpt-6-sol'].status, 'unknown');

  clearUsageCache();
  time = 0;
  await collectUsage(config(), ids, { codex: fakeSource('account:a'), claude: fakeSource() }, ctx, undefined, okFetch(counter), () => time);
  time = 2 * MINUTE;
  const broken: typeof fetch = async () => new Response('', { status: 500 });
  const switched = await collectUsage(config(), ids, { codex: fakeSource('account:b'), claude: fakeSource() }, ctx, undefined, broken, () => time);
  assert.equal(switched['openai-codex/gpt-6-sol'].status, 'unknown', 'Another account never sees the old value');

  clearUsageCache();
  time = 0;
  counter.calls = 0;
  const limited: typeof fetch = async () => { counter.calls++; return new Response('', { status: 429, headers: { 'retry-after': '600' } }); };
  await collectUsage(config(), ids, { codex: fakeSource(), claude: fakeSource() }, ctx, undefined, limited, () => time);
  time = 5 * MINUTE;
  await collectUsage(config(), ids, { codex: fakeSource(), claude: fakeSource() }, ctx, undefined, limited, () => time);
  assert.equal(counter.calls, 2, 'No refetch before Retry-After, even past the cache period');
});

test('a 401 without a body still clears cached usage', async () => {
  clearUsageCache();
  let time = 0;
  const sources = { codex: fakeSource(), claude: fakeSource() };
  await collectUsage(config(), ids, sources, ctx, undefined, okFetch({ calls: 0 }), () => time);
  time = 2 * MINUTE;
  const empty: typeof fetch = async () => new Response(null, { status: 401 });
  const result = await collectUsage(config(), ids, sources, ctx, undefined, empty, () => time);
  assert.equal(result['openai-codex/gpt-6-sol'].status, 'unknown');
});

test('throwing sources, fetchers and bodies never reject collectUsage', async () => {
  const throwing: UsageSource = { request: async () => { throw new Error('boom'); }, parse: () => undefined };
  const badParse: UsageSource = { ...fakeSource(), parse: () => { throw new Error('boom'); } };
  for (const [sources, fetcher] of [
    [{ codex: throwing, claude: badParse }, okFetch({ calls: 0 })],
    [{ codex: fakeSource(), claude: fakeSource() }, (() => { throw new Error('sync'); }) as typeof fetch],
    [{ codex: fakeSource(), claude: fakeSource() }, (async () => new Response('not json')) as typeof fetch],
  ] as const) {
    clearUsageCache();
    const result = await collectUsage(config(), ids, sources, ctx, undefined, fetcher, () => 0);
    assert.equal(result['openai-codex/gpt-6-sol'].status, 'unknown');
    assert.equal(result['claude-bridge/opus'].status, 'unknown');
  }
});

test('caller cancellation leaves the next call free to fetch immediately', async () => {
  clearUsageCache();
  const controller = new AbortController();
  const counter = { calls: 0 };
  const aborting: typeof fetch = async () => { counter.calls++; controller.abort(); throw new Error('aborted'); };
  await collectUsage(config(), ids, { codex: fakeSource(), claude: fakeSource() }, ctx, controller.signal, aborting, () => 0);
  const result = await collectUsage(config(), ids, { codex: fakeSource(), claude: fakeSource() }, ctx, undefined, okFetch(counter), () => 1);
  assert.equal(counter.calls, 4, 'Two aborted attempts, then two real fetches');
  assert.equal(result['openai-codex/gpt-6-sol'].status, 'ok');
});

test('a hanging credential lookup or request is bounded and reported unknown', async () => {
  clearUsageCache();
  const hanging: UsageSource = { request: () => new Promise(() => {}), parse: () => undefined };
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const started = Date.now();
    const result = await collectUsage(config(), ids, { codex: hanging, claude: fakeSource() }, ctx, undefined,
      (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('deadline')))));
    assert.ok(Date.now() - started < 1000);
    assert.equal(result['openai-codex/gpt-6-sol'].status, 'unknown');
    assert.equal(result['claude-bridge/opus'].status, 'unknown');
  } finally { clearTimeout(keepAlive); }
});

test('modelWindow adds the configured Claude window for that model only', async () => {
  clearUsageCache();
  const claude: UsageSource = { ...fakeSource(), parse: () => ({ windows: { '5h': { usedPercent: 10, resetsAt: null } },
    named: { seven_day_opus: { usedPercent: 90, resetsAt: null } }, models: {} }) };
  const result = await collectUsage(config(), ids, { codex: fakeSource(), claude }, ctx, undefined, okFetch({ calls: 0 }), () => 0);
  assert.deepEqual(result['claude-bridge/opus'].windows, { '5h': { remainingPercent: 90, resetsInMinutes: null },
    seven_day_opus: { remainingPercent: 10, resetsInMinutes: null } });
});

test('Jev receives usage reports, not config plumbing or tokens', async () => {
  clearUsageCache();
  const c = config();
  const usage = await collectUsage(c, ids, { codex: fakeSource(), claude: fakeSource() }, ctx, undefined, okFetch({ calls: 0 }), () => 0);
  let body: any;
  const fetcher: typeof fetch = async (_url, init) => {
    body = init!.body as string;
    return Response.json({ answers: { execution: { type: 'choice', choice: 'option_0' } } });
  };
  await route(c, { prompt: 'Refactor login.', description: 'Refactor login' }, [{ name: 'Explore', description: 'd' }],
    undefined, fetcher, 'key', usage);
  assert.ok(!body.includes('secret-token'));
  const execution = JSON.parse(body).questions.execution;
  assert.match(execution.instructions, /remaining subscription usage/);
  assert.equal(execution.criteria.option_0.usage.status, 'ok');
  assert.equal(execution.criteria.option_4.usage.status, 'unknown', 'Source none still tells Jev there is no data');

  await route(c, { prompt: 'Refactor login.', description: 'Refactor login' }, [{ name: 'Explore', description: 'd' }],
    undefined, fetcher, 'key');
  const plain = JSON.parse(body).questions.execution;
  assert.doesNotMatch(plain.instructions, /subscription usage/);
  assert.equal(plain.criteria.option_0.usage, undefined, 'The configured source block is never sent');
});

test('usage config is validated', () => {
  const base = config();
  for (const bad of [
    { ...base, usage: { cacheSeconds: 1 } },
    { ...base, usage: [] },
    { ...base, usage: { timeoutMs: 50_000 } },
    { ...base, models: [model('a/b', { source: 'gemini' })] },
    { ...base, models: [model('a/b', { source: 'codex', modelWindow: 'seven_day_opus' })] },
    { ...base, models: [model('a/b', { source: 'claude', modelWindow: ' ' })] },
  ]) assert.throws(() => validateConfig(bad), /usage|Invalid Jev model/);
});
