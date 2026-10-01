/**
 * emit-js.ts —— 生成应用运行时的 JavaScript 源码
 *
 * web 与 server 两个目标共用本模块的输出：同一份 renderPage() 既用于
 * 服务端首屏渲染（SSR），也用于浏览器端水合。两边跑同一份代码，是
 * 「SSR 是编译目标而非语言特性」这条规范得以落地的前提（§15）。
 *
 * 两个关键实现决定：
 *   · 事件用 data 属性 + 事件委托，不用 inline onclick。状态变更会重渲染
 *     所属区域，inline 处理器会随 DOM 一起被替换掉。
 *   · 重渲染前后保存 / 恢复输入焦点与光标位置，否则每次输入都会丢光标。
 */

import type { Attr, Expr, Stmt, TplPart } from './ast.ts';
import type { ComponentIr, IrProgram, PageIr } from './ir.ts';
import type { SpecBundle } from './spec.ts';

/** 样式白名单 → CSS 属性（白名单本身取自 spec/keywords.json）。 */
const STYLE_CSS: Record<string, string> = {
  色: 'color',
  背景: 'background',
  边框: 'border',
  圆角: 'border-radius',
  字号: 'font-size',
  字重: 'font-weight',
  行高: 'line-height',
  间距: 'gap',
  内距: 'padding',
  外距: 'margin',
  对齐: 'text-align',
  宽度: 'width',
};

const PX_KEYS = new Set(['圆角', '字号', '间距', '内距', '外距', '宽度']);

/** 内置函数 id → 运行时函数名。id 取自 spec/keywords.json。 */
const FN_IDS: Record<string, string> = {
  len: 'len',
  take: 'take',
  push: 'push',
  contains: 'contains',
  keys: 'keys',
  get: 'get',
  'get-or': 'getOr',
  'to-number': 'toNumber',
  'to-text': 'toText',
  print: 'print',
  goto: 'goto',
};

interface Ctx {
  kind: 'component' | 'page';
  comp: ComponentIr | null;
  page: PageIr | null;
  locals: string[];
  /** 状态容器表达式：'__G' | '__P' | 'S'。 */
  container: string;
  /** 该层在事件分派中的作用域标识表达式。 */
  scope: string;
  out: string;
  depth: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const jsStr = (s: string): string => JSON.stringify(s);
const pad = (n: number): string => '  '.repeat(n);

export class JsEmitter {
  private spec: SpecBundle;
  private program: IrProgram;
  private lines: string[] = [];
  private counter = 0;
  /** true 时在末尾追加 ES 模块导出（server 目标用）。 */
  private asModule: boolean;

  constructor(program: IrProgram, spec: SpecBundle, asModule = false) {
    this.program = program;
    this.spec = spec;
    this.asModule = asModule;
  }

  private uid(): number {
    return this.counter++;
  }

  // -------------------------------------------------- 关键字字形

  private isFn(id: string, text: string): boolean {
    const k = this.spec.keywords.keywords.find((x) => x.id === id);
    if (!k) return false;
    return k.zh.includes(text) || k.en.includes(text);
  }

  private builtinOf(name: string): string | null {
    const first = name.split('.')[0];
    for (const [id, js] of Object.entries(FN_IDS)) {
      if (this.isFn(id, first)) return js;
    }
    return null;
  }

  // -------------------------------------------------- 表达式

  private expr(e: Expr, c: Ctx): string {
    switch (e.k) {
      case 'num':
        return String(e.value);
      case 'str': {
        if (e.value.includes('{')) {
          const parts = parseTemplate(e.value);
          if (parts.some((p) => p.k === 'expr')) {
            return parts.map((p) => (p.k === 'text' ? jsStr(p.value) : `__ese.txt(${this.expr(p.expr, c)})`)).join(' + ');
          }
        }
        return jsStr(e.value);
      }
      case 'bool':
        return e.value ? 'true' : 'false';
      case 'ref':
        return this.ref(e.path, c);
      case 'list':
        return `[${e.items.map((i) => this.expr(i, c)).join(', ')}]`;
      case 'dict':
        return `{ ${e.entries.map((x) => `${jsStr(x.key)}: ${this.expr(x.value, c)}`).join(', ')} }`;
      case 'bin': {
        const l = this.expr(e.left, c);
        const r = this.expr(e.right, c);
        switch (e.op) {
          case '并且':
            return `(${l} && ${r})`;
          case '或者':
            return `(${l} || ${r})`;
          case '==':
            return `(${l} === ${r})`;
          case '!=':
            return `(${l} !== ${r})`;
          default:
            return `(${l} ${e.op} ${r})`;
        }
      }
      case 'un':
        return e.op === '非' ? `(!${this.expr(e.operand, c)})` : `(-${this.expr(e.operand, c)})`;
      case 'call': {
        const b = this.builtinOf(e.name.join('.'));
        const args = e.args.map((a) => this.expr(a, c)).join(', ');
        if (b === 'goto') return `__ese.goto(${args})`;
        if (b) return `__ese.${b}(${args})`;
        return `__ese.callFn(${jsStr(e.name.join('.'))}, [${args}])`;
      }
      case 'event':
        return `((__ev && __ev[${jsStr(e.field)}]) !== undefined ? (__ev && __ev[${jsStr(e.field)}]) : undefined)`;
      case 'tpl':
        return e.parts
          .map((p) => (p.k === 'text' ? jsStr(p.value) : `__ese.txt(${this.expr(p.expr, c)})`))
          .join(' + ');
      default:
        return 'undefined';
    }
  }

