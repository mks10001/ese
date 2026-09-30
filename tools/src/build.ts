/**
 * build.ts —— ese build：三个转译目标的统一入口
 *
 *   ese build --target=web      静态站点（每页预渲染 HTML + app.js）
 *   ese build --target=server   可运行的 Node HTTP 服务（SSR）
 *   ese build --target=wasm     逻辑层二进制模块（.wasm）
 *   ese build --target=all      以上全部
 *
 * 管线：源码 → 词法 → 语法 → IR →（目标各自发射）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import type { FileAst } from './ast.ts';
import { EseError, type Mode } from './diagnostics.ts';
import { buildIr, type IrProgram } from './ir.ts';
import { parseFile } from './parse.ts';
import { emitWeb } from './emit-web.ts';
import { emitServer } from './emit-server.ts';
import { emitWasm } from './emit-wasm.ts';
import type { CmdContext } from './commands.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.workbuddy']);

export type Target = 'web' | 'server' | 'wasm';

interface BuildOptions {
  targets: Target[];
  outDir: string;
  input: string | null;
}

function parseArgs(args: string[]): BuildOptions {
  const targets = new Set<Target>();
  let outDir = 'dist';
  let input: string | null = null;
  for (const a of args) {
    if (a.startsWith('--target=')) {
      const v = a.slice('--target='.length);
      if (v === 'all') {
        targets.add('web');
        targets.add('server');
        targets.add('wasm');
      } else if (v === 'web' || v === 'server' || v === 'wasm') {
        targets.add(v);
      } else {
        throw new Error(`未知目标 ${v}（可用：web / server / wasm / all）`);
      }
    } else if (a.startsWith('--out=')) {
      outDir = a.slice('--out='.length);
    } else if (a.startsWith('-')) {
      throw new Error(`未知选项 ${a}`);
    } else {
      input = a;
    }
  }
  if (targets.size === 0) targets.add('web');
  return { targets: [...targets], outDir, input };
}

function collectBd(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(resolve(d, e.name));
      } else if (e.name.endsWith('.bd')) {
        const abs = resolve(d, e.name);
        out.set(relative(dir, abs).replace(/\\/g, '/'), readFileSync(abs, 'utf8'));
      }
    }
  };
  walk(dir);
  return out;
}

/** ese.json 清单。中英双形并存，键名跟随项目模式（与 `[zz]` / `[ee]` 一致）。 */
interface Manifest {
  名称?: string;
  name?: string;
  模式?: string;
  mode?: string;
  入口?: string;
  entry?: string;
  首页?: string;
  home?: string;
  ui?: string;
}

