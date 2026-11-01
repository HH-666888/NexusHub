/**
 * 产物检查结果的形状，与检查手段（正则、编译器、测试框架）无关。
 */

export interface CheckResult {
  /** 人可读，直接显示在界面上 */
  name: string;
  pass: boolean;
  /** 通过写依据，不通过写原因 */
  detail: string;
}

export interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  /** 界面只展示这些 */
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
