/**
 * 画布的端到端
 * ============================================================
 * 这个脚本和前三个不一样：它需要**真的用浏览器操作**。
 *
 * 前三端到端都是发 HTTP 请求看响应，因为那些功能的结果都在响应里。
 * 画布不行 —— 平移缩放的结果是**计算样式**，
 * 服务端返回的 HTML 里根本没有视口信息。
 *
 * 所以这里用 CDP：
 *   真的滚一次滚轮、真的拖一次鼠标、真的点一次按钮，
 *   然后读元素的计算样式看有没有变。
 *
 * 为什么不能只截图看：截图只能证明「画面看起来对」，
 * 证明不了「滚轮真的缩放」—— 而后者才是这次要交付的东西。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect_, finish, heading, info, ok, signUp } from "./e2e-kit";

const BASE = process.env.NEXUS_BASE ?? "http://localhost:3000";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9337;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   极简 CDP 客户端
   ============================================================ */

async function waitForTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(
        (t: { type: string; url: string; webSocketDebuggerUrl?: string }) =>
          t.type === "page" &&
          t.webSocketDebuggerUrl &&
          (t.url === "about:blank" || t.url.startsWith("http")),
      );
      if (page) return page.webSocketDebuggerUrl as string;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("调试端口没有就绪");
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<{ result?: { value?: string } }>;
  close(): void;
}

function connect(wsUrl: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map<number, { res: (v: never) => void; rej: (e: Error) => void }>();

    ws.addEventListener("message", (ev) => {
      let m: { id?: number; error?: { message: string }; result?: never };
      try {
        m = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message));
        else p.res(m.result as never);
      }
    });

    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            pending.set(id, { res: res as never, rej });
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

/* ============================================================
   读画布状态
   ============================================================ */

interface CanvasState {
  bgPos: string;
  bgSize: string;
  gridStep: number;
  panX: number;
  panY: number;
  originX: number;
  originY: number;
  zoomLabel: string;
  /** 画布元素的真实尺寸。**不要假设它等于窗口尺寸** */
  stageW: number;
  stageH: number;
}

const READ = `(() => {
  const stage = document.querySelector('[data-canvas-stage]');
  if (!stage) return JSON.stringify({ missing: true });
  const cs = getComputedStyle(stage);
  const rect = stage.getBoundingClientRect();
  const origin = document.querySelector('[data-canvas-origin]');
  const zoom = document.querySelector('[data-canvas-zoom]');
  const size = parseFloat(cs.backgroundSize) || 0;
  const posParts = cs.backgroundPosition.split(' ');
  return JSON.stringify({
    bgPos: cs.backgroundPosition,
    bgSize: cs.backgroundSize,
    gridStep: size,
    panX: parseFloat(posParts[0]) || 0,
    panY: parseFloat(posParts[1]) || 0,
    originX: origin ? parseFloat(origin.style.left) || 0 : -1,
    originY: origin ? parseFloat(origin.style.top) || 0 : -1,
    zoomLabel: zoom ? zoom.textContent.trim() : '',
    stageW: Math.round(rect.width),
    stageH: Math.round(rect.height),
  });
})()`;

async function read(cdp: Cdp): Promise<CanvasState> {
  const r = await cdp.send("Runtime.evaluate", { expression: READ, returnByValue: true });
  return JSON.parse(r.result!.value!) as CanvasState;
}

/* ============================================================
   主流程
   ============================================================ */

