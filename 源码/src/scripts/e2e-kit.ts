/**
 * 端到端脚本的共用检查器：ok / fail / expect_ / heading / finish。
 * 有失败时以退出码 1 结束，CI 与 npm run 只看退出码。
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

// 返回布尔值，调用方可据此提前返回
export function expect_(cond: boolean, passMsg: string, failMsg: string): boolean {
  if (cond) ok(passMsg);
  else fail(failMsg);
  return cond;
}

// 收尾：打印汇总；有失败时以退出码 1 结束。
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

// 注册页是 Server Action 表单，直接 POST 拿不到会话 Cookie。
// 需先 GET 页面，把隐藏字段（含 action id）原样回传。

// 只取 name 以 $ 开头的隐藏字段，它们是 Next.js 定位服务端动作的载荷。
// value 组必须紧贴标签结束，否则正则会跳过可选组、拿到空值。
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

// 浏览器解析 HTML 后会提交还原过的值
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function readSessionCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const m = /nexus_session=([^;]+)/.exec(raw);
  return m ? m[1] : null;
}

// 返回完整 Cookie 串，可直接放进 headers.cookie。
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