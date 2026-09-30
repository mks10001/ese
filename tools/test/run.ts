/**
 * test/run.ts —— 自测
 *
 * 覆盖五层：① 迁移规则逐条；② 缩进格式化；③ 单一数据源校验；
 * ④ 命令层端到端；⑤ 转译器端到端（前端 / 后端 / 二进制三个目标，见 test/build.ts）。
 * 端到端直接调用与 CLI 完全相同的命令函数（cmdFmt / cmdSpecVerify / cmdBuild），
 * 因此不依赖能否派生子进程；只有在宿主允许时才额外跑一次真实 CLI 子进程做冒烟。
 * 零测试框架依赖，失败即以退出码 1 结束。
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { loadSpec, verifySpec } from '../src/spec.ts';
import { migrateLine, formatLines } from '../src/rules.ts';
import { Reporter } from '../src/diagnostics.ts';
import { cmdFmt, cmdSpecVerify } from '../src/commands.ts';
import type { CmdContext } from '../src/commands.ts';
import { runBuildTests } from './build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = resolve(here, '..');
const cliPath = resolve(toolsDir, 'src', 'cli.ts');
const repoRoot = resolve(toolsDir, '..');

/**
 * 尽力尝试派生子进程。部分受限宿主（含本项目的开发沙箱）整体禁止派生，
 * 此时返回 null 由调用方跳过，不算失败。
 */
function runCli(args: string[], cwd = toolsDir): { status: number | null; stdout: string; stderr: string } | null {
  try {
    const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd });
    if (r.error) return null;
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch {
    return null;
  }
}

let passed = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failures.push(`${name}\n     期望 ${e}\n     实际 ${a}`);
  }
}

// ------------------------------------------------------------- ① 迁移规则

interface MigrateCase {
  name: string;
  input: string;
  expected: string;
}

const migrateCases: MigrateCase[] = [
  { name: 'M1 单层圆括号按钮', input: '  [( 去首页 )]', expected: '  [c. 去首页 .c]' },
  { name: 'M2 双层圆括号按钮', input: '  [(( 去首页 ))]', expected: '  [c. 去首页 .c]' },
  { name: 'M2 文字含单层半角括号', input: '  [(( 提交 (v2) ))]', expected: '  [c. 提交 (v2) .c]' },
  { name: 'M3 紧贴写法补空格', input: '  [c.去关于.c]', expected: '  [c. 去关于 .c]' },
  { name: 'M3 紧贴写法含点语法', input: '  [c.用户.名字.c]', expected: '  [c. 用户.名字 .c]' },
  { name: '语句位置：前一条语句之后', input: '  [- 你好 -] [( 你好 )]', expected: '  [- 你好 -] [c. 你好 .c]' },
  { name: '值位置：列表不改为按钮', input: '  [# 名单 = [(1 + 2), 4] #]', expected: '  [# 名单 = [(1 + 2), 4] #]' },
  { name: '值位置：紧贴形态是列表', input: '  [# 路径 = [c.a.c] #]', expected: '  [# 路径 = [c.a.c] #]' },
  { name: '值位置：括号表达式不动', input: '  [$ 结果 = (1 + 2) * 3 $]', expected: '  [$ 结果 = (1 + 2) * 3 $]' },
  { name: '注释内不动', input: '  [! 旧写法 [( x )] 不是按钮 !]', expected: '  [! 旧写法 [( x )] 不是按钮 !]' },
  { name: '文字块内不动', input: '  [- 看到 [( x )] 就写按钮 -]', expected: '  [- 看到 [( x )] 就写按钮 -]' },
  { name: 'M4 路由补页面关键字', input: '  [/ home', expected: '  [/ 页面 home' },
  { name: 'M4 路由剥前导斜杠', input: '  [/ /home', expected: '  [/ 页面 home' },
  { name: 'M4 已正确不动', input: '  [/ 页面 home', expected: '  [/ 页面 home' },
  { name: 'M5 跳转剥离前导斜杠', input: '  [c.去用户页.c] 跳转 /用户/3', expected: '  [c. 去用户页 .c] 跳转 用户/3' },
  { name: 'M5 英文 goto', input: '  [c.to about.c] goto /about', expected: '  [c. to about .c] goto about' },
  { name: 'M5 文字块内不动', input: '  [- 跳转 /about 是旧写法 -]', expected: '  [- 跳转 /about 是旧写法 -]' },
  { name: 'M6 行尾多余分隔符', input: '  [- a -] [!!]', expected: '  [- a -]' },
  { name: 'M6 行内分隔符保留', input: '  [- a -] [!!] [- b -] [!!]', expected: '  [- a -] [!!] [- b -]' },
  { name: 'M6 仅分隔符的一行不动', input: '  [!!]', expected: '  [!!]' },
  { name: '已正确的按钮不动', input: '  [c. 提交 (v2) .c]', expected: '  [c. 提交 (v2) .c]' },
  { name: '空按钮不动', input: '  [c. .c]', expected: '  [c. .c]' },
  { name: '组件调用不动', input: '  [< 欢迎卡 名字="张三" >]', expected: '  [< 欢迎卡 名字="张三" >]' },
];

console.log('① 迁移规则');
for (const c of migrateCases) {
  const r = migrateLine(c.input);
  eq(c.name, r.line, c.expected);
}

// 位置无法判定时拒绝改写
{
  const r = migrateLine('  [[( x )]]');
  eq('位置未知时拒绝改写', r.line, '  [[( x )]]');
  eq('位置未知时上报 skip', r.skips.length, 1);
}

// ------------------------------------------------------------- ② 缩进格式化

