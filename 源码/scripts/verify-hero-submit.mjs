// 验证首页那个箭头真的能建出运行。
//
// 做法：用 CDP 打开首页 → 往输入框里打字 → 点 ↑ → 看落到哪个地址。
// 用 CDP 而不是 fetch，是因为脚本要的 cookie 只有 CDP 的
// Network.setCookie 能可靠带上（Invoke-WebRequest 那条路一直 401）。
//
// 只创建运行、不触发生成 —— 创建是免费的（createRunAction 只写一行记录）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9340;
const BASE = "http://localhost:3000";
const token = fs.readFileSync(path.join(os.tmpdir(), "nexus-tok.txt"), "utf8").trim();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hero-"));
const browser = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + profile,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sleep(2500);
  const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  };
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send("Page.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Network.setCookie", {
    name: "nexus_session",
    value: token,
    domain: "localhost",
    path: "/",
  });

  await send("Page.navigate", { url: BASE + "/" });
  await sleep(3500);

  // 1) 按钮在不在、是不是真的 submit（不是 type=button）
  const before = await send("Runtime.evaluate", {
    expression: `(() => {
      const btn = document.querySelector('button[aria-label="开始构建"]');
      const ta = document.querySelector('textarea[name="prompt"]');
      const form = btn ? btn.closest('form') : null;
      return JSON.stringify({
        hasBtn: !!btn,
        btnType: btn ? btn.getAttribute('type') : null,
        disabled: btn ? btn.disabled : null,
        hasTextarea: !!ta,
        inForm: !!form,
        formAction: form ? typeof form.action : null,
      });
    })()`,
    returnByValue: true,
  });
  console.log("  点之前: " + before.result.value);

  // 2) 打字（用原生 setter，否则 React 收不到 change）
  const typed = await send("Runtime.evaluate", {
    expression: `(() => {
      const ta = document.querySelector('textarea[name="prompt"]');
      if (!ta) return "没有输入框";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "首页箭头验证：做一个倒计时");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      const btn = document.querySelector('button[aria-label="开始构建"]');
      return JSON.stringify({ value: ta.value, btnDisabled: btn ? btn.disabled : null });
    })()`,
    returnByValue: true,
  });
  console.log("  打字后: " + typed.result.value);

  await sleep(400);

  // 3) 点它
  await send("Runtime.evaluate", {
    expression: `(() => {
      const btn = document.querySelector('button[aria-label="开始构建"]');
      if (btn) btn.click();
      return true;
    })()`,
    returnByValue: true,
  });

  // 4) 等服务端动作跑完（创建 + redirect）
  for (let i = 0; i < 12; i++) {
    await sleep(700);
    const u = await send("Runtime.evaluate", {
      expression: "location.pathname + location.search",
      returnByValue: true,
    });
    const where = u.result.value;
    if (where && where.includes("/studio")) {
      console.log("  ✅ 点完跳到了: " + where);
      break;
    }
    if (i === 11) console.log("  ❌ 12 次轮询后地址仍是: " + where);
  }

  ws.close();
  browser.kill();
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
}

main().catch((e) => {
  console.error("  异常: " + e.message);
  browser.kill();
  process.exit(1);
});