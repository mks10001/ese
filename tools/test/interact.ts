/**
 * test/interact.ts —— 客户端交互链路验证（第 ⑥ 层）。
 *
 * 背景：SSR / 预渲染测试只能证明「渲染正确」，测不出点击后的行为。
 * 这里用最小 DOM 桩在 Node 里真实驱动生成的运行时：
 *   set（输入绑定）→ invoke（处理器调用）→ 重渲染 → 断言 DOM 变化。
 * 覆盖：添加、空输入守门、带参删除、删空兜底、路由页渲染。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadSpec } from '../src/spec.ts';
import { parseFile } from '../src/parse.ts';
import { buildIr } from '../src/ir.ts';
import { emitServer } from '../src/emit-server.ts';

export async function runInteractTests(
  eq: (label: string, actual: unknown, expected: unknown) => void,
  repoRoot: string,
): Promise<void> {
  // ---- 进程内构建「备忘录」示例的模块运行时 ----
  const spec = loadSpec();
  const srcDir = join(repoRoot, 'examples', '备忘录');
  const ast = parseFile(await import('node:fs').then((m) => m.readFileSync(join(srcDir, 'ese.bd'), 'utf8')), 'ese.bd', spec);
  const program = buildIr(ast, new Map([['ese.bd', ast]]), spec, {
    projectName: '备忘录',
    report: () => {},
  } as never);
  const out = emitServer(program, spec);

  const tmp = mkdtempSync(join(tmpdir(), 'ese-interact-'));
  for (const [rel, content] of out.files) {
    if (typeof content !== 'string') continue;
    writeFileSync(join(tmp, rel), content, 'utf8');
  }

  // ---- 最小 DOM 桩 ----
  const root: { innerHTML: string; addEventListener: () => void; contains: () => boolean } = {
    innerHTML: '',
    addEventListener() {},
    contains() { return false; },
  };
  (globalThis as Record<string, unknown>).document = {
    getElementById: () => root,
    activeElement: null,
    readyState: 'complete',
    addEventListener() {},
  };
  (globalThis as Record<string, unknown>).window = { addEventListener() {}, location: { pathname: '/' } };

  const mod = (await import(pathToFileURL(join(tmp, 'runtime.mjs')).href)) as {
    mountClient(): void;
    renderRoute(r: string, p?: Record<string, string>): string;
  };
  mod.mountClient();
  const ese = (globalThis as { window: { __ese: { set: (s: string, n: string, v: unknown) => void; invoke: (s: string, n: string, a?: unknown[]) => void } } }).window.__ese;

  const items = (html: string): string[] =>
    [...html.matchAll(/class="ese-text">([^<]*)<\/div>/g)]
      .map((m) => m[1].trim())
      .filter((t) => t.includes('写第一行') || t.includes('转译') || t.includes('仓库') || t.includes('新条目'));

  const before = items(root.innerHTML);
  eq('交互 初始 3 条', before.length, 3);

  // 输入绑定 + 添加 + 输入框清空
  ese.set('P', '草稿', '新条目一');
  ese.invoke('P', '添加', []);
  eq('交互 添加后 4 条', items(root.innerHTML).length, 4);
  eq('交互 添加后输入框已清空', !/新条目一"\s+value|value="新条目一"/.test(root.innerHTML), true);

  // 空输入守门
  ese.invoke('P', '添加', []);
  eq('交互 空输入不添加', items(root.innerHTML).length, 4);

  // 带参删除
  ese.invoke('P', '删除', [before[0]]);
  eq('交互 删除后 3 条', items(root.innerHTML).length, 3);
  eq('交互 被删条目已消失', items(root.innerHTML).includes(before[0]), false);

  // 删空兜底
  for (const t of items(root.innerHTML).slice()) ese.invoke('P', '删除', [t]);
  eq('交互 删空显示兜底', root.innerHTML.includes('列表空空的'), true);

  // 路由页渲染
  eq('交互 about 页可渲染', mod.renderRoute('about', {}).includes('关于这一页'), true);
}
