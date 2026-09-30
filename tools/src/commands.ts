/**
 * commands.ts —— 子命令实现
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { SpecBundle } from './spec.ts';
import { verifySpec } from './spec.ts';
import type { Reporter, Mode } from './diagnostics.ts';
import { processText, RULES } from './rules.ts';

export interface CmdContext {
  spec: SpecBundle;
  reporter: Reporter;
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.workbuddy']);

function collectBdFiles(inputs: string[]): string[] {
  const files = new Set<string>();
  for (const input of inputs) {
    const p = resolve(input);
    if (!existsSync(p)) continue;
    const st = statSync(p);
    if (st.isFile()) {
      if (p.endsWith('.bd')) files.add(p);
      continue;
    }
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(resolve(dir, e.name));
        } else if (e.name.endsWith('.bd')) {
          files.add(resolve(dir, e.name));
        }
      }
    };
    walk(p);
  }
  return [...files].sort();
}

/** 报错语言跟随文件模式（规范 §8.3）。 */
function detectMode(text: string): Mode {
  const head = text.slice(0, 4096);
  return /^\s*\[ee\]/m.test(head) ? 'en' : 'zh';
}

function lineDiff(original: string, result: string): string[] {
  const a = original.split(/\r?\n/);
  const b = result.split(/\r?\n/);
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    const no = String(i + 1).padStart(4);
    if (a[i] !== undefined) out.push(`  ${no} - ${a[i]}`);
    if (b[i] !== undefined) out.push(`  ${no} + ${b[i]}`);
  }
  return out;
}

interface FmtOptions {
  write: boolean;
  check: boolean;
  migrate: boolean;
  listRules: boolean;
  json: boolean;
  quiet: boolean;
  paths: string[];
}

function parseFmtArgs(args: string[]): FmtOptions {
  const o: FmtOptions = { write: false, check: false, migrate: false, listRules: false, json: false, quiet: false, paths: [] };
  for (const a of args) {
    if (a === '--write' || a === '-w') o.write = true;
    else if (a === '--check') o.check = true;
    else if (a === '--migrate') o.migrate = true;
    else if (a === '--dry-run' || a === '-n') o.write = false;
    else if (a === '--rules') o.listRules = true;
    else if (a === '--json') o.json = true;
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a.startsWith('-')) throw new Error(`未知选项 ${a}`);
    else o.paths.push(a);
  }
  return o;
}

