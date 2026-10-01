/**
 * parse.ts —— ese 语法分析器（递归下降）
 *
 * 输入：源码文本；输出：FileAst。诊断一律以 EseError 抛出「码 + 参数 + 位置」，
 * 文本由上层用 spec/diagnostics.json 渲染。
 *
 * 三个实现期裁决（已在 spec/README.md 登记）：
 *   D-1 块容器的闭合符是「开符号 + ]」：+] >] ?] ~] /]。§18 文法写作单独的 "]"
 *       属简写疏漏（勘误 E-2，已回写规范）。
 *   D-2 值位置的 `{ 标识符 }`（无冒号）按「取值」解析，`{ 字符串 : 值 }` 按字典
 *       字面量解析。前者是 `键={项.id}` 这类写法得以成立的前提。
 *   D-3 属性与语句之间的注释 token 一律跳过；以 `文档:` / `doc:` 开头的注释
 *       绑定其后紧邻的组件定义（§11.5）。
 */

import type {
  ActionN,
  Attr,
  AssertS,
  BinOp,
  BranchN,
  ButtonN,
  CalcS,
  ChildrenN,
  CompCallN,
  ComponentDefS,
  DataS,
  ExecS,
  Expr,
  FileAst,
  ImportS,
  InputN,
  Invoke,
  LoopN,
  MediaN,
  Mode,
  Node,
  Pos,
  PropDecl,
  PropLineS,
  RoutePageS,
  Stmt,
  TextN,
  TplPart,
} from './ast.ts';
import { tokenize, type Token } from './lex.ts';
import { EseError, type Position } from './diagnostics.ts';
import type { KeywordRecord, SpecBundle } from './spec.ts';

// ---------------------------------------------------------------- 关键字表

/**
 * 关键字访问器。所有关键字文本均取自 spec/keywords.json，
 * 本模块不硬编码任何一个关键字的字形。
 */
export class KwTable {
  private byId = new Map<string, KeywordRecord>();

  constructor(spec: SpecBundle) {
    for (const k of spec.keywords.keywords) this.byId.set(k.id, k);
  }

  words(id: string, mode: Mode): string[] {
    const k = this.byId.get(id);
    if (!k) return [];
    return mode === 'en' ? k.en : k.zh;
  }

  /** token 是否为该关键字的**首个**词元。 */
  head(id: string, text: string, mode: Mode): boolean {
    const w = this.words(id, mode);
    return w.length > 0 && w[0] === text;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** 关键字在两种模式下的全部字形（用于「语言与模式不符」的诊断）。 */
  anyForm(id: string): string[] {
    const k = this.byId.get(id);
    if (!k) return [];
    return [...k.zh, ...k.en];
  }
}

// ---------------------------------------------------------------- 常量

/** 可作为块闭合符的符号（开符号本身，闭合写作「符号 + ]」）。 */
const CLOSER_SYMS = new Set(['+', '>', '?', '~', '#', '$', '*', '=', '<']);

const CMP_OPS = ['==', '!=', '>=', '<=', '>', '<'];

// ---------------------------------------------------------------- 解析器

class Parser {
  private toks: Token[];
  private i = 0;
  private src: string;
  private file: string;
  private kw: KwTable;
  mode: Mode = 'zh';
  private pendingDoc: string | null = null;

  constructor(src: string, file: string, spec: SpecBundle) {
    this.src = src;
    this.file = file;
    this.kw = new KwTable(spec);
    this.toks = tokenize(src, file);
  }

  // ------------------------------------------------------------ 基础工具

  private peek(k = 0): Token {
    return this.toks[this.i + k] ?? this.toks[this.toks.length - 1];
  }

  private kind(k = 0): string {
    return this.peek(k).kind;
  }

  private sym(k = 0): string {
    const t = this.peek(k);
    return t.kind === 'sym' ? t.text : '';
  }

  private atEnd(): boolean {
    return this.i >= this.toks.length;
  }

  private pos(): Pos {
    const t = this.peek(0);
    return t.pos;
  }

  private at(): Position {
    const p = this.pos();
    return { file: this.file, line: p.line, column: p.column };
  }

  private err(code: string, params: Record<string, string | number>, pos?: Pos): EseError {
    const p = pos ?? this.pos();
    return new EseError(code, params, { file: this.file, line: p.line, column: p.column });
  }

  /** 当前位置附近的源码片段，用于诊断的 {detail} 占位符。 */
  private here(): string {
    const t = this.peek(0);
    const end = Math.min(this.src.length, t.start + 28);
    const line = this.src.slice(t.start, end).split('\n')[0] ?? '';
    return line.length > 0 ? line : '<行尾>';
  }

  /** 跳过注释、行内分隔符 —— 但不跳过换行。 */
  private skipTrivia(): void {
    while (!this.atEnd()) {
      const k = this.kind();
      if (k === 'comment') {
        const text = this.peek(0).text.trim();
        const docHead = this.kw.words('doc', this.mode)[0] ?? '文档';
        const m = /^([^:：]+)[:：](.*)$/.exec(text);
        if (m && m[1].trim() === docHead) this.pendingDoc = m[2].trim();
        this.i++;
        continue;
      }
      if (k === 'sep') {
        this.i++;
        continue;
      }
      break;
    }
  }

  private skipNewlines(): void {
    while (!this.atEnd() && (this.kind() === 'newline' || this.kind() === 'comment' || this.kind() === 'sep')) this.i++;
  }

