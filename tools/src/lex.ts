/**
 * lex.ts —— ese 词法器
 *
 * 与 scan.ts 的「行级启发式扫描」不同，本模块产出完整 token 流，
 * 供真正的语法分析器消费。两者的关系：scan.ts 服务于文本改写（fmt），
 * lex.ts 服务于解析与转译（check / build）。
 *
 * 关键约定（依据 spec/grammar.ebnf）：
 *   · 换行是 token —— 「换行即结束」的形式化基础（§4.2）。
 *   · 文字块 [- … -]、注释块 [! … !]、按钮 [c. … .c] 在词法层整体成 token，
 *     其内部不再拆分（按钮文字允许含单个半角括号，见 §7.5）。
 *   · 标识符允许内嵌点号，`用户.名字` 与 `ese.bd` 各为一个词；
 *     点号紧贴规则（§6.2）由解析器在拆词时校验。
 *   · 每个 token 记录 [start, end) 源码区间，供解析器原样回取文本
 *     （行为按钮文字、路径等必须逐字保真）。
 */

import type { Pos } from './ast.ts';
import { EseError } from './diagnostics.ts';

export type TokKind =
  | 'open' // [
  | 'close' // ]
  | 'word' // 标识符 / 数字 / 关键字
  | 'string' // "…"（text 为去引号内容）
  | 'sym' // 单字符符号与比较运算符
  | 'text' // [- … -] 的内容
  | 'comment' // [! … !] 的内容
  | 'button' // [c. 文字 .c] 的文字
  | 'divider' // [---]
  | 'sep' // [!!] 行内分隔符
  | 'newline';

export interface Token {
  kind: TokKind;
  text: string;
  pos: Pos;
  start: number;
  end: number;
}

/** 单字符符号集合。`.` 不在其中——它允许内嵌于标识符。 */
const SYM_CHARS = new Set('+-*/=><?:~#$!@,;(){}|&%^'.split(''));

/** 需整体识别的多字符运算符，避免 `=` `=` 被拆成两个 token。 */
const MULTI_SYM = ['==', '!=', '>=', '<='];

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

function isWordStart(ch: string): boolean {
  return !SYM_CHARS.has(ch) && ch !== '[' && ch !== ']' && ch !== '"' && !isSpace(ch);
}

function isWordChar(ch: string): boolean {
  return isWordStart(ch) || ch === '.';
}

const BUTTON_EMPTY = /^\[c\.[ \t]+\.c\]/;
const BUTTON_TEXT = /^\[c\.[ \t]+([^\n]*?)[ \t]+\.c\]/;

export function tokenize(src: string, file: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const here = (): Pos => ({ line, column: col });
  const push = (kind: TokKind, text: string, at: Pos, start: number): void => {
    toks.push({ kind, text, pos: at, start, end: start });
  };
  /** 把最后一个 token 的区间右界推进到当前位置。 */
  const finish = (): void => {
    const t = toks[toks.length - 1];
    if (t) t.end = i;
  };

  const advance = (n: number): void => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else if (src[i] === '\r') {
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < src.length) {
    const ch = src[i];
    const start = i;

    // ---- 换行 ----
    if (ch === '\n' || ch === '\r') {
      const at = here();
      const width = ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      push('newline', '\n', at, start);
      advance(width);
      finish();
      continue;
    }

    // ---- 行内空白 ----
    if (isSpace(ch)) {
      advance(1);
      continue;
    }

    // ---- 以 `[` 起始的整体识别 ----
    if (ch === '[') {
      const nl = src.indexOf('\n', i);
      const rest = src.slice(i, nl === -1 ? src.length : nl);

      if (rest.startsWith('[---]')) {
        push('divider', '', here(), start);
        advance(5);
        finish();
        continue;
      }
      if (rest.startsWith('[!!]')) {
        push('sep', '', here(), start);
        advance(4);
        finish();
        continue;
      }
      if (rest.startsWith('[!')) {
        const at = here();
        const raw = src.slice(i);
        const end = raw.indexOf('!]');
        if (end === -1) {
          // 注释未闭合：词法层按行末收束，是否报 ESE1003 由解析器判定
          const stop = raw.indexOf('\n');
          const n = stop === -1 ? raw.length : stop;
          push('comment', raw.slice(2, n), at, start);
          advance(n);
          finish();
          continue;
        }
        push('comment', raw.slice(2, end), at, start);
        advance(end + 2);
        finish();
        continue;
      }
      if (rest.startsWith('[-')) {
        const at = here();
        const raw = src.slice(i);
        const end = raw.indexOf('-]');
        if (end === -1) {
          const stop = raw.indexOf('\n');
          const n = stop === -1 ? raw.length : stop;
          push('text', raw.slice(2, n), at, start);
          advance(n);
          finish();
          continue;
        }
        push('text', raw.slice(2, end), at, start);
        advance(end + 2);
        finish();
        continue;
      }
      const mEmpty = BUTTON_EMPTY.exec(rest);
      if (mEmpty) {
        push('button', '', here(), start);
        advance(mEmpty[0].length);
        finish();
        continue;
      }
      const mText = BUTTON_TEXT.exec(rest);
      if (mText) {
        push('button', mText[1], here(), start);
        advance(mText[0].length);
        finish();
        continue;
      }

      push('open', '[', here(), start);
      advance(1);
      finish();
      continue;
    }

    if (ch === ']') {
      push('close', ']', here(), start);
      advance(1);
      finish();
      continue;
    }

    // ---- 字符串 ----
    if (ch === '"') {
      const at = here();
      const raw = src.slice(i + 1);
      const end = raw.indexOf('"');
      if (end === -1) {
        throw new EseError('ESE1004', { symbol: '"' }, { file, line: at.line, column: at.column });
      }
      push('string', raw.slice(0, end), at, start);
      advance(end + 2);
      finish();
      continue;
    }

    // ---- 多字符运算符 ----
    const two = src.slice(i, i + 2);
    if (MULTI_SYM.includes(two)) {
      push('sym', two, here(), start);
      advance(2);
      finish();
      continue;
    }

    // ---- 单字符符号 ----
    if (SYM_CHARS.has(ch)) {
      push('sym', ch, here(), start);
      advance(1);
      finish();
      continue;
    }

    // ---- 词 ----
    if (isWordStart(ch)) {
      let j = i;
      while (j < src.length && isWordChar(src[j]) && src[j] !== '\n' && src[j] !== '\r') j++;
      let text = src.slice(i, j);
      // 词尾点号不属于词（避免把 `foo.` 吞进标识符）
      while (text.endsWith('.')) text = text.slice(0, -1);
      push('word', text, here(), start);
      advance(text.length);
      finish();
      continue;
    }

    // ---- 防御性兜底（正常不可达） ----
    push('sym', ch, here(), start);
    advance(1);
    finish();
  }

  push('newline', '\n', here(), i);
  finish();
  return toks;
}
