/** Display-only purpose supplied with a command; never evidence of its result. */
export function normalizeCommandDescription(value) {
  return typeof value === 'string' ? value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80) : '';
}
