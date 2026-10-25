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

  /*
    ⚠️ 原点标记的屏幕位置要**量**（getBoundingClientRect），不能读 style.left。

    以前它在屏幕上绝对定位，style.left 就是屏幕坐标，读它没问题。
    现在它在世界坐标层里 —— style.left 是固定的世界坐标（400），
    永远不变。于是「拖动后原点跟着动」那条断言永远红，
    而画面其实动得好好的。

    量出来的才是屏幕上真实的位置。减掉 stage 的 rect 得到相对视口的坐标，
    和 panX / panY 量的是同一个基准。
  */
  let originX = -1, originY = -1;
  if (origin) {
    const orect = origin.getBoundingClientRect();
    originX = orect.left - rect.left;
    originY = orect.top - rect.top;
  }

  return JSON.stringify({
    bgPos: cs.backgroundPosition,
    bgSize: cs.backgroundSize,
    gridStep: size,
    panX: parseFloat(posParts[0]) || 0,
    panY: parseFloat(posParts[1]) || 0,
    originX,
    originY,
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

    /* ---------- 3. 初始视口：整条流水线一屏看得下 ---------- */
    /*
      ⚠️ 这一条以前是「初始视口对准核心格、倍率 100%」。
      那是画布还空着的时候 —— 打开它就该看到第 3 列第 2 行的那一格。

      现在画布上有六道工序（整条 1840 宽），所以打开时该做的是
      **把整条装进视口**：窗口 1440 时装不下，要缩到 ~70%。
      仍然缩到 100% 的话，用户第一眼只看到四道半，剩下的一道半
      要自己滚一下滚轮才知道在 —— 而"还有东西在右边"这件事，
      不滚是看不出来的。
    */
    heading("第三步 · 初始视口装下整条流水线");

    expect_(
      initial.zoomLabel !== "100%",
      `打开时自动缩放（${initial.zoomLabel}），整条看得下`,
      "打开时还是 100% —— 六道工序一屏装不下",
    );
    expect_(
      initial.gridStep > 60 && initial.gridStep < 160,
      `网格间距 ${initial.gridStep}px，说明确实缩小了`,
      `网格间距是 ${initial.gridStep}px，看着不像缩过`,
    );

    /*
      原点标记（核心格）在这种视口下**不该**落在正中 ——
      整条流水线以核心格的 x 居中，但纵向的偏移不一样。
      这里只断言它在视口内，不断言具体位置：
      具体位置由 fitViewport 的算法决定，而那个算法有自己的单测。
    */
    expect_(
      initial.originX > 0 && initial.originX < vw && initial.originY > 0 && initial.originY < vh,
      "原点标记落在视口里",
      `原点跑到了视口外：(${Math.round(initial.originX)}, ${Math.round(initial.originY)})`,
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
    /*
      ⚠️ 这一条以前断言「回到原点后倍率复位到 100%、核心格回到正中」。
      现在这个按钮的意思是**回到初始视口** —— 也就是重新装下整条流水线，
      而初始视口是缩放的（~70%）。所以断言对象从"核心格的位置"
      换成了"整条流水线的位置"，那才是这个按钮真正该保证的事。
    */
    heading("第六步 · 回到原点（重新装下整条流水线）");

    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-zoom]').click()`,
    });
    await sleep(400);
    const home = await read(cdp);

    expect_(
      home.zoomLabel === initial.zoomLabel,
      `回到原点后倍率回到初始值 ${initial.zoomLabel}`,
      `实际 ${home.zoomLabel}，初始是 ${initial.zoomLabel}`,
    );
    expect_(
      Math.abs(home.originX - initial.originX) < 2 && Math.abs(home.originY - initial.originY) < 2,
      "回到原点后画面回到初始位置",
      `回到 (${Math.round(home.originX)}, ${Math.round(home.originY)})，初始是 (${Math.round(initial.originX)}, ${Math.round(initial.originY)})`,
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

    /* ---------- 8. 画布上的六道工序 ---------- */
    /*
      这里原来有一条**反向**断言：「画布上没有流程、没有节点，只有原点标记」。
      那是上一版：画布确实什么也没有，而首页的「新建项目」正好指向它 ——
      「从一句话开始」这句承诺把人带进一片空白网格。

      现在六道工序画上去了，断言跟着反过来：**它必须有东西**，
      而且东西要是对的（顺序、权限、连线、缩放）。
    */
    heading("第八步 · 画布上的六道工序");

    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const pipeline = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const q = (s) => [...document.querySelectorAll(s)];
        const stage = document.querySelector('[data-canvas-stage]');
        return JSON.stringify({
          hasWorld: !!document.querySelector('[data-canvas-world]'),
          hasPipeline: !!document.querySelector('[data-canvas-pipeline]'),
          ids: q('[data-pipeline-stage]').map(el => el.getAttribute('data-pipeline-stage')),
          actors: q('[data-stage-actor]').map(el => ({
            id: el.getAttribute('data-stage-actor'),
            label: el.textContent.trim(),
          })),
          gates: q('[data-stage-gate]').map(el => el.getAttribute('data-stage-gate')),
          watches: q('[data-stage-watches]').length,
          hasGrid: !!stage,
          hasOrigin: !!document.querySelector('[data-canvas-origin]'),
        });
      })()`,
      returnByValue: true,
    });
    const pl = JSON.parse(pipeline.result!.value!) as {
      hasWorld: boolean;
      hasPipeline: boolean;
      ids: string[];
      actors: Array<{ id: string; label: string }>;
      gates: string[];
      watches: number;
      hasGrid: boolean;
      hasOrigin: boolean;
    };

    info(`画布上的工序：${pl.ids.join(" ")}`);

    expect_(pl.hasWorld, "画布有世界坐标层", "没有世界坐标层 —— 内容无处安放");
    expect_(pl.hasPipeline, "画布上有流水线", "画布上还是一片空白");
    expect_(
      pl.ids.length === 6,
      "六道工序都画出来了",
      `只有 ${pl.ids.length} 道：${pl.ids.join(" ")}`,
    );
    expect_(
      pl.ids.join(",") === "spec,arch,ui,build,assemble,verify",
      "顺序是 ①②③④⑤⑥",
      `顺序不对：${pl.ids.join(" ")}`,
    );
    expect_(pl.hasGrid && pl.hasOrigin, "网格和原点标记都还在", "画布本体的网格或原点标记没了");

    /*
      权限四件套也要跟着上画布 ——
      在 /studio 那张图上有、搬到画布上就没了的话，
      等于这一趟搬家把最重要的东西丢了。
    */
    const flowVerifyActor = pl.actors.find((a) => a.id === "verify");
    expect_(
      flowVerifyActor?.label === "AI · 只读",
      "验收在画布上也是「AI · 只读」",
      `验收标成了「${flowVerifyActor?.label}」—— 判定者不该参与生产`,
    );
    expect_(
      pl.gates.length === 1 && pl.gates[0] === "on",
      "只有规格化带门禁，且是「会停下问人」",
      `门禁标记：${pl.gates.join(" ") || "（无）"}`,
    );
    expect_(
      pl.watches === 6,
      "六道工序都写了「看什么数」",
      `只有 ${pl.watches} 道写了看什么数`,
    );

    /*
      连线：顺序流转的实线 + 失败回退的虚线。
      回退边是别家画不出来的东西（他们的流程里没定义失败退回到哪），
      所以它必须真的画出来，而不是只存在于数据结构里。
    */
    const edgeCheck = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const paths = [...document.querySelectorAll('[data-canvas-pipeline] svg path')];
        const dashed = paths.filter(p => p.getAttribute('stroke-dasharray'));
        return JSON.stringify({ total: paths.length, dashed: dashed.length });
      })()`,
      returnByValue: true,
    });
    const ed = JSON.parse(edgeCheck.result!.value!) as { total: number; dashed: number };
    info(`连线：共 ${ed.total} 条，其中虚线（失败回退）${ed.dashed} 条`);

    expect_(
      ed.dashed === 5,
      "五道工序各有一条失败回退边",
      `虚线的条数是 ${ed.dashed}，应该是 5`,
    );

    /*
      缩放自动适应：整条流水线 1840 宽，窗口 1440，
      打开时应该已经缩到看得全 —— 而不是要用户自己滚一下滚轮。
    */
    const zoomCheck = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-zoom]')?.textContent?.trim() ?? ''`,
      returnByValue: true,
    });
    const pct = Number(String(zoomCheck.result!.value).replace("%", ""));
    info(`打开时的缩放：${pct}%`);
    expect_(
      pct > 40 && pct < 100,
      `打开时自动缩到 ${pct}%，整条看得全`,
      `打开时是 ${pct}% —— 六道工序应该一屏看得下`,
    );

    /* ---------- 9. 点节点高亮整条上下游链 ---------- */
    heading("第九步 · 点节点高亮上下游链");

    const clickAndRead = async (stageId: string) => {
      await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('[data-pipeline-stage="${stageId}"]')?.click()`,
        returnByValue: true,
      });
      await sleep(500);
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const cards = [...document.querySelectorAll('[data-pipeline-stage]')];
          return JSON.stringify(cards.map(el => ({
            id: el.getAttribute('data-pipeline-stage'),
            opacity: Number(getComputedStyle(el).opacity),
          })));
        })()`,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as Array<{ id: string; opacity: number }>;
    };

    /*
      ---------- 点节点之后会发生什么 ----------
      点「验收」：它的上游是全部五道，所以六个都该亮着。
    */
    const allLit = await clickAndRead("verify");
    const dim1 = allLit.filter((c) => c.opacity < 0.5).map((c) => c.id);
    expect_(dim1.length === 0, "点「验收」时六道全亮（它的上游是全部）", `这几道被压暗了：${dim1.join(" ")}`);

    /*
      ⚠️ 这里原来断言「点中间某一道会压暗它下游的那几道」。**那条是错的。**

      tracePath 的 chain = 自己 + 全部上游 + 全部下游。
      而这是一条**线性**流水线（spec→arch→ui→build→assemble→verify），
      所以点任何一道，chain 都是全部六个 —— 一道也暗不下去。

      也就是说，「点节点压暗其他」这个效果在这张图上**永远不会发生**。
      断言写成"应该暗三道"是我照着"高亮一条链"这个说法想当然写的，
      没去核 tracePath 实际返回什么。跑起来才看见。

      那这个点击到底有什么用？—— 它选中那一道，
      好让详情面板显示它的原理、验收标准、权限说明和失败退回目标。
      所以下面断言的是**选中态**，不是压暗。
    */
    /*
      点一道，它就该有选中态。
      这里点的是「界面设计」—— 它是**未接入**的一道，
      正好顺带验一件事：点灰的工序时它要**亮起来**，
      因为点它恰恰是想看清它的详情。最需要看清的时候它最暗，是反的。
    */
    await clickAndRead("ui");

    const selected = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-pipeline-stage="ui"]');
        return JSON.stringify({
          boxShadow: getComputedStyle(el).boxShadow,
          opacity: Number(getComputedStyle(el).opacity),
        });
      })()`,
      returnByValue: true,
    });
    const sel = JSON.parse(selected.result!.value!) as { boxShadow: string; opacity: number };
    expect_(
      sel.boxShadow !== "none",
      "点中的那一道有外发光",
      `没有外发光：boxShadow=${sel.boxShadow}`,
    );
    expect_(
      sel.opacity > 0.9,
      `未接入的工序被点中时亮起来（opacity=${sel.opacity}）`,
      `点中之后还是灰的（opacity=${sel.opacity}）—— 最需要看清的时候它最暗`,
    );

    /* ---------- 10. 任务图上的权限四件套（React Flow 那版，待退役） ---------- */
    /*
      任务图是**纯客户端渲染**的 —— SSR 出来的 HTML 里一个节点都没有
      （实测过：data-node-actor / 「要人点头」/「AI · 只读」全是 false）。
      所以这一组只能在浏览器里验，加在这个脚本里而不是 e2e-run 里。

      这一组测的是**设计意图有没有真的传到界面上**：
      核心层改了 access 而图上还画着旧徽章的话，看的人仍然会误解。
    */
    heading("第十步 · 任务图上的权限（React Flow 那版，待退役）");

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