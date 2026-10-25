// 量一下两处画布到底有多大。
//
// 不猜：面板高度受导航栏、页头、底部工作区三层挤压，
// 靠看截图估算差个一两百像素很正常，而那一两百决定了该摆几行。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9334;
const BASE = "http://localhost:3000";
const token = fs.readFileSync(path.join(os.tmpdir(), "nexus-tok.txt"), "utf8").trim();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-measure-"));
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
  /*
    必须显式设设备尺寸。
    只给 --window-size 的话 headless 里的布局视口不是那个尺寸 ——
    第一次量出来 /canvas 的容器是 500x385，而截图明明是 1440 宽。
    量错了尺寸，后面推出来的「该摆几行」全是错的。
  */
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

  const probe = [
    "(() => {",
    "  const shell = document.querySelector('[data-canvas-shell]');",
    "  const pipes = [...document.querySelectorAll('[data-pipeline-stage]')];",
    "  const zoom = document.querySelector('[data-canvas-zoom]');",
    "  const sr = shell ? shell.getBoundingClientRect() : null;",
    "  const c = pipes[0] ? pipes[0].getBoundingClientRect() : null;",
    "  return JSON.stringify({",
    "    viewport: [window.innerWidth, window.innerHeight],",
    "    shell: sr ? [Math.round(sr.width), Math.round(sr.height)] : null,",
    "    stages: pipes.length,",
    "    zoom: zoom ? zoom.textContent.trim() : null,",
    "    card: c ? [Math.round(c.width), Math.round(c.height)] : null,",
    "  });",
    "})()",
  ].join("\n");

  for (const url of [BASE + "/studio?tab=graph", BASE + "/canvas"]) {
    await send("Page.navigate", { url });
    await sleep(4000);
    const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
    console.log(url + "\n  " + r.result.value);
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