function readManifest(dir: string): Manifest | null {
  const p = resolve(dir, 'ese.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

const mName = (m: Manifest | null): string | undefined => m?.名称 ?? m?.name;
const mEntry = (m: Manifest | null): string | undefined => m?.入口 ?? m?.entry;
const mHome = (m: Manifest | null): string | null => m?.首页 ?? m?.home ?? null;

export function cmdBuild(args: string[], ctx: CmdContext): number {
  let opts: BuildOptions;
  try {
    opts = parseArgs(args);
  } catch (e) {
    ctx.err(String(e instanceof Error ? e.message : e));
    return 2;
  }

  const dir = resolve(ctx.cwd, opts.input ?? '.');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const d = ctx.reporter.make('ESE4003', { path: 'ese.bd' }, { file: 'ese.bd', line: 1, column: 1 }, 'zh');
    ctx.err(ctx.reporter.render(d, 'zh'));
    return 1;
  }

  const manifest = readManifest(dir);
  const sources = collectBd(dir);
  const declaredEntry = mEntry(manifest);
  const entryKey = declaredEntry && sources.has(declaredEntry) ? declaredEntry : 'ese.bd';
  if (!sources.has(entryKey)) {
    const d = ctx.reporter.make('ESE4003', { path: entryKey }, { file: entryKey, line: 1, column: 1 }, 'zh');
    ctx.err(ctx.reporter.render(d, 'zh'));
    return 1;
  }

  // ---- 解析 ----
  const asts = new Map<string, FileAst>();
  const modes = new Set<Mode>();
  for (const [rel, src] of sources) {
    try {
      const ast = parseFile(src, rel, ctx.spec);
      asts.set(rel, ast);
      modes.add(ast.mode);
    } catch (e) {
      return reportEseError(e, ctx, rel, 'zh');
    }
  }
  const entryAst = asts.get(entryKey)!;
  const mode = entryAst.mode;

  if (modes.size > 1) {
    const d = ctx.reporter.make(
      'ESE4001',
      { detail: [...modes].join(' / ') },
      { file: entryKey, line: 1, column: 1 },
      mode,
    );
    ctx.err(ctx.reporter.render(d, mode));
    return 1;
  }

  // ---- 降级 ----
  let program: IrProgram;
  let failed = false;
  const diagnostics: string[] = [];
  try {
    program = buildIr(entryAst, asts, ctx.spec, {
      projectName: mName(manifest) ?? basename(dir),
      entryPage: mHome(manifest),
      report: (code, params, pos, severity) => {
        const d = ctx.reporter.make(code, params, { file: entryKey, line: pos.line, column: pos.column }, mode);
        diagnostics.push(ctx.reporter.render(d, mode));
        if (severity === 'error') failed = true;
      },
    });
  } catch (e) {
    return reportEseError(e, ctx, entryKey, mode);
  }

  for (const line of diagnostics) ctx.err(line);
  if (failed) {
    ctx.err('\n降级失败：请先修正上述错误。');
    return 1;
  }

  // ---- 发射 ----
  const outDir = resolve(ctx.cwd, opts.outDir);
  const written: string[] = [];
  const subFor = (target: Target): string => (opts.targets.length > 1 ? `${opts.outDir}/${target}` : opts.outDir);

  for (const target of opts.targets) {
    let out: { files: Map<string, string | Buffer> };
    let note = '';
    try {
      if (target === 'web') {
        const r = emitWeb(program, ctx.spec);
        out = r;
        note = `（其中 ${r.pageCount} 个页面已预渲染）`;
      } else if (target === 'server') {
        out = emitServer(program, ctx.spec);
      } else {
        const r = emitWasm(program, ctx.spec);
        out = r;
        note = `（导出 ${r.exported.length} 个函数）`;
      }
    } catch (e) {
      return reportEseError(e, ctx, entryKey, mode);
    }
    const sub = subFor(target);
    const base = resolve(ctx.cwd, sub);
    for (const [rel, content] of out.files) {
      const abs = resolve(base, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      written.push(`${sub}/${rel}`);
    }
    ctx.out(`[${target}] 产出 ${out.files.size} 个文件${note}`);
  }

  const entryLabel = program.entryRoute === '' ? '根页面' : program.entryRoute;
  ctx.out('');
  ctx.out(
    `${program.name}（模式 ${program.mode}）：${program.components.size} 个组件 / ${program.pages.length} 个页面 / ${program.globals.length} 项全局状态`,
  );
  ctx.out(`站点入口：${entryLabel}`);
  ctx.out(`产物目录：${relative(ctx.cwd, outDir) || '.'}`);
  for (const w of written) ctx.out(`  ${w}`);
  if (opts.targets.includes('server')) {
    ctx.out('');
    ctx.out(`启动服务：node ${subFor('server')}/server.mjs`);
  }
  return 0;
}

function reportEseError(e: unknown, ctx: CmdContext, file: string, mode: Mode): number {
  if (e instanceof EseError) {
    const d = ctx.reporter.make(e.code, e.params, e.pos, mode);
    ctx.err(ctx.reporter.render(d, mode));
    return 1;
  }
  ctx.err(String(e instanceof Error ? e.stack ?? e.message : e));
  void file;
  return 1;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'ese';
}
