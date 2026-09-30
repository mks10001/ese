/**
 * spec.ts —— 单一数据源装载与一致性校验
 *
 * ese 的硬性约束：关键字与诊断消息不得手工维护中英两份。
 * 本模块是工具链访问 spec/ 的唯一入口，其余模块禁止自行读取 spec 目录。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface KeywordRecord {
  id: string;
  zh: string[];
  en: string[];
  position: string;
  since: string;
  status: string;
  upstream?: string;
  note?: string;
  precedence?: number;
  associativity?: string;
  open_version?: string;
}

export interface PragmaRecord {
  id: string;
  form: string;
  meaning: string;
  since: string;
  constraints: string;
}

export interface BuiltinAttribute {
  id: string;
  zh: string;
  en: string | null;
  valueType: string;
  since: string;
  status: string;
  note?: string;
}

export interface UiComponentRecord {
  id: string;
  zh: string;
  en: string;
  since: string;
  note?: string;
}

export interface KeywordsFile {
  $schema?: string;
  meta: Record<string, unknown>;
  keywords: KeywordRecord[];
  pragmas: PragmaRecord[];
  builtinAttributes: BuiltinAttribute[];
  styleWhitelist: string[];
  eventFields: string[];
  /** ese-ui 标准库第一批（内置组件名，中英两形）。 */
  uiComponents?: UiComponentRecord[];
}

export interface DiagnosticTemplate {
  code: string;
  severity: 'error' | 'warning' | 'hint';
  topic: string;
  since: string;
  spec_ref: string;
  zh: string;
  en: string;
  placeholders: string[];
  trigger: string;
  note?: string;
  hint_zh?: string;
  hint_en?: string;
}

export interface DiagnosticsFile {
  $schema?: string;
  meta: Record<string, unknown>;
  diagnostics: DiagnosticTemplate[];
  textFormats: {
    message: string;
    hint: string;
    severity_labels: Record<string, { zh: string; en: string }>;
  };
}

/** 仓库根目录：本文件位于 tools/src/，上溯两级。 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const specDir = process.env['ESE_SPEC_DIR'] ?? resolve(repoRoot, 'spec');

function loadJson<T>(file: string): T {
  if (!existsSync(file)) {
    throw new Error(`缺少单一数据源文件：${file}`);
  }
  const raw = readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`单一数据源 JSON 解析失败：${file}\n  ${String(err)}`);
  }
}

export interface SpecBundle {
  keywords: KeywordsFile;
  diagnostics: DiagnosticsFile;
  grammar: string;
  paths: { keywords: string; diagnostics: string; grammar: string };
}

export function loadSpec(): SpecBundle {
  const paths = {
    keywords: resolve(specDir, 'keywords.json'),
    diagnostics: resolve(specDir, 'diagnostics.json'),
    grammar: resolve(specDir, 'grammar.ebnf'),
  };
  const grammar = existsSync(paths.grammar) ? readFileSync(paths.grammar, 'utf8') : '';
  if (!grammar) throw new Error(`缺少单一数据源文件：${paths.grammar}`);
  return {
    keywords: loadJson<KeywordsFile>(paths.keywords),
    diagnostics: loadJson<DiagnosticsFile>(paths.diagnostics),
    grammar,
    paths,
  };
}

/** 关键字查表：给定标识符，返回它在另一模式下的写法。 */
export function counterpart(spec: SpecBundle, token: string, from: 'zh' | 'en'): string | null {
  for (const k of spec.keywords.keywords) {
    if (from === 'zh' && k.zh.includes(token)) return k.en[k.zh.indexOf(token)] ?? null;
    if (from === 'en' && k.en.includes(token)) return k.zh[k.en.indexOf(token)] ?? null;
  }
  return null;
}

// ---------------------------------------------------------------- 一致性校验

export interface SpecProblem {
  check: string;
  detail: string;
}

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

function placeholdersIn(template: string): Set<string> {
  const found = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_RE)) found.add(m[1]);
  return found;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** 从 grammar.ebnf 中提取全部字符串字面量（跳过注释块与注释行）。 */
export function grammarLiterals(grammar: string): string[] {
  const out: string[] = [];
  const lines = grammar.split(/\r?\n/);
  let inBlockComment = false;
  for (const raw of lines) {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*)');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    // 去掉行内块注释
    let guard = 0;
    for (;;) {
      const start = line.indexOf('(*');
      if (start === -1) break;
      const end = line.indexOf('*)', start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlockComment = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
      if (++guard > 500) break;
    }
    // 提取 "...."
    for (const m of line.matchAll(/"([^"]*)"/g)) out.push(m[1]);
  }
  return out;
}

/** @symbols 区块中列出的正式符号对数量。 */
export function symbolPairCount(grammar: string): number {
  const lines = grammar.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('@symbols'));
  if (start === -1) return 0;
  let count = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('---') || t.includes('@reserved')) break;
    if (/^\[[^\]]+\]\s+\S+/.test(t)) count++;
  }
  return count;
}