  private ref(path: string[], c: Ctx): string {
    const head = path[0];
    const tail = path.slice(1).map((p) => `[${jsStr(p)}]`).join('');
    if (c.locals.includes(head)) return `${head}${tail}`;
    if (c.comp && c.comp.params.some((p) => p.name === head)) return `${head}${tail}`;
    if (c.comp && c.comp.states.some((s) => s.name === head)) return `${c.container}[${jsStr(head)}]${tail}`;
    if (c.page && c.page.states.some((s) => s.name === head)) return `${c.container}[${jsStr(head)}]${tail}`;
    if (this.program.globals.some((g) => g.name === head)) return `__G[${jsStr(head)}]${tail}`;
    return `${head}${tail}`;
  }

  // -------------------------------------------------- 语句

  private emitView(stmts: Stmt[], c: Ctx): void {
    for (const s of stmts) this.emitStmt(s, c);
  }

  private emitStmt(s: Stmt, c: Ctx): void {
    const o = c.out;
    const p = pad(c.depth);
    switch (s.k) {
      case 'text': {
        const parts = s.parts.map((part) => this.part(part, c));
        this.lines.push(`${p}${o} += '<div class="ese-text">' + (${parts.length ? parts.join(' + ') : "''"}) + '</div>';`);
        break;
      }
      case 'divider':
        this.lines.push(`${p}${o} += '<hr class="ese-hr">';`);
        break;
      case 'panel':
        this.emitPanel(s.attrs, s.children, c);
        break;
      case 'media': {
        const alt = this.findAttr(s.attrs, '替代');
        const style = this.styleOf(s.attrs, c);
        this.lines.push(
          `${p}${o} += '<img class="ese-media" src="' + __e(${jsStr(s.file)}) + '" alt="' + __e(${alt ? this.expr(alt, c) : "''"}) + '"${style}>';`,
        );
        break;
      }
      case 'input':
        this.emitInput(s.name, s.attrs, c);
        break;
      case 'button': {
        // 文法中 button 无属性产生式（仅 text + 可选 jump）：
        //   button = "[" , "c" , "." , SP , [ button-text , SP ] , "." , "c" , "]" , [ jump ]
        const jump = s.jump ?? '';
        this.lines.push(
          `${p}${o} += '<button class="ese-btn" type="button" data-ese-goto="' + __e(${jsStr(jump)}) + '">' + __e(${jsStr(s.text)}) + '</button>';`,
        );
        break;
      }
      case 'action': {
        if (!s.invoke) {
          this.lines.push(`${p}${o} += '<button class="ese-btn" type="button" disabled>' + __e(${jsStr(s.text)}) + '</button>';`);
          break;
        }
        const args = s.invoke.args.map((a) => this.expr(a, c));
        const argsJs = `[${args.join(', ')}]`;
        this.lines.push(
          `${p}${o} += '<button class="ese-btn ese-action" type="button"' +` +
            ` ' data-ese-scope="' + __e(${c.scope}) + '"' +` +
            ` ' data-ese-invoke="' + __e(${jsStr(s.invoke.name)}) + '"' +` +
            ` ' data-ese-args="' + __e(JSON.stringify(${argsJs})) + '">' +` +
            ` __e(${jsStr(s.text)}) + '</button>';`,
        );
        break;
      }
      case 'branch': {
        this.lines.push(`${p}if (${this.expr(s.cond, c)}) {`);
        this.emitView(s.then, { ...c, depth: c.depth + 1 });
        if (s.otherwise) {
          this.lines.push(`${p}} else {`);
          this.emitView(s.otherwise, { ...c, depth: c.depth + 1 });
        }
        this.lines.push(`${p}}`);
        break;
      }
      case 'loop': {
        const idx = `__i${this.uid()}`;
        if (s.mode === 'count') {
          this.lines.push(`${p}for (let ${idx} = 0; ${idx} < (${s.count ? this.expr(s.count, c) : '0'}); ${idx}++) {`);
          this.emitView(s.body, { ...c, depth: c.depth + 1 });
          this.lines.push(`${p}}`);
        } else {
          const listVar = `__l${this.uid()}`;
          const item = s.item ?? '__item';
          this.lines.push(`${p}{`);
          this.lines.push(`${p}  const ${listVar} = __ese.iter(${s.iterable ? this.expr(s.iterable, c) : '[]'});`);
          this.lines.push(`${p}  for (let ${idx} = 0; ${idx} < ${listVar}.length; ${idx}++) {`);
          this.lines.push(`${p}    const ${item} = ${listVar}[${idx}];`);
          this.lines.push(`${p}    const 序号 = ${idx} + 1;`);
          this.emitView(s.body, { ...c, depth: c.depth + 2, locals: [...c.locals, item, '序号'] });
          this.lines.push(`${p}  }`);
          this.lines.push(`${p}}`);
        }
        break;
      }
      case 'comp-call':
        this.emitCompCall(s.name.join('.'), s.props, s.children, c);
        break;
      case 'children':
        this.lines.push(`${p}${o} += (__children || '');`);
        break;
      case 'exec':
        if (s.name === null) this.emitView(s.body, c);
        break;
      default:
        break;
    }
  }

