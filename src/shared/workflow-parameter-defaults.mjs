const RULES = new Map([
  ["today", "today"],
  ["今天", "today"],
  ["yesterday", "yesterday"],
  ["昨天", "yesterday"],
  ["last-week", "last-week"],
  ["上周", "last-week"],
  ["last-month", "last-month"],
  ["上月", "last-month"],
]);
const iso = (date) => date.toISOString().slice(0, 10);
export function resolveRelativeDate(
  value,
  {
    now = Date.now(),
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  } = {},
) {
  const rule = RULES.get(value);
  if (!rule) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  const date = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)),
  );
  if (rule === "today") return iso(date);
  if (rule === "yesterday") {
    date.setUTCDate(date.getUTCDate() - 1);
    return iso(date);
  }
  if (rule === "last-week") {
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) - 7);
    const end = new Date(date);
    end.setUTCDate(end.getUTCDate() + 6);
    return `${iso(date)}～${iso(end)}`;
  }
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1),
  );
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
  return `${iso(start)}～${iso(end)}`;
}
export function resolveParameterDefaults(parameters, context = {}) {
  const values = {},
    sources = {},
    issues = [];
  for (const parameter of parameters) {
    if (parameter.defaultRule) {
      const value = resolveRelativeDate(parameter.defaultRule, context);
      if (value == null)
        issues.push({
          code: "invalid-default",
          field: parameter.key,
          message: `不支持的默认日期规则：${parameter.defaultRule}`,
        });
      else {
        values[parameter.key] = value;
        sources[parameter.key] = {
          kind: "default-rule",
          rule: parameter.defaultRule,
          timeZone: context.timeZone,
          resolvedAt: context.now,
        };
      }
    } else if (parameter.defaultValue !== undefined) {
      values[parameter.key] = parameter.defaultValue;
      sources[parameter.key] = { kind: "default" };
    }
  }
  return { values, sources, issues };
}
