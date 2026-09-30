/**
 * scan.ts —— 行级轻量扫描器
 *
 * 目的不是完整解析（那是 ese check 的职责），而是为改写类工具提供
 * 两个判据：① 某个位置处于代码 / 注释 / 文字块 / 字符串中的哪一种；
 * ② 某个位置是语句位置还是值位置（规范 §7.5 的位置裁决）。
 */

export type Zone = 'code' | 'comment' | 'text' | 'string';

export interface LineScan {
  zones: Zone[];
  /** 代码区内的括号净变化量（开为正、闭为负） */
  depth: number;
  /** 代码区内首个括号字符是否为右括号（即本行以闭合开头） */
  closerFirst: boolean;
  /** 整行是否只有注释与空白 */
  commentsOnly: boolean;
}

/** 判断某个字符是否处于注释 / 文字块 / 字符串内部（即不可改写区）。 */
export function scanLine(line: string): LineScan {
  const zones: Zone[] = new Array<Zone>(line.length).fill('code');
  let i = 0;
  while (i < line.length) {
    if (line.startsWith('[!', i)) {
      const end = line.indexOf('!]', i + 2);
      const stop = end === -1 ? line.length : end + 1; // 保留末尾 ']' 为代码区
      for (let k = i + 1; k < stop && k < line.length; k++) zones[k] = 'comment';
      i = stop;
      continue;
    }
    if (line.startsWith('[-', i)) {
      const end = line.indexOf('-]', i + 2);
      const stop = end === -1 ? line.length : end + 1; // 保留末尾 ']' 为代码区
      for (let k = i + 1; k < stop && k < line.length; k++) zones[k] = 'text';
      i = stop;
      continue;
    }
    if (line[i] === '"') {
      const end = line.indexOf('"', i + 1);
      const stop = end === -1 ? line.length : end + 1;
      for (let k = i; k < stop && k < line.length; k++) zones[k] = 'string';
      i = stop;
      continue;
    }
    i++;
  }

  let depth = 0;
  let closerFirst = false;
  let sawBracket = false;
  let sawCode = false;
  for (let k = 0; k < line.length; k++) {
    if (zones[k] !== 'code') continue;
    const ch = line[k];
    if (ch === '[') {
      if (!sawBracket) {
        closerFirst = false;
        sawBracket = true;
      }
      depth++;
      sawCode = true;
    } else if (ch === ']') {
      if (!sawBracket) {
        closerFirst = true;
        sawBracket = true;
      }
      depth--;
      sawCode = true;
    } else if (ch !== ' ' && ch !== '\t') {
      sawCode = true;
    }
  }

  const commentsOnly = !sawCode;
  return { zones, depth, closerFirst, commentsOnly };
}

export type PositionKind = 'statement' | 'value' | 'unknown';

/**
 * 位置裁决：判断 line[idx] 处的 `[` 属于语句位置还是值位置。
 *
 * 规则（规范 §7.5）：向前跳过空白，若前一个有效字符是 `]` 或行首，则为语句位置；
 * 若落在表达式内部（= , ( { : 或运算符、标识符之后）则为值位置；
 * 其余情形返回 unknown —— 迁移工具对 unknown 一律不改写。
 */
export function positionOf(line: string, scan: LineScan, idx: number): PositionKind {
  for (let i = idx - 1; i >= 0; i--) {
    if (scan.zones[i] !== 'code') continue;
    const ch = line[i];
    if (ch === ' ' || ch === '\t') continue;
    if (ch === ']') return 'statement';
    if (ch === '[') return 'unknown';
    if (ch === '=' || ch === ',' || ch === '(' || ch === '{' || ch === ':' || ch === ';') return 'value';
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '<' || ch === '>' || ch === '!' || ch === '&' || ch === '|') {
      return 'value';
    }
    return 'value'; // 标识符 / 数字 / 字符串之后必然是表达式内部
  }
  return 'statement';
}

/** 某个区间是否完全位于代码区。 */
export function allCode(scan: LineScan, start: number, end: number): boolean {
  for (let k = start; k < end; k++) {
    if (scan.zones[k] !== 'code') return false;
  }
  return true;
}

/** 拆分文本为「行 + 行尾符」序列，保留原始换行风格。 */
export function splitLines(text: string): { line: string; eol: string }[] {
  const out: { line: string; eol: string }[] = [];
  let i = 0;
  while (i <= text.length) {
    let j = i;
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++;
    const line = text.slice(i, j);
    let eol = '';
    if (j < text.length) {
      if (text[j] === '\r' && text[j + 1] === '\n') eol = '\r\n';
      else eol = text[j];
    }
    out.push({ line, eol });
    if (j >= text.length) break;
    i = j + eol.length;
  }
  return out;
}

export function joinLines(lines: { line: string; eol: string }[]): string {
  return lines.map((l) => l.line + l.eol).join('');
}

export function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
