# tools/ —— ese 命令行工具链

**当前版本：CLI v0.1.0**（规范 v2.9）

已实现两个子命令。它们**不是**解释器——ese 目前仍然不能运行，本目录只做静态处理与元数据校验。

| 子命令 | 状态 | 说明 |
|--------|------|------|
| `ese fmt`（含 `--migrate`） | ✅ 已实现 | 统一缩进；`--migrate` 自动迁移历史破坏性变更 |
| `ese spec verify` | ✅ 已实现 | 校验 `spec/` 三个单一数据源的一致性（CI 用） |
| `ese check` | ⏳ 未实现 | 静态检查（括号配对、属性契约、全部诊断码） |
| `ese doc` / `ese test` / `ese build` / `ese serve` | ⏳ 未实现 | 见规范第十九节 |

## 运行

**无需构建、无需安装依赖。** Node ≥ 22.18 内置 TypeScript 类型擦除，直接加载 `.ts` 源码：

```bash
node tools/src/cli.ts --help
node tools/src/cli.ts spec verify
node tools/src/cli.ts fmt --migrate .            # dry-run，只打印差异
node tools/src/cli.ts fmt --migrate --write .    # 落盘
```

或经启动器（`package.json` 已声明 `bin`，`npm link` 后可全局调用 `ese`）：

```bash
node tools/bin/ese.mjs fmt --check .
```

真类型检查需要 TypeScript（**仅开发依赖**，运行时不依赖）：

```bash
cd tools && npm install --no-save typescript && npm run check:types
```

自测（46 项，零框架依赖）：

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
│   └── commands.ts      fmt / spec 子命令实现
└── test/run.ts          46 项自测：规则、格式化、数据源、命令层端到端
```

## 设计约束

1. **零自然语言硬编码**。所有诊断消息与关键字都从 `spec/` 读取；`src/` 里搜不到任何一句面向用户的报错文本。这条约束由 `ese spec verify` 的 C1/C3 间接保障。
2. **零运行时依赖**。生产代码不引入任何 npm 包，避免把供应链风险带进一个刚起步的项目。
3. **不做猜测式改写**。规则命中但判据不足 → 报错并保留原文。
4. **诊断语言跟随文件模式**。`[ee]` 文件报英文，`[zz]` 文件报中文，不受用户配置影响（规范 §8.3）。

## 下一步

按规范第十九节顺序：`ese check`（读 `grammar.ebnf` 建解析器，消费全部 50 个诊断码）→ `ese doc` → 解释器 v0.1。`ese check` 是 `ese fmt` 默认值改为 `--write` 的前置条件。