  private emitPanel(attrs: Attr[], children: Stmt[], c: Ctx): void {
    const p = pad(c.depth);
    const o = c.out;
    const tolerant = this.findAttr(attrs, '容错') !== undefined;
    const fallback = this.findAttr(attrs, '兜底');
    const cls = this.classOf(attrs, c);
    const style = this.styleOf(attrs, c);
    const altAttr = this.a11yOf(attrs, c);
    const fbJs = fallback ? this.expr(fallback, c) : "''";

    if (tolerant) this.lines.push(`${p}try {`);
    const ind = tolerant ? c.depth + 1 : c.depth;
    const pp = pad(ind);
    this.lines.push(`${pp}${o} += '<div class="ese-panel${cls}"${style}${altAttr}>';`);
    this.emitView(children, { ...c, depth: ind + 1 });
    this.lines.push(`${pp}${o} += '</div>';`);
    if (tolerant) {
      this.lines.push(`${p}} catch (__err) {`);
      this.lines.push(`${p}  ${o} += '<div class="ese-panel ese-fallback">' + __e(__ese.txt(${fbJs})) + '</div>';`);
      this.lines.push(`${p}}`);
    }
  }

  private emitInput(name: string, attrs: Attr[], c: Ctx): void {
    const p = pad(c.depth);
    const o = c.out;
    const id = `ese-i-${this.uid()}`;
    const label = this.findAttr(attrs, '标签');
    const ph = this.findAttr(attrs, '提示');
    const style = this.styleOf(attrs, c);
    const scope = this.scopeFor(name, c);

    if (label) {
      this.lines.push(`${p}${o} += '<label class="ese-label" for="${id}">' + __e(__ese.txt(${this.expr(label, c)})) + '</label>';`);
    }
    this.lines.push(
      `${p}${o} += '<input class="ese-input" id="${id}" type="text"${style}' +` +
        ` ' data-ese-scope="' + __e(${scope}) + '"' +` +
        ` ' data-ese-bind="${esc(name)}"' +` +
        ` ' value="' + __e(__ese.txt(${c.container}[${jsStr(name)}])) + '"' +` +
        (ph ? ` ' placeholder="' + __e(__ese.txt(${this.expr(ph, c)})) + '"' +` : '') +
        ` '>';`,
    );
  }

  /** 输入框绑定的状态所在作用域。 */
  private scopeFor(name: string, c: Ctx): string {
    if (c.comp && c.comp.states.some((s) => s.name === name)) return c.scope;
    if (c.page && c.page.states.some((s) => s.name === name)) return c.scope;
    return "'G'";
  }

  private emitCompCall(full: string, props: Attr[], children: Stmt[], c: Ctx): void {
    const p = pad(c.depth);
    const o = c.out;
    const ui = this.uiKind(full);
    if (ui) {
      this.emitUiComponent(ui, props, children, c);
      return;
    }
    const comp = this.program.components.get(full) ?? this.program.components.get(full.split('.').pop() ?? full);
    if (!comp) {
      this.lines.push(`${p}${o} += '<!-- 未定义组件 ${esc(full)} -->';`);
      return;
    }
    const propsJs = props
      .map((a) => `${jsStr(a.name)}: ${a.value ? this.expr(a.value, c) : 'true'}`)
      .join(', ');
    const args = [`${jsStr(comp.key)}`, `{ ${propsJs} }`, '__CH', '__ese.seq()'];
    if (children.length > 0) {
      const childVar = `__ch${this.uid()}`;
      this.lines.push(`${p}let ${childVar} = '';`);
      this.emitView(children, { ...c, depth: c.depth + 1, out: childVar });
      args[2] = childVar;
    } else {
      args[2] = "''";
    }
    this.lines.push(`${p}${o} += __ese.renderComp(${args.join(', ')});`);
  }

  private uiKind(name: string): 'card' | 'list' | 'navbar' | null {
    const short = name.split('.').pop() ?? name;
    for (const u of this.spec.keywords.uiComponents ?? []) {
      if (u.zh === short || u.en === short) {
        if (u.id === 'ui-card') return 'card';
        if (u.id === 'ui-list') return 'list';
        if (u.id === 'ui-navbar') return 'navbar';
      }
    }
    return null;
  }

  private emitUiComponent(kind: 'card' | 'list' | 'navbar', props: Attr[], children: Stmt[], c: Ctx): void {
    const p = pad(c.depth);
    const o = c.out;
    const get = (n: string): Expr | null => props.find((x) => x.name === n)?.value ?? null;

    if (kind === 'card') {
      const title = get('标题');
      this.lines.push(`${p}${o} += '<section class="ese-card">';`);
      if (title) this.lines.push(`${p}${o} += '<h3 class="ese-card-title">' + __e(__ese.txt(${this.expr(title, c)})) + '</h3>';`);
      this.emitView(children, { ...c, depth: c.depth + 1 });
      this.lines.push(`${p}${o} += '</section>';`);
      return;
    }

    if (kind === 'list') {
      const data = get('数据') ?? get('名单');
      const idx = `__i${this.uid()}`;
      const listVar = `__l${this.uid()}`;
      this.lines.push(`${p}{`);
      this.lines.push(`${p}  const ${listVar} = __ese.iter(${data ? this.expr(data, c) : '[]'});`);
      this.lines.push(`${p}  for (let ${idx} = 0; ${idx} < ${listVar}.length; ${idx}++) {`);
      this.lines.push(`${p}    const 项 = ${listVar}[${idx}];`);
      this.lines.push(`${p}    const 序号 = ${idx} + 1;`);
      this.emitView(children, { ...c, depth: c.depth + 2, locals: [...c.locals, '项', '序号'] });
      this.lines.push(`${p}  }`);
      this.lines.push(`${p}}`);
      return;
    }

    const items = get('项目');
    const idx = `__i${this.uid()}`;
    const listVar = `__l${this.uid()}`;
    this.lines.push(`${p}${o} += '<nav class="ese-nav">';`);
    this.lines.push(`${p}{`);
    this.lines.push(`${p}  const ${listVar} = __ese.iter(${items ? this.expr(items, c) : '[]'});`);
    this.lines.push(`${p}  for (let ${idx} = 0; ${idx} < ${listVar}.length; ${idx}++) {`);
    this.lines.push(`${p}    const 项 = ${listVar}[${idx}];`);
    this.lines.push(
      `${p}    ${o} += '<button class="ese-nav-item" type="button" data-ese-goto="' + __e(__ese.txt(项)) + '">' + __e(__ese.txt(项)) + '</button>';`,
    );
    this.lines.push(`${p}  }`);
    this.lines.push(`${p}}`);
    this.lines.push(`${p}${o} += '</nav>';`);
  }

