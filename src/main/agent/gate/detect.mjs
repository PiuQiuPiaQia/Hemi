import { HARDLINE_COMPILED, DANGEROUS_COMPILED } from './policy.mjs';

/**
 * 命令检测引擎（005 迭代）：两级探测 + 防误伤工艺，纯函数。
 * 数据在 policy.mjs，判定在 pi-gate.mjs，这里只做「这条命令命中了哪级哪条」。
 */

/**
 * 引号遮蔽：把单/双引号字符串的**内容**抹成空格（引号本身保留），使
 * `echo "cat f > /dev/sda"` 不触发写块设备规则——引号里是数据不是重定向。
 * 双引号内的 `$(...)` 与反引号段保留（shell 会真的执行它们）；未闭合引号
 * 遮到串尾（shell 同样不会执行）。
 */
export function maskQuotedProse(command) {
  let out = '';
  let quote = null; // 当前所在引号字符
  let subst = 0; // 双引号内的 $( / ` 嵌套深度
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (!quote) {
      if (ch === "'" || ch === '"') {
        quote = ch;
        out += ch;
      } else {
        out += ch;
      }
      continue;
    }
    if (subst === 0 && ch === quote) {
      quote = null;
      out += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '$' && command[i + 1] === '(') {
        subst += 1;
        out += '$(';
        i += 1;
        continue;
      }
      if (ch === '`' && subst === 0) {
        subst += 1;
        out += ch;
        continue;
      }
      if (subst > 0) {
        if (ch === ')' || ch === '`') subst -= 1;
        out += ch;
        continue;
      }
    }
    out += ' ';
  }
  return out;
}

function matchTier(compiled, commandLower) {
  let masked = null;
  for (const entry of compiled) {
    if (entry.masked && masked === null) masked = maskQuotedProse(commandLower);
    if (entry.regex.test(entry.masked ? masked : commandLower)) {
      // 052 R-03：带回风险类别（R-04 任务内同类确认合并的键；缺省 'dangerous'）。
      return { hit: true, description: entry.description, category: entry.category ?? 'dangerous' };
    }
  }
  return { hit: false, description: null, category: null };
}

/** 灾难级：任何模式不可绕过。输入归一小写后匹配。 */
export function detectHardline(command) {
  return matchTier(HARDLINE_COMPILED, String(command ?? '').toLowerCase());
}

/** 危险级：进问档（confirm 弹卡 / review 审查 / full 直通）。 */
export function detectDangerous(command) {
  return matchTier(DANGEROUS_COMPILED, String(command ?? '').toLowerCase());
}