console.log('② 缩进格式化');
const flat = [
  '[> 提交 :',
  '[? 名字 == "" 或者 长度(名字) > 20',
  '[- 名字不合法 -]',
  '[??',
  '[< 欢迎卡 名字=名字 >]',
  '??]',
  '?]',
  '>]',
].map((line) => ({ line, eol: '\n' }));
const expectedIndent = ['[> 提交 :', '  [? 名字 == "" 或者 长度(名字) > 20', '    [- 名字不合法 -]', '    [??', '      [< 欢迎卡 名字=名字 >]', '    ??]', '  ?]', '>]'];
eq(
  '条件块缩进',
  formatLines(flat).lines.map((l) => l.line),
  expectedIndent,
);
eq('格式化幂等', formatLines(formatLines(flat).lines).changed, 0);

{
  const src = ['[ese.bd', '[- 正文 -]', ']'].map((line) => ({ line, eol: '\n' }));
  eq('文件头缩进', formatLines(src).lines.map((l) => l.line), ['[ese.bd', '  [- 正文 -]', ']']);
}

// ------------------------------------------------------------- ③ 单一数据源

console.log('③ 单一数据源校验');
const spec = loadSpec();
const problems = verifySpec(spec);
eq('spec verify 无问题', problems.map((p) => `${p.check}: ${p.detail}`), []);
eq('关键字条目数', spec.keywords.keywords.length > 0, true);
eq('诊断码已登记 ESE1015', new Reporter(spec).codes().includes('ESE1015'), true);

// 诊断渲染
{
  const rep = new Reporter(spec);
  const d = rep.make('ESE1008', { detail: '语句位置出现 [( … )]' }, { file: 'ese.bd', line: 7, column: 3 }, 'zh');
  const text = rep.render(d, 'zh');
  eq('诊断文本含错误码', text.includes('ESE1008'), true);
  eq('诊断文本含位置', text.includes('ese.bd:7:3'), true);
  const en = rep.render(rep.make('ESE1008', { detail: 'legacy form' }, { file: 'ese.bd', line: 7, column: 3 }, 'en'), 'en');
  eq('英文模式诊断可用英文模板', en.includes('Wrong button delimiter'), true);
}

// ------------------------------------------------------- ④ 命令层端到端

function makeCtx(): { ctx: CmdContext; out: string[]; err: string[] } {
  const s = loadSpec();
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CmdContext = {
    spec: s,
    reporter: new Reporter(s),
    cwd: toolsDir,
    out: (x) => out.push(x),
    err: (x) => err.push(x),
  };
  return { ctx, out, err };
}

console.log('④ 命令层端到端');
const tmp = mkdtempSync(join(tmpdir(), 'ese-test-'));
try {
  const legacy = [
    '[zz]',
    '[ese.bd',
    '[- 你好 -] [!!]',
    '  [( 去首页 )]',
    '[c.去关于.c] 跳转 /about',
    '[/ home',
    '[- 首页 -]',
    '/]',
    ']',
    '',
  ].join('\n');
  const file = join(tmp, 'ese.bd');
  writeFileSync(file, legacy, 'utf8');

  const a = makeCtx();
  eq('dry-run 退出码为 1（有待改写）', cmdFmt(['--migrate', tmp], a.ctx), 1);
  eq('dry-run 不改盘', readFileSync(file, 'utf8'), legacy);
  eq('dry-run 提示未写回', a.out.join('\n').includes('dry-run'), true);

  const b = makeCtx();
  eq('--write 退出码为 0', cmdFmt(['--migrate', '--write', tmp], b.ctx), 0);
  eq(
    '迁移后内容',
    readFileSync(file, 'utf8'),
    ['[zz]', '[ese.bd', '  [- 你好 -]', '  [c. 去首页 .c]', '  [c. 去关于 .c] 跳转 about', '  [/ 页面 home', '    [- 首页 -]', '  /]', ']', ''].join('\n'),
  );

  const c = makeCtx();
  eq('幂等：再次 --check 通过', cmdFmt(['--migrate', '--check', tmp], c.ctx), 0);

  const d = makeCtx();
  eq('spec verify 退出码为 0', cmdSpecVerify([], d.ctx), 0);
  eq('spec verify 四项通过', d.out.join('\n').includes('四项校验全部通过'), true);

  const e = makeCtx();
  cmdFmt(['--rules'], e.ctx);
  eq('--rules 列出六条规则', (e.out.join('\n').match(/button-|jump-|route-|redundant-/g) ?? []).length >= 6, true);

  // 无法自动迁移时必须以错误退出，且不得改写文件
  const f = makeCtx();
  const bad = join(tmp, 'bad.bd');
  writeFileSync(bad, '[ese.bd\n  [[( x )]]\n]\n', 'utf8');
  eq('需人工确认时退出码为 1', cmdFmt(['--migrate', '--write', bad], f.ctx), 1);
  eq('需人工确认时不改写', readFileSync(bad, 'utf8'), '[ese.bd\n  [[( x )]]\n]\n');
  eq('需人工确认时报 ESE4004', f.err.join('\n').includes('ESE4004'), true);

  // 可选冒烟：宿主允许派生子进程时跑一次真实 CLI
  const cli = runCli(['spec', 'verify'], repoRoot);
  if (cli) eq('CLI 子进程 spec verify 退出码为 0', cli.status, 0);
  else console.log('   （宿主禁止派生子进程，跳过 CLI 子进程冒烟；同一逻辑已在进程内覆盖）');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------- ⑤ 转译器

console.log('⑤ 转译器端到端（前端 / 后端 / 二进制）');
await runBuildTests(eq, repoRoot);

// ------------------------------------------------------------------ 汇总

if (failures.length > 0) {
  console.error(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
  process.exitCode = 1;
} else {
  console.log(`\n全部通过：${passed} 项。`);
}