  // -------------------------------------------------- 属性

  private findAttr(attrs: Attr[], name: string): Expr | null {
    const a = attrs.find((x) => x.name === name);
    return a?.value ?? null;
  }

  private styleOf(attrs: Attr[], c: Ctx): string {
    const decls: string[] = [];
    for (const a of attrs) {
      if (a.name === '宽' && a.value) decls.push(`width: ${this.constNum(a.value, c)}px`);
      else if (a.name === '居中') decls.push('text-align: center');
      else if (a.name === '背景' && a.value) decls.push(`background: ${this.constStr(a.value, c)}`);
      else if (a.name === '间距' && a.value) decls.push(`display: flex; flex-direction: column; gap: ${this.constNum(a.value, c)}px`);
      else if (a.name === '边框') decls.push('border: 1px solid #d8dee9; border-radius: 6px; padding: 10px');
      else if (a.name === '样式' && a.value) decls.push(...this.parseStyleDecl(this.constStr(a.value, c)));
    }
    return decls.length === 0 ? '' : ` style="${esc(decls.join('; '))}"`;
  }

  private parseStyleDecl(text: string): string[] {
    const out: string[] = [];
    for (const chunk of text.split(/[;；]/)) {
      const idx = chunk.indexOf(':');
      if (idx === -1) continue;
      const key = chunk.slice(0, idx).trim();
      const raw = chunk.slice(idx + 1).trim();
      const css = STYLE_CSS[key];
      if (!css || !raw) continue;
      // 数值型属性：整体或逐个 token 补 px（如 "外距: 10 0" → "margin: 10px 0"）
      const value = PX_KEYS.has(key)
        ? raw
            .split(/\s+/)
            .map((t) => (/^\d+(\.\d+)?$/.test(t) ? `${t}px` : t))
            .join(' ')
        : raw;
      out.push(`${css}: ${value}`);
    }
    return out;
  }

  private classOf(attrs: Attr[], c: Ctx): string {
    const cls = attrs.find((a) => a.name === '类' && a.value);
    return cls ? ` ${esc(this.constStr(cls.value!, c))}` : '';
  }

  private a11yOf(attrs: Attr[], c: Ctx): string {
    const alt = attrs.find((a) => a.name === '替代' && a.value);
    return alt ? ` alt="${esc(this.constStr(alt.value!, c))}"` : '';
  }

  private constStr(e: Expr, _c: Ctx): string {
    if (e.k === 'str') return e.value;
    if (e.k === 'num') return String(e.value);
    if (e.k === 'bool') return e.value ? '是' : '否';
    if (e.k === 'ref') return e.path.join('.');
    return '';
  }

  private constNum(e: Expr, c: Ctx): string {
    if (e.k === 'num') return String(e.value);
    const s = this.constStr(e, c);
    return /^-?\d+(\.\d+)?$/.test(s) ? s : '0';
  }

  private part(part: TplPart, c: Ctx): string {
    if (part.k === 'text') return jsStr(esc(part.value));
    return `__e(__ese.txt(${this.expr(part.expr, c)}))`;
  }

  // -------------------------------------------------- 渲染函数

  private baseCtx(comp: ComponentIr | null, page: PageIr | null, container: string, scope: string): Ctx {
    return {
      kind: comp ? 'component' : 'page',
      comp,
      page,
      locals: comp ? comp.params.map((p) => p.name) : [...(page?.params ?? [])],
      container,
      scope,
      out: '__o',
      depth: 1,
    };
  }

