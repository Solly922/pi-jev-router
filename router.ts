import { randomUUID } from 'node:crypto';
import type { UsageReport } from './usage.ts';

export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Thinking = typeof THINKING[number];
export const USAGE_SOURCES = ['codex', 'claude', 'none'] as const;
export type Selection = { agent: string; model: string; thinking: Thinking };
export type ModelConfig = {
  id: string;
  tier: string;
  strengths: string[];
  weaknesses: string[];
  grades?: Record<string, number>;
  thinking: { supported: Thinking[]; default: Thinking };
  routing: { preferWhen: string[]; avoidWhen: string[]; escalateTo?: string };
  benchmarks: { artificialAnalysis: { intelligenceIndex: number | null; costPerTask: number | null } };
  /** Where live subscription usage comes from. `modelWindow` picks an extra per-model Claude window. */
  usage?: { source: typeof USAGE_SOURCES[number]; modelWindow?: string };
};
export type Config = {
  timeoutMs: number;
  notes?: string[];
  usage?: { cacheSeconds?: number; timeoutMs?: number };
  models: ModelConfig[];
  agents: { name: string; definition: string }[];
  fallback?: Selection;
};
export type Input = { prompt: string; description: string; agent?: string; model?: string; thinking?: Thinking; max_turns?: number };
export type Agent = { name: string; description: string };
type Bus = { on(event: string, handler: (data: any) => void): () => void; emit(event: string, data: unknown): void };

/** Reject configuration errors before sending task content or starting an agent. */
export function validateConfig(value: unknown): Config {
  const c = value as Config;
  if (!c || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 120_000) {
    throw new Error('Jev router timeoutMs must be an integer from 100 to 120000.');
  }
  if (!Array.isArray(c.models) || !c.models.length || !Array.isArray(c.agents) || !c.agents.length) {
    throw new Error('Jev router requires nonempty models and agents arrays.');
  }
  const between = (value: unknown, min: number, max: number) => value === undefined ||
    (Number.isInteger(value) && (value as number) >= min && (value as number) <= max);
  if (c.usage !== undefined && (!c.usage || typeof c.usage !== 'object' || Array.isArray(c.usage) ||
      !between(c.usage.cacheSeconds, 10, 3600) || !between(c.usage.timeoutMs, 100, 10_000))) {
    throw new Error('Jev router usage.cacheSeconds must be 10-3600 and usage.timeoutMs 100-10000.');
  }
  const tags = (value: unknown): value is string[] => Array.isArray(value) &&
    value.every(item => typeof item === 'string' && item.trim().length > 0);
  const metric = (value: unknown): value is number | null => value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (c.notes !== undefined && !tags(c.notes)) throw new Error('Jev router notes must be an array of nonempty strings.');
  for (const m of c.models) {
    if (!m || typeof m.id !== 'string' || !/^[^\s/]+\/\S+$/.test(m.id) ||
        typeof m.tier !== 'string' || !m.tier.trim() || !tags(m.strengths) || !tags(m.weaknesses) ||
        (m.grades !== undefined && (!m.grades || typeof m.grades !== 'object' || Array.isArray(m.grades) ||
          Object.entries(m.grades).some(([skill, grade]) => !skill.trim() || skill !== skill.trim() ||
            !Number.isInteger(grade) || grade < 1 || grade > 10))) ||
        !m.thinking || !Array.isArray(m.thinking.supported) || !m.thinking.supported.length ||
        m.thinking.supported.some(t => !THINKING.includes(t)) ||
        new Set(m.thinking.supported).size !== m.thinking.supported.length ||
        !m.thinking.supported.includes(m.thinking.default) ||
        !m.routing || !tags(m.routing.preferWhen) || !tags(m.routing.avoidWhen) ||
        (m.routing.escalateTo !== undefined && (typeof m.routing.escalateTo !== 'string' || !m.routing.escalateTo.trim())) ||
        !m.benchmarks?.artificialAnalysis ||
        !metric(m.benchmarks.artificialAnalysis.intelligenceIndex) ||
        !metric(m.benchmarks.artificialAnalysis.costPerTask) ||
        (m.usage !== undefined && (!m.usage || !USAGE_SOURCES.includes(m.usage.source) ||
          (m.usage.modelWindow !== undefined && (m.usage.source !== 'claude' ||
            typeof m.usage.modelWindow !== 'string' || !m.usage.modelWindow.trim()))))) throw new Error(`Invalid Jev model entry: ${m?.id ?? 'unknown'}.`);
  }
  for (const m of c.models) {
    if (m.routing.escalateTo && (m.routing.escalateTo === m.id || !c.models.some(other => other.id === m.routing.escalateTo))) {
      throw new Error(`Invalid advisory escalation target for ${m.id}.`);
    }
  }
  for (const a of c.agents) {
    if (!a || typeof a.name !== 'string' || !/^[\w-]+$/.test(a.name) || a.name === 'none' ||
        typeof a.definition !== 'string' || !a.definition.endsWith('.md')) throw new Error('Invalid Jev agent entry.');
  }
  if (new Set(c.models.map(m => m.id)).size !== c.models.length ||
      new Set(c.agents.map(a => a.name.toLowerCase())).size !== c.agents.length) throw new Error('Duplicate Jev model or agent.');
  if (c.models.reduce((n, m) => n + m.thinking.supported.length, 0) > 254 || c.agents.length > 254) {
    throw new Error('Jev router supports at most 254 model/thinking pairs and 254 agents.');
  }
  if (c.fallback) validateSelection(c, c.fallback);
  return c;
}

