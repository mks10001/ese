/**
 * emit-web.ts —— 前端目标：ese → 静态站点
 *
 * 产物：
 *   dist/index.html 等   每个静态路由一个预渲染页面（首屏无白屏，§15 规则 1）
 *   dist/app.js          自包含的非模块脚本（可被 file:// 直接打开）
 *   dist/style.css       基础样式
 *
 * 带路径参数的页面（用户/{id}）无法在构建期穷举，生成占位页 + 由客户端路由接管。
 */

import type { IrProgram, PageIr } from './ir.ts';
import { BASE_CSS, generateApp, instantiateApp } from './emit-js.ts';
import type { SpecBundle } from './spec.ts';

export interface EmitOutput {
  /** 相对输出目录的路径 → 内容。 */
  files: Map<string, string>;
  /** 实际预渲染的页面数。 */
  pageCount: number;
}

/** 路由 → 输出文件名。 */
export function fileNameFor(route: string): string {
  if (route === '') return 'index.html';
  const parts = route.split('/').map((seg) => (seg.startsWith(':') ? `_${seg.slice(1)}` : seg));
  return `${parts.join('/')}.html`;
}

/** 输出目录内部深度，用于计算相对前缀（保证 file:// 下也能打开）。 */
function prefixFor(file: string): string {
  const depth = file.split('/').length - 1;
  return '../'.repeat(depth);
}

export function htmlShell(program: IrProgram, file: string, title: string, body: string, scriptSrc: string): string {
  const prefix = prefixFor(file);
  const lang = program.mode === 'en' ? 'en' : 'zh-CN';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<link rel="stylesheet" href="${prefix}style.css">
</head>
<body>
<div id="ese-app">${body}</div>
<script src="${prefix}${scriptSrc}"></script>
</body>
</html>
`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function emitWeb(program: IrProgram, spec: SpecBundle): EmitOutput {
  const files = new Map<string, string>();
  const appJs = generateApp(program, spec, false);
  const api = instantiateApp(appJs);

  files.set('app.js', appJs);
  files.set('style.css', BASE_CSS);

  let pageCount = 0;
  for (const page of program.pages) {
    const file = fileNameFor(page.route);
    const params: Record<string, string> = {};
    for (const p of page.params) params[p] = `{${p}}`;
    const body = api.renderRoute(page.route, params);
    const title = pageTitle(program, page);
    files.set(file, htmlShell(program, file, title, body, 'app.js'));
    if (page.params.length === 0) pageCount++;
  }

  // 站点入口即 `/`。规范未定义根路由，入口由降级层裁决（IrProgram.entryRoute）：
  // 入口不是根页面时，额外写一份 index.html，静态托管与 file:// 直接打开都能落到首页。
  if (program.entryRoute !== '') {
    const entry = program.pages.find((p) => p.route === program.entryRoute);
    if (entry && entry.params.length === 0) {
      const body = api.renderRoute(entry.route, {});
      files.set('index.html', htmlShell(program, 'index.html', pageTitle(program, entry), body, 'app.js'));
    }
  }

  // 404 兜底：静态托管未命中时使用
  const notFound = htmlShell(program, '404.html', `${program.name} —— 页面不存在`, '<div class="ese-panel"><div class="ese-text">页面不存在</div></div>', 'app.js');
  files.set('404.html', notFound);

  return { files, pageCount };
}

function pageTitle(program: IrProgram, page: PageIr): string {
  if (page.route === '') return program.name;
  return `${page.route} —— ${program.name}`;
}
