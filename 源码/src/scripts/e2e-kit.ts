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

/* ════════════════════════════════════════════════════════════
   注册与登录
   ════════════════════════════════════════════════════════════
   这几个函数原本在 e2e-run / e2e-generate / e2e-settings 里
   各抄了一份。要写第四条脚本（画布）时又要抄第四份 ——
   那就说明它不该被复制。

   ── 为什么注册不能直接 POST ──
   注册页是 Next.js 的 Server Action 表单，不是普通接口。
   直接 POST username/password 会得到一个 HTTP 200，
   但**没有任何会话 Cookie** —— 因为服务端在等一个它没收到的东西。
   （画布脚本第一版就是这么写的，19 项检查全红，
   而表面症状是「注册返回 200」，看起来像成功了。）

   正确顺序是：先 GET 页面，把表单里的隐藏字段（含 action id）
   原样带上再 POST。下面这组函数做的就是这个。
   ════════════════════════════════════════════════════════════ */

/**
 * 从 HTML 里抠出目标表单的 **Server Action 隐藏字段**。
 *
 * 只取 name 以 `$` 开头的那些（`$ACTION_REF_1` / `$ACTION_1:0` / …）——
 * 它们是 Next.js 用来定位服务端动作的载荷，必须原样回传。
 * username / password 这类真实字段由调用方自己填。
 *
 * @param contains 用来识别目标表单的片段，例如 'name="confirmPassword"'
 *
 * ── 这里踩过两个坑，都写下来 ──
 *
 * 一、**可选组会被短路。**
 *    第一版写成 `[^>]*?(?:value="([^"]*)")?[^>]*>` ——
 *    因为末尾还有一个 `[^>]*>` 能吃掉剩余部分，
 *    正则引擎完全可以**跳过那个可选的 value 组**照样匹配成功。
 *    结果所有字段的 value 全是空字符串，而正则看起来完全正常。
 *    修法：把 value 组放在紧挨着标签结束的位置，后面不再留 `[^>]*`。
 *
 * 二、**必须解 HTML 实体。**
 *    载荷长这样：value="{&quot;id&quot;:&quot;6005…"
 *    浏览器解析 HTML 时会把它还原成 `{"id":"6005…"}` 再提交，
 *    所以这里也得还原。少了这一步，服务端收到一个残缺的 JSON，
 *    回一句 "Invalid Server Action request."，而状态码是 400 ——
 *    从状态码完全看不出是转义的问题。
 */
export function extractFormFields(html: string, contains: string): Record<string, string> {
  const chunks = html.split(/<form\b/).slice(1);
  for (const chunk of chunks) {
    const end = chunk.indexOf("</form>");
    const body = end >= 0 ? chunk.slice(0, end) : chunk;
    if (!body.includes(contains)) continue;

    const fields: Record<string, string> = {};
    const inputRe = /<input\s+type="hidden"\s+name="(\$[^"]+)"(?:\s+value="([^"]*)")?\s*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = inputRe.exec(body)) !== null) {
      fields[m[1]] = decodeEntities(m[2] ?? "");
    }
    return fields;
  }
  return {};
}

/** 还原 HTML 实体。表单被浏览器解析后提交的是还原过的值 */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 从响应头里取会话 Cookie 的值 */
export function readSessionCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const m = /nexus_session=([^;]+)/.exec(raw);
  return m ? m[1] : null;
}

/**
 * 注册一个账号，返回**完整的 Cookie 串**（`nexus_session=…`），
 * 可以直接塞进 fetch 的 headers.cookie。
 *
 * 失败时把页面上那句中文错误原因抓出来 ——
 * 只报状态码的话排查全靠猜：这里吃过一次亏，
 * 测试用户名超过 20 字符上限，而输出里只有一个「状态 200」。
 */
export async function signUp(base: string, username: string): Promise<string> {
  const page = await fetch(`${base}/register`);
  const html = await page.text();
  const fields = extractFormFields(html, 'name="confirmPassword"');

  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("username", username);
  form.append("password", "abc123");
  form.append("confirmPassword", "abc123");

  const res = await fetch(`${base}/register`, {
    method: "POST",
    body: form,
    redirect: "manual",
  });

  const token = readSessionCookie(res);
  if (!token) {
    const body = await res.text();
    const reason =
      /role="alert"[^>]*>\s*([^<]+?)\s*</.exec(body)?.[1] ?? "(页面上没有找到错误提示)";
    throw new Error(`注册失败（HTTP ${res.status}）：${reason}`);
  }
  return `nexus_session=${token}`;
}