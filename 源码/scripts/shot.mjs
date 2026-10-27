/**
 * 带登录态的截图工具
 * ============================================================
 * 用法：
 *   node scripts/shot.mjs <网址> <输出图片路径> [会话Cookie值] [高] [宽]
 *
 * 为什么需要它：
 *   工作台、设置页这些页面都要求登录，而 Edge 的 --screenshot 参数
 *   没法带 Cookie —— 它只能截公开页面。
 *   这个脚本走 CDP（Chrome 调试协议）：先注入 Cookie，再导航，再截图。
 *
 * 宽为什么也要能改：
 *   一开始写死 1440。而「角上太空」这类问题**只在宽屏上才看得出来** ——
 *   1440 下两边各让 52px 是正常页边距，1920 下同样的写法
 *   会各让 292px，一眼就空。窄屏截图看不见这个问题。
 *
 * 这是开发期的验证工具，不参与线上运行。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9333;

const [, , url, out, cookieValue, heightArg, widthArg] = process.argv;
if (!url || !out) {
  console.error("用法: node scripts/shot.mjs <网址> <输出路径> [Cookie值] [高] [宽]");
  process.exit(1);
}
const viewportHeight = Number(heightArg) || 900;
const viewportWidth = Number(widthArg) || 1440;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-shot-"));
const browser = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    // 关掉扩展：它们会注册一堆 background_page 目标，
    // 让「挑哪个标签页」这件事变得不可靠
    "--disable-extensions",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${viewportWidth},${viewportHeight}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等调试端口起来，并挑出「我们自己那个空白标签页」。
 *
 * 这里踩过一个坑：不能简单地取第一个 type === "page" 的目标。
 * Edge 启动时会注册一堆自己的页面（同步确认页、新标签页等），
 * 它们同样报 type: "page" —— 连上去之后导航和截图都会卡死，
 * 而且不会有任何报错，就是一直等。所以要按 URL 精确挑。
 */
async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
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
      // 还没起来，继续等
    }
    await sleep(250);
  }
  throw new Error("调试端口没有就绪");
}

/**
 * 连上 CDP 并提供一个简易客户端。
 *
 * 这里踩过一个坑，值得写下来：
 *   最初的版本把 WebSocket 的 message 监听**放在 onEvent() 里**，
 *   也就是说只有调用方主动订阅事件之后才开始收消息。
 *   结果第一个 cdp.send() 就永远等不到回应 —— 因为监听器还没挂上。
 *   表现是「脚本毫无输出地卡死」，没有报错，最难查。
 *   正确的做法是：连上的那一刻就把监听挂好，事件转发是附加能力，不是前提。
 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = [];

    // 无条件挂上：响应分发和事件转发都靠它
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
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    });

    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            // 兜底超时：CDP 偶发不回应时给出明确报错，而不是无限等
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP 调用超时：${method}`));
              }
            }, 15000);
          });
        },
        onEvent: (fn) => listeners.push(fn),
        close: () => ws.close(),
      });

    ws.onerror = () => reject(new Error("无法连接调试端口"));
    setTimeout(() => reject(new Error("连接调试端口超时")), 10000);
  });
}

async function main() {
  const wsUrl = await waitForTarget();
  const cdp = await connect(wsUrl);

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

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 等页面加载完成（含流式内容的初始渲染）
  const loaded = new Promise((resolve) => {
    cdp.onEvent((msg) => {
      if (msg.method === "Page.loadEventFired") resolve();
    });
  });
  await cdp.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(15000)]);
  // 多等一会儿：动画与客户端水合需要时间
  await sleep(2500);

  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));

  cdp.close();
  browser.kill();
  console.log(`已截图 -> ${out}`);
}

main()
  .catch((err) => {
    console.error("截图失败：", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => {
      browser.kill();
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        // 清理失败无所谓
      }
    }, 500);
  });
