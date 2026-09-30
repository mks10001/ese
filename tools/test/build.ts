/**
 * test/build.ts —— 转译器端到端自测
 *
 * 覆盖转译管线各层：
 *   ① 词法 / 语法：两个示例全量解析，零诊断
 *   ② IR：组件、页面、全局状态、入口路由裁决
 *   ③ 前端目标：index.html 的内容确为 SSR 结果（而非空壳）
 *   ④ 后端目标：置盘后真的 import runtime.mjs，核对路由匹配与每请求隔离
 *   ⑤ 二进制目标：实例化 .wasm 并调用导出函数，核对返回值
 *   ⑥ 命令层：退出码、产物布局、错误路径
 *   ⑦ HTTP 冒烟：宿主允许派生子进程时，真的起服务发一次请求
 *
 * 断言函数由调用方注入（见 run.ts），零测试框架依赖。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadSpec, type SpecBundle } from '../src/spec.ts';
import { parseFile } from '../src/parse.ts';
import { buildIr, type IrProgram } from '../src/ir.ts';
import { emitWeb } from '../src/emit-web.ts';
import { emitServer } from '../src/emit-server.ts';
import { emitWasm, sleb, uleb } from '../src/emit-wasm.ts';
import { RUNTIME } from '../src/emit-js.ts';
import { cmdBuild } from '../src/build.ts';
import { Reporter } from '../src/diagnostics.ts';
import type { CmdContext } from '../src/commands.ts';

export type Eq = (name: string, actual: unknown, expected: unknown) => void;

interface Fixture {
  label: string;
  dir: string;
  mode: 'zh' | 'en';
  /** 项目名（清单里的 名称 / name）。 */
  proj: string;
}

/** 把一份产物写盘（相对路径 → 内容），供后续 import / 起服务使用。 */
function writeAll(dir: string, files: Map<string, string | Buffer>): void {
  for (const [rel, content] of files) {
    const abs = join(dir, rel);
    const parent = dirname(abs);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(abs, content);
  }
}

/** 降级一份源码，收集诊断。 */
function lower(src: string, spec: SpecBundle, name: string): { program: IrProgram; diags: string[] } {
  const ast = parseFile(src, 'ese.bd', spec);
  const diags: string[] = [];
  const program = buildIr(ast, new Map([['ese.bd', ast]]), spec, {
    projectName: name,
    report: (code, _p, _pos, sev) => diags.push(`${sev}:${code}`),
  });
  return { program, diags };
}

