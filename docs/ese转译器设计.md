# ese 转译器设计（CLI v0.2.0）

> 本文记录 `ese build` 三目标转译器的**实现期设计决策**：管线结构、IR 定义、
> 三个转译目标各自的产物形态与策略、二进制路线的取舍，以及已声明的能力边界。
> 规范层面的语义以《ese语言规范-完整版.md》（v2.10）为准；本文只回答「怎么编译」。

---

## 1. 总览

```
                     ┌─────────────────────────────────────────────┐
 .bd 源文件（多模块） │ ese.bd（入口） + 被 引入 的模块               │
                     └──────────────┬──────────────────────────────┘
                                    │ collectBd + 模式一致性检查（ESE4001）
                                    ▼
             ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
             │  lex.ts      │──▶│  parse.ts    │──▶│  ir.ts       │
             │  词法         │   │  递归下降解析  │   │  降级 + 契约  │
             │  整体 token   │   │  FileAst     │   │  IrProgram   │
             └──────────────┘   └──────────────┘   └──────┬───────┘
                                                          │  唯一共用层
                                    ┌─────────────────────┼─────────────────────┐
                                    ▼                     ▼                     ▼
                            ┌──────────────┐     ┌──────────────┐      ┌──────────────┐
                            │  emit-web    │     │  emit-server │      │  emit-wasm   │
                            │  静态站点     │     │  Node SSR     │      │  .wasm 二进制 │
                            └──────────────┘     └──────────────┘      └──────────────┘
```

三个后端**只共用 IR 一层**。任何语义修正只需落在 lex/parse/ir 三处；三个目标的
差异（预渲染 vs 每请求渲染 vs 纯逻辑）全部隔离在各自的 emitter 里。

### 1.1 管线各层的职责边界

| 层 | 输入 | 输出 | 职责 | 明确不做 |
|----|------|------|------|----------|
| `lex.ts` | 源码文本 + 模式 | token 流 | 文字块 `[- -]`、注释 `[! !]`、按钮 `[c. .c]` 在词法层**整体成 token**；标识符允许内嵌点号；每个 token 记录 `[start, end)` 源码区间 | 不判定语法合法性 |
| `parse.ts` | token 流 + spec | `FileAst` | 递归下降；关键字全部取自 `spec/keywords.json`（不硬编码）；中英双模式 | 不做语义检查 |
| `ir.ts` | `FileAst` 集合 | `IrProgram` | 切组件/页面为「状态 + 处理器 + 视图」；合并被引入模块的组件（带命名空间）；契约校验（ESE2002/2003/2004） | 不生成任何目标代码 |
| `emit-*` | `IrProgram` | 产物文件 | 目标专属策略 | 不重做语法判断 |

**单一数据源纪律在编译器内部同样生效**：`src/` 内不允许出现任何面向用户的
自然语言报错文本，关键字与诊断消息一律经 `spec.ts` 的 `loadSpec()` 装载。

---

## 2. IR 定义（`ir.ts`）

```ts
interface IrProgram {
  mode: Mode;                    // 'zh' | 'ee'，整个程序单模式（ESE2017 拦跨模式引入）
  name: string;                  // 项目名：ese.json 的 名称，缺省取目录名
  entryRoute: string;            // 入口页路由（见 §2.1）
  globals: StateDecl[];          // 全局状态（ese.bd 顶层 [# #]）
  globalInit: Stmt[];            // 全局执行块 [> 全局 : … >] 体内语句
  components: Map<string, ComponentIr>;
  pages: PageIr[];               // [/ 页面 /路由] 降级结果
  imports: ImportS[];
  asserts: AssertS[];
}
```

组件与页面统一降级为同一形状：`{ 状态, 处理器(命名执行块), 视图 }`。
「页面就是没有形参的组件」是降级层的基本假设，三个目标都按此渲染。

### 2.1 入口裁决（entryRoute）

规范未定义「根路由 `/` 归谁」。实现期裁决：**声明的第一个页面即入口页**，
`entryRoute` 记录在 IR 上，三个目标共用同一结论：

- **web**：额外出一份 `index.html`（内容 = 入口页预渲染），本地双击即可打开；
- **server**：`GET /` 回落入口页（`__match` 空路径命中 `__ENTRY`）；
- **wasm**：不涉及路由，无此概念。

这条裁决是**实现层的**，不是语言语义——若未来规范定义根路由归属，
只需改 `ir.ts` 一处与 `emit-web/server` 的回落逻辑。

### 2.2 全局状态的初始化时机（§13.3 落地）

