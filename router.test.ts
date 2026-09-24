import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { route, rpc, validateConfig, type Config, type Input } from './router.ts';

const config = (): Config => validateConfig({
  timeoutMs: 100,
  models: [
    { id: 'local/cheap', tier: 'fast-economy', strengths: ['lookups'], weaknesses: ['hard-debugging'],
      thinking: { supported: ['low'], default: 'low' },
      routing: { preferWhen: ['task_is_search'], avoidWhen: ['task_is_high_risk'], escalateTo: 'local/strong' },
      benchmarks: { artificialAnalysis: { intelligenceIndex: null, costPerTask: null } } },
    { id: 'local/strong', tier: 'expert', strengths: ['debugging'], weaknesses: ['cost'],
      thinking: { supported: ['medium', 'high'], default: 'medium' },
      routing: { preferWhen: ['task_is_complex'], avoidWhen: [] },
      benchmarks: { artificialAnalysis: { intelligenceIndex: 80, costPerTask: 2.5 } } },
  ],
  agents: [{ name: 'Explore', definition: 'Explore.md' }, { name: 'architect', definition: 'architect.md' }],
});
const agents = [{ name: 'Explore', description: 'Locate files' }, { name: 'architect', description: 'Architecture decisions' }];
const task: Input = { prompt: 'Find the login module.', description: 'Find login module' };
const answer = (choice: string) => ({ type: 'choice', choice });

test('distributed model catalog uses the new schema and keeps Muse max advisory', () => {
  const example = validateConfig(JSON.parse(readFileSync(new URL('./config.example.json', import.meta.url), 'utf8')));
  assert.deepEqual(example.models.map(m => m.id), [
    'openai-codex/gpt-6-astra', 'openai-codex/gpt-6-sol', 'openai-codex/gpt-6-luna',
    'meta/muse-spark-1.3-contributor',
  ]);
  assert.deepEqual(example.models[3].thinking, { supported: ['xhigh', 'max'], default: 'max' });
  assert.equal(example.models[3].routing.escalateTo, 'openai-codex/gpt-6-sol');
  assert.equal(example.models[3].benchmarks.artificialAnalysis.intelligenceIndex, null);
});

// Stub only the HTTP boundary. Candidate construction and validation remain real.
test('one Jev request selects an agent and a compatible model/thinking pair', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async (url, init) => {
    requests++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.state.task, task.prompt);
    assert.equal(body.state.notes, undefined);
    assert.deepEqual(Object.keys(body.questions), ['agent', 'execution']);
    const candidate = body.questions.execution.criteria.option_0;
    assert.equal(candidate.selectedThinking, 'low');
    assert.equal(candidate.tier, 'fast-economy');
    assert.equal(candidate.grades, undefined);
    assert.deepEqual(candidate.strengths, ['lookups']);
    assert.deepEqual(candidate.routing.preferWhen, ['task_is_search']);
    assert.equal(candidate.routing.escalateTo, 'local/strong');
    assert.equal(candidate.thinking.default, 'low');
    assert.equal(candidate.benchmarks.artificialAnalysis.intelligenceIndex, null);
    return Response.json({ answers: { agent: answer('Explore'), execution: answer('option_0') } });
  };
  assert.deepEqual(await route(config(), task, agents, undefined, fetcher, 'test-key'),
    { agent: 'Explore', model: 'local/cheap', thinking: 'low', source: 'jev' });
  assert.equal(requests, 1);
});

test('user notes and model grades reach Jev as advisory routing context', async () => {
  const c = validateConfig({ ...config(), notes: ['Prefer local/strong for frontend work.'], models: [
    { ...config().models[0], grades: { frontend: 9 } },
    { ...config().models[1], grades: { frontend: 10 } },
  ] });
  const result = await route(c, task, agents, undefined, async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.deepEqual(body.state.notes, c.notes);
    assert.deepEqual(body.questions.execution.criteria.option_0.grades, { frontend: 9 });
    assert.deepEqual(body.questions.execution.criteria.option_1.grades, { frontend: 10 });
    assert.match(body.questions.execution.instructions, /Task adequacy comes first/);
    // Grades guide Jev; they never force the highest-scored option.
    return Response.json({ answers: { agent: answer('Explore'), execution: answer('option_0') } });
  }, 'test-key');
  assert.equal(result.model, 'local/cheap');
});