/** Caller constraints are exact, not fuzzy aliases, and may never be silently replaced. */
export function validateInput(c: Config, p: Input): void {
  if (!p || typeof p.prompt !== 'string' || !p.prompt.trim() || p.prompt.length > 32_000 ||
      typeof p.description !== 'string' || !p.description.trim() || p.description.length > 200) {
    throw new Error('Provide a nonempty prompt up to 32000 characters and description up to 200.');
  }
  if (p.agent !== undefined && !c.agents.some(a => a.name === p.agent)) throw new Error('Agent override is not in jev-router/config.json.');
  if (p.model !== undefined && !c.models.some(m => m.id === p.model)) throw new Error('Model override must exactly match a configured provider/model ID.');
  if (p.thinking !== undefined && !THINKING.includes(p.thinking)) throw new Error('Invalid thinking override.');
  if (p.max_turns !== undefined && (!Number.isInteger(p.max_turns) || p.max_turns < 1 || p.max_turns > 100)) throw new Error('max_turns must be between 1 and 100.');
  if (!pairs(c, p).length) throw new Error('No configured model supports the requested thinking level.');
}

/** Build joint candidates so Jev cannot select an incompatible thinking/model combination. */
export function pairs(c: Config, p: Partial<Input>): Omit<Selection, 'agent'>[] {
  return c.models.filter(m => p.model === undefined || m.id === p.model)
    .flatMap(m => m.thinking.supported.filter(t => p.thinking === undefined || t === p.thinking)
      .map(thinking => ({ model: m.id, thinking })));
}

/** Check API output and fallback against the same allowlist used to build questions. */
export function validateSelection(c: Config, s: Selection): Selection {
  if (!s || !c.agents.some(a => a.name === s.agent) ||
      !pairs(c, {}).some(p => p.model === s.model && p.thinking === s.thinking)) {
    throw new Error('Jev returned an invalid selection or fallback configuration.');
  }
  return s;
}

const USAGE_INSTRUCTIONS = ' Each option\'s usage field reports remaining subscription usage: remainingPercent per window and minutes until it resets. Options with the same pool share one limit. When several options are adequate, prefer those with more remaining usage, weighing long windows over short windows that reset soon. modelAvailable false means the provider reports that model unavailable. Status unknown means no data, not an exhausted quota; stale values are older estimates. Usage is advisory; adequacy for the task comes first.';

