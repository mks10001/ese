# tools/ —— ese 命令行工具链

**当前版本：CLI v0.2.0**（规范 v2.10）

已实现三个子命令。`ese build` 是三目标转译器——ese **可以运行了**，设计细节见[《ese转译器设计》](../docs/ese转译器设计.md)。

| 子命令 | 状态 | 说明 |
|--------|------|------|
| `ese fmt`（含 `--migrate`） | ✅ 已实现 | 统一缩进；`--migrate` 自动迁移历史破坏性变更 |
| `ese spec verify` | ✅ 已实现 | 校验 `spec/` 三个单一数据源的一致性（CI 用） |
| `ese build` | ✅ 已实现 | 三目标转译：`--target=web`（静态站点）/ `server`（Node SSR）/ `wasm`（逻辑层二进制） |
| `ese check` | ⏳ 未实现 | 独立静态检查命令（解析器已随转译器落地，待拆分） |
| `ese doc` / `ese test` / `ese serve` | ⏳ 未实现 | 见规范第十九节 |

## 运行

**无需构建、无需安装依赖。** Node ≥ 22.18 内置 TypeScript 类型擦除，直接加载 `.ts` 源码：

```bash
node tools/src/cli.ts --help
node tools/src/cli.ts spec verify
node tools/src/cli.ts fmt --migrate .            # dry-run，只打印差异
node tools/src/cli.ts fmt --migrate --write .    # 落盘
node tools/src/cli.ts build --target=all examples/计数站 --out=dist
node dist/server/server.mjs                      # 启动 SSR 服务（PORT 可覆盖）
```

或经启动器（`package.json` 已声明 `bin`，`npm link` 后可全局调用 `ese`）：

```bash
node tools/bin/ese.mjs fmt --check .
```

真类型检查需要 TypeScript（**仅开发依赖**，运行时不依赖）：

```bash
cd tools && npm install --no-save typescript && npm run check:types
```

自测（149 项，零框架依赖）：

```bash
node tools/test/run.ts
```

## `ese fmt`

统一缩进为每层两个半角空格。缩进不参与语义（规范 §4.5），因此这是纯风格改写。输出**幂等**：对同一份文件重复运行不再产生差异。

| 选项 | 作用 |
|------|------|
| `--migrate` | 应用历史破坏性变更的自动迁移（默认关闭） |
| `--write`, `-w` | 改写文件 |
| `--check` | 只判断是否需要改写，需要则以退出码 1 结束 |
| `--rules` | 列出全部迁移规则 |
| `--json` | 以 JSON 输出结果 |

### 默认 dry-run 是刻意的

`ese fmt` **默认不落盘**。原因很直接：在 `ese check` 可用之前，改写没有二次校验，静默破坏用户代码的风险高于多敲一个 `--write`。`ese check` 发布后会把默认值改为 `--write`。

### 迁移规则（`--migrate`）

| 规则 | 改写 | 关联诊断码 |
|------|------|-----------|
| `button-single-parens` | `[( 文字 )]` → `[c. 文字 .c]`（v2.5 写法） | `ESE1008` |
| `button-double-parens` | `[(( 文字 ))]` → `[c. 文字 .c]`（v2.6 写法） | `ESE1008` |
| `button-tight` | `[c.文字.c]` → `[c. 文字 .c]`（v2.7 漏空格） | `ESE1008` |
| `route-page-keyword` | `[/ home` → `[/ 页面 home`，并剥离路径前导 `/` | `ESE1015` |
| `jump-leading-slash` | `跳转 /about` → `跳转 about` | `ESE1015` |
| `redundant-inline-sep` | 删除行尾多余的 `[!!]`（v2.1 起换行即结束） | — |

### 位置裁决：迁移只改写「确定是按钮」的地方

规范 §7.5 的按钮定界符靠位置区分：语句位置是按钮，值位置是列表。迁移器实现了同一条判据——
**只有当前一个有效字符是 `]` 或行首时才改写**。因此：

```
  [( 去首页 )]                  →  [c. 去首页 .c]      语句位置，改写
  [# 名单 = [(1 + 2), 4] #]     →  不变                值位置，是列表
  [# 路径 = [c.a.c] #]          →  不变                值位置，是列表
  [! 旧写法 [( x )] 不是按钮 !]  →  不变                注释内不触碰
  [- 看到 [( x )] 就写按钮 -]    →  不变                文字块内不触碰
```