  private componentFn(comp: ComponentIr): void {
    const fn = `__renderComp_${sanitize(comp.key)}`;
    this.lines.push(`function ${fn}(__props, __children, __instKey) {`);
    const initCtx = this.baseCtx(comp, null, 'S', '__instKey');

    // 形参绑定必须先于状态初始化：状态初值可以引用形参（如 `[# 当前 = 起始 #]`），
    // 反之会让初值表达式落入形参的暂时性死区。
    for (const prm of comp.params) {
      const dflt = prm.def ? this.expr(prm.def, initCtx) : 'undefined';
      const rhs = prm.required
        ? `__ese.require(${jsStr(prm.name)}, __props[${jsStr(prm.name)}])`
        : `(__props[${jsStr(prm.name)}] !== undefined ? __props[${jsStr(prm.name)}] : ${dflt})`;
      this.lines.push(`  const ${prm.name} = ${rhs};`);
    }

    this.lines.push(`  const S = __ese.instInit(__instKey, function () {`);
    this.lines.push(`    const __init = {};`);
    for (const st of comp.states) {
      if (st.kind === 'data' && st.init) this.lines.push(`    __init[${jsStr(st.name)}] = ${this.expr(st.init, initCtx)};`);
    }
    this.lines.push(`    return __init;`);
    this.lines.push(`  });`);

    for (const st of comp.states) {
      if (st.kind === 'derived' && st.init) this.lines.push(`  S[${jsStr(st.name)}] = ${this.expr(st.init, initCtx)};`);
    }
    this.lines.push(`  let __o = '';`);
    this.emitView(comp.view, initCtx);
    this.lines.push(`  return __o;`);
    this.lines.push(`}`);
    this.lines.push('');
  }

  private pageFn(page: PageIr): void {
    const fn = `__renderPage_${sanitize(page.route || 'index')}`;
    this.lines.push(`function ${fn}(__params) {`);
    this.lines.push(`  const P = __ese.page(${jsStr(page.route)});`);
    const ctx = this.baseCtx(null, page, 'P', "'P'");
    for (const prm of page.params) this.lines.push(`  const ${prm} = __params[${jsStr(prm)}];`);
    for (const st of page.states) {
      if (st.kind === 'data' && st.init) {
        this.lines.push(`  if (P[${jsStr(st.name)}] === undefined) P[${jsStr(st.name)}] = ${this.expr(st.init, ctx)};`);
      }
    }
    for (const st of page.states) {
      if (st.kind === 'derived' && st.init) this.lines.push(`  P[${jsStr(st.name)}] = ${this.expr(st.init, ctx)};`);
    }
    this.lines.push(`  let __o = '';`);
    this.emitView(page.view, ctx);
    this.lines.push(`  return __o;`);
    this.lines.push(`}`);
    this.lines.push('');
  }

  private handlerFn(fnSuffix: string, owner: 'comp' | 'page', params: string[], body: Stmt[], comp: ComponentIr | null, page: PageIr | null): void {
    this.lines.push(`function __h_${owner}_${sanitize(fnSuffix)}(__scope, __ev, __args) {`);
    const ctx: Ctx = {
      kind: owner === 'comp' ? 'component' : 'page',
      comp: owner === 'comp' ? comp : null,
      page: owner === 'page' ? page : null,
      locals: [...params],
      container: owner === 'comp' ? '__ese.inst(__scope)' : `__ese.page(__scope)`,
      scope: '__scope',
      out: '__o',
      depth: 1,
    };
    for (let k = 0; k < params.length; k++) {
      this.lines.push(`  const ${params[k]} = __args ? __args[${k}] : undefined;`);
    }
    for (const s of body) this.emitLogic(s, ctx);
    this.lines.push(`}`);
    this.lines.push('');
  }

  private emitLogic(s: Stmt, c: Ctx): void {
    const p = pad(c.depth);
    switch (s.k) {
      case 'calc':
      case 'data':
        this.lines.push(`${p}${this.assignTarget(s.name, c)} = ${this.expr(s.value, c)};`);
        break;
      case 'exec':
        if (s.name === null) for (const x of s.body) this.emitLogic(x, c);
        break;
      case 'branch':
        this.lines.push(`${p}if (${this.expr(s.cond, c)}) {`);
        for (const x of s.then) this.emitLogic(x, { ...c, depth: c.depth + 1 });
        if (s.otherwise) {
          this.lines.push(`${p}} else {`);
          for (const x of s.otherwise) this.emitLogic(x, { ...c, depth: c.depth + 1 });
        }
        this.lines.push(`${p}}`);
        break;
      case 'loop': {
        const idx = `__i${this.uid()}`;
        if (s.mode === 'count') {
          this.lines.push(`${p}for (let ${idx} = 0; ${idx} < (${s.count ? this.expr(s.count, c) : '0'}); ${idx}++) {`);
          for (const x of s.body) this.emitLogic(x, { ...c, depth: c.depth + 1 });
          this.lines.push(`${p}}`);
        } else {
          const item = s.item ?? '__item';
          this.lines.push(`${p}for (const ${item} of __ese.iter(${s.iterable ? this.expr(s.iterable, c) : '[]'})) {`);
          for (const x of s.body) this.emitLogic(x, { ...c, depth: c.depth + 1, locals: [...c.locals, item] });
          this.lines.push(`${p}}`);
        }
        break;
      }
      case 'assert':
        this.lines.push(`${p}__ese.assert(${jsStr(s.title)}, ${this.expr(s.cond, c)});`);
        break;
      default:
        break;
    }
  }

  private assignTarget(name: string, c: Ctx): string {
    if (c.comp && c.comp.params.some((x) => x.name === name)) return name;
    if (c.comp && c.comp.states.some((x) => x.name === name)) return `${c.container}[${jsStr(name)}]`;
    if (c.page && c.page.states.some((x) => x.name === name)) return `${c.container}[${jsStr(name)}]`;
    if (this.program.globals.some((g) => g.name === name)) return `__G[${jsStr(name)}]`;
    return `${c.container}[${jsStr(name)}]`;
  }

  // -------------------------------------------------- 装配