/** One request, no retries. Full overrides need no paid inference. `usage` is advisory and keyed by model ID. */
export async function route(c: Config, p: Input, agents: Agent[], signal?: AbortSignal,
  fetcher: typeof fetch = fetch, apiKey = process.env.TYPESAFE_API_KEY,
  usage: Record<string, UsageReport> = {}): Promise<Selection & { source: string }> {
  validateInput(c, p);
  signal?.throwIfAborted();
  const choices = pairs(c, p);
  const agentChoices = agents.filter(a => p.agent === undefined || p.agent === a.name);
  if (!agentChoices.length) throw new Error('No enabled configured agents are available.');
  const hasUsage = Object.keys(usage).length > 0;
  const questions: Record<string, unknown> = {};
  if (agentChoices.length > 1) questions.agent = {
    type: 'choice', instructions: 'Choose the existing agent whose role best fits the delegated task. Select none if none is appropriate.',
    criteria: { ...Object.fromEntries(agentChoices.map(a => [a.name, a.description])), none: 'No suitable agent.' },
  };
  if (choices.length > 1) questions.execution = {
    type: 'choice', instructions: 'Choose the model and thinking effort adequate for the task. Prefer lower cost and effort when adequate. The configured default is a preference only if it appears in the supported thinking levels; otherwise ignore it. Routing hints and escalation targets are advisory only; no second agent is launched. Null benchmarks mean unknown, not zero. User notes in state are advisory preferences. Model grades are user-assigned 1-10 scores: favor higher grades for skills relevant to the task, but an absent grade means unknown, not zero. Task adequacy comes first. Select none if no option is adequate.' +
      (hasUsage ? USAGE_INSTRUCTIONS : ''),
    criteria: { ...Object.fromEntries(choices.map((s, i) => {
      // The configured usage source is local plumbing; Jev gets the measured report instead.
      const { usage: _source, ...model } = c.models.find(m => m.id === s.model)!;
      return [`option_${i}`, { ...model, selectedThinking: s.thinking,
        ...(hasUsage ? { usage: usage[s.model] ?? { status: 'unknown' } } : {}) }];
    })), none: 'No suitable execution configuration.' },
  };
  try {
    let answers: any = {};
    if (Object.keys(questions).length) {
      if (!apiKey?.trim()) throw new Error('TYPESAFE_API_KEY is not set.');
      const deadline = AbortSignal.timeout(c.timeoutMs);
      const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'jev-latest', state: { task: p.prompt, description: p.description,
          ...(c.notes?.length ? { notes: c.notes } : {}) }, questions }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}.`);
      answers = (await response.json() as any)?.answers;
      // Check only consumed answers. Never interpolate an untrusted response into an executor call.
      for (const key of Object.keys(questions)) {
        const a = answers?.[key];
        const criteria = (questions[key] as any).criteria;
        if (a?.type !== 'choice' || typeof a.choice !== 'string' || !Object.hasOwn(criteria, a.choice) || a.choice === 'none') {
          throw new Error(`TypeSafe returned no valid ${key} choice.`);
        }
      }
    }
    const agent = questions.agent ? answers.agent.choice : agentChoices[0].name;
    const execution = questions.execution ? choices[Number(answers.execution.choice.slice(7))] : choices[0];
    return { ...validateSelection(c, { agent, ...execution }), source: Object.keys(questions).length ? 'jev' : 'constraints' };
  } catch (error) {
    signal?.throwIfAborted();
    if (!c.fallback) throw new Error(`Jev routing failed: ${error instanceof Error ? error.message : 'request failed'}`);
    const fallback = validateSelection(c, {
      agent: p.agent ?? c.fallback.agent, model: p.model ?? c.fallback.model, thinking: p.thinking ?? c.fallback.thinking,
    });
    if (!agentChoices.some(a => a.name === fallback.agent)) throw new Error('Configured fallback agent is unavailable.');
    return { ...fallback, source: 'explicit-fallback' };
  }
}

/** The installed executor owns execution, queueing, results and completion notifications. */
export function rpc(bus: Bus, method: 'ping' | 'spawn', payload: Record<string, unknown>, timeoutMs: number,
  signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const channel = `subagents:rpc:${method}`;
    const controller = new AbortController();
    // Only startup is bounded here. Clear the timer on acknowledgement so a detached agent can finish normally.
    const finish = (error?: Error, data?: unknown) => {
      clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
      if (error) { controller.abort(); reject(error); } else resolve(data);
    };
    const abort = () => finish(new Error('Subagent request cancelled.'));
    const unsubscribe = bus.on(`${channel}:reply:${requestId}`, reply => {
      if (reply?.success !== true) finish(new Error(typeof reply?.error === 'string' ? reply.error : 'Invalid subagent RPC response.'));
      else finish(undefined, reply.data);
    });
    const timer = setTimeout(() => finish(new Error(`Subagent ${method} timed out; do not retry automatically.`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const options = payload.options as Record<string, unknown> | undefined;
      bus.emit(channel, { ...payload, requestId, ...(method === 'spawn' ? { options: { ...options, signal: controller.signal } } : {}) });
    } catch (error) { finish(error instanceof Error ? error : new Error('Subagent RPC failed.')); }
  });
}
