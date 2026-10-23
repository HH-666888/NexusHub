/**
 * 把 JS 渲染的页面渲染出来，取正文
 * ============================================================
 * 用法：node scripts/render-text.mjs <网址> [最多字符数]
 *
 * 为什么需要它：
 *   现在很多页面是前端渲染的 —— 直接 fetch 只能拿到一个空壳
 *   （HTTP 200，但正文一个字都没有）。
 *   要判断页面里到底写了什么，必须真的用浏览器跑一遍。
 *
 * 取的是 innerText 而不是 innerHTML：
 *   innerHTML 里全是标签和样式，正文被埋在一堆 div 里读不出来；
 *   innerText 是浏览器算完样式后的**可见文本**，
 *   也就是人眼真正看到的东西。
 *
 * 开发工具，不参与线上运行。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9335;

const [, , url, limitArg] = process.argv;
if (!url) {
  console.error("用法: node scripts/render-text.mjs <网址> [最多字符数]");
  process.exit(1);
}
const limit = Number(limitArg) || 6000;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-render-"));
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
    "--window-size=1440,1200",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
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
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
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

async function main() {
  const wsUrl = await waitForTarget();
  const cdp = await connect(wsUrl);
  await cdp.send("Page.enable");

  await cdp.send("Page.navigate", { url });
  // 多等一会儿：这类页面先出骨架、再拉数据、再渲染
  await sleep(7000);

  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const t = document.body ? document.body.innerText : '';
      return JSON.stringify({
        title: document.title || '',
        url: location.href,
        len: t.length,
        text: t.slice(0, ${limit}),
      });
    })()`,
    returnByValue: true,
  });

  const data = JSON.parse(result.value);
  console.log(`标题：${data.title}`);
  console.log(`地址：${data.url}`);
  console.log(`可见文本长度：${data.len}`);
  console.log("─".repeat(60));
  console.log(data.text || "（页面没有任何可见文本）");

  cdp.close();
  browser.kill();
}

main()
  .catch((e) => {
    console.error("渲染失败：", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => {
      browser.kill();
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* 清理失败无所谓 */
      }
    }, 500);
  });