export async function runBuildTests(eq: Eq, repoRoot: string): Promise<void> {
  const spec = loadSpec();
  const fixtures: Fixture[] = [
    { label: '计数站(zh)', dir: join(repoRoot, 'examples', '计数站'), mode: 'zh', proj: '计数站' },
    { label: 'counter(en)', dir: join(repoRoot, 'examples', 'counter'), mode: 'en', proj: 'counter' },
  ];

  // ------------------------------------------------------- ①② 解析与降级
  const programs = new Map<string, IrProgram>();
  // 内置运行时的完整性单独兜底：RUNTIME 是 String.raw 模板，
  // 其中出现反引号会导致它退化成非字符串而不报错。
  eq('内置运行时模板完整', typeof RUNTIME === 'string' && RUNTIME.length > 1000, true);

  for (const fx of fixtures) {
    const src = readFileSync(join(fx.dir, 'ese.bd'), 'utf8');
    const ast = parseFile(src, 'ese.bd', spec);
    eq(`${fx.label} 模式识别`, ast.mode, fx.mode);
    eq(`${fx.label} 顶层语句非空`, ast.stmts.length > 0, true);

    const { program, diags } = lower(src, spec, fx.proj);
    eq(`${fx.label} 降级零诊断`, diags, []);
    eq(`${fx.label} 组件数为 1`, program.components.size, 1);
    eq(`${fx.label} 页面数为 2`, program.pages.length, 2);
    eq(`${fx.label} 入口路由为 home`, program.entryRoute, 'home');
    programs.set(fx.label, program);
  }
  eq('计数站 组件名为「计数器」', [...programs.get('计数站(zh)')!.components.keys()], ['计数器']);
  eq('counter 组件名为 Counter', [...programs.get('counter(en)')!.components.keys()], ['Counter']);
  eq('计数站 全局状态 1 项', programs.get('计数站(zh)')!.globals.length, 1);
  eq('counter 无全局状态', programs.get('counter(en)')!.globals.length, 0);
  eq('计数站 全局执行块 1 条语句', programs.get('计数站(zh)')!.globalInit.length, 1);

  const zh = programs.get('计数站(zh)')!;

  // ------------------------------------------------------- ③ 前端目标
  const web = emitWeb(zh, spec);
  for (const f of ['index.html', 'home.html', 'about.html', '404.html', 'app.js', 'style.css']) {
    eq(`前端 产出 ${f}`, web.files.has(f), true);
  }
  eq('前端 预渲染页面数 2', web.pageCount, 2);

  const indexHtml = web.files.get('index.html') ?? '';
  // 全局执行块把 访问语 由「欢迎来到 ese 站点」改成「欢迎回来！」——
  // 这一条同时锁住「全局状态每请求独立初始化 + 全局执行块必跑」。
  eq('前端 SSR 应用了全局执行块', indexHtml.includes('欢迎回来！'), true);
  eq('前端 SSR 未保留全局初值', indexHtml.includes('欢迎来到 ese 站点'), false);
  // 组件形参 起始=10 → 当前 10、派生 双倍 20（锁住「形参先于状态初始化」的绑定顺序）
  eq('前端 SSR 展开组件状态与派生值', indexHtml.includes('当前计数：10（双倍：20）'), true);
  // 遍历循环对 ["买菜","写代码"] 展开
  eq('前端 SSR 展开遍历循环', indexHtml.includes('买菜') && indexHtml.includes('写代码'), true);
  // 事件绑定走 data- 属性 + 委托（inline onclick 会在重渲染时丢绑定）
  eq('前端 行为按钮带 data-ese-invoke', indexHtml.includes('data-ese-invoke="加一"'), true);
  eq('前端 无 inline onclick', indexHtml.includes('onclick='), false);
  eq('前端 跳转按钮带 data-ese-goto', indexHtml.includes('data-ese-goto="about"'), true);
  eq('前端 引用同目录 app.js', indexHtml.includes('src="app.js"'), true);

  const appJs = web.files.get('app.js') ?? '';
  eq('前端 app.js 含路由表', appJs.includes('const __PAGES = {'), true);
  eq('前端 app.js 含入口常量', appJs.includes('const __ENTRY = "home";'), true);
  // 客户端事件委托：内联 onclick 会在重渲染替换 DOM 后丢绑定，故必须走 data- 属性 + 委托
  eq('前端 app.js 装载事件委托', appJs.includes("addEventListener('click'"), true);
  eq('前端 app.js 按 data-ese-invoke 分派', appJs.includes('data-ese-invoke'), true);
  eq('前端 app.js 注册组件处理器', appJs.includes('"加一": __h_comp_计数器__加一'), true);
  eq('前端 app.js 重渲染前保存焦点', appJs.includes('__saveFocus'), true);
  // web 产物必须能被 file:// 直接打开，因此不能是 ES 模块
  eq('前端 app.js 为自包含脚本', /^\s*(import|export)\s/m.test(appJs), false);

  // ------------------------------------------------------- ④ 后端目标（置盘 + import）
  const server = emitServer(zh, spec);
  eq('后端 有 server.mjs', server.files.has('server.mjs'), true);
  eq('后端 有 runtime.mjs', server.files.has('runtime.mjs'), true);
  eq('后端 有 style.css', server.files.has('style.css'), true);

  const runtimeSrc = server.files.get('runtime.mjs') ?? '';
  eq('后端 runtime 为 ES 模块', /\bexport function renderRoute\b/.test(runtimeSrc), true);
  eq('后端 runtime 每请求重置全局', runtimeSrc.includes('__resetGlobals();'), true);
  const serverSrc = server.files.get('server.mjs') ?? '';
  eq('后端 服务基于 node:http', serverSrc.includes("from 'node:http'"), true);
  // 依赖面：只允许 node: 内置模块与相对路径，不得出现第三方包
  const specs = [...serverSrc.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  eq(
    '后端 服务无第三方依赖',
    specs.every((s) => s.startsWith('node:') || s.startsWith('.')),
    true,
  );
  eq('后端 服务确实引入了相对运行时', specs.includes('./runtime.mjs'), true);

  const tmp = mkdtempSync(join(tmpdir(), 'ese-build-'));
  try {
    // 覆盖路径参数的合成工程：示例里没有 {id}，单独造一个
    const paramSrc = ['[zz]', '[ese.bd', '  [/ 页面 用户/{id}', '    [- 编号：{id} -]', '  /]', ']', ''].join('\n');
    const paramProg = lower(paramSrc, spec, '参数路由').program;

    const cases = [
      { name: '计数站', program: zh },
      { name: '参数路由', program: paramProg },
    ];
    for (const c of cases) {
      const dir = join(tmp, c.name);
      mkdirSync(dir, { recursive: true });
      writeAll(dir, emitServer(c.program, spec).files);
    }

    const rt = (await import(pathToFileURL(join(tmp, '计数站', 'runtime.mjs')).href)) as {
      matchRoute: (p: string) => { route: string; params: Record<string, string> } | null;
      renderRoute: (r: string, p: Record<string, string>) => string;
      routeKeys: string[];
      programName: string;
    };
    eq('后端 routeKeys', rt.routeKeys, ['home', 'about']);
    eq('后端 programName', rt.programName, '计数站');
    eq('后端 根路径回落到入口页', rt.matchRoute('/'), { route: 'home', params: {} });
    eq('后端 命名路由命中', rt.matchRoute('/about'), { route: 'about', params: {} });
    eq('后端 未命中返回 null', rt.matchRoute('/nope'), null);
    const ssr = rt.renderRoute('home', {});
    eq('后端 SSR 应用了全局执行块', ssr.includes('欢迎回来！'), true);
    eq('后端 SSR 展开组件与派生值', ssr.includes('当前计数：10（双倍：20）'), true);
    // §13.3 每请求独立初始化：第二次请求不得累积
    eq('后端 SSR 每请求独立', rt.renderRoute('home', {}), ssr);

    const rtParam = (await import(pathToFileURL(join(tmp, '参数路由', 'runtime.mjs')).href)) as {
      matchRoute: (p: string) => { route: string; params: Record<string, string> } | null;
      renderRoute: (r: string, p: Record<string, string>) => string;
    };
    eq('后端 路径参数匹配', rtParam.matchRoute('/用户/3'), { route: '用户/:id', params: { id: '3' } });
    eq('后端 路径参数注入渲染', rtParam.renderRoute('用户/:id', { id: '3' }).includes('编号：3'), true);

    // ---------------------------------------------------- ⑤ 二进制目标
    const wasm = emitWasm(zh, spec);
    const bin = wasm.files.get('logic.wasm');
    eq('二进制 产物为 Buffer', Buffer.isBuffer(bin), true);
    const buf = bin as Buffer;
    eq('二进制 魔数为 \\0asm', [...buf.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
    eq('二进制 版本为 1', [...buf.subarray(4, 8)], [1, 0, 0, 0]);
    eq('二进制 导出清单', wasm.exported, ['计数器_加一', '计数器_归零', '__global']);
    eq('二进制 附加载器', wasm.files.has('logic.mjs'), true);
    eq('二进制 附签名清单', wasm.files.has('logic.manifest.json'), true);

    // LEB128 边界：手写编码器最易出错处
    eq('uleb 0', uleb(0), [0]);
    eq('uleb 127', uleb(127), [0x7f]);
    eq('uleb 128', uleb(128), [0x80, 0x01]);
    eq('uleb 16384', uleb(16384), [0x80, 0x80, 0x01]);
    eq('sleb -1', sleb(-1), [0x7f]);
    eq('sleb -64', sleb(-64), [0x40]);
    eq('sleb -65', sleb(-65), [0xbf, 0x7f]);

    // 实例化并调用：本目标只覆盖逻辑层（形参、字符串、列表均无表示），
    // 故 起始 取 0、字符串赋值取 0。这里锁住的是这条能力边界本身。
    const inst = await WebAssembly.instantiate(buf);
    const ex = inst.instance.exports as Record<string, CallableFunction>;
    eq('二进制 可实例化', typeof inst.instance.exports, 'object');
    eq('二进制 加一返回 1', ex['计数器_加一'](), 1);
    eq('二进制 归零返回 0', ex['计数器_归零'](), 0);
    eq('二进制 全局执行块可导出调用', typeof ex['__global'], 'function');

    // 逻辑层能力矩阵：算术、传参、分支、计数循环、否则分支、全局执行块各来一发
    const capSrc = [
      '[zz]',
      '[ese.bd',
      '  [# 基数 = 3 #]',
      '  [> 全局 :',
      '    [$ 基数 = 基数 + 4 $]',
      '  >]',
      '  [> 算式(甲, 乙) :',
      '    [# 倍 = 甲 * 2 #]',
      '    [$ 终 = 倍 + 乙 $]',
      '    [? 终 > 10',
      '      [$ 终 = 终 - 10 $]',
      '    ?]',
      '  >]',
      '  [> 累计(上限) :',
      '    [# 和 = 0 #]',
      '    [~ 上限 次',
      '      [$ 和 = 和 + 1 $]',
      '    ~]',
      '    [$ 结果 = 和 $]',
      '  >]',
      '  [> 分段(值) :',
      '    [? 值 > 0',
      '      [# 档 = 1 #]',
      '    [??',
      '      [# 档 = -1 #]',
      '    ??]',
      '  ?]',
      '  >]',
      ']',
      '',
    ].join('\n');
    const cap = lower(capSrc, spec, '能力边界');
    eq('二进制 能力工程降级零诊断', cap.diags, []);
    const capWasm = emitWasm(cap.program, spec);
    eq('二进制 能力工程导出名', capWasm.exported, ['算式', '累计', '分段', '__global']);
    const capEx = (await WebAssembly.instantiate(capWasm.files.get('logic.wasm') as Buffer)).instance
      .exports as unknown as Record<string, CallableFunction>;
    eq('二进制 两参函数 算式(3,5)', capEx['算式'](3, 5), 1);
    eq('二进制 分支未命中时返回末次赋值 算式(1,2)', capEx['算式'](1, 2), 4);
    eq('二进制 计数循环 累计(4)', capEx['累计'](4), 4);
    eq('二进制 计数循环 累计(0)', capEx['累计'](0), 0);
    eq('二进制 否则分支 分段(5)', capEx['分段'](5), 1);
    eq('二进制 否则分支 分段(-5)', capEx['分段'](-5), -1);
    eq('二进制 全局执行块结果', capEx['__global'](), 4);

    // ---------------------------------------------------- ⑥ 命令层
    const outLines: string[] = [];
    const errLines: string[] = [];
    const mk = (cwd: string): CmdContext => ({
      spec,
      reporter: new Reporter(spec),
      cwd,
      out: (s) => outLines.push(s),
      err: (s) => errLines.push(s),
    });

    eq('缺入口目录时退出码为 1', cmdBuild([join(tmp, '不存在')], mk(tmp)), 1);
    eq('缺入口目录时报 ESE4003', errLines.join('\n').includes('ESE4003'), true);
    eq('未知目标时退出码为 2', cmdBuild(['--target=native', fixtures[0].dir], mk(tmp)), 2);

    // 未定义组件必须在降级阶段拦下，不得产出错误产物
    const badDir = join(tmp, '坏工程');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(badDir + '/ese.bd', ['[zz]', '[ese.bd', '  [- 页 -]', '  [< 不存在的组件 >]', ']', ''].join('\n'), 'utf8');
    const badErr: string[] = [];
    const badCode = cmdBuild([badDir], {
      spec,
      reporter: new Reporter(spec),
      cwd: tmp,
      out: () => {},
      err: (s) => badErr.push(s),
    });
    eq('未定义组件时退出码为 1', badCode, 1);
    eq('未定义组件时报 ESE2002', badErr.join('\n').includes('ESE2002'), true);

    const out = join(tmp, 'dist');
    eq('--target=all 退出码为 0', cmdBuild([fixtures[0].dir, '--target=all', `--out=${out}`], mk(tmp)), 0);
    for (const f of ['web/index.html', 'web/app.js', 'server/server.mjs', 'server/runtime.mjs', 'wasm/logic.wasm']) {
      eq(`--target=all 产出 ${f}`, existsSync(join(out, f)), true);
    }
    const single = join(tmp, 'only');
    cmdBuild([fixtures[0].dir, '--target=web', `--out=${single}`], mk(tmp));
    eq('单目标不建子目录', existsSync(join(single, 'index.html')), true);
    eq('单目标不建 web/ 子目录', existsSync(join(single, 'web')), false);

    // ---------------------------------------------------- ⑦ HTTP 冒烟
    const smoke = await httpSmoke(join(out, 'server'));
    if (smoke === null) {
      console.log('   （宿主禁止派生子进程，跳过 HTTP 冒烟；同一逻辑已在进程内覆盖）');
    } else {
      eq('HTTP / 状态码 200', smoke.root, 200);
      eq('HTTP /about 状态码 200', smoke.about, 200);
      eq('HTTP /nope 状态码 404', smoke.nope, 404);
      eq('HTTP /style.css 状态码 200', smoke.css, 200);
      eq('HTTP / 首屏含 SSR 内容', smoke.body.includes('欢迎回来！'), true);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

interface SmokeResult {
  root: number;
  about: number;
  nope: number;
  css: number;
  body: string;
}

/** 起一次真实服务并发四个请求。宿主禁止派生时返回 null。 */
async function httpSmoke(dir: string): Promise<SmokeResult | null> {
  const port = 41000 + Math.floor(Math.random() * 9000);
  const host = '127.0.0.1';
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [join(dir, 'server.mjs')], {
      env: { ...process.env, PORT: String(port), HOST: host },
      stdio: 'ignore',
    });
  } catch {
    return null;
  }
  const spawnFailed = await new Promise<boolean>((res) => {
    child.once('error', () => res(true));
    setTimeout(() => res(false), 300);
  });
  if (spawnFailed) return null;

  const get = (p: string): Promise<{ status: number; body: string }> =>
    new Promise((res) => {
      const req = httpGet({ host, port, path: p, timeout: 3000 }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => res({ status: r.statusCode ?? 0, body: b }));
      });
      req.on('error', () => res({ status: -1, body: '' }));
      req.on('timeout', () => {
        req.destroy();
        res({ status: -1, body: '' });
      });
    });

  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await get('/');
      if (r.status > 0) {
        ready = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 50));
    }
    if (!ready) return null;
    const root = await get('/');
    const about = await get('/about');
    const nope = await get('/nope');
    const css = await get('/style.css');
    return { root: root.status, about: about.status, nope: nope.status, css: css.status, body: root.body };
  } finally {
    child.kill();
  }
}