test('notes and grades are optional but reject malformed values', () => {
  const original = config();
  assert.equal(original.notes, undefined);
  assert.equal(original.models[0].grades, undefined);
  for (const notes of ['prefer cheap', [42], [' '], null]) {
    assert.throws(() => validateConfig({ ...original, notes }), /notes/);
  }
  for (const grades of [null, [], 'frontend: 10', { ' ': 10 }, { ' frontend ': 10 }, { frontend: 0 },
    { frontend: 11 }, { frontend: 9.5 }, { frontend: '10' }]) {
    assert.throws(() => validateConfig({ ...original,
      models: [{ ...original.models[0], grades }, original.models[1]] }), /Invalid Jev model entry/);
  }
});

test('complete explicit overrides bypass inference and preserve all fields', async () => {
  const result = await route(config(), { ...task, agent: 'architect', model: 'local/strong', thinking: 'high' }, agents,
    undefined, async () => { throw new Error('Must not call HTTP'); }, '');
  assert.deepEqual(result, { agent: 'architect', model: 'local/strong', thinking: 'high', source: 'constraints' });
});

test('partial overrides constrain choices and cannot be overwritten by an API answer', async () => {
  const result = await route(config(), { ...task, agent: 'architect', thinking: 'medium' }, agents,
    undefined, async () => { throw new Error('Only one valid pair, no inference needed'); });
  assert.equal(result.model, 'local/strong');
  assert.equal(result.agent, 'architect');
  assert.equal(result.thinking, 'medium');
  await assert.rejects(route(config(), { ...task, model: 'local/cheap' }, agents, undefined,
    async () => Response.json({ answers: { agent: answer('unconfigured') } }), 'key'), /no valid agent/);
});

test('bad inputs and incompatible constraints fail before HTTP', async () => {
  for (const override of [{ agent: 'unknown' }, { model: 'cheap' }, { thinking: 'max' },
    { model: 'local/cheap', thinking: 'high' }, { prompt: ' ' }, { max_turns: 0 }]) {
    await assert.rejects(route(config(), { ...task, ...override } as Input, agents,
      undefined, async () => { assert.fail('Invalid input reached HTTP'); }, 'key'));
  }
  const first = config().models[0];
  for (const model of [
    { ...first, thinking: { supported: ['unknown'], default: 'unknown' } },
    { ...first, thinking: { supported: ['low'], default: 'high' } },
    { ...first, thinking: { supported: ['low', 'low'], default: 'low' } },
    { ...first, strengths: 'lookups' },
    { ...first, routing: { ...first.routing, preferWhen: [''] } },
    { ...first, routing: { ...first.routing, escalateTo: 'local/missing' } },
    { ...first, benchmarks: { artificialAnalysis: { intelligenceIndex: -1, costPerTask: null } } },
    { ...first, benchmarks: { artificialAnalysis: { intelligenceIndex: null, costPerTask: 'cheap' } } },
  ]) assert.throws(() => validateConfig({ ...config(), models: [model, config().models[1]] }));
  assert.throws(() => validateConfig({ ...config(), agents: [{ name: 'none', definition: 'none.md' }] }));
  assert.throws(() => validateConfig({ ...config(), timeoutMs: 0 }));
});

test('missing key, HTTP failure, invalid and none selections fail closed without retry', async () => {
  await assert.rejects(route(config(), task, agents, undefined, fetch, ''), /TYPESAFE_API_KEY/);
  for (const response of [new Response('', { status: 429 }), Response.json({}),
    Response.json({ answers: { agent: answer('none'), execution: answer('option_0') } }),
    Response.json({ answers: { agent: answer('Explore'), execution: answer('option_900') } })]) {
    let calls = 0;
    await assert.rejects(route(config(), task, agents, undefined, async () => { calls++; return response; }, 'key'));
    assert.equal(calls, 1);
  }
});