export function verifySpec(spec: SpecBundle): SpecProblem[] {
  const problems: SpecProblem[] = [];

  // C1 gramar.ebnf 中出现的关键字，全部存在于 keywords.json
  const allowed = new Set<string>();
  for (const k of spec.keywords.keywords) {
    for (const t of k.zh) allowed.add(t);
    for (const t of k.en) allowed.add(t);
  }
  for (const p of spec.keywords.pragmas) allowed.add(p.form.replace(/[[\]]/g, ''));
  for (const a of spec.keywords.builtinAttributes) {
    allowed.add(a.zh);
    if (a.en) allowed.add(a.en);
  }
  for (const t of spec.keywords.styleWhitelist) allowed.add(t);
  for (const t of spec.keywords.eventFields) allowed.add(t);
  // 文法中出现的结构性 ASCII 词（长度 ≥ 2）必须是关键字
  const structuralExempt = new Set(['ese.bd']);
  for (const lit of grammarLiterals(spec.grammar)) {
    if (literalIsStructural(lit) || structuralExempt.has(lit)) continue;
    if (!allowed.has(lit)) {
      problems.push({ check: 'C1', detail: `grammar.ebnf 中的字面量 "${lit}" 不在 keywords.json 中` });
    }
  }

  // C2 中英两形数量相等、整条词组无重复
  //
  // 唯一性作用于「整条词组」而非单个词元：多词关键字（如 引入 … 的 … / import … from …、
  // 引入 … 为 … / import … as …）本就必须共享词元，按词元判重会把正确的表判成错的。
  const seenZh = new Map<string, string>();
  const seenEn = new Map<string, string>();
  for (const k of spec.keywords.keywords) {
    if (k.zh.length !== k.en.length) {
      problems.push({
        check: 'C2',
        detail: `关键字 ${k.id} 的中英形数量不等（zh=${k.zh.length}, en=${k.en.length}）`,
      });
    }
    if (k.zh.length === 0 || k.en.length === 0) {
      problems.push({ check: 'C2', detail: `关键字 ${k.id} 缺少中形或英形` });
    }
    const zhPhrase = k.zh.join(' ');
    const enPhrase = k.en.join(' ');
    if (seenZh.has(zhPhrase)) problems.push({ check: 'C2', detail: `中文词组「${zhPhrase}」重复（${seenZh.get(zhPhrase)} 与 ${k.id}）` });
    else seenZh.set(zhPhrase, k.id);
    if (seenEn.has(enPhrase)) problems.push({ check: 'C2', detail: `英文词组「${enPhrase}」重复（${seenEn.get(enPhrase)} 与 ${k.id}）` });
    else seenEn.set(enPhrase, k.id);
  }
  // 词组首词元不得互相包含（防止解析器的关键字前缀歧义），仅对单词语组做严格判定
  const singleZh = new Map<string, string>();
  for (const k of spec.keywords.keywords) {
    if (k.zh.length !== 1) continue;
    const t = k.zh[0];
    if (singleZh.has(t)) problems.push({ check: 'C2', detail: `中文关键字「${t}」重复（${singleZh.get(t)} 与 ${k.id}）` });
    else singleZh.set(t, k.id);
  }

  // C3 诊断码：中英模板占位符集合一致，且占位符均已登记
  const declared = new Set(Object.keys((spec.diagnostics.meta['placeholders'] as Record<string, string>) ?? {}).map((s) => s.replace(/[{}]/g, '')));
  const seenCodes = new Set<string>();
  for (const d of spec.diagnostics.diagnostics) {
    if (seenCodes.has(d.code)) problems.push({ check: 'C3', detail: `诊断码 ${d.code} 重复定义` });
    seenCodes.add(d.code);
    const zh = placeholdersIn(d.zh);
    const en = placeholdersIn(d.en);
    if (!sameSet(zh, en)) {
      problems.push({
        check: 'C3',
        detail: `${d.code} 的中英消息占位符不一致（zh={${[...zh].join(',')}} en={${[...en].join(',')}}）`,
      });
    }
    const listed = new Set(d.placeholders);
    if (!sameSet(listed, zh)) {
      problems.push({
        check: 'C3',
        detail: `${d.code} 的 placeholders 字段与模板不符（字段={${[...listed].join(',')}} 模板={${[...zh].join(',')}}）`,
      });
    }
    for (const p of zh) {
      if (!declared.has(p)) problems.push({ check: 'C3', detail: `${d.code} 使用了未登记的占位符 {${p}}` });
    }
    if (!/^ESE[1-4]\d{3}$/.test(d.code)) {
      problems.push({ check: 'C3', detail: `${d.code} 不符合 ESExxxx 四段编码规则` });
    }
  }

  // C4 正式符号 17 对
  const n = symbolPairCount(spec.grammar);
  if (n !== 17) {
    problems.push({ check: 'C4', detail: `grammar.ebnf 的 @symbols 列出 ${n} 对符号，应为 17 对` });
  }

  return problems;
}

/**
 * 判断文法中的某个字面量是否为「结构性符号」而非关键字。
 * 结构性：运算符、定界符、单字符字母（如按钮定界字母 c）、路径片段等。
 */
function literalIsStructural(lit: string): boolean {
  if (lit === '') return true;
  // 含非字母数字下划线者（运算符、路径、扩展名）一律视为结构性
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(lit)) return true;
  // 单字母为结构性定界符（如 c / s）
  return lit.length < 2;
}
