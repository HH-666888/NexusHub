/**
 * 问浏览器：.dot-grid 到底算出来是什么
 * ============================================================
 * 比对着源码猜快得多。要回答三件事：
 *   1. 那条规则有没有生效（backgroundImage 算出来是什么）
 *   2. CSS 变量有没有解析出来（--dot-alpha 的值）
 *   3. 元素的实际尺寸（background-size 是相对 padding box 的，
 *      如果元素高度为 0，点阵自然什么都看不到）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9334;
const [, , url, cookieValue] = process.argv;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-probe-"));
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
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl && (t.url === "about:blank" || t.url.startsWith("http")),
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
            }, 15000);
          });
        },
        close: () => ws.close(),
      });
    ws.onerror = () => reject(new Error("无法连接调试端口"));
  });
}

const PROBE = `(() => {
  const root = getComputedStyle(document.documentElement);
  const out = {
    dot: null,
    tintVars: {},
    samples: [],
  };

  const el = document.querySelector('.dot-grid');
  if (el) {
    const cs = getComputedStyle(el);
    out.dot = {
      backgroundImage: cs.backgroundImage,
      backgroundSize: cs.backgroundSize,
    };
  }

  for (const n of ['--tint-1','--tint-2','--tint-3','--app-accent-glow','--dot-color','--dot-alpha']) {
    out.tintVars[n] = root.getPropertyValue(n).trim();
  }

  /*
    抽查几个「用变量拼颜色」的元素，看计算值有没有被丢弃。
    判据：如果 rgb(var(--tint-1) / 0.4) 是合法的，
    borderColor 会是一个带透明的具体颜色；
    如果非法，它会回落到 currentColor（也就是文字色），
    或者干脆是初始值 —— 两者看起来都不「像那个色」。
  */
  const sels = ['.tint-card', '.tint-chip', '[style*="--tint"]', '[style*="--t"]'];
  const seen = new Set();
  for (const s of sels) {
    for (const node of document.querySelectorAll(s)) {
      if (seen.has(node) || out.samples.length >= 4) continue;
      seen.add(node);
      const cs = getComputedStyle(node);
      out.samples.push({
        tag: node.tagName.toLowerCase(),
        cls: (node.className || '').toString().slice(0, 40),
        borderColor: cs.borderTopColor,
        boxShadow: cs.boxShadow.slice(0, 60),
        backgroundImage: cs.backgroundImage.slice(0, 60),
        color: cs.color,
      });
    }
  }
  return JSON.stringify(out);
})()`;

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

  await cdp.send("Page.navigate", { url });
  await sleep(3500);

  const { result } = await cdp.send("Runtime.evaluate", {
    expression: PROBE,
    returnByValue: true,
  });

  const data = JSON.parse(result.value);
  console.log("  CSS 变量");
  console.log("  ─────────────────────────────────────────");
  for (const [k, v] of Object.entries(data.tintVars)) {
    const comma = v.includes(",");
    console.log(
      `  ${k.padEnd(18)} ${(v || "（未定义）").padEnd(22)} ${comma ? "← 逗号分隔" : v ? "← 空格分隔" : ""}`,
    );
  }
  console.log("");
  console.log("  .dot-grid");
  console.log("  ─────────────────────────────────────────");
  if (data.dot) {
    console.log(`  background-image  ${data.dot.backgroundImage}`);
    console.log(`  background-size   ${data.dot.backgroundSize}`);
  } else {
    console.log("  页面上没有 .dot-grid");
  }
  console.log("");
  console.log("  用到 tint 变量的元素（抽查）");
  console.log("  ─────────────────────────────────────────");
  for (const s of data.samples) {
    console.log(`  <${s.tag}> ${s.cls}`);
    console.log(`     border  ${s.borderColor}`);
    console.log(`     color   ${s.color}   ← 如果 border 等于这个，说明回落到 currentColor 了`);
    console.log(`     shadow  ${s.boxShadow}`);
    console.log(`     bg-img  ${s.backgroundImage}`);
  }
  if (data.samples.length === 0) console.log("  没有找到用 tint 变量的元素");

  cdp.close();
  browser.kill();
}

main()
  .catch((e) => {
    console.error("探测失败：", e.message);
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