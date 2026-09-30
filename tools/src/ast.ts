/**
 * ast.ts —— ese 抽象语法树
 *
 * 文法依据：spec/grammar.ebnf（机器可读单一数据源）。
 * 本文件只描述结构，不含任何诊断文本与转译逻辑。
 */

export interface Pos {
  line: number;
  column: number;
}

export type Mode = 'zh' | 'en';

// ---------------------------------------------------------------- 表达式

export type BinOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '=='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | '并且'
  | '或者';

export type Expr =
  | { k: 'num'; value: number; pos: Pos }
  | { k: 'str'; value: string; pos: Pos }
  | { k: 'bool'; value: boolean; pos: Pos }
  | { k: 'ref'; path: string[]; pos: Pos }
  | { k: 'list'; items: Expr[]; pos: Pos }
  | { k: 'dict'; entries: { key: string; value: Expr }[]; pos: Pos }
  | { k: 'bin'; op: BinOp; left: Expr; right: Expr; pos: Pos }
  | { k: 'un'; op: '非' | '-'; operand: Expr; pos: Pos }
  | { k: 'call'; name: string[]; args: Expr[]; pos: Pos }
  | { k: 'event'; field: string; pos: Pos }
  /** 含插值的字符串："共{数量}人"（§7.4：插值仅在文字块与字符串内）。 */
  | { k: 'tpl'; parts: TplPart[]; pos: Pos };

/** 文字块与字符串中的模板片段。 */
export type TplPart = { k: 'text'; value: string } | { k: 'expr'; expr: Expr };

// ---------------------------------------------------------------- 属性

/** 属性。value 为 null 表示开关属性（无值，如 `居中`）。 */
export interface Attr {
  name: string;
  value: Expr | null;
  pos: Pos;
}

// ---------------------------------------------------------------- 界面节点

export type Node =
  | PanelN
  | TextN
  | MediaN
  | InputN
  | ButtonN
  | ActionN
  | DividerN
  | BranchN
  | LoopN
  | CompCallN
  | ChildrenN;

export interface PanelN {
  k: 'panel';
  attrs: Attr[];
  /** 「一切皆嵌套」：容器内可放任意语句，不只是界面节点。 */
  children: Stmt[];
  pos: Pos;
}

export interface TextN {
  k: 'text';
  parts: TplPart[];
  pos: Pos;
}

export interface MediaN {
  k: 'media';
  file: string;
  attrs: Attr[];
  pos: Pos;
}

export interface InputN {
  k: 'input';
  name: string;
  attrs: Attr[];
  pos: Pos;
}

export interface ButtonN {
  k: 'button';
  text: string;
  jump: string | null;
  pos: Pos;
}

export interface Invoke {
  name: string;
  args: Expr[];
  pos: Pos;
}

export interface ActionN {
  k: 'action';
  text: string;
  invoke: Invoke | null;
  pos: Pos;
}

export interface DividerN {
  k: 'divider';
  pos: Pos;
}

export interface BranchN {
  k: 'branch';
  cond: Expr;
  then: Stmt[];
  otherwise: Stmt[] | null;
  pos: Pos;
}

export interface LoopN {
  k: 'loop';
  mode: 'count' | 'iterate';
  count: Expr | null;
  iterable: Expr | null;
  item: string | null;
  key: Expr | null;
  body: Stmt[];
  pos: Pos;
}

export interface CompCallN {
  k: 'comp-call';
  name: string[];
  props: Attr[];
  /** 调用处子内容（插槽实参）。 */
  children: Stmt[];
  pos: Pos;
}

export interface ChildrenN {
  k: 'children';
  pos: Pos;
}

// ---------------------------------------------------------------- 语句

export interface DataS {
  k: 'data';
  name: string;
  value: Expr;
  pos: Pos;
}

export interface CalcS {
  k: 'calc';
  name: string;
  value: Expr;
  derived: boolean;
  pos: Pos;
}

export interface ExecS {
  k: 'exec';
  /** null 表示无名执行块（到达即执行）；'全局' 表示全局执行块。 */
  name: string | null;
  params: string[];
  body: Stmt[];
  pos: Pos;
}

export interface RoutePageS {
  k: 'route-page';
  path: string[];
  body: Stmt[];
  pos: Pos;
}

export interface ImportS {
  k: 'import';
  from: string;
  members: string[];
  namespace: string | null;
  pos: Pos;
}

export interface AssertS {
  k: 'assert';
  title: string;
  cond: Expr;
  pos: Pos;
}

export interface PropDecl {
  name: string;
  type: string | null;
  def: Expr | null;
  required: boolean;
  pos: Pos;
}

/** `属性 名字 类型 = 默认值 必须` —— 形参声明行，仅出现在组件体首部。 */
export interface PropLineS {
  k: 'prop-line';
  props: PropDecl[];
  pos: Pos;
}

export interface ComponentDefS {
  k: 'component-def';
  name: string;
  /** 形参声明行（已按出现顺序展平）。 */
  params: PropDecl[];
  body: Stmt[];
  doc: string | null;
  pos: Pos;
}

export type Stmt =
  | Node
  | DataS
  | CalcS
  | ExecS
  | RoutePageS
  | ImportS
  | AssertS
  | PropLineS
  | ComponentDefS;

export interface FileAst {
  /** 仓库相对路径，仅用于诊断定位。 */
  file: string;
  mode: Mode;
  kind: 'entry' | 'module';
  /** 入口固定为 ese.bd；模块名为文件名去扩展名。 */
  name: string;
  stmts: Stmt[];
}

// ---------------------------------------------------------------- 工具

export function isNode(s: Stmt): s is Node {
  return (s as Node).k !== undefined && NODE_KINDS.has((s as Node).k);
}

const NODE_KINDS = new Set<string>([
  'panel',
  'text',
  'media',
  'input',
  'button',
  'action',
  'divider',
  'branch',
  'loop',
  'comp-call',
  'children',
]);

/** 表达式是否为常量（用于 SSR 期求值与静态折叠）。 */
export function isConstExpr(e: Expr): boolean {
  switch (e.k) {
    case 'num':
    case 'str':
    case 'bool':
      return true;
    case 'list':
      return e.items.every(isConstExpr);
    case 'dict':
      return e.entries.every((x) => isConstExpr(x.value));
    case 'bin':
      return isConstExpr(e.left) && isConstExpr(e.right);
    case 'un':
      return isConstExpr(e.operand);
    default:
      return false;
  }
}