规范要求「全局状态每请求独立初始化」。实现：

- 生成的运行时里 `__G` 不再是模块级字面量对象，而是**初值模板 + 克隆函数**；
- web（浏览器）：首次挂载时克隆并执行 `globalInit`（「欢迎回来！」只出现一次）；
- server（Node）：`renderRoute` 每次调用先重置全局状态，再执行 `globalInit`，
  因此并发请求之间互不污染；
- wasm：全局初值编译进每个函数的局部变量初值，`__global` 执行块单独导出。

---

## 3. 前端目标（emit-web → 静态站点）

产物：

```
dist/web/
├── index.html        入口页预渲染（file:// 双击可开）
├── home.html …       每个无参路由一份预渲染 HTML
├── 404.html          兜底页
├── app.js            自包含运行时（非 ES 模块，见 §3.1）
└── style.css         12 项样式白名单的映射
```

策略要点：

1. **预渲染 + 水合**。每个页面在构建期先跑一遍 `renderRoute` 得到静态 HTML
   写入文件；`app.js` 加载后 `mountClient` 接管事件。构建失败的内容不会静默
   变成空白页。
2. **file:// 优先**。`prefixFor()` 计算页面间的相对前缀，全部引用走相对路径；
   `app.js` 故意**不是** ES 模块——ES 模块在 `file://` 下被 CORS 拦截。
   SSR 场景（server 目标）才使用模块版运行时 `runtime.mjs`。
3. **事件用 `data-*` + 委托**。生成代码不写 inline `onclick`——重渲染会整体
   替换 DOM，inline 处理器随之失效；委托绑定挂在容器上，重渲染天然存活。
   现用属性：`data-ese-goto`（跳转）/ `data-ese-invoke`（调用处理器）/
   `data-ese-scope`（作用域实例键）/ `data-ese-bind`（双向绑定）/
   `data-ese-args`（事件传参）。
4. **焦点与光标保持**。重渲染前后记录 `activeElement` 与选区，恢复后再写回，
   输入框连续打字不闪烁（§12「输入框不打断输入」的实现前提）。

---

## 4. 后端目标（emit-server → Node HTTP 服务）

产物：

```
dist/server/
├── server.mjs        node:http 服务（SSR 直出 + 水合脚本）
├── runtime.mjs       ES 模块版运行时（导出 renderRoute / mountClient / matchRoute / routeKeys）
└── style.css
```

策略要点：

1. **零依赖**。只 `import` 自 `node:http` / `node:url`；`ese spec verify` 与
   自测都会断言产物中不出现 `node:` 前缀之外的 import。
2. **每请求重置全局**。SSR 之前重置 `__G` 并执行全局执行块（§2.2），
   这是「全局状态每请求独立」在服务端的表现。
3. **同构水合**。响应体尾部附 `<script type="module">import { mountClient }
   from './runtime.mjs' …</script>`，浏览器端接管后续交互；静态产物
   （`app.js`）与模块产物（`runtime.mjs`）由同一 `generateApp(program, spec,
   asModule)` 生成，只差一个导出尾巴，保证两端行为一致。
4. **运行时求值不走 `import()`**。构建期若需要拿到 `renderRoute`（web 目标
   预渲染即如此），使用 `new Function` 同步求值产物脚本——`import()` 在
   `file://` 下会被 CORS 拒绝，而 `new Function` 不受影响。

启动：`PORT=8080 HOST=127.0.0.1 node dist/server/server.mjs`。

---

## 5. 二进制目标（emit-wasm → 逻辑层 .wasm）

产物：

```
dist/wasm/
├── logic.wasm            手写编码的 WebAssembly 二进制
├── logic.manifest.json   导出清单（函数名、形参数、来源）
└── logic.mjs             加载器（instantiate + 导出包装）
```

### 5.1 两条路线的取舍

| | A. 手写二进制编码器（**已采用**） | B. 依赖外部工具链（wat2wasm / Emscripten） |
|---|---|---|
| 依赖 | 零。`uleb` / `sleb` / 段编码约 200 行 | npm 包或系统二进制，破坏「零依赖」约束 |
| 可控性 | 每个字节可解释，产物可diff、可复核 | 黑盒 |
| 覆盖面 | f64 逻辑层（够用，见 §5.2） | 理论上全覆盖，但 ese 的字符串/列表语义本就没有 wasm 原生对应物，最终还是要写 JS 胶水 |
| 升级路径 | 逐步扩操作码即可 | 升级即换工具链版本 |

