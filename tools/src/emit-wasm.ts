/**
 * emit-wasm.ts —— 二进制目标：ese 逻辑层 → WebAssembly
 *
 * 本目标不产出文本，产出真正的 .wasm 二进制模块（自写编码器，零外部依赖）。
 *
 * 能力边界（已在《ese转译器设计.md》写明）：
 *   支持 —— 四则运算、比较、逻辑、局部变量（[# #] / [$ $]）、条件分支
 *           （[? ?] / [?? ??]）、计数循环（[~ n 次 ~]）、命名执行块
 *           （编译为可导出的函数，形参为 f64），以及块内的内置函数调用。
 *   不支持 —— 界面构造（浮雕框 / 文字 / 媒体 / 输入框 / 按钮）、字符串、
 *           列表与字典、遍历循环、路由。这些属于 web / server 两个目标的职责；
 *           在本目标下它们被跳过，而不是报错——因为二进制目标本就不是
 *           用来产出界面的（见设计文档「二进制目标的两条路线」）。
 */

import type { Expr, Stmt } from './ast.ts';
import type { ComponentIr, IrProgram, PageIr } from './ir.ts';
import type { SpecBundle } from './spec.ts';

// ---------------------------------------------------------------- 编码原语

const MAGIC = [0x00, 0x61, 0x73, 0x6d];
const VERSION = [0x01, 0x00, 0x00, 0x00];

const SEC_TYPE = 1;
const SEC_FUNC = 3;
const SEC_EXPORT = 7;
const SEC_CODE = 10;

const T_F64 = 0x7c;
const T_EMPTY = 0x40;

const OP_BLOCK = 0x02;
const OP_LOOP = 0x03;
const OP_IF = 0x04;
const OP_ELSE = 0x05;
const OP_END = 0x0b;
const OP_BR = 0x0c;
const OP_BR_IF = 0x0d;
const OP_CALL = 0x10;
const OP_DROP = 0x1a;
const OP_LOCAL_GET = 0x20;
const OP_LOCAL_SET = 0x21;
const OP_LOCAL_TEE = 0x22;
const OP_F64_CONST = 0x44;
const OP_F64_EQ = 0x61;
const OP_F64_NE = 0x62;
const OP_F64_LT = 0x63;
const OP_F64_GT = 0x64;
const OP_F64_LE = 0x65;
const OP_F64_GE = 0x66;
const OP_F64_ADD = 0xa0;
const OP_F64_SUB = 0xa1;
const OP_F64_MUL = 0xa2;
const OP_F64_DIV = 0xa3;
const OP_F64_NEG = 0x9a;
const OP_F64_ABS = 0x99;
const OP_F64_CONVERT_I32_S = 0xb7;