  generate(): string {
    this.lines.push('// 由 ese build 生成 —— 请勿手工编辑。');
    this.lines.push('');
    const gctx = this.baseCtx(null, null, '__G', "'G'");
    const g = this.program.globals.map((x) => `${jsStr(x.name)}: ${x.init ? this.expr(x.init, gctx) : 'null'}`);
    // 初值保留在模板里：§13.3 要求全局状态每请求独立初始化，
    // 因此 __G 由模板克隆而非直接持有初值。
    this.lines.push(`const __G_INIT = { ${g.join(', ')} };`);
    this.lines.push('let __G = Object.assign({}, __G_INIT);');
    this.lines.push('function __resetGlobals() { __G = Object.assign({}, __G_INIT); }');
    this.lines.push('const __P = {};');
    this.lines.push('const __INST = {};');
    this.lines.push('const __FNS = {};');
    this.lines.push('');

    for (const comp of this.program.components.values()) this.componentFn(comp);
    for (const page of this.program.pages) this.pageFn(page);

    for (const comp of this.program.components.values()) {
      for (const h of comp.handlers) {
        if (h.k === 'exec' && h.name) this.handlerFn(`${comp.key}__${h.name}`, 'comp', h.params, h.body, comp, null);
      }
    }
    for (const page of this.program.pages) {
      for (const h of page.handlers) {
        if (h.k === 'exec' && h.name) this.handlerFn(`${page.route}__${h.name}`, 'page', h.params, h.body, null, page);
      }
    }

    this.lines.push('const __COMPONENTS = {');
    for (const comp of this.program.components.values()) {
      const hs = comp.handlers
        .filter((h): h is Extract<Stmt, { k: 'exec' }> => h.k === 'exec' && h.name !== null)
        .map((h) => `${jsStr(h.name!)}: __h_comp_${sanitize(`${comp.key}__${h.name!}`)}`);
      this.lines.push(`  ${jsStr(comp.key)}: { render: __renderComp_${sanitize(comp.key)}, handlers: { ${hs.join(', ')} } },`);
    }
    this.lines.push('};');
    this.lines.push('');

    this.lines.push('const __PAGES = {');
    for (const page of this.program.pages) {
      const hs = page.handlers
        .filter((h): h is Extract<Stmt, { k: 'exec' }> => h.k === 'exec' && h.name !== null)
        .map((h) => `${jsStr(h.name!)}: __h_page_${sanitize(`${page.route}__${h.name!}`)}`);
      this.lines.push(
        `  ${jsStr(page.route)}: { render: __renderPage_${sanitize(page.route || 'index')}, handlers: { ${hs.join(', ')} } },`,
      );
    }
    this.lines.push('};');
    this.lines.push(`const __ENTRY = ${jsStr(this.program.entryRoute)};`);
    this.lines.push('');

    if (this.program.globalInit.length > 0) {
      const ctx: Ctx = {
        kind: 'page',
        comp: null,
        page: null,
        locals: [],
        container: '__G',
        scope: "'G'",
        out: '__o',
        depth: 1,
      };
      this.lines.push('// 全局执行块：全局状态的唯一修改入口（§13.2）');
      this.lines.push('function __globalInit() {');
      for (const s of this.program.globalInit) this.emitLogic(s, ctx);
      this.lines.push('}');
      this.lines.push('');
    } else {
      this.lines.push('function __globalInit() {}');
      this.lines.push('');
    }

    this.lines.push(RUNTIME);

    if (this.asModule) {
      this.lines.push('');
      this.lines.push('// ---- 模块导出（server 目标消费；web 目标不追加此段） ----');
      this.lines.push('export function renderRoute(route, params) {');
      this.lines.push('  __ROUTE = route;');
      this.lines.push('  __PARAMS = params || {};');
      this.lines.push('  __SEQ = 0;');
      this.lines.push('  __resetGlobals();'); // §13.3 每请求独立初始化
      this.lines.push('  __globalInit();');
      this.lines.push('  return __ese.renderPage(route, __PARAMS);');
      this.lines.push('}');
      this.lines.push('export function mountClient() { __mount(); }');
      this.lines.push('export function matchRoute(path) { return __match(path); }');
      this.lines.push('export const routeKeys = Object.keys(__PAGES);');
      this.lines.push('export const programName = ' + jsStr(this.program.name) + ';');
    }

    return this.lines.join('\n');
  }
}

// ---------------------------------------------------------------- 运行时

export const RUNTIME = String.raw`
function __e(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function __iter(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') return Object.keys(x).map(function (k) { return { 键: k, 值: x[k], key: k, value: x[k] }; });
  return [];
}

const __ese = {
  len: function (x) {
    if (x == null) return 0;
    if (typeof x === 'string' || Array.isArray(x)) return x.length;
    if (typeof x === 'object') return Object.keys(x).length;
    return 0;
  },
  take: function (l, i) {
    if (!Array.isArray(l) || i < 1 || i > l.length) throw new Error('ESE3003 取第越界: ' + i);
    return l[i - 1];
  },
  push: function (l, v) {
    if (!Array.isArray(l)) throw new Error('ESE3002 加入需要列表');
    l.push(v);
    return l;
  },
  contains: function (c, v) {
    if (Array.isArray(c)) return c.indexOf(v) !== -1;
    if (typeof c === 'string') return c.indexOf(v) !== -1;
    if (c && typeof c === 'object') return Object.prototype.hasOwnProperty.call(c, v);
    return false;
  },
  keys: function (d) { return d && typeof d === 'object' ? Object.keys(d) : []; },
  get: function (d, k, dflt) {
    return d && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, k) ? d[k] : dflt;
  },
  getOr: function (l, i, dflt) { return Array.isArray(l) && i >= 1 && i <= l.length ? l[i - 1] : dflt; },
  toNumber: function (x) {
    if (typeof x === 'number') return x;
    const n = Number(x);
    if (Number.isNaN(n)) throw new Error('ESE3009 转数字失败: ' + x);
    return n;
  },
  toText: function (x) {
    if (x == null) return '';
    if (typeof x === 'object') return JSON.stringify(x);
    return String(x);
  },
  txt: function (x) { return __ese.toText(x); },
  print: function (x) { if (typeof console !== 'undefined') console.log('[ese]', x); },
  goto: function (p) { if (typeof window !== 'undefined') __navigate(String(p)); },
  iter: __iter,
  inst: function (key) { const k = String(key); if (!__INST[k]) __INST[k] = {}; return __INST[k]; },
  instInit: function (key, factory) {
    const k = String(key);
    if (!__INST[k]) __INST[k] = factory();
    return __INST[k];
  },
  page: function (route) { const k = String(route); if (!__P[k]) __P[k] = {}; return __P[k]; },
  seq: function () { return __SEQ++; },
  require: function (name, v) {
    if (v === undefined || v === null) throw new Error('ESE3005 缺少必须属性: ' + name);
    return v;
  },
  assert: function (name, cond) { if (!cond) throw new Error('ESE3008 断言失败: ' + name); },
  callFn: function (name, args) {
    const h = __FNS[name];
    if (!h) throw new Error('ESE3006 未定义的函数: ' + name);
    return h.apply(null, args);
  },
  renderComp: function (key, props, children, seq) {
    const c = __COMPONENTS[key];
    if (!c) return '<!-- ESE3002 未定义的组件: ' + key + ' -->';
    return c.render(props, children, key + ':' + seq);
  },
  renderPage: function (route, params) {
    const p = __PAGES[route];
    if (!p) return '';
    return p.render(params || {});
  },
  findHandler: function (ownerKey, kind, name) {
    const table = kind === 'comp' ? __COMPONENTS[ownerKey] : __PAGES[ownerKey];
    if (!table) return null;
    return table.handlers[name] || null;
  },
};

let __SEQ = 0;
let __ROUTE = '';
let __PARAMS = {};

function __saveFocus(root) {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el || !root || !root.contains(el)) return null;
  let sel = null;
  try { sel = el.selectionStart; } catch (e) { sel = null; }
  return { id: el.id || '', sel: sel };
}

function __restoreFocus(root, snap) {
  if (!snap || !root || !snap.id) return;
  const el = root.querySelector('#' + snap.id);
  if (!el) return;
  if (el.focus) el.focus();
  try { if (snap.sel != null && el.setSelectionRange) el.setSelectionRange(snap.sel, snap.sel); } catch (e) { /* 非文本输入 */ }
}

function __rerender() {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('ese-app');
  if (!root) return;
  const snap = __saveFocus(root);
  __SEQ = 0;
  root.innerHTML = __ese.renderPage(__ROUTE, __PARAMS);
  __restoreFocus(root, snap);
}

function __setState(scope, name, value) {
  if (scope === 'G') { __G[name] = value; __globalInit(); }
  else if (scope === 'P') { __ese.page(__ROUTE)[name] = value; }
  else { __ese.inst(scope)[name] = value; }
}

function __invoke(scope, name, args) {
  const kind = scope === 'P' || scope === 'G' ? 'page' : 'comp';
  const ownerKey = kind === 'page' ? __ROUTE : String(scope).replace(/:[0-9]+$/, '');
  const h = __ese.findHandler(ownerKey, kind, name);
  if (!h) throw new Error('ESE3006 未定义的逻辑块: ' + name);
  h(scope, null, args || []);
  __rerender();
}

function __match(path) {
  const clean = String(path).replace(/^\/+|\/+$/g, '');
  if (Object.prototype.hasOwnProperty.call(__PAGES, clean)) return { route: clean, params: {} };
  // 入口回落：规范未定义根路由，根路径交给降级层裁决出的入口页（IrProgram.entryRoute）
  if (clean === '' && Object.prototype.hasOwnProperty.call(__PAGES, __ENTRY)) return { route: __ENTRY, params: {} };
  const keys = Object.keys(__PAGES);
  for (let n = 0; n < keys.length; n++) {
    const route = keys[n];
    if (route.indexOf(':') === -1) continue;
    const a = route.split('/');
    const b = clean.split('/');
    if (a.length !== b.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i].charAt(0) === ':') params[a[i].slice(1)] = b[i];
      else if (a[i] !== b[i]) { ok = false; break; }
    }
    if (ok) return { route: route, params: params };
  }
  return null;
}

function __navigate(path) {
  const clean = String(path).replace(/^\/+/, '');
  const m = __match(clean) || __match('');
  if (typeof history !== 'undefined' && history.pushState) history.pushState({}, '', '/' + clean);
  if (m) { __ROUTE = m.route; __PARAMS = m.params; }
  __rerender();
}

function __bindEvents(root) {
  root.addEventListener('click', function (ev) {
    const g = ev.target.closest ? ev.target.closest('[data-ese-goto]') : null;
    if (g) { __navigate(g.getAttribute('data-ese-goto')); return; }
    const a = ev.target.closest ? ev.target.closest('[data-ese-invoke]') : null;
    if (a) {
      let args = [];
      try { args = JSON.parse(a.getAttribute('data-ese-args') || '[]'); } catch (e) { args = []; }
      __invoke(a.getAttribute('data-ese-scope'), a.getAttribute('data-ese-invoke'), args);
    }
  });
  root.addEventListener('input', function (ev) {
    const t = ev.target;
    if (!t || !t.getAttribute) return;
    const name = t.getAttribute('data-ese-bind');
    if (!name) return;
    __setState(t.getAttribute('data-ese-scope'), name, t.value);
    __rerender();
  });
}

function __mount() {
  const root = document.getElementById('ese-app');
  if (!root) return;
  const raw = typeof location !== 'undefined' ? location.pathname : '/';
  const m = __match(raw) || __match('');
  __ROUTE = m ? m.route : '';
  __PARAMS = m ? m.params : {};
  __bindEvents(root);
  __globalInit();
  __rerender();
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', function () {
      const mm = __match(location.pathname) || __match('');
      __ROUTE = mm ? mm.route : '';
      __PARAMS = mm ? mm.params : {};
      __rerender();
    });
  }
}

if (typeof window !== 'undefined') {
  window.__ese = { set: __setState, invoke: __invoke, navigate: __navigate, rerender: __rerender };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __mount);
  else __mount();
}
`;

// ---------------------------------------------------------------- 工具

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_\u4e00-\u9fa5]/g, '_').replace(/^(\d)/, '_$1');
}

