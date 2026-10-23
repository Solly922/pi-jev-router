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
    assert.equal(result.details.fast, false);

    // fast: true launches the always-priority twin that pi-openai-fast-mode registers.
    const fastConfig = JSON.parse(initialConfig);
    fastConfig.models[0].fast = true;
    await writeFile(configPath, JSON.stringify(fastConfig));
    const fastModel = { ...model, provider: 'openai-codex-fast' };
    const fastContext = (models: object[]) => ({ cwd: originalCwd, modelRegistry: { getAvailable: () => models } });
    const fastResult = await tool.execute('fast-call', params, undefined, undefined, fastContext([model, fastModel]));
    assert.equal(spawn.options.model, fastModel);
    assert.equal(fastResult.details.model, 'openai-codex/gpt-6-astra');
    assert.equal(fastResult.details.fast, true);
    assert.match(fastResult.content[0].text, /openai-codex\/gpt-6-astra \(fast\), thinking high/);
    // Without the twin, fail before routing instead of silently launching the normal model.
    spawn = undefined;
    await assert.rejects(tool.execute('no-twin-call', params, undefined, undefined, fastContext([model])),
      /openai-codex-fast\/gpt-6-astra is not available/);
    assert.equal(spawn, undefined);
    await writeFile(configPath, initialConfig);

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

    // A built-in has no file, so its configured description is what Jev reads.
    const builtinConfig = JSON.parse(initialConfig);
    builtinConfig.agents.push({ name: 'general-purpose', builtin: true, description: 'Research and multi-step tasks' });
    await writeFile(configPath, JSON.stringify(builtinConfig));
    const builtinParams = { ...params, agent: 'general-purpose' };
    const builtinResult = await tool.execute('builtin-call', builtinParams, undefined, undefined, context(originalCwd));
    assert.equal(spawn.type, 'general-purpose');
    assert.equal(builtinResult.details.agent, 'general-purpose');
    // Without an agent override, Jev chooses from the configured built-in description.
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.TYPESAFE_API_KEY;
    let agentCriteria: any;
    globalThis.fetch = (async (_url: unknown, init: any) => {
      agentCriteria = JSON.parse(init.body).questions.agent.criteria;
      return Response.json({ answers: { agent: { type: 'choice', choice: 'general-purpose' } } });
    }) as typeof fetch;
    process.env.TYPESAFE_API_KEY = 'test-key';
    try {
      const { agent: _agent, ...unpinned } = builtinParams;
      assert.equal((await tool.execute('jev-builtin', unpinned, undefined, undefined, context(originalCwd))).details.source, 'jev');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = originalKey;
    }
    assert.equal(agentCriteria['general-purpose'], 'Research and multi-step tasks');
    assert.equal(spawn.type, 'general-purpose');

    // A same-named file replaces the built-in in pi-subagents, so the description would be wrong. The
    // executor also resolves a lone case variant, such as General-Purpose, when defaults are disabled.
    for (const [folder, file] of [[resolve(agentDir, 'agents'), 'general-purpose.md'],
      [resolve(workspace, '.pi/agents'), 'general-purpose.md'], [resolve(agentDir, 'agents'), 'General-Purpose.md']]) {
      await mkdir(folder, { recursive: true });
      const override = resolve(folder, file);
      await writeFile(override, '---\ndescription: Replaced general-purpose\n---\n');
      process.chdir(workspace);
      spawn = undefined;
      await assert.rejects(tool.execute('shadowed-builtin', builtinParams, undefined, undefined, context(workspace)),
        /general-purpose is configured as a pi-subagents built-in, but .*\.md defines general-purpose/i);
      assert.equal(spawn, undefined);
      process.chdir(originalCwd);
      await rm(override);
    }

    // With defaults disabled the built-in isn't registered, so the executor would launch its fallback.
    // Files merge like pi-subagents: only a boolean counts, and the project's .pi/subagents.json wins.
    const refuseDisabled = async (tool: any, cwd: string) => {
      spawn = undefined;
      await assert.rejects(tool.execute('disabled-builtin', builtinParams, undefined, undefined, context(cwd)),
        /general-purpose is a pi-subagents built-in, but disableDefaultAgents is on/);
      assert.equal(spawn, undefined);
    };
    const launchBuiltin = async (cwd: string) => assert.equal(
      (await tool.execute('enabled-builtin', builtinParams, undefined, undefined, context(cwd))).details.agent, 'general-purpose');
    const globalSettings = resolve(agentDir, 'subagents.json');
    const projectSettings = resolve(workspace, '.pi/subagents.json');
    await writeFile(globalSettings, JSON.stringify({ disableDefaultAgents: true }));
    await refuseDisabled(tool, originalCwd);
    process.chdir(workspace);
    // pi-subagents drops a non-boolean value, so the global true still applies.
    await writeFile(projectSettings, JSON.stringify({ disableDefaultAgents: 0 }));
    await refuseDisabled(tool, originalCwd);
    await writeFile(projectSettings, JSON.stringify({ disableDefaultAgents: false }));
    await launchBuiltin(workspace);
    // Like agent files, the project settings come from process.cwd(), not the session's cwd.
    await writeFile(projectSettings, JSON.stringify({ disableDefaultAgents: true }));
    await rm(globalSettings);
    await refuseDisabled(tool, originalCwd);
    process.chdir(originalCwd);
    await launchBuiltin(workspace);
    await rm(projectSettings);

    // pi-subagents applies settings when it starts and on /agents changes, and never re-reads the files.
    // A change counts even when its save failed, and a startup value outlasts a later file edit.
    events.emit('subagents:settings_changed', { settings: { disableDefaultAgents: true }, persisted: false });
    await refuseDisabled(tool, originalCwd);
    events.emit('subagents:settings_changed', { settings: { disableDefaultAgents: false }, persisted: true });
    await launchBuiltin(originalCwd);
    await writeFile(globalSettings, JSON.stringify({ disableDefaultAgents: true }));
    const restarted = (await loadExtensions([resolve(here, 'index.ts')], originalCwd, events)).extensions[0].tools.get('JevAgent').definition;
    await rm(globalSettings);
    await refuseDisabled(restarted, originalCwd);

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
