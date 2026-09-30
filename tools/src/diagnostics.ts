/**
 * diagnostics.ts —— 诊断对象构造与渲染
 *
 * 消息文本全部来自 spec/diagnostics.json，本模块不包含任何硬编码的自然语言文本。
 */

import type { DiagnosticsFile, DiagnosticTemplate, SpecBundle } from './spec.ts';

export type Severity = 'error' | 'warning' | 'hint';
export type Mode = 'zh' | 'en';

export interface Diagnostic {
  code: string;
  severity: Severity;
  topic: string;
  file: string;
  line: number;
  column: number;
  message: string;
  hint: string | null;
  params: Record<string, string | number>;
}

export interface Position {
  file: string;
  line: number;
  column: number;
}

/**
 * 结构化错误：只携带「诊断码 + 参数 + 位置」，不含任何自然语言文本。
 * 文本一律由 Reporter 从 spec/diagnostics.json 取模板渲染——
 * 这是「报错语言跟随文件模式」得以成立的前提。
 */
export class EseError extends Error {
  readonly code: string;
  readonly params: Record<string, string | number>;
  readonly pos: Position;

  constructor(code: string, params: Record<string, string | number>, pos: Position) {
    super(`${code}@${pos.line}:${pos.column}`);
    this.name = 'EseError';
    this.code = code;
    this.params = params;
    this.pos = pos;
  }
}

function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_all, name: string) => {
    const v = params[name];
    return v === undefined ? `{${name}}` : String(v);
  });
}

export class Reporter {
  private byCode: Map<string, DiagnosticTemplate> = new Map();
  private file: DiagnosticsFile;

  constructor(spec: SpecBundle) {
    this.file = spec.diagnostics;
    for (const d of this.file.diagnostics) this.byCode.set(d.code, d);
  }

  codes(): string[] {
    return [...this.byCode.keys()].sort();
  }

  template(code: string): DiagnosticTemplate {
    const t = this.byCode.get(code);
    if (!t) throw new Error(`未定义的诊断码 ${code}（应先在 spec/diagnostics.json 登记）`);
    return t;
  }

  /** 构造一条诊断。消息按 mode 选择中英模板。 */
  make(code: string, params: Record<string, string | number>, at: Position, mode: Mode = 'zh'): Diagnostic {
    const t = this.template(code);
    const template = mode === 'en' ? t.en : t.zh;
    const hintTemplate = mode === 'en' ? (t.hint_en ?? null) : (t.hint_zh ?? null);
    return {
      code,
      severity: t.severity,
      topic: t.topic,
      file: at.file,
      line: at.line,
      column: at.column,
      message: fill(template, params),
      hint: hintTemplate ? fill(hintTemplate, params) : null,
      params,
    };
  }

  label(severity: Severity, mode: Mode): string {
    return this.file.textFormats.severity_labels[severity]?.[mode] ?? severity;
  }

  /** 渲染为规范 §8.3 规定的文本格式。 */
  render(d: Diagnostic, mode: Mode = 'zh'): string {
    const head = fill(this.file.textFormats.message, {
      severity_label: this.label(d.severity, mode),
      code: d.code,
      file: d.file,
      line: d.line,
      column: d.column,
      message: d.message,
    });
    if (!d.hint) return head;
    return `${head}\n${fill(this.file.textFormats.hint, { hint: d.hint })}`;
  }

  /** 机器可读形式：规范 §8.3 的诊断对象。 */
  toObject(d: Diagnostic): Record<string, unknown> {
    return {
      code: d.code,
      severity: d.severity,
      file: d.file,
      line: d.line,
      column: d.column,
      message: d.message,
      ...(d.hint ? { hint: d.hint } : {}),
    };
  }
}