async function main() {
  const started = Date.now();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-canvas-"));
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

  try {
    /* ---------- 1. 注册一个用户拿会话 ---------- */
    heading("第一步 · 注册一个测试账号");
    const username = `ec_${Date.now().toString(36)}`;
    /*
      用 e2e-kit 里的 signUp，不自己写。
      注册页是 Server Action 表单，直接 POST username/password
      会拿到一个 HTTP 200 但**没有 Cookie** —— 看起来像成功了。
      这一段第一版就是这么写的，19 项检查全红。
    */
    const cookie = await signUp(BASE, username);
    const token = cookie.replace(/^nexus_session=/, "");
    expect_(token.length > 0, "注册成功并拿到会话", "没拿到 Cookie");

    /* ---------- 2. 打开画布 ---------- */
    heading("第二步 · 打开画布");
    const cdp = await connect(await waitForTarget());
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCookie", {
      name: "nexus_session",
      value: token,
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
    });
    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const initial = await read(cdp);
    expect_(!("missing" in initial), "画布元素存在", "页面上找不到 [data-canvas-stage]");

    /*
      期望值必须从**画布元素的真实尺寸**算，不能从窗口尺寸推。
      第一版写的是 1440 × (900-64)，结果差 15 和 48 像素 ——
      窗口外框尺寸不等于视口尺寸，视口尺寸也不等于
      减掉导航栏之后的画布尺寸。三个数看着都像，实际都不是。
    */
    const vw = initial.stageW;
    const vh = initial.stageH;
    info(`画布实际尺寸 ${vw}×${vh}，网格间距 ${initial.gridStep}px，倍率 ${initial.zoomLabel}`);

    /* ---------- 3. 初始视口对准核心格 ---------- */
    heading("第三步 · 初始视口对准核心格（第 3 列第 2 行）");

    expect_(
      Math.abs(initial.gridStep - 160) < 1,
      "初始倍率下网格间距 160px",
      `实际 ${initial.gridStep}px`,
    );
    expect_(initial.zoomLabel === "100%", "倍率显示 100%", `实际显示 ${initial.zoomLabel}`);

    /*
      核心格中心应当落在「水平正中、纵向 34%」。
      34% 是刻意不是 50%：流水线往下长，下面要留地方。
    */
    const targetX = vw / 2;
    const targetY = vh * 0.34;
    expect_(
      Math.abs(initial.originX - targetX) < 2,
      `原点横向落在正中（${Math.round(initial.originX)} ≈ ${targetX}）`,
      `横向偏了：${Math.round(initial.originX)} vs ${targetX}`,
    );
    expect_(
      Math.abs(initial.originY - targetY) < 2,
      `原点纵向偏上（${Math.round(initial.originY)} ≈ ${Math.round(targetY)}）`,
      `纵向不对：${Math.round(initial.originY)} vs ${Math.round(targetY)}`,
    );

    /* ---------- 4. 滚轮缩放 ---------- */
    heading("第四步 · 滚轮缩放（以光标为锚点）");

    const anchorX = 400;
    const anchorY = 300;

    // 向上滚 = 放大
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: anchorX,
      y: anchorY,
      deltaX: 0,
      deltaY: -300,
    });
    await sleep(400);
    const zoomedIn = await read(cdp);

    expect_(
      zoomedIn.gridStep > initial.gridStep,
      `向上滚放大：网格 ${initial.gridStep}px → ${zoomedIn.gridStep}px`,
      `网格没有变大：还是 ${zoomedIn.gridStep}px`,
    );
    expect_(
      zoomedIn.zoomLabel !== initial.zoomLabel,
      `倍率显示跟着变：${initial.zoomLabel} → ${zoomedIn.zoomLabel}`,
      `倍率显示没变：还是 ${zoomedIn.zoomLabel}`,
    );

    /*
      【关键】锚点不动。
      光标下面那个世界点在缩放前后应当落在同一个屏幕位置。
      做法：锚点的世界坐标 = (光标 - 平移) / 倍率，
      缩放后该点的新平移 = 光标 - 世界坐标 × 新倍率。
      这里反过来验：算出的新平移应当等于实际的新平移。
    */
    const worldX = (anchorX - initial.panX) / (initial.gridStep / 160);
    const expectPanX = anchorX - worldX * (zoomedIn.gridStep / 160);
    expect_(
      Math.abs(zoomedIn.panX - expectPanX) < 2,
      `缩放的锚点在光标处（期望平移 ${Math.round(expectPanX)}，实际 ${Math.round(zoomedIn.panX)}）`,
      `锚点漂了：期望 ${Math.round(expectPanX)}，实际 ${Math.round(zoomedIn.panX)}`,
    );

    // 向下滚 = 缩小，应当缩回接近原始倍率
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: anchorX,
      y: anchorY,
      deltaX: 0,
      deltaY: 300,
    });
    await sleep(400);
    const zoomedBack = await read(cdp);
    expect_(
      zoomedBack.gridStep <= zoomedIn.gridStep,
      `向下滚缩小：网格 ${zoomedIn.gridStep}px → ${zoomedBack.gridStep}px`,
      `网格没有变小：还是 ${zoomedBack.gridStep}px`,
    );

    /* ---------- 5. 拖拽平移 ---------- */
    heading("第五步 · 拖拽平移");

    const beforeDrag = await read(cdp);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 700,
      y: 500,
      button: "left",
      clickCount: 1,
    });
    await sleep(120);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 800,
      y: 560,
      button: "left",
    });
    await sleep(120);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 800,
      y: 560,
      button: "left",
    });
    await sleep(300);

    const afterDrag = await read(cdp);
    expect_(
      Math.abs(afterDrag.panX - beforeDrag.panX - 100) < 3,
      `拖动向右 100px，平移跟着走（${Math.round(beforeDrag.panX)} → ${Math.round(afterDrag.panX)}）`,
      `横向平移不对：期望 +100，实际 ${Math.round(afterDrag.panX - beforeDrag.panX)}`,
    );
    expect_(
      Math.abs(afterDrag.panY - beforeDrag.panY - 60) < 3,
      `拖动向下 60px，平移跟着走`,
      `纵向平移不对：期望 +60，实际 ${Math.round(afterDrag.panY - beforeDrag.panY)}`,
    );
    expect_(
      Math.abs(afterDrag.originX - beforeDrag.originX - 100) < 3,
      "原点标记跟着一起动（它属于画布内容，不是屏幕装饰）",
      `原点没跟着动：${Math.round(beforeDrag.originX)} → ${Math.round(afterDrag.originX)}`,
    );

    /* ---------- 6. 回到原点 ---------- */
    heading("第六步 · 回到原点");

    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-zoom]').click()`,
    });
    await sleep(400);
    const home = await read(cdp);

    expect_(home.zoomLabel === "100%", "回到原点后倍率复位到 100%", `实际 ${home.zoomLabel}`);
    expect_(
      Math.abs(home.originX - targetX) < 2 && Math.abs(home.originY - targetY) < 2,
      "回到原点后核心格回到初始位置",
      `回到 (${Math.round(home.originX)}, ${Math.round(home.originY)})，期望 (${targetX}, ${Math.round(targetY)})`,
    );

    /* ---------- 7. 缩放按钮 ---------- */
    heading("第七步 · 缩放按钮");

    await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '放大').click()`,
    });
    await sleep(300);
    const afterPlus = await read(cdp);
    expect_(
      afterPlus.gridStep > home.gridStep,
      `点「+」放大：${home.gridStep}px → ${afterPlus.gridStep}px`,
      `点「+」没放大：还是 ${afterPlus.gridStep}px`,
    );

    await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '缩小').click()`,
    });
    await sleep(300);
    const afterMinus = await read(cdp);
    expect_(
      Math.abs(afterMinus.gridStep - home.gridStep) < 1,
      `点「−」缩回来：${afterPlus.gridStep}px → ${afterMinus.gridStep}px`,
      `没缩回来：${afterMinus.gridStep}px，期望 ${home.gridStep}px`,
    );

    /* ---------- 8. 画布确实是空的 ---------- */
    heading("第八步 · 画布上没有内容");

    const emptyCheck = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const stage = document.querySelector('[data-canvas-stage]');
        // 画布的直接子元素：应当只有那个原点标记，没有别的
        const kids = [...stage.children].map(el => el.tagName.toLowerCase() + (el.hasAttribute('data-canvas-origin') ? '[origin]' : ''));
        return JSON.stringify({ count: stage.children.length, kids });
      })()`,
      returnByValue: true,
    });
    const empty = JSON.parse(emptyCheck.result!.value!) as { count: number; kids: string[] };
    info(`画布子元素：${empty.kids.join(", ") || "（无）"}`);
    expect_(
      empty.count <= 1,
      "画布上没有流程、没有节点，只有原点标记",
      `画布上多了 ${empty.count} 个元素：${empty.kids.join(", ")}`,
    );

    /* ---------- 9. 任务图上的权限四件套 ---------- */
    /*
      任务图是**纯客户端渲染**的 —— SSR 出来的 HTML 里一个节点都没有
      （实测过：data-node-actor / 「要人点头」/「AI · 只读」全是 false）。
      所以这一组只能在浏览器里验，加在这个脚本里而不是 e2e-run 里。

      这一组测的是**设计意图有没有真的传到界面上**：
      核心层改了 access 而图上还画着旧徽章的话，看的人仍然会误解。
    */
    heading("第九步 · 任务图上的权限");

    await cdp.send("Page.navigate", { url: `${BASE}/studio?tab=graph` });
    await sleep(4000);

    const graphCheck = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const q = (s) => [...document.querySelectorAll(s)];
        return JSON.stringify({
          actors: q('[data-node-actor]').map(el => ({
            id: el.getAttribute('data-node-actor'),
            label: el.textContent.trim(),
          })),
          gates: q('[data-node-gate]').map(el => el.getAttribute('data-node-gate')),
          watches: q('[data-node-watches]').map(el => ({
            id: el.getAttribute('data-node-watches'),
            text: el.textContent.trim(),
          })),
        });
      })()`,
      returnByValue: true,
    });
    const gd = JSON.parse(graphCheck.result!.value!) as {
      actors: Array<{ id: string; label: string }>;
      gates: string[];
      watches: Array<{ id: string; text: string }>;
    };

    info(`节点上的角色徽章：${gd.actors.map((a) => `${a.id}=${a.label}`).join(" ")}`);

    expect_(
      gd.actors.length === 6,
      "六道工序都带了角色徽章",
      `只有 ${gd.actors.length} 道工序带了角色徽章`,
    );

    /*
      【最要紧】验收在图上必须是「AI · 只读」。
      核心层有一条单测钉着 STAGE_MAP.verify.access === "read"，
      这一条钉的是它有没有真的画出来。
    */
    const verifyActor = gd.actors.find((a) => a.id === "verify");
    expect_(
      verifyActor?.label === "AI · 只读",
      "验收在图上标着「AI · 只读」",
      `验收标成了「${verifyActor?.label}」—— 判定者不该参与生产`,
    );

    expect_(
      gd.actors.filter((a) => a.label === "AI · 干活").length === 5,
      "其余五道都是「AI · 干活」",
      `「AI · 干活」有 ${gd.actors.filter((a) => a.label === "AI · 干活").length} 道，应该是 5 道`,
    );

    expect_(
      gd.gates.length === 1 && gd.gates[0] === "spec",
      "只有规格化标着「要人点头」",
      `带门禁的是：${gd.gates.join(" ") || "（无）"}`,
    );

    /*
      ---------- 门禁的「声明」与「实际」 ----------
      改之前 stages.ts 里那句 humanGate: true 没有任何代码读它，
      实际控制门禁的是 SPEC_GATE 环境变量。两个真相来源，
      而且放行是静默的 —— 界面上写着「要人点头」而实际不停。

      现在图上会同时说出两件事：声明要不要批（那段文字），
      以及实际会不会停（data-node-gate-active）。
      两者不一致时，文字会变成「要人点头（已放行）」并且划掉。
    */
    const gateActive = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-node-gate]');
        return el ? el.getAttribute('data-node-gate-active') : null;
      })()`,
      returnByValue: true,
    });
    const active = gateActive.result!.value as string | null;
    info(`门禁标记：${active === "1" ? "会停下问人" : "已放行（模型会替你猜）"}`);

    expect_(
      active === "0" || active === "1",
      "门禁标记说出了实际会不会停",
      `data-node-gate-active 是 ${active}`,
    );

    /*
      当前跑端到端时 SPEC_GATE 没设，也就是 "declared" ——
      按权限模型来，规格化声明了要人点头，所以实际会停。
      这条断言把"默认值就是声明"这件事钉住。
    */
    expect_(
      active === "1",
      "没设 SPEC_GATE 时按权限模型来：规格化会停下问人",
      `没设 SPEC_GATE，但门禁标记是 ${active} —— 默认值不是 declared？`,
    );

    expect_(
      gd.watches.length === 6,
      "六道工序都写了「看什么数」",
      `只有 ${gd.watches.length} 道写了看什么数`,
    );

    // 看什么数不能是空壳
    const emptyWatches = gd.watches.filter((w) => w.text.replace(/^看：/, "").trim().length === 0);
    expect_(
      emptyWatches.length === 0,
      "「看什么数」都不是空的",
      `有 ${emptyWatches.length} 道工序的「看什么数」是空的`,
    );

    cdp.close();
    ok("画布交互与任务图权限全部通过");
  } finally {
    browser.kill();
    setTimeout(() => {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* 清理失败无所谓 */
      }
    }, 500);
  }

  finish(started);
}

main().catch((err: unknown) => {
  // 用 expect_ 把异常也计入失败数，这样 finish 会以退出码 1 结束 ——
  // 直接 console.error 再 return 的话，退出码是 0，等于「崩了也算通过」
  expect_(false, "脚本正常结束", `异常终止：${err instanceof Error ? err.message : String(err)}`);
  finish(Date.now());
});