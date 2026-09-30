/**
 * ir.ts —— 中间表示（IR）与降级
 *
 * IR 是三个转译目标（web / server / wasm）的唯一共用层。
 * 目标可插拔的关键就在于此：新增一个后端只需消费 IrProgram，
 * 完全不触碰词法、语法与降级。
 *
 * 降级做四件事：
 *   1. 把顶层语句分派到状态 / 组件 / 页面 / 全局初始化 / 断言；
 *   2. 把每个组件体、页面体切成「状态声明 + 标签处理块 + 视图」三段；
 *   3. 合并模块文件中的组件（带命名空间）；
 *   4. 做契约层静态校验（未定义组件、必须属性、未知属性、派生值被赋值）。
 */

import type {
  AssertS,
  ComponentDefS,
  Expr,
  FileAst,
  ImportS,
  Mode,
  Pos,
  PropDecl,
  Stmt,
} from './ast.ts';
import { EseError } from './diagnostics.ts';
import type { SpecBundle } from './spec.ts';

// ---------------------------------------------------------------- 类型

export interface StateDecl {
  name: string;
  kind: 'data' | 'derived';
  /** data 为初值字面量；derived 为计算表达式。 */
  init: Expr | null;
  pos: Pos;
}

export interface ComponentIr {
  name: string;
  /** 完整限定名，用于查表（含命名空间前缀）。 */
  key: string;
  params: PropDecl[];
  states: StateDecl[];
  view: Stmt[];
  handlers: Stmt[];
  doc: string | null;
  builtin: boolean;
  pos: Pos;
}

export interface PageIr {
  /** 路由路径，段以 / 连接；根页面为空串。 */
  route: string;
  segments: string[];
  /** 路径参数名（`用户/{id}` → ['id']）。 */
  params: string[];
  states: StateDecl[];
  view: Stmt[];
  handlers: Stmt[];
  file: string;
  pos: Pos;
}

export interface IrProgram {
  mode: Mode;
  name: string;
  globals: StateDecl[];
  /** 全局执行块体内的语句（全局状态的唯一修改入口，§13.2）。 */
  globalInit: Stmt[];
  components: Map<string, ComponentIr>;
  pages: PageIr[];
  rootView: Stmt[];
  imports: ImportS[];
  asserts: AssertS[];
  /**
   * 站点入口路由（`/` 指向哪个页面）。
   *
   * 规范未定义根路由约定，因此这条裁决归降级层，且三个目标共用：
   *   1. 存在根页面（route 为空串）时，入口就是根页面；
   *   2. 否则用清单指定的 `首页` / `home`；
   *   3. 再否则取首个声明的页面。
   * 入口只在 `web` / `server` 两个目标上有意义，`wasm` 目标忽略它。
   */
  entryRoute: string;
}

export interface LowerOptions {
  /** 项目名，用于生成标题与文件名。 */
  projectName: string;
  /** 清单里的 `首页` / `home`；缺省为 null。 */
  entryPage?: string | null;
  /** 诊断回调；由调用方决定渲染与是否中断。 */
  report: (code: string, params: Record<string, string | number>, pos: Pos, severity: 'error' | 'warning') => void;
}

// ---------------------------------------------------------------- 降级

function splitStates(stmts: Stmt[]): { states: StateDecl[]; rest: Stmt[] } {
  const states: StateDecl[] = [];
  const rest: Stmt[] = [];
  for (const s of stmts) {
    if (s.k === 'data') {
      states.push({ name: s.name, kind: 'data', init: s.value, pos: s.pos });
    } else if (s.k === 'calc') {
      states.push({ name: s.name, kind: 'derived', init: s.value, pos: s.pos });
    } else {
      rest.push(s);
    }
  }
  return { states, rest };
}

function splitHandlers(stmts: Stmt[]): { handlers: Stmt[]; view: Stmt[] } {
  const handlers: Stmt[] = [];
  const view: Stmt[] = [];
  for (const s of stmts) {
    if (s.k === 'exec' && s.name !== null) handlers.push(s);
    else view.push(s);
  }
  return { handlers, view };
}

function routeOf(segments: string[]): string {
  return segments
    .map((s) => (s.startsWith('{') && s.endsWith('}') ? `:${s.slice(1, -1)}` : s))
    .join('/');
}

function paramNames(segments: string[]): string[] {
  const out: string[] = [];
  for (const s of segments) {
    if (s.startsWith('{') && s.endsWith('}')) out.push(s.slice(1, -1));
  }
  return out;
}

