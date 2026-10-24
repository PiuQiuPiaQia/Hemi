/** Shared desktop / Bot session routing, including the same fallback semantics. */
export function sessionModelOptions({ config, fallback, fallbacks = [] }) {
  const candidates = fallbacks.length ? fallbacks : fallback ? [fallback] : [];
  const thinking = { level: config.thinkingLevel ?? 'default', format: config.thinkingFormat ?? null };
  return candidates.length
    ? { model: null, routing: { execution: { ...config }, fallback: candidates[0], fallbacks: candidates }, thinking }
    : { model: { ...config }, routing: null, thinking };
}
