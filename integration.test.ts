import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// This repo installs Pi beside Node with mise. Override for another installation.
const piPackage = process.env.PI_PACKAGE_DIR ?? resolve(dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent');
const { loadExtensions } = await import(pathToFileURL(resolve(piPackage, 'dist/core/extensions/loader.js')).href);
const { createEventBus } = await import(pathToFileURL(resolve(piPackage, 'dist/core/event-bus.js')).href);

/** Load from Pi with a separate user config, then confirm the real RPC payload. */
test('JevAgent reads user config and delegates through the existing RPC contract', async () => {
  const agentDir = await mkdtemp(resolve(tmpdir(), 'jev-agent-config-'));
  const workspace = await mkdtemp(resolve(tmpdir(), 'jev-project-'));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const events = createEventBus();
    let spawn: any;
    let pings = 0;
    events.on('subagents:rpc:ping', (p: any) => {
      pings++;
      events.emit(`subagents:rpc:ping:reply:${p.requestId}`, { success: true, data: { version: 2 } });
    });
    events.on('subagents:rpc:spawn', (p: any) => {
      spawn = p;
      events.emit(`subagents:rpc:spawn:reply:${p.requestId}`, { success: true, data: { id: 'executor-agent-id' } });
    });
    const loaded = await loadExtensions([resolve(here, 'index.ts')], originalCwd, events);
    assert.deepEqual(loaded.errors, []);
    const tool = loaded.extensions[0].tools.get('JevAgent').definition;
    const model = { provider: 'openai-codex', id: 'gpt-6-astra', reasoning: true };
    const params = { prompt: 'Review the module boundaries.', description: 'Review module boundaries',
      agent: 'architect', model: 'openai-codex/gpt-6-astra', thinking: 'high', max_turns: 7 };
    const context = (cwd: string) => ({ cwd, modelRegistry: { getAvailable: () => [model] } });
    const run = (cwd: string) => tool.execute('call-id', params, undefined, undefined, context(cwd));

    await assert.rejects(run(originalCwd), /config missing at .*jev-router\/config\.json/);
    assert.equal(pings, 0, 'Missing config must fail before contacting the executor');
    await mkdir(resolve(agentDir, 'jev-router'), { recursive: true });
    const configPath = resolve(agentDir, 'jev-router/config.json');
    await writeFile(configPath, '{ invalid JSON');
    await assert.rejects(run(originalCwd), /Invalid Jev router config at .*config\.json/);
    assert.equal(pings, 0, 'Invalid config must fail before contacting the executor');

    // Definition paths are relative to the user's config, not the installed extension.
    await mkdir(resolve(agentDir, 'agents'), { recursive: true });
    await writeFile(resolve(agentDir, 'agents/architect.md'), '---\nname: architect\ndescription: Reviews boundaries\n---\n');
    const initialConfig = JSON.stringify({ timeoutMs: 1000,
      models: [{ id: params.model, tier: 'expert', strengths: ['reasoning'], weaknesses: ['cost'],
        thinking: { supported: ['high'], default: 'high' },
        routing: { preferWhen: ['task_is_complex'], avoidWhen: [] },
        benchmarks: { artificialAnalysis: { intelligenceIndex: null, costPerTask: null } } }],
      agents: [{ name: 'architect', definition: '../agents/architect.md' }],
    });
    await writeFile(configPath, JSON.stringify({ ...JSON.parse(initialConfig), notes: [' '] }));
    await assert.rejects(run(originalCwd), /Invalid Jev router config at .*notes must be an array of nonempty strings/);
    assert.equal(pings, 0, 'Invalid notes must fail before contacting the executor');
    await writeFile(configPath, initialConfig);
    const result = await run(originalCwd);
    assert.equal(spawn.type, 'architect');
    assert.equal(spawn.options.model, model);
    assert.equal(spawn.options.thinkingLevel, 'high');
    assert.equal(spawn.options.maxTurns, 7);
    assert.equal(spawn.options.isBackground, true);
    assert.equal(result.details.agentId, 'executor-agent-id');
    assert.equal(result.details.source, 'constraints');

    // Muse max remains in the user config, but the runtime only offers xhigh.
    const muse = { provider: 'meta', id: 'muse-spark-1.3-contributor', reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh', max: null } };
    await writeFile(configPath, JSON.stringify({ timeoutMs: 1000,
      models: [{ id: 'meta/muse-spark-1.3-contributor', tier: 'fast-economy',
        strengths: ['search'], weaknesses: ['architecture'],
        thinking: { supported: ['xhigh', 'max'], default: 'max' },
        routing: { preferWhen: ['task_is_search'], avoidWhen: [], escalateTo: 'openai-codex/gpt-6-sol' },
        benchmarks: { artificialAnalysis: { intelligenceIndex: null, costPerTask: null } } },
      { id: 'openai-codex/gpt-6-sol', tier: 'frontier-general', strengths: ['code'], weaknesses: ['cost'],
        thinking: { supported: ['high'], default: 'high' },
        routing: { preferWhen: ['task_is_complex'], avoidWhen: [] },
        benchmarks: { artificialAnalysis: { intelligenceIndex: null, costPerTask: null } } }],
      agents: [{ name: 'architect', definition: '../agents/architect.md' }],
    }));
    const museParams = { ...params, model: 'meta/muse-spark-1.3-contributor', thinking: 'xhigh' };
    const museContext = { cwd: originalCwd, modelRegistry: { getAvailable: () => [muse] } };
    const museResult = await tool.execute('muse-call', museParams, undefined, undefined, museContext);
    assert.equal(museResult.details.thinking, 'xhigh');
    assert.equal(spawn.options.model, muse);
    spawn = undefined;
    await assert.rejects(tool.execute('unsupported-muse-call', { ...museParams, thinking: 'max' },
      undefined, undefined, museContext), /No configured model supports the requested thinking level/);
    assert.equal(spawn, undefined);

    // Restore Astra for the executor discovery and shadowing checks.
    await writeFile(configPath, initialConfig);
    // The executor discovers definitions from process.cwd(), not the session context cwd.
    await mkdir(resolve(workspace, '.pi/agents'), { recursive: true });
    await writeFile(resolve(workspace, '.pi/agents/architect.md'), '---\nenabled: false\ndescription: Disabled architect\n---\n');
    assert.equal((await run(workspace)).details.agentId, 'executor-agent-id');
    process.chdir(workspace);
    spawn = undefined;
    await assert.rejects(run(originalCwd), /shadowed, disabled/);
    assert.equal(spawn, undefined);
  } finally {
    process.chdir(originalCwd);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(agentDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
