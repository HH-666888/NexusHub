// 量一下导航栏和页面内容各自从左边多少像素开始。
//
// 为什么写成一个文件而不是内联：这个项目在 PowerShell 里内联 Node 脚本
// 已经栽过好几次（引号和正则会 被吃掉）。规矩是带引号的代码一律落文件。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9335;
const BASE = "http://localhost:3000";
const token = fs.readFileSync(path.join(os.tmpdir(), "nexus-tok.txt"), "utf8").trim();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gutter-"));
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
    width: 1920,
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

  // 量：品牌的最左、右侧用户块的最右、以及正文第一块内容的最左
  const probe = [
    "(() => {",
    "  const nav = document.querySelector('header');",
    "  const brand = nav ? nav.querySelector('a') : null;",
    "  const navRect = nav ? nav.getBoundingClientRect() : null;",
    "  const brandRect = brand ? brand.getBoundingClientRect() : null;",
    "  const main = document.querySelector('main') || document.querySelector('section');",
    "  const mainRect = main ? main.getBoundingClientRect() : null;",
    "  return JSON.stringify({",
    "    vw: window.innerWidth,",
    "    navLeft: navRect ? Math.round(navRect.left) : null,",
    "    brandLeft: brandRect ? Math.round(brandRect.left) : null,",
    "    mainLeft: mainRect ? Math.round(mainRect.left) : null,",
    "    navClass: nav ? nav.className.slice(0, 40) : null,",
    "  });",
    "})()",
  ].join("\n");

  for (const p of ["/", "/canvas", "/studio?tab=graph", "/settings"]) {
    await send("Page.navigate", { url: BASE + p });
    await sleep(3500);
    const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
    console.log(p.padEnd(22) + r.result.value);
  }

  ws.close();
  browser.kill();
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
}

main().catch((e) => {
  console.error(e);
  browser.kill();
  process.exit(1);
});