  private eatSym(s: string): boolean {
    if (this.sym(0) === s) {
      this.i++;
      return true;
    }
    return false;
  }

  private expectSym(s: string): void {
    if (!this.eatSym(s)) {
      throw this.err('ESE1016', { detail: this.here() });
    }
  }

  private eatClose(): boolean {
    if (this.kind() === 'close') {
      this.i++;
      return true;
    }
    return false;
  }

  /**
   * 跳过换行与注释/行内分隔。
   *
   * 块闭合符允许 `?` 与 `]` 跨行书写（`[?? … ??]` 的 `??` 与 `]`
   * 也可能分占两行），这里统一收口，避免每处各写一遍。
   */
  private skipNewlines(): void {
    for (;;) {
      this.skipTrivia();
      if (this.kind() !== 'newline') return;
      this.i++;
    }
  }

  private expectNewline(): void {
    this.skipTrivia();
    if (this.kind() === 'newline') {
      this.i++;
      return;
    }
    // 允许块闭合紧跟（如 `[+ 居中 +]` 单行形态）
    if (this.kind() === 'close') return;
    if (this.kind() === 'sym' && this.peek(1).kind === 'close') return;
    throw this.err('ESE1016', { detail: this.here() });
  }

  private lineEndIdx(from: number): number {
    let j = from;
    while (j < this.toks.length && this.toks[j].kind !== 'newline') j++;
    return j;
  }

  private lastSignificant(from: number, to: number): Token | null {
    let last: Token | null = null;
    for (let j = from; j < to; j++) {
      const t = this.toks[j];
      if (t.kind === 'comment' || t.kind === 'sep') continue;
      last = t;
    }
    return last;
  }

  /** 从 token 区间原样回取源码文本（保真：按钮文字、路径等必须逐字一致）。 */
  private slice(from: number, to: number): string {
    const a = this.toks[from];
    const b = this.toks[to];
    if (!a) return '';
    const endOff = b ? b.start : (this.toks[to - 1]?.end ?? a.end);
    return this.src.slice(a.start, endOff);
  }

  // ------------------------------------------------------------ 顶层

  parse(): FileAst {
    this.skipNewlines();

    // pragma：[zz] / [ee]
    if (
      this.kind(0) === 'open' &&
      this.kind(1) === 'word' &&
      this.kind(2) === 'close'
    ) {
      const t = this.peek(1).text;
      const zh = this.kw.words('mode-zh', 'zh');
      const en = this.kw.words('mode-en', 'zh');
      // pragma 的字形固定为 ee / zz（不进符号表，也不参与中英切换）
      if (t === 'ee' || t === 'zz' || zh.includes(t) || en.includes(t)) {
        this.mode = t === 'ee' ? 'en' : 'zh';
        this.i += 3;
        this.skipNewlines();
      }
    }

    // file-head：[ese.bd / [名字.bd
    if (this.kind(0) !== 'open' || this.kind(1) !== 'word') {
      throw this.err('ESE1016', { detail: this.here() });
    }
    const headTok = this.peek(1);
    if (!headTok.text.endsWith('.bd')) {
      throw this.err('ESE1016', { detail: this.here() });
    }
    this.i += 2;
    const base = headTok.text.slice(0, -3);
    const kind: 'entry' | 'module' = headTok.text === 'ese.bd' ? 'entry' : 'module';
    this.expectNewline();

    const stmts = this.parseStmts(null);

    if (this.kind(0) === 'close') this.i++;
    else throw this.err('ESE1001', { symbol: '[', line: headTok.pos.line }, headTok.pos);

    return { file: this.file, mode: this.mode, kind, name: base, stmts };
  }

  // ------------------------------------------------------------ 语句序列

  /**
   * 解析语句序列，直到遇见块闭合（`closer` + `]`）或文件级 `]`。
   * 不消费闭合符 —— 由调用方消费，以保证 `+]` `>]` 等形态的配对可见。
   */
  private parseStmts(closer: string | string[] | null, stopAtElse = false): Stmt[] {
    const closers = closer === null ? [] : typeof closer === 'string' ? [closer] : closer;
    const out: Stmt[] = [];
    for (;;) {
      this.skipTrivia();
      while (this.kind() === 'newline') {
        this.i++;
        this.skipTrivia();
      }
      if (this.atEnd()) break;
      if (this.kind() === 'close') break;
      if (closers.length > 0 && this.atAnyCloser(closers)) break;
      if (stopAtElse && this.isElseStart()) break;

      out.push(this.parseStmt());
      this.endStmt();
    }
    return out;
  }

