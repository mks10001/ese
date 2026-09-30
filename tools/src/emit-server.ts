/**
 * emit-server.ts —— 后端目标：ese → 可运行的 Node HTTP 服务
 *
 * 产物：
 *   dist/runtime.mjs   渲染运行时（含 renderRoute / matchRoute，可被复用）
 *   dist/server.mjs    HTTP 服务：按请求做服务端渲染，首屏直出完整 HTML
 *   dist/style.css     基础样式
 *
 * 不依赖任何 npm 包，`node dist/server.mjs` 即可启动（§15 规则 1 / 2）。
 */

import type { IrProgram } from './ir.ts';
import { BASE_CSS, generateApp } from './emit-js.ts';
import type { SpecBundle } from './spec.ts';
import type { EmitOutput } from './emit-web.ts';

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SERVER_TEMPLATE = String.raw`// 由 ese build --target=server 生成 —— 请勿手工编辑。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderRoute, matchRoute, programName } from './runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const ASSETS = {
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/runtime.mjs': { file: 'runtime.mjs', type: 'text/javascript; charset=utf-8' },
};

function shell(html) {
  return '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + programName + '</title>\n' +
    '<link rel="stylesheet" href="/style.css">\n' +
    '</head>\n' +
    '<body>\n' +
    '<div id="ese-app">' + html + '</div>\n' +
    '<script type="module">import { mountClient } from "/runtime.mjs"; mountClient();</script>\n' +
    '</body>\n' +
    '</html>\n';
}

const server = createServer(function (req, res) {
  let path = '/';
  try {
    path = new URL(req.url || '/', 'http://localhost').pathname;
  } catch (e) {
    path = '/';
  }

  const asset = ASSETS[path];
  if (asset) {
    try {
      const body = readFileSync(join(HERE, asset.file));
      res.writeHead(200, { 'content-type': asset.type });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('资源读取失败: ' + asset.file);
    }
    return;
  }

  const m = matchRoute(path);
  if (!m) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(shell('<div class="ese-panel"><div class="ese-text">页面不存在</div></div>'));
    return;
  }

  try {
    const html = renderRoute(m.route, m.params);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(shell(html));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end(shell('<div class="ese-panel ese-fallback"><div class="ese-text">渲染失败：' + String(err && err.message ? err.message : err) + '</div></div>'));
  }
});

server.listen(PORT, HOST, function () {
  console.log('[ese] ' + programName + ' 已启动：http://' + HOST + ':' + PORT + '/');
});
`;

export function emitServer(program: IrProgram, spec: SpecBundle): EmitOutput {
  const files = new Map<string, string>();
  files.set('runtime.mjs', generateApp(program, spec, true));
  files.set('style.css', BASE_CSS);
  files.set('server.mjs', SERVER_TEMPLATE);
  void escHtml;
  return { files, pageCount: program.pages.length };
}
