/**
 * 端到端脚本的共用检查器
 * ============================================================
 * 四条 e2e 脚本（认证 / 构建记录 / 设置 / 生成）此前各自定义了一套
 * ok / fail / expect_，而且**四条都犯了同一个错**：
 *
 *   末尾的「全部通过」是无条件打印的，不看有没有失败过。
 *
 * 于是出现了一种最危险的情况：脚本里有 ❌，结束时却报绿。
 * 真实例子：规格化阶段接上之后，成本流水从 1 条变成 2 条，
 * 那条断言打了 ❌，脚本仍然打印「全部通过 · 总耗时 23.9 秒」。
 * 是人工去看输出才发现的。
 *
 * ── 为什么抽成共用模块而不是各修各的 ──
 *   同一个缺陷出现在四个地方，说明它不该被复制四遍。
 *   集中之后，计数、汇总、退出码只有一份实现，
 *   以后加第五条脚本时不会又把老毛病抄一遍。
 *
 * ── 退出码 ──
 *   有失败时以 1 退出。这一点很关键：
 *   CI 与 `npm run` 只看退出码，不看你打印了什么。
 *   原来即使有失败也退 0，等于对外宣称成功。
 */

let checks = 0;
let failures = 0;
const failureMessages: string[] = [];

export function ok(msg: string): void {
  checks++;
  console.log(`  ✅ ${msg}`);
}

export function fail(msg: string): void {
  checks++;
  failures++;
  failureMessages.push(msg);
  console.log(`  ❌ ${msg}`);
}

export function info(msg: string): void {
  console.log(`     ${msg}`);
}

export function heading(title: string): void {
  console.log("══════════════════════════════════════════════");
  console.log(` ${title}`);
  console.log("══════════════════════════════════════════════");
}

/** 断言。返回布尔值，调用方需要时可以据此提前返回 */
export function expect_(cond: boolean, passMsg: string, failMsg: string): boolean {
  if (cond) ok(passMsg);
  else fail(failMsg);
  return cond;
}

/** 已经失败了多少条。用于「出错了就别往下走」这类判断 */
export function failureCount(): number {
  return failures;
}

/**
 * 收尾：打印汇总，并在有失败时以非零退出码结束。
 *
 * 成功时打印「全部通过 · 共 N 项检查」——
 * 把检查条数也说出来，读者才知道这个「通过」覆盖了多少东西。
 */
export function finish(startedAt: number): never {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (failures === 0) {
    heading(`全部通过 · ${checks} 项检查 · 总耗时 ${seconds} 秒`);
    process.exit(0);
  }

  heading(`有 ${failures} 项失败（共 ${checks} 项检查）· 总耗时 ${seconds} 秒`);
  for (const m of failureMessages) {
    console.log(`  ❌ ${m}`);
  }
  console.log("");
  console.log("  失败项已在上方逐条列出。脚本以退出码 1 结束 ——");
  console.log("  只看「有没有报错」的自动化流程也能发现这次没过。");
  process.exit(1);
}