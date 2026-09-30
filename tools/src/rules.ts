/**
 * rules.ts —— 迁移规则集与缩进格式化
 *
 * 迁移规则覆盖规范第十九节第 ④ 步所列的历史破坏性变更。
 * 每条规则都是**纯文本改写**：命中即替换，无法判定位置时一律不改写并上报，
 * 绝不猜测——猜测导致的静默改义比拒绝改写危险得多。
 */

import { scanLine, positionOf, allCode, splitLines, joinLines } from './scan.ts';
import type { LineScan } from './scan.ts';

export interface Hit {
  rule: string;
  code: string | null;
  column: number;
  from: string;
  to: string;
}

export interface Skip {
  rule: string;
  code: string | null;
  column: number;
  from: string;
  reason: string;
}

export interface RuleResult {
  line: string;
  hits: Hit[];
  skips: Skip[];
}

export interface Rule {
  id: string;
  code: string | null;
  title: string;
  apply(line: string): RuleResult;
}

const NONE: RuleResult = { line: '', hits: [], skips: [] };

/** 要求命中处于语句位置（规范 §7.5 的位置裁决）。 */
function requireStatement(line: string, scan: LineScan, idx: number): { ok: boolean; reason?: string } {
  const pos = positionOf(line, scan, idx);
  if (pos === 'statement') return { ok: true };
  return {
    ok: false,
    reason:
      pos === 'value'
        ? '值位置：此处按列表 / 括号表达式解析，不是按钮'
        : '无法确定位置（前一个字符为 [），拒绝猜测',
  };
}

/**
 * 基于正则的通用改写。gate 返回 false 时记为 skip。
 */
function rewrite(
  ruleId: string,
  code: string | null,
  line: string,
  re: RegExp,
  build: (m: RegExpExecArray) => string,
  gate?: (line: string, scan: LineScan, idx: number) => { ok: boolean; reason?: string },
): RuleResult {
  const hits: Hit[] = [];
  const skips: Skip[] = [];
  const scan = scanLine(line);
  let out = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!allCode(scan, start, end)) {
      // 落入注释 / 文字块 / 字符串，不动
      re.lastIndex = end;
      continue;
    }
    const verdict = gate ? gate(line, scan, start) : { ok: true };
    if (!verdict.ok) {
      skips.push({ rule: ruleId, code, column: start + 1, from: m[0], reason: verdict.reason ?? '未通过前置判据' });
      re.lastIndex = end;
      continue;
    }
    const to = build(m);
    hits.push({ rule: ruleId, code, column: start + 1, from: m[0], to });
    out += line.slice(cursor, start) + to;
    cursor = end;
    re.lastIndex = end;
  }
  if (hits.length === 0) return { line, hits, skips };
  out += line.slice(cursor);
  return { line: out, hits, skips };
}

