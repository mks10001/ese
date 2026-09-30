/**
 * cli.ts —— ese 命令行入口
 *
 * 无需构建步骤：Node >= 22.18 可直接运行 TypeScript（类型擦除），
 * 因此本工具零运行时依赖、零编译产物。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpec } from './spec.ts';
import { Reporter } from './diagnostics.ts';
import { cmdFmt, cmdSpec } from './commands.ts';
import type { CmdContext } from './commands.ts';

const here = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  const p = resolve(here, '..', 'package.json');
  if (!existsSync(p)) return '0.0.0';
  try {
    return (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `ese —— ese 语言工具链

用法：
  ese fmt [路径…] [选项]     统一缩进为每层两空格（幂等）
  ese spec verify            校验 spec/ 三个单一数据源的一致性
  ese help                   显示本帮助
  ese --version              显示版本

fmt 选项：
  --migrate        应用历史破坏性变更的自动迁移（默认关闭）
  --write, -w      改写文件（默认 dry-run，只打印差异）
  --check          只判断是否需要改写，需要则以退出码 1 结束（供 CI 使用）
  --dry-run, -n    显式指定 dry-run（默认行为）
  --rules          列出全部迁移规则后退出
  --json           以 JSON 输出结果
  --quiet, -q      只输出汇总

退出码：
  0  成功，且无需改写
  1  需要改写 / 存在需人工确认项 / 单一数据源校验失败
  2  用法错误

注意：默认 dry-run 是刻意的。在 ese check 可用之前，改写不做二次校验，
静默落盘的风险高于多敲一个 --write。ese check 发布后将把默认值改为 --write。
`;

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  let spec;
  try {
    spec = loadSpec();
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.stderr.write('提示：请从仓库内运行，或用 ESE_SPEC_DIR 指向 spec/ 目录。\n');
    return 2;
  }

  const ctx: CmdContext = {
    spec,
    reporter: new Reporter(spec),
    cwd: process.cwd(),
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  };

  const cmd = args[0];
  const rest = args.slice(1);
  switch (cmd) {
    case 'fmt':
      return cmdFmt(rest, ctx);
    case 'spec':
      return cmdSpec(rest[0], rest.slice(1), ctx);
    default:
      process.stderr.write(`未知子命令：${cmd}\n\n${HELP}`);
      return 2;
  }
}

process.exitCode = main(process.argv);