export function cmdFmt(args: string[], ctx: CmdContext): number {
  let opts: FmtOptions;
  try {
    opts = parseFmtArgs(args);
  } catch (e) {
    ctx.err(String(e instanceof Error ? e.message : e));
    return 2;
  }

  if (opts.listRules) {
    ctx.out('迁移规则（按执行顺序）：');
    for (const r of RULES) {
      ctx.out(`  ${r.id.padEnd(22)} ${r.code ?? '—     '}  ${r.title}`);
    }
    return 0;
  }

  const inputs = opts.paths.length > 0 ? opts.paths : ['.'];
  const files = collectBdFiles(inputs);
  if (files.length === 0) {
    if (!opts.quiet) ctx.out('未发现 .bd 文件。');
    return 0;
  }

  let changedFiles = 0;
  let migratedCount = 0;
  let skippedCount = 0;
  const report: Record<string, unknown>[] = [];

  for (const abs of files) {
    const rel = relative(ctx.cwd, abs) || abs;
    const original = readFileSync(abs, 'utf8');
    const mode = detectMode(original);

    let processed: { result: string; migrate: ReturnType<typeof processText>['migrate']; indentChanged: number };
    try {
      processed = processText(original, rel, { migrate: opts.migrate });
    } catch (e) {
      const d = ctx.reporter.make(
        'ESE4004',
        { file: rel, line: 1, detail: e instanceof Error ? e.message : String(e) },
        { file: rel, line: 1, column: 1 },
        mode,
      );
      ctx.err(ctx.reporter.render(d, mode));
      return 1;
    }

    const { result, migrate } = processed;
    const fileHits = migrate?.hits ?? [];
    const fileSkips = migrate?.skips ?? [];
    migratedCount += fileHits.length;

    // 未能自动迁移的命中：报错，要求人工处理（绝不猜测）
    for (const s of fileSkips) {
      skippedCount++;
      const d = ctx.reporter.make(
        'ESE4004',
        { file: rel, line: s.line, detail: `${s.skip.from} —— ${s.skip.reason}` },
        { file: rel, line: s.line, column: s.skip.column },
        mode,
      );
      ctx.err(ctx.reporter.render(d, mode));
    }

    if (result === original) continue;
    changedFiles++;

    if (!opts.quiet) {
      ctx.out(`${rel}${opts.write && !opts.check ? '（已改写）' : '（待改写）'}`);
      if (!opts.json) {
        for (const l of lineDiff(original, result)) ctx.out(l);
      }
      for (const h of fileHits) {
        ctx.out(`        ↳ ${h.hit.rule} 第 ${h.line} 行：${h.hit.from} → ${h.hit.to}`);
      }
    }

    if (opts.write && !opts.check) writeFileSync(abs, result, 'utf8');

    report.push({ file: rel, hits: fileHits.length, skips: fileSkips.length });
  }

  if (opts.json) {
    ctx.out(JSON.stringify({ files: report, changed: changedFiles, migrated: migratedCount, skipped: skippedCount }, null, 2));
  } else if (!opts.quiet) {
    ctx.out(
      `\n合计：扫描 ${files.length} 个文件，${opts.write && !opts.check ? '改写' : '需改写'} ${changedFiles} 个` +
        (opts.migrate ? `，自动迁移 ${migratedCount} 处` : '') +
        (skippedCount > 0 ? `，需人工确认 ${skippedCount} 处` : ''),
    );
    if (opts.write && !opts.check) ctx.out('已写回磁盘。');
    else if (changedFiles > 0) ctx.out('未写回（dry-run）。确认无误后加 --write 落盘。');
  }

  if (skippedCount > 0) return 1;
  if (opts.check) return changedFiles > 0 ? 1 : 0;
  if (!opts.write) return changedFiles > 0 ? 1 : 0;
  return 0;
}

export function cmdSpecVerify(_args: string[], ctx: CmdContext): number {
  const problems = verifySpec(ctx.spec);
  ctx.out(`单一数据源：${ctx.spec.paths.keywords}`);
  ctx.out(`                ${ctx.spec.paths.diagnostics}`);
  ctx.out(`                ${ctx.spec.paths.grammar}`);
  ctx.out(`关键字 ${ctx.spec.keywords.keywords.length} 条 / 诊断码 ${ctx.spec.diagnostics.diagnostics.length} 个\n`);

  const groups: Record<string, string> = {
    C1: 'grammar.ebnf 中的关键字必须存在于 keywords.json',
    C2: 'keywords.json 中英两形数量相等、无重复',
    C3: 'diagnostics.json 中英模板占位符一致且已登记',
    C4: '正式符号对数量恒为 17',
  };

  let failed = 0;
  for (const key of Object.keys(groups)) {
    const list = problems.filter((p) => p.check === key);
    if (list.length === 0) {
      ctx.out(`[通过] ${key}  ${groups[key]}`);
    } else {
      failed++;
      ctx.out(`[失败] ${key}  ${groups[key]}`);
      for (const p of list) ctx.out(`       - ${p.detail}`);
    }
  }
  if (failed > 0) {
    ctx.err(`\n单一数据源校验失败：${problems.length} 处不一致。`);
    return 1;
  }
  ctx.out('\n四项校验全部通过。');
  return 0;
}

export function cmdSpec(action: string | undefined, args: string[], ctx: CmdContext): number {
  if (action === 'verify') return cmdSpecVerify(args, ctx);
  ctx.err('用法：ese spec verify');
  return 2;
}
