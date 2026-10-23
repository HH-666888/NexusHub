/**
 * 查开发浮标到底还在不在
 * ============================================================
 * 比看截图确定：截图只能看到左下角那块区域，
 * 而且浮标在折叠状态下只是一个圆形图标，很容易看漏。
 * 直接问 DOM 里有没有它的宿主元素，是就是，不是就不是。
 *
 * Next.js 的开发工具挂在 <nextjs-portal> 里（Shadow DOM），
 * 所以除了查标签，还要把 shadow root 挖开看里面的文字。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9336;
const [, , url, cookieValue] = process.argv;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-badge-"));
const browser = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--disable-extensions",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(
        (t) =>
          t.type === "page" &&
          t.webSocketDebuggerUrl &&
          (t.url === "about:blank" || t.url.startsWith("http")),
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("调试端口没有就绪");
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message));
        else res(m.result);
      }
    });
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP 超时：${method}`));
              }
            }, 20000);
          });
        },
        close: () => ws.close(),
      });
    ws.onerror = () => reject(new Error("无法连接调试端口"));
  });
}

const CHECK = `(() => {
  const portals = document.querySelectorAll('nextjs-portal');

  /*
    判据不能用「portal 元素在不在」。
    那个元素就算关掉浮标也还在 —— 它还承载错误浮层、构建错误提示等
    一整套开发工具，关掉的只是**角上那个指示器**。
    第一版就是这么判的，于是明明关掉了还报「浮标还在」。

    真正该看的是 shadow DOM 里有没有**指示器本身**：
    它有几个可辨认的特征 —— 一句 "Route Info" 文案，
    或者一个 title 含 "Next.js" 的按钮。
  */
  let shadowText = '';
  let indicatorNodes = 0;
  let tags = [];

  for (const p of portals) {
    const sr = p.shadowRoot;
    if (!sr) continue;
    shadowText += sr.textContent + ' ';
    for (const el of sr.querySelectorAll('*')) {
      tags.push(el.tagName.toLowerCase());
      const t = (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '');
      if (/next\\.?js/i.test(t)) indicatorNodes++;
    }
  }

  // 统计标签出现次数，用来确认 shadow 里到底有什么
  const counted = {};
  for (const t of tags) counted[t] = (counted[t] || 0) + 1;

  const bodyText = document.body ? document.body.innerText : '';

  return JSON.stringify({
    portalCount: portals.length,
    shadowLen: shadowText.length,
    shadowHasRouteInfo: shadowText.includes('Route Info'),
    shadowHasPreferences: shadowText.includes('Preferences'),
    shadowHasBundler: shadowText.includes('Bundler'),
    bodyHasRouteInfo: bodyText.includes('Route Info'),
    indicatorNodes,
    tagSummary: Object.entries(counted).sort((a,b)=>b[1]-a[1]).slice(0, 10).map(([k,v])=>k+'×'+v).join(' '),
  });
})()`;

async function main() {
  const cdp = await connect(await waitForTarget());
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");

  if (cookieValue) {
    const { hostname } = new URL(url);
    await cdp.send("Network.setCookie", {
      name: "nexus_session",
      value: cookieValue,
      domain: hostname,
      path: "/",
      httpOnly: true,
    });
  }

  await cdp.send("Page.navigate", { url });
  await sleep(4000);

  const { result } = await cdp.send("Runtime.evaluate", {
    expression: CHECK,
    returnByValue: true,
  });
  const d = JSON.parse(result.value);

  console.log("  开发浮标检测");
  console.log("  ────────────────────────────────────────");
  console.log(`  <nextjs-portal> 元素数量        ${d.portalCount}   （关掉浮标它也会在，承载错误浮层）`);
  console.log(`  shadow DOM 文本长度             ${d.shadowLen}`);
  console.log(`  shadow 里有 "Route Info"        ${d.shadowHasRouteInfo}`);
  console.log(`  shadow 里有 "Preferences"       ${d.shadowHasPreferences}`);
  console.log(`  shadow 里有 "Bundler"           ${d.shadowHasBundler}`);
  console.log(`  正文里有 "Route Info"           ${d.bodyHasRouteInfo}`);
  console.log(`  含 "Next.js" 的指示器按钮        ${d.indicatorNodes}`);
  if (d.tagSummary) console.log(`  shadow 里的标签：${d.tagSummary}`);
  console.log("");
  const gone =
    !d.shadowHasRouteInfo &&
    !d.shadowHasPreferences &&
    !d.shadowHasBundler &&
    !d.bodyHasRouteInfo &&
    d.indicatorNodes === 0;
  console.log(gone ? "  ✅ 角上那个浮标已经不在了" : "  ❌ 浮标还在");

  cdp.close();
  browser.kill();
}

main()
  .catch((e) => {
    console.error("检测失败：", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => {
      browser.kill();
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* 无所谓 */
      }
    }, 500);
  });