  /**
   * 是否停在块闭合符前。
   *
   * 闭合符 = 开头符号 + `]`（如 `+]` `?]` `~]` `??]`）。这里的 `closers` 是
   * 多字符符号串（如 `'??'`），逐符号比对后再要求紧跟 `]`；
   * 也宽松允许符号与 `]` 分占两行。
   */
  private atAnyCloser(closers: string[]): boolean {
    for (const c of closers) {
      const chars = [...c];
      let ok = true;
      for (let n = 0; n < chars.length; n++) {
        if (this.sym(n) !== chars[n]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const after = this.kind(chars.length);
      if (after === 'close' || after === 'newline') return true;
    }
    return false;
  }

  /**
   * 否则分支闭合符。
   *
   * 规范符号表（§3.1 `[?? ??]`）与规范全部示例写作 `??]`，而 spec/grammar.ebnf
   * 旧版写作 `?]`——按「闭合符 = 开头符号 + `]`」的通则，`??]` 才是规范形
   * （已记入勘误 E-3，文法与文档同步修正）。这里两形均接受，以免旧源码失效。
   */
  private eatElseCloser(): boolean {
    if (this.sym() === '?' && this.sym(1) === '?' && this.kind(2) === 'close') {
      this.i += 2;
      return this.eatClose();
    }
    if (this.sym() === '?' && this.kind(1) === 'close') {
      this.i += 1;
      return this.eatClose();
    }
    return false;
  }

  private isElseStart(): boolean {
    return this.kind(0) === 'open' && this.sym(1) === '?' && this.sym(2) === '?';
  }

  /** 语句收尾：要求其后只能是换行、行内分隔、注释或块闭合。 */
  private endStmt(): void {
    this.skipTrivia();
    if (this.kind() === 'newline') {
      this.i++;
      return;
    }
    if (this.kind() === 'close') return;
    if (this.kind() === 'sym' && this.peek(1).kind === 'close') return;
    if (this.atEnd()) return;
    throw this.err('ESE1016', { detail: this.here() });
  }

  // ------------------------------------------------------------ 单条语句

  private parseStmt(): Stmt {
    const k0 = this.kind(0);

    // 词法层整体成 token 的三类：文字块、分割线、按钮
    if (k0 === 'text') return this.parseText();
    if (k0 === 'divider') {
      const pos = this.pos();
      this.i += 1;
      return { k: 'divider', pos };
    }
    if (k0 === 'button') return this.parseButton();

    // 裸行语句（属性行 / 引入 / 断言 / 渲染 内容 / 预留语法）
    if (k0 === 'word') return this.parseBareStmt();

    if (k0 === 'open') {
      const t1 = this.peek(1);
      if (t1.kind === 'sym') {
        switch (t1.text) {
          case '+':
            return this.parsePanelOrComponent();
          case '*':
            return this.parseMedia();
          case '=':
            return this.parseInput();
          case '/':
            return this.parseRoute();
          case '>':
            return this.parseExecOrAction();
          case '?':
            return this.parseBranch();
          case '~':
            return this.parseLoop();
          case '#':
            return this.parseData();
          case '$':
            return this.parseCalc();
          case '<':
            return this.parseCompCall();
          default:
            break;
        }
      }
      throw this.err('ESE1016', { detail: this.here() });
    }

    throw this.err('ESE1016', { detail: this.here() });
  }

  /**
   * 不以 `[` 起始的语句：属性行 / 引入 / 断言 / 渲染 内容 / 预留异步语法。
   * 这四类在 spec/grammar.ebnf 中都是**裸行**产生式，不带括号定界。
   */
  private parseBareStmt(): Stmt {
    const t0 = this.peek(0);
    const m = this.mode;
    if (this.kw.head('prop', t0.text, m)) return this.parsePropLine();
    if (this.kw.head('import', t0.text, m)) return this.parseImport();
    if (this.kw.head('assert', t0.text, m)) return this.parseAssert();
    if (this.kw.head('render-children', t0.text, m)) return this.parseChildren();
    if (
      this.kw.head('wait', t0.text, m) ||
      this.kw.head('on-mount', t0.text, m) ||
      this.kw.head('on-unmount', t0.text, m)
    ) {
      throw this.err('ESE1011', { symbol: t0.text }, t0.pos);
    }
    throw this.err('ESE1016', { detail: this.here() });
  }

  // ------------------------------------------------------------ 前端层

  private parseText(): TextN {
    const tok = this.peek(0);
    this.i += 1;
    // 定界符内侧的空白属于排版而非内容（与按钮 SP 规则同理），裁剪首尾
    return { k: 'text', parts: this.template(tok.text.trim(), tok.pos), pos: tok.pos };
  }

  private parseButton(): ButtonN {
    const tok = this.peek(0);
    this.i += 1;
    // 尾随跳转
    let jump: string | null = null;
    const save = this.i;
    this.skipTrivia();
    const t = this.peek(0);
    if (t.kind === 'word' && this.kw.head('goto', t.text, this.mode)) {
      this.i++;
      jump = this.readPathToLineEnd();
    } else {
      this.i = save;
    }
    return { k: 'button', text: tok.text.trim(), jump, pos: tok.pos };
  }

  private parsePanelOrComponent(): Node | ComponentDefS {
    const openTok = this.peek(0);
    const third = this.peek(2);
    if (third.kind === 'word' && this.kw.head('component-def', third.text, this.mode)) {
      return this.parseComponentDef();
    }

    this.i += 2; // [ +
    const attrs = this.parseAttrs();
    this.expectNewline();
    const children = this.parseStmts('+');
    if (this.sym() === '+') this.i++;
    if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[+', line: openTok.pos.line }, openTok.pos);
    return { k: 'panel', attrs, children, pos: openTok.pos };
  }

  private parseMedia(): MediaN {
    const openTok = this.peek(0);
    const at = this.pos();
    this.i += 2; // [ *
    this.skipTrivia();
    let file = '';
    if (this.kind() === 'word') {
      file = this.peek(0).text;
      this.i++;
    } else if (this.kind() === 'string') {
      file = this.peek(0).text;
      this.i++;
    } else {
      throw this.err('ESE1013', { detail: this.here() }, at);
    }
    const attrs = this.parseAttrs();
    if (this.sym() === '*') this.i++;
    else throw this.err('ESE1001', { symbol: '[*', line: openTok.pos.line }, openTok.pos);
    if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[*', line: openTok.pos.line }, openTok.pos);
    return { k: 'media', file, attrs, pos: at };
  }

  private parseInput(): InputN {
    const openTok = this.peek(0);
    const at = this.pos();
    this.i += 2; // [ =
    this.skipTrivia();
    if (this.kind() !== 'word') throw this.err('ESE1016', { detail: this.here() }, at);
    const name = this.peek(0).text;
    this.i++;
    const attrs = this.parseAttrs();
    if (this.sym() === '=') this.i++;
    else throw this.err('ESE1001', { symbol: '[=', line: openTok.pos.line }, openTok.pos);
    if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[=', line: openTok.pos.line }, openTok.pos);
    return { k: 'input', name, attrs, pos: at };
  }

  // ------------------------------------------------------------ 逻辑层

  private parseExecOrAction(): ExecS | ActionN {
    const openTok = this.peek(0);
    const at = this.pos();
    const bodyStart = this.i + 2; // 跳过 [ >

    const end = this.lineEndIdx(bodyStart);
    const last = this.lastSignificant(bodyStart, end);
    const isExec = last === null || (last.kind === 'sym' && last.text === ':');

    if (isExec) {
      this.i += 2;
      let name: string | null = null;
      let params: string[] = [];
      this.skipTrivia();
      if (this.kind() === 'word' && this.sym(1) !== ':') {
        name = this.peek(0).text;
        this.i++;
        if (this.sym() === '(') {
          params = this.parseParamNames();
        }
      } else if (this.kind() === 'word') {
        name = this.peek(0).text;
        this.i++;
      }
      this.skipTrivia();
      if (this.sym() === ':') this.i++;
      else if (name !== null) throw this.err('ESE1016', { detail: this.here() }, at);
      if (this.kind() !== 'newline' && this.kind() !== 'close') {
        throw this.err('ESE1016', { detail: this.here() }, at);
      }
      if (this.kind() === 'newline') this.i++;
      const body = this.parseStmts('>');
      if (this.sym() === '>') this.i++;
      if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[>', line: openTok.pos.line }, openTok.pos);
      return { k: 'exec', name, params, body, pos: at };
    }

    // 行为按钮 [> 文字 <] [调用 名字(args)]
    let j = bodyStart;
    while (j < end) {
      if (this.toks[j].kind === 'sym' && this.toks[j].text === '<' && this.toks[j + 1]?.kind === 'close') break;
      j++;
    }
    if (j >= end) throw this.err('ESE1016', { detail: this.here() }, at);
    const text = this.src.slice(this.toks[bodyStart]?.start ?? 0, this.toks[j].start).replace(/\s+$/, '');
    this.i = j + 2;

    let invoke: Invoke | null = null;
    const save = this.i;
    this.skipTrivia();
    const t = this.peek(0);
    if (t.kind === 'word' && this.kw.head('call', t.text, this.mode)) {
      this.i++;
      this.skipTrivia();
      if (this.kind() !== 'word') throw this.err('ESE1016', { detail: this.here() }, at);
      const nameTok = this.peek(0);
      const name = nameTok.text;
      this.i++;
      let args: Expr[] = [];
      if (this.sym() === '(') args = this.parseArgs();
      invoke = { name, args, pos: nameTok.pos };
    } else {
      this.i = save;
    }
    return { k: 'action', text: text.trim(), invoke, pos: at };
  }

  private parseParamNames(): string[] {
    this.expectSym('(');
    const out: string[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.kind() === 'word') {
        out.push(this.peek(0).text);
        this.i++;
      }
      this.skipTrivia();
      if (this.eatSym(',')) continue;
      break;
    }
    this.expectSym(')');
    return out;
  }

  private parseArgs(): Expr[] {
    this.expectSym('(');
    const out: Expr[] = [];
    this.skipTrivia();
    if (this.sym() === ')') {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.parseExpr());
      this.skipTrivia();
      if (this.eatSym(',')) continue;
      break;
    }
    this.expectSym(')');
    return out;
  }

  private parseBranch(): BranchN {
    const openTok = this.peek(0);
    const at = this.pos();
    this.i += 2; // [ ?
    const cond = this.parseExpr();
    if (this.kind() !== 'newline' && this.kind() !== 'close') {
      throw this.err('ESE1016', { detail: this.here() }, at);
    }
    if (this.kind() === 'newline') this.i++;

    const then = this.parseStmts('?', true);
    let otherwise: Stmt[] | null = null;
    if (this.isElseStart()) {
      this.i += 3; // [ ? ?
      if (this.kind() === 'newline') this.i++;
      otherwise = this.parseStmts(['??', '?']);
      if (!this.eatElseCloser()) throw this.err('ESE1001', { symbol: '[??', line: openTok.pos.line }, openTok.pos);
    }
    // 分支自身的闭合符 `?]`：`?` 与 `]` 之间允许跨行（含 `[?? … ??]` 之后）
    this.skipNewlines();
    if (this.sym() === '?') this.i++;
    this.skipNewlines();
    if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[?', line: openTok.pos.line }, openTok.pos);
    return { k: 'branch', cond, then, otherwise, pos: at };
  }

  private parseLoop(): LoopN {
    const openTok = this.peek(0);
    const at = this.pos();
    this.i += 2; // [ ~
    this.skipTrivia();

    const m = this.mode;
    let node: LoopN;

    if (this.kind() === 'word' && this.kw.head('for', this.peek(0).text, m)) {
      this.i++;
      const iterable = this.parseExpr();
      this.skipTrivia();
      const forWords = this.kw.words('for', m);
      if (this.kind() === 'word' && (forWords[1] === this.peek(0).text || this.kw.words('for', m === 'zh' ? 'en' : 'zh')[1] === this.peek(0).text)) {
        this.i++;
      } else {
        throw this.err('ESE1016', { detail: this.here() }, at);
      }
      let item: string | null = null;
      this.skipTrivia();
      if (this.kind() === 'word') {
        item = this.peek(0).text;
        this.i++;
      }
      let key: Expr | null = null;
      this.skipTrivia();
      if (this.kind() === 'word' && this.kw.head('key', this.peek(0).text, m)) {
        this.i++;
        this.skipTrivia();
        if (this.eatSym('=')) key = this.parseExpr();
      }
      node = { k: 'loop', mode: 'iterate', count: null, iterable, item, key, body: [], pos: at };
    } else {
      const count = this.parseExpr();
      this.skipTrivia();
      if (this.kind() === 'word') this.i++; // 次 / times
      node = { k: 'loop', mode: 'count', count, iterable: null, item: null, key: null, body: [], pos: at };
    }

    if (this.kind() !== 'newline' && this.kind() !== 'close') {
      throw this.err('ESE1016', { detail: this.here() }, at);
    }
    if (this.kind() === 'newline') this.i++;
    node.body = this.parseStmts('~');
    if (this.sym() === '~') this.i++;
    if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[~', line: openTok.pos.line }, openTok.pos);
    return node;
  }

  // ------------------------------------------------------------ 数据层

  private parseData(): DataS {
    const openTok = this.peek(0);
    const at = this.pos();
    this.i += 2; // [ #
    this.skipTrivia();
    if (this.kind() !== 'word') throw this.err('ESE1016', { detail: this.here() }, at);
    const name = this.peek(0).text;
    this.i++;
    this.skipTrivia();
    if (!this.eatSym('=')) throw this.err('ESE1016', { detail: this.here() }, at);
    const value = this.parseExpr();
    this.skipTrivia();
    if (this.sym() === '#') this.i++;
    else throw this.err('ESE1001', { symbol: '[#', line: openTok.pos.line }, openTok.pos);
    if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[#', line: openTok.pos.line }, openTok.pos);
    return { k: 'data', name, value, pos: at };
  }

  private parseCalc(): CalcS {
    const openTok = this.peek(0);
    const at = this.pos();
    this.i += 2; // [ $
    this.skipTrivia();
    let derived = false;
    if (this.kind() === 'word' && this.kw.head('derived', this.peek(0).text, this.mode)) {
      derived = true;
      this.i++;
      this.skipTrivia();
    }
    if (this.kind() !== 'word') throw this.err('ESE1016', { detail: this.here() }, at);
    const name = this.peek(0).text;
    this.i++;
    this.skipTrivia();
    if (!this.eatSym('=')) throw this.err('ESE1016', { detail: this.here() }, at);
    const value = this.parseExpr();
    this.skipTrivia();
    if (this.sym() === '$') this.i++;
    else throw this.err('ESE1001', { symbol: '[$', line: openTok.pos.line }, openTok.pos);
    if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[$', line: openTok.pos.line }, openTok.pos);
    return { k: 'calc', name, value, derived, pos: at };
  }

  // ------------------------------------------------------------ 路由

  private parseRoute(): RoutePageS {
    const openTok = this.peek(0);
    const at = this.pos();
    const third = this.peek(2);
    const isPage = third.kind === 'word' && this.kw.head('page', third.text, this.mode);

    if (isPage) {
      this.i += 3; // [ / 页面
      const pathText = this.readPathToLineEnd(true);
      if (this.kind() === 'newline') this.i++;
      const body = this.parseStmts('/');
      if (this.sym() === '/') this.i++;
      if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[/', line: openTok.pos.line }, openTok.pos);
      return { k: 'route-page', path: splitPath(pathText), body, pos: at };
    }

    // 单行路由表 [ / home / ]
    const end = this.lineEndIdx(this.i);
    let lastIdx = end - 1;
    while (lastIdx >= this.i && this.toks[lastIdx].kind === 'close') lastIdx--;
    if (!(this.toks[lastIdx]?.kind === 'sym' && this.toks[lastIdx].text === '/')) {
      throw this.err('ESE1015', { detail: this.here() }, at);
    }
    const pathText = this.src.slice(this.toks[this.i + 2]?.start ?? 0, this.toks[lastIdx].start);
    this.i = end;
    // 单行路由表（[ / home / ]）只登记路径，不携带界面内容
    return { k: 'route-page', path: splitPath(pathText), body: [], pos: at };
  }

  /** 读取行内剩余文本作为路径，并剥离前导斜杠（§9：路径不得以 / 开头）。 */
  private readPathToLineEnd(): string {
    const end = this.lineEndIdx(this.i);
    const raw = this.src.slice(this.toks[this.i]?.start ?? 0, this.toks[end - 1]?.end ?? 0);
    this.i = end;
    return raw.trim().replace(/^\/+/, '');
  }

  // ------------------------------------------------------------ 组件

  private parseComponentDef(): ComponentDefS {
    const openTok = this.peek(0);
    const at = this.pos();
    const doc = this.pendingDoc;
    this.pendingDoc = null;
    this.i += 3; // [ + 组件
    this.skipTrivia();
    if (this.kind() !== 'word') throw this.err('ESE1016', { detail: this.here() }, at);
    const name = this.peek(0).text;
    this.i++;
    if (this.kind() !== 'newline' && this.kind() !== 'close') {
      throw this.err('ESE1016', { detail: this.here() }, at);
    }
    if (this.kind() === 'newline') this.i++;

    const raw = this.parseStmts('+');
    // 形参声明行（attr-line）从体内提取，其余为组件体
    const params: PropDecl[] = [];
    const body: Stmt[] = [];
    for (const s of raw) {
      if (s.k === 'prop-line') params.push(...s.props);
      else body.push(s);
    }

    if (this.sym() === '+') this.i++;
    if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[+', line: openTok.pos.line }, openTok.pos);
    return { k: 'component-def', name, params, body, doc, pos: at };
  }

  private parseCompCall(): CompCallN {
    const openTok = this.peek(0);
    const at = this.pos();
    this.i += 2; // [ <
    this.skipTrivia();
    if (this.kind() !== 'word') throw this.err('ESE1016', { detail: this.here() }, at);
    const name = this.peek(0).text.split('.').filter(Boolean);
    this.i++;
    const props = this.parseAttrs();

    let children: Stmt[] = [];
    if (this.kind() === 'newline') {
      this.i++;
      children = this.parseStmts('>');
    }
    if (this.sym() === '>') this.i++;
    if (!this.eatClose()) throw this.err('ESE1001', { symbol: '[<', line: openTok.pos.line }, openTok.pos);
    return { k: 'comp-call', name, props, children, pos: at };
  }

  // ------------------------------------------------------------ 复用与杂项

  private parseImport(): ImportS {
    const at = this.pos();
    this.i += 1; // 引入
    this.skipTrivia();
    if (this.kind() !== 'string') throw this.err('ESE1016', { detail: this.here() }, at);
    const from = this.peek(0).text;
    this.i++;
    this.skipTrivia();
    const m = this.mode;
    let namespace: string | null = null;
    const members: string[] = [];
    if (this.kind() === 'word') {
      const w = this.peek(0).text;
      const fromWords = this.kw.words('import', m);
      const asWords = this.kw.words('import-as', m);
      if (w === asWords[1]) {
        this.i++;
        this.skipTrivia();
        if (this.kind() === 'word') {
          namespace = this.peek(0).text;
          this.i++;
        }
      } else if (w === fromWords[1]) {
        this.i++;
        for (;;) {
          this.skipTrivia();
          if (this.kind() !== 'word') break;
          members.push(this.peek(0).text);
          this.i++;
          this.skipTrivia();
          if (this.eatSym(',')) continue;
          break;
        }
        if (namespace === null) namespace = members.length > 0 ? null : null;
      }
    }
    return { k: 'import', from, members, namespace, pos: at };
  }

  private parseAssert(): AssertS {
    const at = this.pos();
    this.i += 1; // 断言
    this.skipTrivia();
    if (this.kind() !== 'string') throw this.err('ESE1016', { detail: this.here() }, at);
    const title = this.peek(0).text;
    this.i++;
    const cond = this.parseExpr();
    return { k: 'assert', title, cond, pos: at };
  }

  private parseChildren(): ChildrenN {
    const at = this.pos();
    this.i += 2; // 渲染 内容
    return { k: 'children', pos: at };
  }

  private parsePropLine(): PropLineS {
    const at = this.pos();
    this.i += 1; // 属性
    const props: PropDecl[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.kind() !== 'word') break;
      const nameTok = this.peek(0);
      const name = nameTok.text;
      this.i++;
      this.skipTrivia();

      let type: string | null = null;
      if (this.kind() === 'word' && this.isTypeName(this.peek(0).text)) {
        type = this.peek(0).text;
        this.i++;
        this.skipTrivia();
      }
      let def: Expr | null = null;
      if (this.eatSym('=')) def = this.parseExpr();
      this.skipTrivia();
      let required = false;
      if (this.kind() === 'word' && this.kw.head('required', this.peek(0).text, this.mode)) {
        required = true;
        this.i++;
      }
      props.push({ name, type, def, required, pos: nameTok.pos });
      this.skipTrivia();
      if (this.eatSym(',')) continue;
      break;
    }
    return { k: 'prop-line', props, pos: at };
  }

  private isTypeName(text: string): boolean {
    for (const id of ['type-text', 'type-number', 'type-bool', 'type-list', 'type-dict', 'type-any']) {
      if (this.kw.anyForm(id).includes(text)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ 属性

  /** 解析属性列表，直到换行或块闭合。 */
  private parseAttrs(): Attr[] {
    const attrs: Attr[] = [];
    for (;;) {
      this.skipTrivia();
      const t = this.peek(0);
      if (t.kind === 'newline' || t.kind === 'close') break;
      if (t.kind === 'sym' && CLOSER_SYMS.has(t.text) && this.peek(1).kind === 'close') break;
      if (t.kind === 'sym' && CLOSER_SYMS.has(t.text) && this.peek(1).kind === 'newline') break;
      if (t.kind !== 'word') break;

      const name = t.text;
      const save = this.i;
      this.i++;
      this.skipTrivia();
      if (this.sym() === '=') {
        this.i++;
        const value = this.parseExpr();
        attrs.push({ name, value, pos: t.pos });
      } else {
        this.i = save + 1;
        attrs.push({ name, value: null, pos: t.pos });
      }
      if (this.i === save) break; // 防御：无进展即中止
    }
    return attrs;
  }

  // ------------------------------------------------------------ 表达式

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    for (;;) {
      this.skipTrivia();
      const t = this.peek(0);
      if (t.kind !== 'word') break;
      const zh = this.kw.words('or', 'zh')[0];
      const en = this.kw.words('or', 'en')[0];
      if (t.text !== zh && t.text !== en) break;
      this.i++;
      const right = this.parseAnd();
      left = { k: 'bin', op: '或者', left, right, pos: left.pos };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseCmp();
    for (;;) {
      this.skipTrivia();
      const t = this.peek(0);
      if (t.kind !== 'word') break;
      const zh = this.kw.words('and', 'zh')[0];
      const en = this.kw.words('and', 'en')[0];
      if (t.text !== zh && t.text !== en) break;
      this.i++;
      const right = this.parseCmp();
      left = { k: 'bin', op: '并且', left, right, pos: left.pos };
    }
    return left;
  }

  private parseCmp(): Expr {
    const left = this.parseAdd();
    this.skipTrivia();
    const t = this.peek(0);
    if (t.kind === 'sym' && CMP_OPS.includes(t.text)) {
      // 闭合符消歧：`>` 紧跟 `]`（组件调用 [< … >]）或行尾时是闭合符，
      // 不是大于号。否则 `[< 计数器 起始=10 >]` 会被读成 `10 > ]`。
      if (t.text === '>' && (this.peek(1).kind === 'close' || this.peek(1).kind === 'newline')) {
        return left;
      }
      if (t.text === '<' && this.peek(1).kind === 'close') {
        return left;
      }
      this.i++;
      const right = this.parseAdd();
      return { k: 'bin', op: t.text as BinOp, left, right, pos: left.pos };
    }
    return left;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    for (;;) {
      this.skipTrivia();
      const t = this.peek(0);
      if (t.kind !== 'sym' || (t.text !== '+' && t.text !== '-')) break;
      this.i++;
      const right = this.parseMul();
      left = { k: 'bin', op: t.text as BinOp, left, right, pos: left.pos };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    for (;;) {
      this.skipTrivia();
      const t = this.peek(0);
      if (t.kind !== 'sym' || (t.text !== '*' && t.text !== '/')) break;
      // `*]` 是媒体块闭合，不是乘号
      if (t.text === '*' && this.peek(1).kind === 'close') break;
      this.i++;
      const right = this.parseUnary();
      left = { k: 'bin', op: t.text as BinOp, left, right, pos: left.pos };
    }
    return left;
  }

  private parseUnary(): Expr {
    this.skipTrivia();
    const t = this.peek(0);
    if (t.kind === 'word') {
      const zh = this.kw.words('not', 'zh')[0];
      const en = this.kw.words('not', 'en')[0];
      if (t.text === zh || t.text === en) {
        this.i++;
        const operand = this.parseUnary();
        return { k: 'un', op: '非', operand, pos: t.pos };
      }
    }
    if (t.kind === 'sym' && t.text === '-') {
      this.i++;
      const operand = this.parseUnary();
      return { k: 'un', op: '-', operand, pos: t.pos };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    this.skipTrivia();
    const t = this.peek(0);

    if (t.kind === 'sym' && t.text === '(') {
      this.i++;
      const e = this.parseExpr();
      this.skipTrivia();
      this.expectSym(')');
      return e;
    }

    // 值位置的 `[` 一律按列表字面量解析（§7.5 位置裁决）
    if (t.kind === 'open') {
      return this.parseListLiteral();
    }

    if (t.kind === 'sym' && t.text === '{') {
      return this.parseBraceExpr();
    }

    if (t.kind === 'string') {
      this.i++;
      return { k: 'str', value: t.text, pos: t.pos };
    }

    if (t.kind === 'word') {
      // 布尔字面量
      const tz = this.kw.words('true', 'zh')[0];
      const te = this.kw.words('true', 'en')[0];
      const fz = this.kw.words('false', 'zh')[0];
      const fe = this.kw.words('false', 'en')[0];
      if (t.text === tz || t.text === te) {
        this.i++;
        return { k: 'bool', value: true, pos: t.pos };
      }
      if (t.text === fz || t.text === fe) {
        this.i++;
        return { k: 'bool', value: false, pos: t.pos };
      }

      this.i++;
      const segs = t.text.split('.').filter(Boolean);

      // 事件对象：事件.值
      const evZh = this.kw.words('event', 'zh')[0];
      const evEn = this.kw.words('event', 'en')[0];
      if (segs.length >= 2 && (segs[0] === evZh || segs[0] === evEn)) {
        return { k: 'event', field: segs.slice(1).join('.'), pos: t.pos };
      }

      if (this.sym() === '(') {
        const args = this.parseArgs();
        return { k: 'call', name: segs, args, pos: t.pos };
      }

      if (/^\d+$/.test(t.text)) {
        return { k: 'num', value: Number(t.text), pos: t.pos };
      }

      return { k: 'ref', path: segs, pos: t.pos };
    }

    throw this.err('ESE1016', { detail: this.here() });
  }

  private parseListLiteral(): Expr {
    const at = this.pos();
    this.i++; // [
    const items: Expr[] = [];
    this.skipTrivia();
    if (this.kind() === 'close') {
      this.i++;
      return { k: 'list', items, pos: at };
    }
    for (;;) {
      items.push(this.parseExpr());
      this.skipTrivia();
      if (this.eatSym(',')) continue;
      break;
    }
    if (this.kind() === 'close') this.i++;
    else throw this.err('ESE1001', { symbol: '[', line: at.line }, at);
    return { k: 'list', items, pos: at };
  }

  /**
   * 值位置的 `{ … }` 二义裁决（实现期裁决 D-2）：
   *   `{ 名字 }` / `{ a.b }` 且无冒号 → 取值表达式
   *   `{ "键" : 值 , … }`          → 字典字面量
   */
  private parseBraceExpr(): Expr {
    const at = this.pos();
    const end = this.matchBrace(this.i);
    if (end === -1) throw this.err('ESE1001', { symbol: '{', line: at.line }, at);

    let hasColon = false;
    for (let j = this.i + 1; j < end; j++) {
      if (this.toks[j].kind === 'sym' && this.toks[j].text === ':') {
        hasColon = true;
        break;
      }
    }

    if (!hasColon) {
      // 取值形式
      this.i++; // {
      this.skipTrivia();
      if (this.kind() !== 'word') throw this.err('ESE1016', { detail: this.here() }, at);
      const segs = this.peek(0).text.split('.').filter(Boolean);
      const first = this.peek(0);
      this.i++;
      this.skipTrivia();
      if (!this.eatSym('}')) throw this.err('ESE1016', { detail: this.here() }, at);
      const evZh = this.kw.words('event', 'zh')[0];
      const evEn = this.kw.words('event', 'en')[0];
      if (segs.length >= 2 && (segs[0] === evZh || segs[0] === evEn)) {
        return { k: 'event', field: segs.slice(1).join('.'), pos: first.pos };
      }
      return { k: 'ref', path: segs, pos: first.pos };
    }

    // 字典字面量
    this.i++; // {
    const entries: { key: string; value: Expr }[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.kind() !== 'string') throw this.err('ESE1016', { detail: this.here() }, at);
      const key = this.peek(0).text;
      this.i++;
      this.skipTrivia();
      if (!this.eatSym(':')) throw this.err('ESE1016', { detail: this.here() }, at);
      const value = this.parseExpr();
      entries.push({ key, value });
      this.skipTrivia();
      if (this.eatSym(',')) continue;
      break;
    }
    if (!this.eatSym('}')) throw this.err('ESE1016', { detail: this.here() }, at);
    return { k: 'dict', entries, pos: at };
  }

  /** 找到与 toks[openIdx] 匹配的右花括号索引；失败返回 -1。 */
  private matchBrace(openIdx: number): number {
    let depth = 0;
    for (let j = openIdx; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.kind === 'sym' && t.text === '{') depth++;
      else if (t.kind === 'sym' && t.text === '}') {
        depth--;
        if (depth === 0) return j;
      }
    }
    return -1;
  }

  // ------------------------------------------------------------ 模板

  /** 文字块内容 → 模板片段（`{名字}` → 取值表达式）。 */
  private template(text: string, pos: Pos): TplPart[] {
    const parts: TplPart[] = [];
    let buf = '';
    let i = 0;
    while (i < text.length) {
      if (text[i] === '{') {
        const end = text.indexOf('}', i);
        if (end === -1) {
          buf += text.slice(i);
          break;
        }
        if (buf) {
          parts.push({ k: 'text', value: buf });
          buf = '';
        }
        const inner = text.slice(i + 1, end).trim();
        if (inner) {
          const segs = inner.split('.').filter(Boolean);
          const evZh = this.kw.words('event', 'zh')[0];
          const evEn = this.kw.words('event', 'en')[0];
          const expr: Expr =
            segs.length >= 2 && (segs[0] === evZh || segs[0] === evEn)
              ? { k: 'event', field: segs.slice(1).join('.'), pos }
              : { k: 'ref', path: segs, pos };
          parts.push({ k: 'expr', expr });
        }
        i = end + 1;
        continue;
      }
      buf += text[i];
      i++;
    }
    if (buf) parts.push({ k: 'text', value: buf });
    return parts;
  }
}

// ---------------------------------------------------------------- 工具

/** 该语句是否产生视觉输出（供转译器区分界面语句与纯逻辑语句）。 */
export function isRenderable(s: Stmt): s is Node {
  switch (s.k) {
    case 'panel':
    case 'text':
    case 'media':
    case 'input':
    case 'button':
    case 'action':
    case 'divider':
    case 'branch':
    case 'loop':
    case 'comp-call':
    case 'children':
      return true;
    default:
      return false;
  }
}

/** 路径文本 → 段序列；`用户/{id}` → ['用户', '{id}']。 */
function splitPath(text: string): string[] {
  return text
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseFile(src: string, file: string, spec: SpecBundle): FileAst {
  return new Parser(src, file, spec).parse();
}