function parseTemplate(text: string): TplPart[] {
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
        parts.push({ k: 'expr', expr: { k: 'ref', path: inner.split('.').filter(Boolean), pos: { line: 0, column: 0 } } });
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

export function generateApp(program: IrProgram, spec: SpecBundle, asModule = false): string {
  assertRuntimeIntact();
  return new JsEmitter(program, spec, asModule).generate();
}

/**
 * RUNTIME 是 String.raw 模板字面量：其中任何反引号都会提前截断它，
 * 使 RUNTIME 退化成非字符串而非报错。这里显式兜底，避免静默产出坏产物。
 */
function assertRuntimeIntact(): void {
  if (typeof RUNTIME !== 'string' || RUNTIME.length < 1000) {
    throw new Error(
      `ESE9001 内置运行时模板损坏（RUNTIME 类型 ${typeof RUNTIME}，长度 ${String(RUNTIME).length}）：` +
        'RUNTIME 模板字面量内出现了反引号，请在注释与字符串中改用普通引号。',
    );
  }
}

/**
 * 在构建期同步求值一份非模块产物，取出 SSR 用的 renderRoute。
 *
 * 之所以不用 import()：web 产物必须是可被 file:// 直接打开的非模块脚本，
 * 而 import() 在 file:// 下会被 CORS 拦下。用 Function 求值可同步取得接口，
 * 且产物中的 `typeof window !== 'undefined'` 守卫会自动跳过客户端挂载。
 */
export function instantiateApp(appJs: string): {
  renderRoute: (route: string, params: Record<string, string>) => string;
  routeKeys: string[];
} {
  const factory = new Function(
    `${appJs}\n;return { renderRoute: function (r, p) { __ROUTE = r; __PARAMS = p || {}; __SEQ = 0; __resetGlobals(); __globalInit(); return __ese.renderPage(r, __PARAMS); }, routeKeys: Object.keys(__PAGES) };`,
  );
  return factory() as { renderRoute: (route: string, params: Record<string, string>) => string; routeKeys: string[] };
}

/** 基础样式表（与生成物配套，不随项目变化）。 */
export const BASE_CSS = `:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 15px;
  line-height: 1.7;
  color: #1f2933;
  background: #ffffff;
}
#ese-app { max-width: 900px; margin: 0 auto; }
.ese-panel { display: block; }
.ese-text { white-space: pre-wrap; }
.ese-hr { border: 0; border-top: 1px solid #e1e7ef; margin: 16px 0; }
.ese-media { max-width: 100%; border-radius: 6px; display: block; }
.ese-btn {
  padding: 6px 14px;
  border: 1px solid #c7d0dc;
  border-radius: 6px;
  background: #f7f9fc;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.ese-btn:hover { background: #eef2f8; }
.ese-btn[disabled] { opacity: .5; cursor: default; }
.ese-action { border-color: #2f6fed; color: #2f6fed; background: #f2f6ff; }
.ese-input { padding: 6px 10px; border: 1px solid #c7d0dc; border-radius: 6px; font: inherit; }
.ese-label { display: block; font-size: 13px; color: #616e7c; margin-bottom: 2px; }
.ese-card { border: 1px solid #e1e7ef; border-radius: 8px; padding: 14px; margin: 12px 0; background: #fcfdff; }
.ese-card-title { margin: 0 0 8px; font-size: 16px; }
.ese-nav { display: flex; gap: 8px; padding: 8px 0; border-bottom: 1px solid #e1e7ef; margin-bottom: 16px; }
.ese-nav-item { border: 0; background: none; color: #2f6fed; cursor: pointer; font: inherit; padding: 4px 6px; }
.ese-fallback { color: #8a6d3b; background: #fff8e6; border: 1px solid #f0dfae; padding: 8px 12px; border-radius: 6px; }
`;
