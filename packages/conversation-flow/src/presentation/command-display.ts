export function normalizeCommandDescription(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, 80)
    : "";
}