function uleb(n: number): number[] {
  const out: number[] = [];
  let v = Math.max(0, Math.floor(n));
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

function sleb(n: number): number[] {
  const out: number[] = [];
  let v = Math.trunc(n);
  let more = true;
  while (more) {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}

function f64Bytes(v: number): number[] {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(v, 0);
  return [...buf];
}

function utf8(s: string): number[] {
  return [...Buffer.from(s, 'utf8')];
}

function u32(n: number): number[] {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0, 0);
  return [...buf];
}

function section(id: number, content: number[]): number[] {
  return [id, ...uleb(content.length), ...content];
}

// ---------------------------------------------------------------- 函数表示

interface WasmFn {
  name: string;
  params: string[];
  /** 局部变量名（不含参数），按索引顺序。 */
  locals: string[];
  localIdx: Map<string, number>;
  /** 源码语句 —— 编译的输入。 */
  src: Stmt[];
  /** 编译后的函数体字节（已含 size 前缀）—— 编译的输出。 */
  code: number[];
  /** 参数个数（决定 functype）。 */
  arity: number;
}

interface CompileCtx {
  fn: WasmFn;
  /** 循环计数器栈（名字 → 索引）。 */
  loopVars: Map<string, number>;
}

// ---------------------------------------------------------------- 编译器

interface StmtResult {
  code: number[];
  producesValue: boolean;
}

export class WasmCompiler {
  private program: IrProgram;
  private fns: WasmFn[] = [];
  private fnIndex = new Map<string, number>();
  private typeIndex = new Map<number, number>();
  private counter = 0;

  constructor(program: IrProgram, _spec: SpecBundle) {
    this.program = program;
    void _spec;
  }

  // ------------------------------ 收集

  private collect(): void {
    const add = (name: string, params: string[], body: Stmt[]): void => {
      const uniq = this.fns.some((f) => f.name === name);
      const finalName = uniq ? `${name}_${this.counter++}` : name;
      const locals = this.collectLocals(body);
      // 全局状态作为每个函数的初始局部变量参与计算
      for (const g of this.program.globals) {
        if (!locals.includes(g.name)) locals.push(g.name);
      }
      this.fns.push({ name: finalName, params, locals, localIdx: new Map(), src: body, code: [], arity: params.length });
    };

    for (const comp of this.program.components.values()) {
      for (const h of comp.handlers) {
        if (h.k === 'exec' && h.name) add(comp.name ? `${comp.name}_${h.name}` : h.name, h.params, h.body);
      }
    }
    for (const page of this.program.pages) {
      for (const h of page.handlers) {
        if (h.k === 'exec' && h.name) add(h.name, h.params, h.body);
      }
    }
    // 全局执行块：导出为 __global 以便外部调用
    if (this.program.globalInit.length > 0) add('__global', [], this.program.globalInit);

    if (this.fns.length === 0) add('__empty', [], []);
  }

  private collectLocals(stmts: Stmt[]): string[] {
    const out: string[] = [];
    const walk = (list: Stmt[]): void => {
      for (const s of list) {
        if ((s.k === 'data' || s.k === 'calc') && !out.includes(s.name)) out.push(s.name);
        else if (s.k === 'branch') {
          walk(s.then);
          if (s.otherwise) walk(s.otherwise);
        } else if (s.k === 'loop') {
          walk(s.body);
        } else if (s.k === 'exec' && s.name === null) {
          walk(s.body);
        } else if (s.k === 'panel' || s.k === 'comp-call') {
          // 「一切皆嵌套」：容器内也可能声明局部变量
          walk(s.children);
        }
      }
    };
    walk(stmts);
    return out;
  }

  /** 给每个函数分配局部索引：参数在前，局部在后。 */
  private assignLocals(): void {
    for (const fn of this.fns) {
      fn.localIdx.clear();
      fn.params.forEach((p, i) => fn.localIdx.set(p, i));
      fn.locals.forEach((l, i) => fn.localIdx.set(l, fn.params.length + i));
    }
  }

  // ------------------------------ 编译

  compile(): void {
    this.collect();
    this.assignLocals();
    for (const fn of this.fns) {
      const code: number[] = [];
      code.push(...this.compileStmts(fn.src, fn, true));
      code.push(OP_END);
      const localTypes: number[] = [];
      if (fn.locals.length > 0) {
        localTypes.push(...uleb(fn.locals.length), T_F64);
      }
      const bodyWithLocals = [...uleb(localTypes.length / 2), ...localTypes, ...code];
      fn.code = [...uleb(bodyWithLocals.length), ...bodyWithLocals];
      if (!this.typeIndex.has(fn.arity)) this.typeIndex.set(fn.arity, this.typeIndex.size);
    }
  }

  private compileStmts(stmts: Stmt[], fn: WasmFn, wantValue: boolean): number[] {
    const out: number[] = [];
    let produced = false;
    for (let i = 0; i < stmts.length; i++) {
      const isLast = i === stmts.length - 1;
      const r = this.compileStmt(stmts[i], fn, wantValue && isLast);
      out.push(...r.code);
      produced = r.producesValue;
    }
    if (wantValue && !produced) {
      // 末条语句不产生值（分支、循环、界面构造……）时，函数返回值取
      // 「整段里最后一次赋值过的变量」；一个都没有就退化为 0。
      // 这条规则让 `[> 累计(上限) : …循环… [$ 结果 = 和 $] >]` 能自然返回 结果，
      // 也不必让分支块伪造一个 0 来把栈配平。
      const name = lastAssigned(stmts);
      const idx = name === null ? undefined : fn.localIdx.get(name);
      if (idx === undefined) out.push(OP_F64_CONST, ...f64Bytes(0));
      else out.push(OP_LOCAL_GET, ...uleb(idx));
    }
    return out;
  }

  private compileStmt(s: Stmt, fn: WasmFn, wantValue: boolean): StmtResult {
    switch (s.k) {
      case 'data':
      case 'calc': {
        const code = this.compileExpr(s.value, fn);
        const idx = fn.localIdx.get(s.name);
        if (idx === undefined) return { code: [...code, OP_DROP], producesValue: false };
        if (wantValue) return { code: [...code, OP_LOCAL_TEE, ...uleb(idx)], producesValue: true };
        return { code: [...code, OP_LOCAL_SET, ...uleb(idx)], producesValue: false };
      }
      case 'branch': {
        // 分支是语句，不产生值：两个分支体都按语句编译，
        // 返回值由 compileStmts 的「最后一次赋值」规则决定。
        // wasm 的 if 条件必须是 i32，因此把 f64 布尔值归一到 i32。
        const cond = this.toI32(s.cond, fn);
        const thenCode = this.compileStmts(s.then, fn, false);
        const code = [...cond, OP_IF, T_EMPTY, ...thenCode];
        if (s.otherwise) code.push(OP_ELSE, ...this.compileStmts(s.otherwise, fn, false));
        code.push(OP_END);
        return { code, producesValue: false };
      }
      case 'loop': {
        if (s.mode !== 'count') {
          // 遍历循环需要数组/字符串支持，本目标暂不实现
          return { code: [], producesValue: false };
        }
        // 每个循环各占两个局部：计数器与上限。嵌套循环因此互不干扰。
        const iIdx = this.allocLocal(fn, '#i');
        const nSlot = this.allocLocal(fn, '#n');
        const n = s.count ? this.compileExpr(s.count, fn) : [OP_F64_CONST, ...f64Bytes(0)];
        const setN = [...n, OP_LOCAL_SET, ...uleb(nSlot)];
        const body = this.compileStmts(s.body, fn, false);
        // 计数器初值 i = 0 —— 注意 OP_F64_CONST 不能省：
        // 少了这个操作码，8 字节的零载荷会被解码成 8 个 unreachable 指令。
        const code: number[] = [
          OP_F64_CONST,
          ...f64Bytes(0),
          OP_LOCAL_SET,
          ...uleb(iIdx),
          ...setN,
          OP_BLOCK,
          T_EMPTY,
          OP_LOOP,
          T_EMPTY,
          OP_LOCAL_GET,
          ...uleb(iIdx),
          OP_LOCAL_GET,
          ...uleb(nSlot),
          OP_F64_GE,
          OP_BR_IF,
          1,
          ...body,
          OP_LOCAL_GET,
          ...uleb(iIdx),
          OP_F64_CONST,
          ...f64Bytes(1),
          OP_F64_ADD,
          OP_LOCAL_SET,
          ...uleb(iIdx),
          OP_BR,
          0,
          OP_END,
          OP_END,
        ];
        // 循环本身不产生值：想要返回值就让循环之后的赋值语句落在末尾
        return { code, producesValue: false };
      }
      case 'exec':
        if (s.name === null) return { code: this.compileStmts(s.body, fn, wantValue), producesValue: wantValue };
        return { code: [], producesValue: false };
      case 'assert':
        return { code: [], producesValue: false };
      default:
        // 界面构造不属于二进制目标的职责范围
        return { code: [], producesValue: false };
    }
  }

  /**
   * 编译期追加一个临时局部（循环计数器、循环上限等）。
   * 索引恒为「参数个数 + 已分配局部数」，与 assignLocals 的规则一致。
   */
  private allocLocal(fn: WasmFn, prefix: string): number {
    const name = `${prefix}${this.counter++}`;
    fn.locals.push(name);
    const idx = fn.params.length + fn.locals.length - 1;
    fn.localIdx.set(name, idx);
    return idx;
  }

  private compileExpr(e: Expr, fn: WasmFn): number[] {
    switch (e.k) {
      case 'num':
        return [OP_F64_CONST, ...f64Bytes(e.value)];
      case 'bool':
        return [OP_F64_CONST, ...f64Bytes(e.value ? 1 : 0)];
      case 'str':
        // 二进制目标无字符串表示；字面量退化为 0
        return [OP_F64_CONST, ...f64Bytes(0)];
      case 'ref': {
        const idx = fn.localIdx.get(e.path[0]);
        if (idx === undefined) return [OP_F64_CONST, ...f64Bytes(0)];
        return [OP_LOCAL_GET, ...uleb(idx)];
      }
      case 'un': {
        const o = this.compileExpr(e.operand, fn);
        if (e.op === '-') return [...o, OP_F64_NEG];
        return [...o, OP_F64_CONST, ...f64Bytes(0), OP_F64_EQ, OP_F64_CONVERT_I32_S];
      }
      case 'bin': {
        const l = this.compileExpr(e.left, fn);
        const r = this.compileExpr(e.right, fn);
        switch (e.op) {
          case '+':
            return [...l, ...r, OP_F64_ADD];
          case '-':
            return [...l, ...r, OP_F64_SUB];
          case '*':
            return [...l, ...r, OP_F64_MUL];
          case '/':
            return [...l, ...r, OP_F64_DIV];
          case '==':
            return [...l, ...r, OP_F64_EQ, OP_F64_CONVERT_I32_S];
          case '!=':
            return [...l, ...r, OP_F64_NE, OP_F64_CONVERT_I32_S];
          case '<':
            return [...l, ...r, OP_F64_LT, OP_F64_CONVERT_I32_S];
          case '>':
            return [...l, ...r, OP_F64_GT, OP_F64_CONVERT_I32_S];
          case '<=':
            return [...l, ...r, OP_F64_LE, OP_F64_CONVERT_I32_S];
          case '>=':
            return [...l, ...r, OP_F64_GE, OP_F64_CONVERT_I32_S];
          case '并且':
            return [...this.toBool(l), ...this.toBool(r), OP_F64_MUL];
          case '或者': {
            return [
              ...this.toBool(l),
              ...this.toBool(r),
              OP_F64_ADD,
              OP_F64_CONST,
              ...f64Bytes(0),
              OP_F64_GT,
              OP_F64_CONVERT_I32_S,
            ];
          }
          default:
            return [OP_F64_CONST, ...f64Bytes(0)];
        }
      }
      case 'call': {
        const name = e.name.join('.');
        const target = this.fnIndex.get(name);
        const args = e.args.flatMap((a) => this.compileExpr(a, fn));
        if (target === undefined) return [...args, OP_DROP, OP_F64_CONST, ...f64Bytes(0)];
        return [...args, OP_CALL, ...uleb(target)];
      }
      default:
        return [OP_F64_CONST, ...f64Bytes(0)];
    }
  }

  /** f64 → 布尔值（0/1）。 */
  private toBool(code: number[]): number[] {
    return [...code, OP_F64_CONST, ...f64Bytes(0), OP_F64_NE, OP_F64_CONVERT_I32_S];
  }

  /** 条件表达式 → wasm 的 i32 条件（`if` 只接受 i32）。 */
  private toI32(e: Expr, fn: WasmFn): number[] {
    return [...this.compileExpr(e, fn), OP_F64_CONST, ...f64Bytes(0), OP_F64_NE];
  }

  // ------------------------------ 组装

  encode(): Buffer {
    this.compile();
    this.fns.forEach((f, i) => this.fnIndex.set(f.name, i));

    const types: number[] = [...uleb(this.typeIndex.size)];
    for (const [arity] of [...this.typeIndex.entries()].sort((a, b) => a[1] - b[1])) {
      types.push(0x60, ...uleb(arity));
      for (let i = 0; i < arity; i++) types.push(T_F64);
      types.push(...uleb(1), T_F64);
    }

    const funcs: number[] = [...uleb(this.fns.length)];
    for (const f of this.fns) funcs.push(...uleb(this.typeIndex.get(f.arity) ?? 0));

    const exports: number[] = [...uleb(this.fns.length)];
    for (let i = 0; i < this.fns.length; i++) {
      const name = utf8(this.fns[i].name);
      exports.push(...uleb(name.length), ...name, 0x00, ...uleb(i));
    }

    const codes: number[] = [...uleb(this.fns.length)];
    for (const f of this.fns) codes.push(...f.code);

    const bytes = [
      ...MAGIC,
      ...VERSION,
      ...section(SEC_TYPE, types),
      ...section(SEC_FUNC, funcs),
      ...section(SEC_EXPORT, exports),
      ...section(SEC_CODE, codes),
    ];
    return Buffer.from(bytes);
  }

  /** 导出签名清单（供加载器与验收使用）。 */
  manifest(): { name: string; params: string[]; returns: string }[] {
    return this.fns.map((f) => ({ name: f.name, params: [...f.params], returns: 'f64' }));
  }
}

/** 全部函数共享的辅助：找出整段语句里「最后一次赋值过的变量」。 */
function lastAssigned(list: Stmt[]): string | null {
  let found: string | null = null;
  for (const s of list) {
    if (s.k === 'data' || s.k === 'calc') found = s.name;
    else if (s.k === 'branch') {
      found = lastAssigned(s.then) ?? found;
      if (s.otherwise) found = lastAssigned(s.otherwise) ?? found;
    } else if (s.k === 'loop') {
      found = lastAssigned(s.body) ?? found;
    } else if (s.k === 'exec' && s.name === null) {
      found = lastAssigned(s.body) ?? found;
    } else if (s.k === 'panel' || s.k === 'comp-call') {
      found = lastAssigned(s.children) ?? found;
    }
  }
  return found;
}

// ---------------------------------------------------------------- 产物

export interface WasmOutput {
  files: Map<string, Buffer | string>;
  exported: string[];
}

export function emitWasm(program: IrProgram, spec: SpecBundle): WasmOutput {
  const compiler = new WasmCompiler(program, spec);
  const wasm = compiler.encode();
  const manifest = compiler.manifest();

  const loader = `// 由 ese build --target=wasm 生成 —— 二进制目标的加载器
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(HERE, 'logic.wasm'));
const { instance } = await WebAssembly.instantiate(bytes, {});

export const exports = instance.exports;
export const manifest = ${JSON.stringify(manifest, null, 2)};
export default instance.exports;
`;

  const files = new Map<string, Buffer | string>();
  files.set('logic.wasm', wasm);
  files.set('logic.manifest.json', JSON.stringify({ source: program.name, exports: manifest }, null, 2));
  files.set('logic.mjs', loader);
  return { files, exported: manifest.map((m) => m.name) };
}

export { u32, sleb, uleb };
