import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { Type } from 'typebox';
import { getSupportedThinkingLevels, StringEnum } from '@earendil-works/pi-ai';
import { getAgentDir, parseFrontmatter, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { THINKING, pairs, route, rpc, validateConfig, validateInput } from './router.ts';
import { collectUsage } from './usage.ts';
import { claudeUsage } from './usage-claude.ts';
import { codexUsage } from './usage-codex.ts';

/** Route one delegated task, then use pi-subagents' documented RPC executor. */
export default function jevRouter(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'JevAgent',
    label: 'Jev-routed agent',
    description: 'Select an existing agent, model and thinking level with Jev, then actually launch it through pi-subagents. Runs in background; existing completion notifications and get_subagent_result supply results. Omit agent/model/thinking for automatic selection, or set exact configured values as hard constraints. No retries or automatic escalation. Sends the prompt and routing metadata to TypeSafe.',
    promptSnippet: 'Delegate a task with automatic agent, model and thinking selection',
    promptGuidelines: [
      'Use JevAgent for delegated tasks that need automatic agent, model or thinking selection. Pass explicit user agent/model/thinking requirements as constraints. Agent and TaskExecute remain unchanged and do not invoke Jev.',
      'After JevAgent returns an agent ID, wait for the existing subagent completion notification. Do not start a duplicate agent or retry automatically on failure.',
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 32000 }),
      description: Type.String({ minLength: 1, maxLength: 200 }),
      agent: Type.Optional(Type.String({ description: 'Exact configured agent name, otherwise auto-select.' })),
      model: Type.Optional(Type.String({ description: 'Exact configured provider/model ID, otherwise auto-select.' })),
      thinking: Type.Optional(StringEnum(THINKING)),
      max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const configPath = resolve(getAgentDir(), 'jev-router/config.json');
      let configText: string;
      try { configText = await readFile(configPath, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Jev router config missing at ${configPath}. Copy config.example.json there and edit it.`);
        }
        throw error;
      }
      let config;
      try { config = validateConfig(JSON.parse(configText)); }
      catch (error) { throw new Error(`Invalid Jev router config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`); }
      validateInput(config, params);
      const ping = await rpc(pi.events, 'ping', {}, Math.min(config.timeoutMs, 2000), signal);
      if (ping?.version !== 2) throw new Error('JevAgent requires pi-subagents RPC protocol 2.');
      // Only advertised, authenticated models with an exact supported effort can be selected.
      const available = ctx.modelRegistry.getAvailable();
      config.models = config.models.flatMap(entry => {
        const model = available.find(m => `${m.provider}/${m.id}` === entry.id);
        if (!model) return [];
        const supported = entry.thinking.supported.filter(t => getSupportedThinkingLevels(model).includes(t));
        if (!supported.length) return [];
        // Keep the configured default as metadata. An unsupported default is not a candidate.
        return [{ ...entry, thinking: { ...entry.thinking, supported } }];
      });
      validateInput(config, params);
      // Usage only informs the execution question, which Jev gets only with two or more candidates.
      // Runs alongside agent discovery. Failures become unknown usage; the catch also guarantees no
      // unhandled rejection while discovery is still awaiting.
      const candidates = pairs(config, params);
      const usage = candidates.length > 1
        ? collectUsage(config, [...new Set(candidates.map(c => c.model))], { codex: codexUsage, claude: claudeUsage },
          { available, registry: ctx.modelRegistry }, signal).catch(() => ({}))
        : Promise.resolve({});
      // pi-subagents 0.19 reloadCustomAgents uses process.cwd(), even when ctx.cwd differs.
      // Match that discovery base exactly; a union could approve definitions the executor never loads.
      const definitions = new Map<string, { path: string; description: unknown; enabled: unknown }>();
      const discoveryCwd = process.cwd();
      for (const folder of [resolve(getAgentDir(), 'agents'), resolve(discoveryCwd, '.agents/agents'), resolve(discoveryCwd, '.pi/agents')]) {
        let files: string[];
        try { files = await readdir(folder); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        for (const file of files.filter(f => f.endsWith('.md'))) {
          const path = resolve(folder, file);
          const text = await readFile(path, 'utf8');
          const { frontmatter } = parseFrontmatter(text.replace(/^\uFEFF/, ''));
          const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : basename(file, '.md');
          definitions.set(name, { path, description: frontmatter.description, enabled: frontmatter.enabled });
        }
      }
      const agents = config.agents.map(entry => {
        const definition = definitions.get(entry.name);
        if (!definition || definition.path !== resolve(dirname(configPath), entry.definition) || definition.enabled === false ||
            typeof definition.description !== 'string' || !definition.description.trim()) {
          throw new Error(`Agent ${entry.name} is missing, shadowed, disabled or has no description. Check its configured definition path.`);
        }
        return { name: entry.name, description: definition.description };
      });
      const selection = await route(config, params, agents, signal, fetch, process.env.TYPESAFE_API_KEY, await usage);
      signal?.throwIfAborted();
      const model = available.find(m => `${m.provider}/${m.id}` === selection.model)!;
      const result = await rpc(pi.events, 'spawn', {
        type: selection.agent, prompt: params.prompt,
        options: { model, thinkingLevel: selection.thinking, description: params.description,
          isBackground: true, ...(params.max_turns === undefined ? {} : { maxTurns: params.max_turns }) },
      }, config.timeoutMs, signal);
      if (typeof result?.id !== 'string' || !result.id) throw new Error('Executor returned no agent ID. Do not retry automatically.');
      return {
        content: [{ type: 'text', text: `Started ${selection.agent}: ${selection.model}, thinking ${selection.thinking}. Agent ID: ${result.id}. Route: ${selection.source}. Existing subagent completion notifications will report the result.` }],
        details: { agentId: result.id, ...selection },
      };
    },
  });
}
