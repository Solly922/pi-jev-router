// Contract with pi-openai-fast-mode (Solly922 fork) for models configured with `fast: true`.
//
// Jev hands the subagent a copy of the model with an ID that is not in Pi's registry, because a
// session swaps any model whose provider/ID is registered back to the registry object whenever an
// extension registers a provider, which would drop the marker. pi-openai-fast-mode reads the
// marker from the session model, puts the real ID back on the request and adds
// `service_tier: "priority"`, even when /fast is off.

export const FAST_MODE_EXTENSION = 'pi-openai-fast-mode';
/** Providers whose requests pi-openai-fast-mode can put on the priority tier. */
export const FAST_MODE_PROVIDERS = ['openai', 'openai-codex'];

type ModelLike = { provider: string; id: string; name?: string };

/** The copy a subagent runs when its model entry sets `fast: true`. */
export function fastVariant<M extends ModelLike>(model: M): M & { fastModeVariant: { baseModelId: string } } {
  return { ...model, id: `${model.id}-fast`, name: `${model.name ?? model.id} (fast)`,
    fastModeVariant: { baseModelId: model.id } };
}

/**
 * Whether pi-subagents loads pi-openai-fast-mode for an agent, read from its frontmatter the way
 * pi-subagents 0.19 does: omitted or true loads every extension, false or "none" loads none, and a
 * comma list loads the named ones ("*" keeps all). `exclude_extensions` wins over both.
 */
export function loadsFastMode(frontmatter: Record<string, unknown>): boolean {
  const list = (value: unknown) => String(value).split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  const excluded = frontmatter.exclude_extensions;
  if (excluded != null && list(excluded).includes(FAST_MODE_EXTENSION)) return false;
  const extensions = frontmatter.extensions ?? frontmatter.inherit_extensions;
  if (extensions == null || extensions === true) return true;
  if (extensions === false) return false;
  // Path entries load that extension directly; accept one that points into this package.
  return list(extensions).some(item => item === '*' || item === FAST_MODE_EXTENSION ||
    (/[/\\~]/.test(item) && item.includes(FAST_MODE_EXTENSION)));
}
