#!/usr/bin/env node
// ese CLI 启动器。
// 运行时不做任何编译：Node >= 22.18 内置 TypeScript 类型擦除，直接加载 src/cli.ts。
// 需要真类型检查时运行 npm run check:types（依赖 TypeScript，非运行时依赖）。
import '../src/cli.ts';
