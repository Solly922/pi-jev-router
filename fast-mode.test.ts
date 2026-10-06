import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fastVariant, loadsFastMode } from './fast-mode.ts';

test('fast variant has an unregistered ID and names the real model for pi-openai-fast-mode', () => {
  const model = { provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', reasoning: true };
  const variant = fastVariant(model);
  assert.deepEqual(variant, { provider: 'openai-codex', id: 'gpt-6.1-sol-fast', name: 'GPT-6.1 Sol (fast)',
    reasoning: true, fastModeVariant: { baseModelId: 'gpt-6.1-sol' } });
  // The registry object other sessions share stays untouched.
  assert.deepEqual(model, { provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', reasoning: true });
  assert.equal(fastVariant({ provider: 'openai', id: 'gpt-6-astra' }).name, 'gpt-6-astra (fast)');
});

test('loadsFastMode follows pi-subagents extensions: and exclude_extensions: rules', () => {
  const loads: Record<string, unknown>[] = [
    {}, { extensions: true }, { extensions: '*' }, { extensions: 'pi-claude-bridge, *' },
    { extensions: 'pi-claude-bridge, pi-openai-fast-mode' }, { extensions: 'PI-OpenAI-Fast-Mode' },
    { extensions: ['pi-claude-bridge', 'pi-openai-fast-mode'] }, { inherit_extensions: 'pi-openai-fast-mode' },
    { extensions: '~/.pi/agent/git/github.com/Solly922/pi-openai-fast-mode/src/index.ts' },
    { extensions: true, exclude_extensions: 'pi-claude-bridge' },
  ];
  const skips: Record<string, unknown>[] = [
    { extensions: false }, { extensions: 'none' }, { extensions: '' }, { extensions: 'pi-claude-bridge' },
    { extensions: 'pi-openai-fast-mode-extra' }, { exclude_extensions: 'pi-openai-fast-mode' },
    { extensions: '*', exclude_extensions: 'pi-claude-bridge, pi-openai-fast-mode' },
  ];
  for (const frontmatter of loads) assert.equal(loadsFastMode(frontmatter), true, JSON.stringify(frontmatter));
  for (const frontmatter of skips) assert.equal(loadsFastMode(frontmatter), false, JSON.stringify(frontmatter));
});