ese 的逻辑层只有 f64 数值、布尔与控制流需要真正下沉到 wasm；字符串、列表、
字典在 wasm 里本来就没有原生类型，任何路线都得在 JS 侧建模。因此路线 A
的覆盖面劣势不存在，而零依赖优势是硬约束（与 `ese fmt` 同一条项目纪律）。

### 5.2 能力边界（已在 manifest 与文档中声明）

**支持**：f64 算术 / 比较 / 逻辑、局部与全局状态、形参传递、`[? ?]` 分支
（含 `??` 否则）、`[~ N 次 ~]` 计数循环（嵌套安全，每层循环独占计数器与上限
两个局部变量）、命名执行块导出、全局执行块导出为 `__global`。

**不支持（使用即 ESE4007）**：界面构造、字符串、列表 / 字典、`[~ 遍历 ~]`、
路由、组件。二进制目标只承接**逻辑层**——这是声明出来的边界，不是缺陷。

### 5.3 编码要点

- 段序：type(1) → func(3) → export(7) → code(10)；全部索引 LEB128 编码；
- 数值统一 f64（`local.get/set/tee` + `f64.*` 操作码），functype 按形参数去重；
- 分支用 `if/else`（带类型），循环用 `block + loop + br_if` 结构；
- 「最后一条语句的值即块值」：`compileStmts(wantValue)` 只在末条语句压值，
  否则补 `f64.const 0`，保证 wasm 的栈一致性验证通过。

---

## 6. 运行时公共层（emit-js.ts）

三个目标里有两个半共用 `generateApp()`：

- web → `asModule=false`（自包含脚本 `app.js`）；
- server → `asModule=true`（`runtime.mjs`，追加 ES 导出）；
- wasm → 不用（逻辑层不走 JS 运行时）。

运行时内置（`RUNTIME` 常量）：

- 内置函数（长度、上限、下限、绝对值、取整…按 `keywords.json` 双语绑定）；
- 三级状态容器 `__G`（全局，克隆式初始化）/ `__P`（页面）/ `__INST`（组件实例）；
- `__match` 路由匹配 + `__ENTRY` 入口回落；
- 事件委托 `__bindEvents` 与重渲染 `__rerender`（焦点保持）。

历史教训已固化为防护：**`RUNTIME` 模板字符串里禁止出现未转义反引号**——
曾因注释里写了 `` `/` `` 把模板提前截断，产出的 app.js 静默变成残片。
`generateApp()` 末尾对产物做结构断言（必须含 `__PAGES` / `__match`），
坏产物在构建期即报错，不会落盘。

---

## 7. 文法同步与勘误（E-2）

实现解析器的过程中暴露了一处三方不一致：`[?? ??]` 否则分支的闭合符。

- 符号总表与规范示例：`[?? … ??]`；
- `spec/grammar.ebnf`（v2.9 稿）：写成了单独的 `"?]"`；
- 按「容器闭合符 = 开头符号 + `]`」的既有裁决（§4、勘误 E-2），
  **规范形 `??]` 正确，文法漏了一个 `?`**。

处理：解析器按规范形实现（并宽松接受旧形以兼容存量文件），
`spec/grammar.ebnf` 与规范 §18 已双向同步。这是「规范文档给人读、spec/ 给
工具读，不一致时以 spec/ 为准并开 Issue 修文档」纪律的一次反向应用：
这次是 spec/ 错了，修 spec/。

---

## 8. 验证

`tools/test/build.ts`（挂在 `tools/test/run.ts` 第 ⑤ 层）对两个示例
（`计数站` zh / `counter` en）各做一轮全目标验证，共 149 项自测：

1. **解析与降级**：AST 形状、`entryRoute`、契约校验诊断；
2. **前端目标**：产物齐全性、`index.html` 预渲染内容含初始计数与派生值、
   `app.js` 为非模块自包含脚本、含事件委托属性、无 `import/export`；
3. **后端目标**：`node:http` 起真实服务，断言 `/`（SSR 含全局执行块效果）、
   `/about`（200）、`/nope`（404）、`/style.css`（200）、无第三方 import；
4. **二进制目标**：字节合法（魔数 + 版本）、`WebAssembly.instantiate` 成功、
   导出函数返回值逐一断言（算术 / 分支 / 计数循环 / 形参 / `__global`）；
5. **命令层**：`cmdBuild` 对目录、清单、模式一致性、目标枚举的完整路径。

测试一律进程内调用（本沙箱禁止派生子进程），服务通过真实 `node:http` 起
停验证。
