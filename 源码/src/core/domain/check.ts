/**
 * 产物检查结果
 * ============================================================
 * 放在领域层：它是「产物是否合格」这件事的描述，
 * 与用什么方式检查（正则、编译器、测试框架）无关。
 */

export interface CheckResult {
  /** 检查项名称，人可读，会直接显示在界面上 */
  name: string;
  pass: boolean;
  /** 补充说明：通过了说明依据，没通过说明原因 */
  detail: string;
}

export interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  /** 没有通过的项，界面只需要展示这些 */
  failures: CheckResult[];
}

export function summarizeChecks(results: CheckResult[]): CheckSummary {
  const passed = results.filter((r) => r.pass).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    failures: results.filter((r) => !r.pass),
  };
}