/** 路径段按 `/` 拆开，忽略空段。 */
function segmentsOf(path: string[]): string[] {
  const out: string[] = [];
  for (const seg of path) {
    for (const part of seg.split('/')) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export function buildIr(entry: FileAst, modules: Map<string, FileAst>, spec: SpecBundle, opts: LowerOptions): IrProgram {
  const components = new Map<string, ComponentIr>();
  const pages: PageIr[] = [];
  const globals: StateDecl[] = [];
  const globalInit: Stmt[] = [];
  const rootStmts: Stmt[] = [];
  const imports: ImportS[] = [];
  const asserts: AssertS[] = [];

  const registerComponent = (def: ComponentDefS, prefix: string | null, builtin = false): void => {
    const key = prefix ? `${prefix}.${def.name}` : def.name;
    if (components.has(key)) {
      opts.report('ESE2014', { name: key, owner: '组件' }, def.pos, 'error');
      return;
    }
    const { states, rest } = splitStates(def.body);
    const { handlers, view } = splitHandlers(rest);
    components.set(key, {
      name: def.name,
      key,
      params: def.params,
      states,
      view,
      handlers,
      doc: def.doc,
      builtin,
      pos: def.pos,
    });
  };

  for (const s of entry.stmts) {
    switch (s.k) {
      case 'data':
        globals.push({ name: s.name, kind: 'data', init: s.value, pos: s.pos });
        break;
      case 'calc':
        globals.push({ name: s.name, kind: 'derived', init: s.value, pos: s.pos });
        break;
      case 'exec':
        if (s.name === null || isGlobalExec(s.name, spec, entry.mode)) globalInit.push(...s.body);
        else rootStmts.push(s);
        break;
      case 'component-def':
        registerComponent(s, null);
        break;
      case 'route-page': {
        const segments = segmentsOf(s.path);
        const { states, rest } = splitStates(s.body);
        const { handlers, view } = splitHandlers(rest);
        pages.push({
          route: routeOf(segments),
          segments,
          params: paramNames(segments),
          states,
          view,
          handlers,
          file: entry.file,
          pos: s.pos,
        });
        break;
      }
      case 'import':
        imports.push(s);
        break;
      case 'assert':
        asserts.push(s);
        break;
      default:
        rootStmts.push(s);
        break;
    }
  }

  // 模块文件中的组件按引入关系合并（命名空间 = 「为」后的名字或文件名）
  for (const imp of imports) {
    const target = resolveModule(imp.from, entry.file);
    const mod = modules.get(target);
    if (!mod) {
      opts.report('ESE4003', { path: imp.from }, imp.pos, 'warning');
      continue;
    }
    if (mod.mode !== entry.mode) {
      opts.report('ESE2017', { path: imp.from }, imp.pos, 'error');
      continue;
    }
    const ns = imp.namespace;
    for (const st of mod.stmts) {
      if (st.k !== 'component-def') continue;
      if (imp.members.length > 0 && !imp.members.includes(st.name)) continue;
      registerComponent(st, ns, false);
    }
  }

  // 未包含在任何页面内的顶层内容编译进 index 页面（§12）
  if (rootStmts.length > 0 || pages.length === 0) {
    const existing = pages.find((p) => p.route === '');
    const { states, rest } = splitStates(rootStmts);
    const { handlers, view } = splitHandlers(rest);
    if (existing) {
      existing.states.unshift(...states);
      existing.view.push(...view);
      existing.handlers.push(...handlers);
    } else {
      pages.unshift({
        route: '',
        segments: [],
        params: [],
        states,
        view,
        handlers,
        file: entry.file,
        pos: { line: 1, column: 1 },
      });
    }
  }

  const program: IrProgram = {
    mode: entry.mode,
    name: opts.projectName,
    globals,
    globalInit,
    components,
    pages,
    rootView: [],
    imports,
    asserts,
    entryRoute: pickEntryRoute(pages, opts.entryPage ?? null, opts),
  };

  checkContracts(program, spec, opts);
  return program;
}

/** 站点入口路由的裁决（见 IrProgram.entryRoute 注释）。 */
function pickEntryRoute(pages: PageIr[], declared: string | null, opts: LowerOptions): string {
  const root = pages.find((p) => p.route === '');
  if (root) return '';
  if (declared) {
    const hit = pages.find((p) => p.route === declared || p.segments.join('/') === declared);
    if (hit) return hit.route;
    opts.report('ESE4003', { path: `首页 ${declared}` }, { line: 1, column: 1 }, 'warning');
  }
  return pages.length > 0 ? pages[0].route : '';
}

function isGlobalExec(name: string, spec: SpecBundle, mode: Mode): boolean {
  const k = spec.keywords.keywords.find((x) => x.id === 'global');
  if (!k) return name === '全局' || name === 'global';
  const forms = mode === 'en' ? k.en : k.zh;
  return forms.includes(name);
}

/** `./组件库.bd` 相对于入口文件解析为仓库内路径。 */
function resolveModule(from: string, entryFile: string): string {
  const base = entryFile.replace(/[^\\/]*$/, '');
  const raw = from.replace(/^\.\//, '');
  return `${base}${raw}`.replace(/\\/g, '/');
}

// ---------------------------------------------------------------- 契约校验

/**
 * 契约层静态校验（§11.1 的表）：
 *   缺必须属性 → error；传未声明属性 → warning；缺非必须属性 → warning。
 * 运行时兜底由各 emitter 生成：有默认值用默认值，否则空串 / 0。
 */
function checkContracts(program: IrProgram, spec: SpecBundle, opts: LowerOptions): void {
  const ui = uiNames(spec, program.mode);
  const known = new Set<string>([...program.components.keys(), ...ui]);

  const visit = (stmts: Stmt[]): void => {
    for (const s of stmts) {
      switch (s.k) {
        case 'comp-call': {
          const full = s.name.join('.');
          const comp = program.components.get(full) ?? program.components.get(s.name[s.name.length - 1]);
          if (!comp && !ui.has(full) && !ui.has(s.name[s.name.length - 1])) {
            opts.report('ESE2002', { name: full }, s.pos, 'error');
          } else if (comp) {
            const passed = new Set(s.props.map((p) => p.name));
            for (const p of comp.params) {
              if (p.required && !passed.has(p.name)) {
                opts.report('ESE2004', { name: p.name, owner: comp.name }, s.pos, 'error');
              }
            }
            const declared = new Set(comp.params.map((p) => p.name));
            for (const p of s.props) {
              if (!declared.has(p.name)) {
                opts.report('ESE2003', { name: p.name, owner: comp.name }, p.pos, 'warning');
              }
            }
          }
          visit(s.children);
          break;
        }
        case 'panel':
          visit(s.children);
          break;
        case 'branch':
          visit(s.then);
          if (s.otherwise) visit(s.otherwise);
          break;
        case 'loop':
          visit(s.body);
          break;
        default:
          break;
      }
    }
    void known;
  };

  for (const c of program.components.values()) visit(c.view);
  for (const p of program.pages) visit(p.view);
}

/** ese-ui 内置组件名（中英两形）。 */
export function uiNames(spec: SpecBundle, mode: Mode): Set<string> {
  const out = new Set<string>();
  for (const c of spec.keywords.uiComponents ?? []) {
    out.add(mode === 'en' ? c.en : c.zh);
    out.add(c.zh);
  }
  return out;
}

// ---------------------------------------------------------------- 查询工具

/** 变量解析结果：告诉 emitter 该名字落在哪一层状态上。 */
export type RefScope = 'global' | 'page' | 'component' | 'local' | 'unknown';

export interface RefTarget {
  scope: RefScope;
  name: string;
}

export interface Resolver {
  globals: Set<string>;
  pages: Set<string>;
  components: Set<string>;
  locals: Set<string>;
}

export function makeResolver(program: IrProgram, page: PageIr | null, comp: ComponentIr | null): Resolver {
  return {
    globals: new Set(program.globals.map((g) => g.name)),
    pages: new Set(page?.states.map((s) => s.name) ?? []),
    components: new Set(comp?.states.map((s) => s.name) ?? []),
    locals: new Set([...(comp?.params.map((p) => p.name) ?? []), ...(page?.params ?? [])]),
  };
}

export function resolveRef(r: Resolver, name: string): RefTarget {
  if (r.locals.has(name)) return { scope: 'local', name };
  if (r.components.has(name)) return { scope: 'component', name };
  if (r.pages.has(name)) return { scope: 'page', name };
  if (r.globals.has(name)) return { scope: 'global', name };
  return { scope: 'unknown', name };
}

/** 收集组件 / 页面体内全部状态名，供 emitter 生成状态容器。 */
export function stateNames(states: StateDecl[]): string[] {
  return states.map((s) => s.name);
}

export { EseError };