**无法判定位置时一律拒绝改写**，并以 `ESE4004` 报错要求人工确认（例如 `[[( x )]]`）。猜测导致的静默改义比拒绝改写危险得多。

## `ese spec verify`

校验四件事，供 CI 使用：

- **C1** `grammar.ebnf` 中出现的关键字，全部存在于 `keywords.json`
- **C2** `keywords.json` 中英两形数量相等；整条词组无重复（多词关键字共享词元是正常的，故按词组判重而非按词元）
- **C3** `diagnostics.json` 每条的「中英模板占位符集合一致、占位符已登记、编码符合 `ESExxxx`」
- **C4** `grammar.ebnf` 的 `@symbols` 区块列出的正式符号对恒为 17

## `ese build`

三目标转译器。输入是一个 ese 项目目录（入口 `ese.bd`，清单 `ese.json` 可选）：

```bash
ese build examples/计数站 --target=web     # 只出前端（默认目标）
ese build examples/counter --target=all    # web + server + wasm
```

| 目标 | 产物 | 形态 |
|------|------|------|
| `web` | `index.html` + 每路由 HTML + `404.html` + `app.js` + `style.css` | 预渲染 + 水合；`file://` 双击可开（`app.js` 刻意非模块） |
| `server` | `server.mjs` + `runtime.mjs` + `style.css` | `node:http` SSR，每请求重置全局状态，零依赖，`node server.mjs` 即启动 |
| `wasm` | `logic.wasm` + `logic.manifest.json` + `logic.mjs` | 逻辑层二进制：f64 算术/分支/计数循环/形参/全局；界面、字符串、列表、路由不支持（使用即 ESE4007） |

关键裁决（详见设计文档）：入口页 = 声明的第一个页面（`entryRoute`，三目标共用）；
全局状态每请求独立初始化（§13.3）；事件用 `data-*` 委托（重渲染不丢绑定）；
wasm 采用**手写二进制编码器**（零依赖），不引入 wat2wasm / Emscripten。

## 源码结构

```
tools/
├── bin/ese.mjs          启动器（转发到 src/cli.ts）
├── src/
│   ├── cli.ts           参数分发、帮助、版本
│   ├── spec.ts          单一数据源装载 + 四项一致性校验
│   ├── diagnostics.ts   诊断对象构造与规范 §8.3 格式渲染
│   ├── scan.ts          行级扫描：代码 / 注释 / 文字块 / 字符串分区；位置裁决
│   ├── rules.ts         六条迁移规则 + 缩进格式化
│   ├── commands.ts      fmt / spec 子命令实现
│   ├── ast.ts lex.ts parse.ts   转译前端：token → AST（关键字取自 spec/）
│   ├── ir.ts            降级：组件/页面 → 状态+处理器+视图；契约校验
│   ├── emit-js.ts       共用 JS 运行时（内置函数、三级状态、事件委托、路由）
│   ├── emit-web.ts      目标 ①：静态站点
│   ├── emit-server.ts   目标 ②：Node SSR 服务
│   ├── emit-wasm.ts     目标 ③：手写 WebAssembly 二进制编码器
│   └── build.ts         build 子命令：收集 → 解析 → 降级 → 发射
└── test/
    ├── run.ts           五层自测入口
    └── build.ts         转译器端到端：两个示例 × 三目标（含真实起服与 wasm 实例化）
```

## 设计约束

1. **零自然语言硬编码**。所有诊断消息与关键字都从 `spec/` 读取；`src/` 里搜不到任何一句面向用户的报错文本。这条约束由 `ese spec verify` 的 C1/C3 间接保障。
2. **零运行时依赖**。生产代码不引入任何 npm 包，避免把供应链风险带进一个刚起步的项目。二进制目标也因此选择了手写 wasm 编码器而非外部工具链。
3. **不做猜测式改写**。规则命中但判据不足 → 报错并保留原文。
4. **诊断语言跟随文件模式**。`[ee]` 文件报英文，`[zz]` 文件报中文，不受用户配置影响（规范 §8.3）。
5. **坏产物不落盘**。发射器对生成产物做结构断言（必须含路由表与匹配函数），断言失败在构建期报错——历史上 RUNTIME 模板被反引号截断产出的残片产物，就是靠这道防线堵住的。

## 下一步

转译器已落地，剩下的是收口：`ese check` 独立命令（解析器已在 `parse.ts`，主要工作是诊断码消费矩阵）→ `ese serve` 独立命令 → VSCode 插件。`ese check` 仍是 `ese fmt` 默认值改为 `--write` 的前置条件。