export const RULES: Rule[] = [
  {
    // M2 —— v2.6 的双层圆括号写法；必须先于 M1 执行
    id: 'button-double-parens',
    code: 'ESE1008',
    title: '旧按钮写法 [(( 文字 ))] → [c. 文字 .c]（v2.6）',
    apply(line: string): RuleResult {
      return rewrite(
        'button-double-parens',
        'ESE1008',
        line,
        /\[\(\(\s*([^[\]]*?)\s*\)\)\]/g,
        (m) => `[c. ${m[1].trim()} .c]`,
        requireStatement,
      );
    },
  },
  {
    // M1 —— v2.5 的单层圆括号写法
    id: 'button-single-parens',
    code: 'ESE1008',
    title: '旧按钮写法 [( 文字 )] → [c. 文字 .c]（v2.5）',
    apply(line: string): RuleResult {
      return rewrite(
        'button-single-parens',
        'ESE1008',
        line,
        /\[\((?!\()\s*([^[\]]*?)\s*\)\]/g,
        (m) => `[c. ${m[1].trim()} .c]`,
        requireStatement,
      );
    },
  },
  {
    // M3 —— v2.7 的紧贴写法（缺空格）
    id: 'button-tight',
    code: 'ESE1008',
    title: '按钮缺空格 [c.文字.c] → [c. 文字 .c]（v2.8 要求）',
    apply(line: string): RuleResult {
      return rewrite(
        'button-tight',
        'ESE1008',
        line,
        /\[c\.(\S(?:[^[\]]*?\S)?)\.c\]/g,
        (m) => `[c. ${m[1].trim()} .c]`,
        requireStatement,
      );
    },
  },
  {
    // M4 —— 路由页面声明缺少「页面」关键字，且旧写法路径带前导斜杠
    id: 'route-page-keyword',
    code: 'ESE1015',
    title: '路由页面声明补 页面 关键字并剥离前导斜杠',
    apply(line: string): RuleResult {
      const m = line.match(/^(\s*)\[\/[ \t]+(?!页面[ \t]|page[ \t])(\/?)([^\s\]]+)/);
      if (!m) return { line, hits: [], skips: [] };
      const from = m[0];
      const to = `${m[1]}[/ 页面 ${m[3]}`;
      return {
        line: to + line.slice(from.length),
        hits: [{ rule: 'route-page-keyword', code: 'ESE1015', column: m[1].length + 1, from, to }],
        skips: [],
      };
    },
  },
  {
    // M5 —— 跳转路径不得以 / 开头
    id: 'jump-leading-slash',
    code: 'ESE1015',
    title: '跳转路径剥离前导斜杠（消除 // 歧义）',
    apply(line: string): RuleResult {
      return rewrite('jump-leading-slash', 'ESE1015', line, /(跳转|goto)([ \t]+)\/([^\s\],)}<>]+)/g, (m) => `${m[1]}${m[2]}${m[3]}`);
    },
  },
  {
    // M6 —— v2.1 起 [!!] 收尾不再是必须的
    id: 'redundant-inline-sep',
    code: null,
    title: '移除行尾多余的 [!!]（v2.1 起换行即结束）',
    apply(line: string): RuleResult {
      const withoutTrailingSpace = line.replace(/[ \t]+$/, '');
      if (!withoutTrailingSpace.endsWith('[!!]')) return { line, hits: [], skips: [] };
      const idx = withoutTrailingSpace.length - 4;
      const scan = scanLine(line);
      // 只判首字符所在区：若 [!!] 落在更外层的注释或文字块内，该位置早被标为 comment/text
      if (scan.zones[idx] !== 'code') return { line, hits: [], skips: [] };
      const before = withoutTrailingSpace.slice(0, idx).replace(/[ \t]+$/, '');
      if (before.trim() === '' || !before.endsWith(']')) return { line, hits: [], skips: [] };
      const to = before + line.slice(withoutTrailingSpace.length);
      return {
        line: to,
        hits: [{ rule: 'redundant-inline-sep', code: null, column: idx + 1, from: '[!!]', to: '' }],
        skips: [],
      };
    },
  },
];

export interface MigrateResult {
  lines: { line: string; eol: string }[];
  hits: { file: string; line: number; hit: Hit }[];
  skips: { file: string; line: number; skip: Skip }[];
}

export function migrateLine(line: string): RuleResult {
  let current = line;
  const hits: Hit[] = [];
  const skips: Skip[] = [];
  for (const rule of RULES) {
    const r = rule.apply(current);
    if (r.hits.length === 0 && r.skips.length === 0) continue;
    current = r.line;
    hits.push(...r.hits);
    skips.push(...r.skips);
  }
  return { line: current, hits, skips };
}

export function migrateText(text: string, file: string): MigrateResult {
  const lines = splitLines(text);
  const out: { line: string; eol: string }[] = [];
  const hits: { file: string; line: number; hit: Hit }[] = [];
  const skips: { file: string; line: number; skip: Skip }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const src = lines[i].line;
    const r = migrateLine(src);
    for (const h of r.hits) hits.push({ file, line: i + 1, hit: h });
    for (const s of r.skips) skips.push({ file, line: i + 1, skip: s });
    out.push({ line: r.line, eol: lines[i].eol });
  }
  return { lines: out, hits, skips };
}

// ------------------------------------------------------------------ 格式化

export interface FormatOptions {
  /** 每层缩进，默认两个半角空格 */
  indent: string;
}

/** 依据括号嵌套层级统一缩进。缩进不参与语义（规范 §4.5），故为纯风格改写。 */
export function formatLines(
  lines: { line: string; eol: string }[],
  opts: FormatOptions = { indent: '  ' },
): { lines: { line: string; eol: string }[]; changed: number } {
  const out: { line: string; eol: string }[] = [];
  let depth = 0;
  let changed = 0;
  for (const { line, eol } of lines) {
    if (line.trim() === '') {
      out.push({ line: '', eol });
      continue;
    }
    const scan = scanLine(line);
    const level = scan.closerFirst ? Math.max(depth - 1, 0) : Math.max(depth, 0);
    const next = opts.indent.repeat(level) + line.trim();
    if (next !== line) changed++;
    out.push({ line: next, eol });
    depth = Math.max(0, depth + scan.depth);
  }
  return { lines: out, changed };
}

export function processText(
  text: string,
  file: string,
  opts: { migrate: boolean; indent?: string },
): { result: string; migrate: MigrateResult | null; indentChanged: number } {
  let lines = splitLines(text);
  let mig: MigrateResult | null = null;
  if (opts.migrate) {
    mig = migrateText(text, file);
    lines = mig.lines;
  }
  const fmt = formatLines(lines, { indent: opts.indent ?? '  ' });
  return { result: joinLines(fmt.lines), migrate: mig, indentChanged: fmt.changed };
}