test('only configured fallback is allowed and it must respect overrides', async () => {
  const c = { ...config(), fallback: { agent: 'Explore', model: 'local/cheap', thinking: 'low' as const } };
  assert.deepEqual(await route(c, { ...task, agent: 'architect' }, agents, undefined, fetch, ''),
    { agent: 'architect', model: 'local/cheap', thinking: 'low', source: 'explicit-fallback' });
  await assert.rejects(route(c, { ...task, model: 'local/strong' }, agents, undefined, fetch, ''), /invalid selection/);
});

test('unavailable default cannot become an automatic fallback', async () => {
  const original = config();
  const muse = { ...original.models[0], thinking: { supported: ['xhigh', 'max'] as const, default: 'max' as const } };
  const configured = validateConfig({ ...original, models: [muse, original.models[1]],
    fallback: { agent: 'Explore', model: muse.id, thinking: 'max' } });
  // Pi filtered max. Keep the declared default visible as metadata, never as a runnable pair.
  const filtered = { ...configured, models: [{ ...muse, thinking: { ...muse.thinking, supported: ['xhigh' as const] } },
    original.models[1]] } as Config;
  await assert.rejects(route(filtered, task, agents, undefined,
    async () => { throw new Error('Service unavailable'); }, 'key'), /invalid selection/);
});

test('caller abort never triggers fallback', async () => {
  const c = { ...config(), fallback: { agent: 'Explore', model: 'local/cheap', thinking: 'low' as const } };
  const controller = new AbortController();
  const fetcher: typeof fetch = async () => { controller.abort(); throw new Error('aborted'); };
  await assert.rejects(route(c, task, agents, controller.signal, fetcher, 'key'), /abort/i);
});

test('HTTP request receives a bounded abort signal', async () => {
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
  });
  // AbortSignal.timeout is unrefed, so keep the test process alive while testing it.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(route(config(), task, agents, undefined, fetcher, 'key'), /deadline/); }
  finally { clearTimeout(keepAlive); }
});

/** Synchronous bus matches pi.events, including immediate reply during emit. */
function bus() {
  const handlers = new Map<string, (data: any) => void>();
  return {
    handlers,
    on(event: string, handler: (data: any) => void) { handlers.set(event, handler); return () => { handlers.delete(event); }; },
    emit(event: string, data: unknown) { handlers.get(event)?.(data); },
  };
}

test('RPC forwards actual model/thinking and cleans reply listeners after acknowledgement', async () => {
  const events = bus();
  events.on('subagents:rpc:spawn', p => {
    assert.equal(p.options.model, 'local/strong');
    assert.equal(p.options.thinkingLevel, 'high');
    assert.equal(p.options.isBackground, true);
    assert.ok(p.options.signal instanceof AbortSignal);
    events.emit(`subagents:rpc:spawn:reply:${p.requestId}`, { success: true, data: { id: 'real-executor-id' } });
  });
  const result = await rpc(events, 'spawn', { type: 'architect', prompt: task.prompt,
    options: { model: 'local/strong', thinkingLevel: 'high', isBackground: true } }, 100);
  assert.equal(result.id, 'real-executor-id');
  assert.equal(events.handlers.size, 1);
});

test('RPC timeout aborts pending startup, and executor errors are not retried', async () => {
  const events = bus();
  let signal: AbortSignal | undefined;
  events.on('subagents:rpc:spawn', p => { signal = p.options.signal; });
  await assert.rejects(rpc(events, 'spawn', {}, 10), /timed out/);
  assert.equal(signal?.aborted, true);
  assert.equal(events.handlers.size, 1);
  events.on('subagents:rpc:spawn', p => events.emit(`subagents:rpc:spawn:reply:${p.requestId}`, { success: false, error: 'Model unavailable' }));
  await assert.rejects(rpc(events, 'spawn', {}, 100), /Model unavailable/);
});
