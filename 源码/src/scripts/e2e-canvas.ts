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
import Database from "better-sqlite3";
import { PLANNING_ROOT_ID } from "@/core/planning/from-run";
import { fitFloor } from "@/core/canvas/viewport";
import { expect_, finish, heading, info, ok, signUp } from "./e2e-kit";

/**
 * 给测试账号造一条「跑到验收」的运行。
 *
 * ── 为什么要造，而不是真跑一次 ──
 *   真跑一次要调模型、花钱、等几十秒 —— e2e 不该为了验一棵树去生成一个应用。
 *   而子树是**只有跑过验收才有**的东西，不造的话画布上永远是空的。
 *
 * ── 造出来的必须"真的可能出现" ──
 *   下面七项就是 inspectArtifact 真正产出的那七项，results 的形状
 *   （name / pass / detail）和真实事件逐字段一致。
 *   造一个现实里不可能出现的形状，这条断言就失去意义了。
 *
 * ── 故意让一项不过 ──
 *   "有事件处理" 设为 fail。全是 pass 的话，
 *   tone 有没有真的读进渲染是看不出来的。
 */
function seedVerifyRun(username: string): { runId: string; count: number } {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-tree-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'verify', 'done', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：一棵有子树的验收", now, now);

    const results = [
      { name: "完整 HTML 结构", pass: true, detail: "产物含 html/head/body 三段完整结构" },
      { name: "内联样式", pass: true, detail: "样式全部内联，没有外部样式表引用" },
      { name: "内联脚本", pass: true, detail: "脚本全部内联，没有外部 js 引用" },
      { name: "完全自包含（无外部引用）", pass: true, detail: "没有任何指向外部域名的引用" },
      { name: "有事件处理", pass: false, detail: "没有找到 addEventListener 或 on* 属性" },
      { name: "数据能持久化", pass: true, detail: "用到了 localStorage 存取" },
      { name: "中文界面", pass: true, detail: "界面文案是中文" },
    ];

    db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, ?, ?, 'check', ?)`,
    ).run(
      runId,
      0,
      now,
      JSON.stringify({
        kind: "check",
        results,
        summary: {
          total: results.length,
          passed: results.filter((r) => r.pass).length,
          failed: results.filter((r) => !r.pass).length,
          failures: results.filter((r) => !r.pass),
        },
      }),
    );

    return { runId, count: results.length };
  } finally {
    db.close();
  }
}

/** 删掉夹具。e2e 跑完不该在库里留东西 */
function cleanupVerifyRun(runId: string): void {
  const db = new Database("./data/nexus.db");
  try {
    db.prepare("DELETE FROM run_events WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  } finally {
    db.close();
  }
}

/* ============================================================
   视口策略（第二十步）用的夹具
   ------------------------------------------------------------
   这一步要验的是「推进到下一步时视口跟过去」，所以要能**制造一次推进**。
   真跑一次运行要调模型、花钱、几十秒 —— e2e 不该为了验一个视口去生成应用。
   所以这里造一条"正在跑"的运行，然后在测试过程中**改库 + 让页面重新渲染**，
   推进就是这样被造出来的（改库见 advanceFixture，重新渲染见第二十步）。

   ⚠️ 造出来的必须是"真的可能出现"的形状：
      runs 那一行的 stage/status 是并行构建开工时的真实取值，
      三条事件分别是规格化的 phase、验收的 check、并行构建的 phase ——
      都是真实代码里会发出的那几种，payload 形状逐字段一致。
      （七项检查的 results 与 seedVerifyRun 用的是同一份。
        那条运行是 done、这条是 running，所以这里让 spec 和 build 同时在跑 ——
        回退重跑的运行真的会同时有两道工序活着。）
   ============================================================ */

/** 一条「正在跑、而且带子树」的运行。返回运行 id */
function seedAdvancingRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-vp-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'build', 'running', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：正在跑的运行（验视口跟随）", now, now);

    const results = [
      { name: "完整 HTML 结构", pass: true, detail: "产物含 html/head/body 三段完整结构" },
      { name: "内联样式", pass: true, detail: "样式全部内联，没有外部样式表引用" },
      { name: "内联脚本", pass: true, detail: "脚本全部内联，没有外部 js 引用" },
      { name: "完全自包含（无外部引用）", pass: true, detail: "没有任何指向外部域名的引用" },
      { name: "有事件处理", pass: false, detail: "没有找到 addEventListener 或 on* 属性" },
      { name: "数据能持久化", pass: true, detail: "用到了 localStorage 存取" },
      { name: "中文界面", pass: true, detail: "界面文案是中文" },
    ];

    /*
      三条事件按 seq 排开，而"当前工序"就是投影里**第一个 running 的工序**
      （见 /canvas 上那段判定）。刚造好时它落在**第一道（规格化）**上 ——
      这很重要：后面删掉 spec 那条 phase，"当前工序"就会自己走到 build，
      于是一次推进是真的由数据推出来的，不是脚本写死的。
    */
    const rows: [number, string, unknown][] = [
      [0, "phase", { kind: "phase", phase: "spec", label: "正在把你的需求整理成规格" }],
      [
        1,
        "check",
        {
          kind: "check",
          results,
          summary: {
            total: results.length,
            passed: results.filter((r) => r.pass).length,
            failed: results.filter((r) => !r.pass).length,
            failures: results.filter((r) => !r.pass),
          },
        },
      ],
      [2, "phase", { kind: "phase", phase: "generating", label: "正在生成" }],
    ];
    const ins = db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [seq, kind, payload] of rows) {
      ins.run(runId, seq, now + seq, kind, JSON.stringify(payload));
    }

    return runId;
  } finally {
    db.close();
  }
}

/**
 * 改库：删掉某一条事件 —— 于是投影出来的"当前工序"会往前走。
 *
 * ── 为什么推进要这样做，而不是等真运行 ──
 *   验的是**视口跟着当前工序走**，而"当前工序"是从事件投影出来的。
 *   删掉规格化唯一的那条痕迹，规格化就回到 pending（没有痕迹就是没跑过，
 *   见 from-run.ts 的诚实底线），于是当前工序自然变成仍在跑的并行构建。
 *   这是**数据驱动的一次推进**，不是脚本假装推进了一下。
 */
function dropRunEvent(runId: string, seq: number): void {
  const db = new Database("./data/nexus.db");
  try {
    db.prepare("DELETE FROM run_events WHERE run_id = ? AND seq = ?").run(runId, seq);
  } finally {
    db.close();
  }
}

/**
 * 一条"陪跑"的运行：唯一用途是被删掉，从而触发一次服务端重新渲染。
 *
 * ── 为什么要这么绕 ──
 *   改库之后页面还不知道 —— 得让它重新渲染。而**整页刷新不算**：
 *   刷新会重新挂载组件，而挂载按规矩是不自动聚焦的（那正是另一条规矩），
 *   于是"推进后是否聚焦"这件事永远测不出来。
 *   删一条别的运行会走服务端动作（deleteRunAction → revalidate + redirect），
 *   那是一次**客户端导航**：服务端重新渲染、组件不重新挂载 —— 正好。
 *
 * created_at 故意比主夹具早一分钟：删完之后页面会跳回 /canvas（不带 run），
 * 那时选中的是"最近一条"，得让主夹具仍然是最新的那一条。
 */
function seedBystanderRun(username: string, tag: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-vp-bystander-${tag}-${Date.now().toString(36)}`;
    const then = Date.now() - 60_000;
    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'spec', 'done', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, `端到端夹具：陪跑（${tag}）`, then, then);
    return runId;
  } finally {
    db.close();
  }
}

/**
 * 给测试账号造一条「刚跑到第一道工序、**一条 check 事件都还没有**」的运行。
 *
 * ── 为什么非要这一条夹具 ──
 *   左侧清单最要紧的一句话是「还没到点的那几道工序，界面上说什么」。
 *   而"没有 check 事件"正是"还没到点"最干净的样子：
 *   六道工序一个执行点都还没出生，清单上就该是六个「待规划」。
 *
 *   上面那条带 7 项检查的夹具验不了这件事：它的七个子节点全在「验收」下面，
 *   另外五道确实是占位，但"六道**全部**是占位"这种最容易画错的情况碰不到 ——
 *   比如有人把占位行写成"只给第一道补"，那条夹具照样是绿的。
 *
 * ── 造出来的必须真的可能出现 ──
 *   这一条 phase:"spec" 就是规格化开工时真正发出的那条
 *   （spec-stage.ts 里 `yield { kind: "phase", phase: "spec", label: "正在把你的需求整理成规格" }`），
 *   runs 那一行的 stage/status 也是那个时候库里的真实取值。
 *   造一个现实里不可能出现的形状，底下那些断言就失去意义了。
 */
function seedRunningRun(username: string): string {
  const db = new Database("./data/nexus.db");
  try {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
      | { id: number }
      | undefined;
    if (!user) throw new Error(`找不到测试账号 ${username}`);

    const runId = `e2e-plan-${Date.now().toString(36)}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO runs (id, user_id, prompt, stage, status, workflow_version, created_at, updated_at)
       VALUES (?, ?, ?, 'spec', 'running', 'e2e-fixture', ?, ?)`,
    ).run(runId, user.id, "端到端夹具：还没跑到验收的运行", now, now);

    db.prepare(
      `INSERT INTO run_events (run_id, seq, at, kind, payload) VALUES (?, 0, ?, 'phase', ?)`,
    ).run(
      runId,
      now,
      JSON.stringify({ kind: "phase", phase: "spec", label: "正在把你的需求整理成规格" }),
    );

    return runId;
  } finally {
    db.close();
  }
}

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

    /*
      ⚠️ 四分布局之后画布**不再从窗口左上角开始** —— 左边多了一块清单面板。
      滚轮事件的 x/y 是**页面坐标**，而画布的缩放锚点用的是**画布内坐标**
      （canvas-stage.tsx 那一行是 `e.clientX - rect.left`）。
      以前画布占满整行，两种坐标恰好相等，所以可以混着用；
      现在它们差着清单面板的宽度 —— 拿页面坐标去和画布内的平移量比，
      算出来的期望值会偏 "面板宽度 × (1 - 缩放变化比)"，几百像素的偏差。
      所以锚点按画布量一次，下面的期望平移用**画布内**的那个 x。

      （纵向不用换算：四分布局只动了左右，画布的上边界没变。）
    */
    const stageLeftRaw = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const r = document.querySelector('[data-canvas-stage]').getBoundingClientRect();
        return JSON.stringify({ left: r.left, top: r.top });
      })()`,
      returnByValue: true,
    });
    const stageAt = JSON.parse(stageLeftRaw.result!.value!) as { left: number; top: number };
    const anchorLocalX = anchorX - stageAt.left;
    info(
      `画布左上角在页面 (${Math.round(stageAt.left)}, ${Math.round(stageAt.top)})，` +
        `光标 ${anchorX} 换算成画布内 x = ${Math.round(anchorLocalX)}`,
    );

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
    const worldX = (anchorLocalX - initial.panX) / (initial.gridStep / 160);
    const expectPanX = anchorLocalX - worldX * (zoomedIn.gridStep / 160);
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
      连线：只有顺序流转的实线。

      ⚠️ 以前这里断言「五道工序各有一条失败回退边」（虚线弧）。
         按用户要求删掉了 —— 回退是**流程内部的机制**，不画在画布上：
         六道工序之间那条顺序实线已经说清「谁接谁」，再叠一层虚弧线，
         读者得先去分辨「这条虚线是什么」，而那件事跟他此刻要看的东西无关。

         断言从「虚线有 5 条」改成「**一条虚线都没有**」——
         这不是放松测试，是把它调转方向去守新的约定：
         画布上不该再出现回退弧线。机制本身还在（node.fallbackTo 照建、
         失败该退到哪照算、点开工序看详情仍然列着回退目标），只是不再画。
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
    info(`连线：共 ${ed.total} 条，其中虚线 ${ed.dashed} 条`);

    expect_(
      ed.total >= 5,
      `顺序流转的实线还在（共 ${ed.total} 条）`,
      `连一条线都没有（${ed.total}）—— 画布不该连"谁接谁"都不画`,
    );
    expect_(
      ed.dashed === 0,
      "画布上没有回退弧线（回退留在流程内部，不显示）",
      `出现了 ${ed.dashed} 条虚线 —— 回退弧线不该再画出来`,
    );

    /*
      ⚠️ 父子连线：**没有它，子树就只是"另一堆漂着的卡片"。**

      用户的反馈原话：「为什么没有树节点的效果」——
      当时子方块确实画出来了，但和父工序之间没有任何连线，
      所以看起来不像「挂在这一步下面」。

      这条断言守的不是"有没有画子方块"（那有别的断言管），
      而是**父子之间有没有被连起来**。数目必须等于子节点数 ——
      少一条就意味着某个子节点是个孤儿方块。
    */
    const linkCheck = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const links = document.querySelectorAll('[data-canvas-tree-link]');
        const chips = document.querySelectorAll('[data-canvas-child]');
        return JSON.stringify({ links: links.length, chips: chips.length });
      })()`,
      returnByValue: true,
    });
    const lk = JSON.parse(linkCheck.result!.value!) as { links: number; chips: number };
    info(`子树：${lk.chips} 个子方块，${lk.links} 条父子连线`);

    if (lk.chips > 0) {
      expect_(
        lk.links === lk.chips,
        `每个子方块都有一条线连回父工序（${lk.links}/${lk.chips}）`,
        `有 ${lk.chips} 个子方块，却只有 ${lk.links} 条父子连线 —— 会有孤儿方块`,
      );
    }

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

    /* ---------- 10. 详情面板 ---------- */
    heading("第十步 · 点开工序看详情");

    const detail = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-stage-detail]');
        if (!el) return JSON.stringify({ missing: true });
        const t = el.textContent;
        return JSON.stringify({
          hasAuthority: t.includes("谁在做"),
          hasWatches: t.includes("看什么数"),
          hasRationale: t.length > 120,
          text: t.slice(0, 60),
        });
      })()`,
      returnByValue: true,
    });
    const dt = JSON.parse(detail.result!.value!) as {
      missing?: boolean;
      hasAuthority?: boolean;
      hasWatches?: boolean;
      hasRationale?: boolean;
      text?: string;
    };

    expect_(!dt.missing, "点开工序后有详情面板", "点了却没出现详情面板");
    expect_(dt.hasRationale === true, "详情里有「这一步为什么存在」", "详情里没有原理那一段");
    /*
      权限说明和「看什么数」是这一版新长出来的两段 ——
      卡片上只放得下几个字（AI · 干活 / 要人点头），
      而"为什么是这样"需要一整句话，只能放这儿。
    */
    expect_(dt.hasAuthority === true, "详情里有权限说明", "详情里缺权限说明");
    expect_(dt.hasWatches === true, "详情里有「看什么数」", "详情里缺看什么数");

    /* ---------- 11. 工作台面板里是同一张图 ---------- */
    /*
      /studio?tab=graph 那张图以前是 React Flow 画的（208×136、一行三个）。
      现在换成和 /canvas 同一个组件，@xyflow/react 也卸了。

      这一组守的是"两处真的合成一处了"：
      如果哪天有人把工作台那份改回另一套实现，节点上就没有
      data-pipeline-stage，这里会红。
    */
    heading("第十一步 · 工作台面板里是同一张图");

    await cdp.send("Page.navigate", { url: `${BASE}/studio?tab=graph` });
    await sleep(4500);

    const panel = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const q = (s) => [...document.querySelectorAll(s)];
        const zoom = document.querySelector('[data-canvas-zoom]');
        const first = q('[data-pipeline-stage]')[0];
        const b = first ? first.getBoundingClientRect() : null;
        return JSON.stringify({
          ids: q('[data-pipeline-stage]').map(el => el.getAttribute('data-pipeline-stage')),
          hasWorld: !!document.querySelector('[data-canvas-world]'),
          zoom: zoom ? zoom.textContent.trim() : null,
          cardW: b ? Math.round(b.width) : null,
        });
      })()`,
      returnByValue: true,
    });
    const pn = JSON.parse(panel.result!.value!) as {
      ids: string[];
      hasWorld: boolean;
      zoom: string | null;
      cardW: number | null;
    };

    info(`面板里的工序：${pn.ids.join(" ")}，缩放 ${pn.zoom}，卡片宽 ${pn.cardW}px`);

    expect_(pn.hasWorld, "面板里也用的是自绘画布", "面板里没有世界坐标层 —— 换回别的实现了？");
    expect_(
      pn.ids.length === 6,
      "面板里也是六道工序",
      `只有 ${pn.ids.length} 道：${pn.ids.join(" ")}`,
    );

    /*
      【关键】面板里的字必须读得清。

      面板实测 808×371。一开始摆成一行六个，自动适应算出 37%，
      卡片只有 114 宽 —— 六个全看见了，可字 7 像素。
      现在摆成三列两行、并且给自动适应加了下限，卡片 149 宽。

      这条断言的阈值是量出来的：15px 的标题乘 0.62 还剩 9px，
      正文 11px 还剩 7px —— 刚好读得出来。再小就不行了。
    */
    expect_(
      pn.cardW !== null && pn.cardW >= 130,
      `面板里的卡片宽 ${pn.cardW}px，字读得清`,
      `卡片只有 ${pn.cardW}px 宽 —— 字会缩到看不清`,
    );

    /* ---------- 12. 全局顶栏在所有页面上的位置一致 ---------- */
    /*
      这一条守的是**以后**：新加页面时如果自己写一个 header，
      或者忘了用全局的 AppNav，这里会红。

      为什么值得一条断言：
        以前有三套顶栏，页边距各不相同 ——
          HomeNav        px-8 + max-w-1400
          CockpitHeader  px-6
          设置页现写的    max-w-5xl 居中（品牌落在 x=472）
        表现是**换一个页面，导航就横向跳一下**，而宽屏上跳得更多。
        这种东西靠自觉守不住，得让它在测试里红一次。
    */
    heading("第十二步 · 顶栏在所有页面上位置一致");

    const routes = ["/", "/canvas", "/studio?tab=graph", "/settings", "/welcome"];
    const seen: Array<{ route: string; brandLeft: number | null; navCount: number }> = [];

    for (const route of routes) {
      await cdp.send("Page.navigate", { url: `${BASE}${route}` });
      await sleep(2200);
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          /*
            ⚠️ 按 data-app-nav 认顶栏，**不能**按"页面里第一个 header"。
            <header> 是个合法的语义化标签，卡片和区块都会用 ——
            设置页就有三个（顶栏 + 两张卡片）。按标签数会把它们一起数进来，
            于是报"出现了多个顶栏"，而实际上只有一个。
          */
          const navs = [...document.querySelectorAll('[data-app-nav]')];
          const nav = navs[0] ?? null;
          const brand = nav ? nav.querySelector('a') : null;
          const b = brand ? brand.getBoundingClientRect() : null;
          return JSON.stringify({
            brandLeft: b ? Math.round(b.left) : null,
            navCount: navs.length,
          });
        })()`,
        returnByValue: true,
      });
      const v = JSON.parse(r.result!.value!) as { brandLeft: number | null; navCount: number };
      seen.push({ route, ...v });
    }

    info(seen.map((s) => `${s.route}=${s.brandLeft}`).join("  "));

    const missing = seen.filter((s) => s.brandLeft === null);
    expect_(
      missing.length === 0,
      "五个页面都有顶栏",
      `这几个页面没有顶栏：${missing.map((s) => s.route).join(" ")}`,
    );

    // 位置必须**完全一样** —— 差一像素都说明有人自己写了一层
    const lefts = new Set(seen.map((s) => s.brandLeft));
    expect_(
      lefts.size === 1,
      `顶栏品牌在所有页面都落在同一个 x（${[...lefts][0]}px）`,
      `品牌位置不一致：${seen.map((s) => `${s.route}=${s.brandLeft}`).join(" ")}`,
    );

    // 一页只能有一个顶栏。两个的话多半是路由组的 layout 和页面各写了一个
    const doubled = seen.filter((s) => s.navCount > 1);
    expect_(
      doubled.length === 0,
      "每个页面只有一个顶栏",
      `这几个页面出现了多个顶栏：${doubled.map((s) => `${s.route}(${s.navCount})`).join(" ")}`,
    );

    /* ---------- 13. 缩小时文字让位 ---------- */
    /*
      这一条守的是「缩小之后屏幕上还剩什么」。

      缩小到一定程度，卡片上的小字会变成一层 6 像素的灰渣 ——
      看着像渲染坏了，而不像「故意缩小」。
      所以要藏的是**字**，不是信息：色块、边框、状态色全都留着。

      ⚠️ 断言的是 `color: transparent` 而不是 `display: none`。
         屏幕阅读器用户不经历「缩放」，对他们内容必须还在 ——
         display:none 会把文字从可访问性树里摘掉。
         这条断言就是在守这件事，别让人以后"顺手"改成 display:none。
    */
    heading("第十三步 · 缩小时文字让位（但信息不消失）");

    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    /** 读当前档位 + 一条次要文字的实际颜色 */
    const readTier = async () => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const world = document.querySelector('[data-canvas-world]');
          const minor = document.querySelector('[data-canvas-label="minor"]');
          const major = document.querySelector('[data-canvas-label="major"]');
          const zoom = document.querySelector('[data-canvas-zoom]');
          const cs = (el) => (el ? getComputedStyle(el).color : null);
          return JSON.stringify({
            tier: world ? world.getAttribute('data-label-tier') : null,
            zoom: zoom ? zoom.textContent.trim() : null,
            minor: cs(minor),
            major: cs(major),
            // 元素还在不在 DOM 里 —— 在，只是看不见
            minorCount: document.querySelectorAll('[data-canvas-label="minor"]').length,
          });
        })()`,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as {
        tier: string | null;
        zoom: string | null;
        minor: string | null;
        major: string | null;
        minorCount: number;
      };
    };

    const clickZoom = async (label: string, times: number) => {
      for (let i = 0; i < times; i++) {
        await cdp.send("Runtime.evaluate", {
          expression: `(() => {
            const b = document.querySelector('button[aria-label="${label}"]');
            if (b && !b.disabled) b.click();
            return true;
          })()`,
          returnByValue: true,
        });
        await sleep(260);
      }
    };

    /**
     * 一直缩，直到档位不再是「全都显示」。
     *
     * 为什么不用固定的点击次数：每点一次是 ÷1.25，
     * 而起始倍率取决于自动适应（屏宽不同就不一样）。
     * 第一版写死「点三次」—— 70% 点三次直接到 36%，
     * **越过了中间那一档**，于是断言在测一个根本没出现过的状态。
     * 按「档位变了就停」来找，换任何屏宽都成立。
     */
    const shrinkUntilTierChanges = async (max = 8) => {
      for (let i = 0; i < max; i++) {
        await clickZoom("缩小", 1);
        const t = await readTier();
        if (t.tier !== "all") return { ...t, clicks: i + 1 };
      }
      return { ...(await readTier()), clicks: max };
    };

    /**
     * 一直放大，直到档位回到「全都显示」。
     *
     * ⚠️ 这一步以前是「打开时的档位就该是 all」，四分布局之后不成立了：
     *    左清单 17rem + 右内容 22rem 吃掉 624px，1440 屏上画布只剩 786px，
     *    自动适应算出来 36%，按"字还能读到哪一档"的下限停在 45% ——
     *    档位 major（工序名和序号看得见，次要文字让位）。
     *    这不是坏掉，是版面变小之后的正确结果，理由写在
     *    core/canvas/viewport.ts 的 fitFloor 里（有单测钉着这个算式）。
     *
     * 而这一步要验的**不是**打开时的倍率（那是第三步和第八步的事），
     * 是档位阶梯本身：all → major → none → 放大回来还是 all。
     * 所以先放大到 all 再开始 —— 阶梯的起点不再依赖屏宽，
     * 和下面 shrinkUntilTierChanges 那段注释是同一条理由的延伸。
     */
    const growToAll = async (max = 6) => {
      for (let i = 0; i < max; i++) {
        const t = await readTier();
        if (t.tier === "all") return { ...t, clicks: i };
        await clickZoom("放大", 1);
      }
      return { ...(await readTier()), clicks: max };
    };

    const start = await growToAll();
    info(`放大 ${start.clicks} 次后开始测阶梯：缩放 ${start.zoom}，档位 ${start.tier}`);
    expect_(
      start.tier === "all",
      `放大到字全都在（缩放 ${start.zoom}）`,
      `放大 ${start.clicks} 次后档位还是 ${start.tier} —— 字没能全回来`,
    );
    expect_(
      (start.minor ?? "").startsWith("rgb") || (start.minor ?? "").startsWith("#"),
      "倍率够大时次要文字是有颜色的",
      `次要文字的颜色是 ${start.minor}`,
    );

    // 缩到中间档
    const mid = await shrinkUntilTierChanges();
    info(`缩 ${mid.clicks} 次后：缩放 ${mid.zoom}，档位 ${mid.tier}`);
    expect_(
      mid.tier === "major",
      `缩到 ${mid.zoom} 时只剩次要文字被藏（档位 ${mid.tier}）`,
      `档位是 ${mid.tier}，期望 major`,
    );
    expect_(
      mid.minor === "rgba(0, 0, 0, 0)" || mid.minor === "transparent",
      "次要文字变成了透明",
      `次要文字的颜色还是 ${mid.minor} —— 缩小后它会糊成一层灰渣`,
    );
    expect_(
      mid.major !== null && mid.major !== "rgba(0, 0, 0, 0)" && mid.major !== "transparent",
      "工序名和序号还留着（这一档还要看得见是哪一道",
      `连工序名也没了（颜色 ${mid.major}）—— 那就不是"让位"，是把信息一起藏了`,
    );

    // 再缩到只剩色块
    await clickZoom("缩小", 3);
    const far = await readTier();
    info(`再缩三次后：缩放 ${far.zoom}，档位 ${far.tier}`);
    expect_(
      far.tier === "none",
      `缩到 ${far.zoom} 时文字全藏（档位 ${far.tier}）`,
      `档位是 ${far.tier}，期望 none`,
    );
    expect_(
      far.minorCount > 0,
      "文字只是看不见，元素仍然在 DOM 里（屏幕阅读器还读得到）",
      "次要文字从 DOM 里消失了 —— 那是把无障碍做成了功能缺失",
    );

    // 放大回来，字要自己回来
    await clickZoom("放大", 6);
    const back = await readTier();
    info(`放大回来：缩放 ${back.zoom}，档位 ${back.tier}`);
    expect_(
      back.tier === "all",
      "放大之后文字自己回来了",
      `放大到 ${back.zoom} 档位还是 ${back.tier}`,
    );

    /* ---------- 14. 界面上没有指向退役页面的链接 ---------- */
    /*
      这一条守的是「/studio 真的退役了」。

      退役一个页面最怕的不是入口没了，而是**有人还指着它**。
      这种东西靠人工 grep 守不住。

      ⚠️ 断言的是界面上没有链接指向它，**不是路由打不开**。
         /studio 的文件全部保留、敲地址仍然能打开 ——
         那是故意的：真要删是另一件事。
    */
    heading("第十四步 · 界面上没有指向退役页面的链接");

    const liveRoutes = ["/", "/canvas", "/settings", "/welcome", "/login", "/register"];
    const stray: string[] = [];
    let navLinkCount = -1;

    for (const route of liveRoutes) {
      await cdp.send("Page.navigate", { url: `${BASE}${route}` });
      await sleep(1600);
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const nav = document.querySelector('[data-app-nav]');
          return JSON.stringify({
            hrefs: [...document.querySelectorAll('a[href]')]
              .map((a) => a.getAttribute('href'))
              .filter((h) => h && h.includes('/studio')),
            navLinks: nav ? nav.querySelectorAll('a[href]').length : -1,
          });
        })()`,
        returnByValue: true,
      });
      const v = JSON.parse(r.result!.value!) as { hrefs: string[]; navLinks: number };
      if (v.hrefs.length > 0) stray.push(`${route} -> ${v.hrefs.join(", ")}`);
      if (v.navLinks > 0) navLinkCount = v.navLinks;
    }

    info(`查了 ${liveRoutes.length} 个页面，顶栏链接 ${navLinkCount} 个`);

    expect_(
      stray.length === 0,
      `${liveRoutes.length} 个页面上都没有指向 /studio 的链接`,
      `这些页面还指着退役的工作台：${stray.join("  |  ")}`,
    );

    expect_(
      navLinkCount === 4,
      "顶栏是 品牌 + 三项（首页 / 构建 / 设置）",
      `顶栏有 ${navLinkCount} 个链接`,
    );

    /* ---------- 15. 子树真的画出来了 ---------- */
    /*
      ⚠️ 这一条填的是一个**验证空洞**。

      前面十四步用的都是全新的测试账号 —— 那个账号没有任何运行记录、
      也就没有任何检查结果。所以画布上的子节点数**永远是 0**，
      关于子树的那些断言全都空转（`if (chips > 0)` 直接跳过）。

      这件事必须说清楚：**那一版看起来"绿了"，但什么都没验证。**
      子树是这个项目最核心的视觉产出，不能只靠人眼看截图。

      所以这一步**给测试账号造一条带检查结果的运行** ——
      直接往库里插一行 runs + 一条 kind:"check" 的事件，
      然后打开 /canvas?run=<id>，断言子树真的长出来了。

      ── 为什么可以直接插库 ──
        这是**测试夹具**，插的是测试账号的一次运行，用完就删。
        生成一次真的运行要调模型、花钱、还要等几十秒 ——
        e2e 不该为了验一棵树去跑一次生成。

      ── 造的数据必须是**真的能出现的** ──
        下面这七项就是 inspectArtifact 真正产出的那七项，
        results 的形状和真实事件逐字段一致。造一个现实里不可能出现的
        形状（比如 name 变成数字）就让这条断言失去意义了。
    */
    heading("第十五步 · 子树真的画出来了（造一条带检查结果的运行）");

    const seeded = seedVerifyRun(username);
    info(`造了一条运行 ${seeded.runId.slice(0, 8)}，带 ${seeded.count} 项检查`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${seeded.runId}` });
    await sleep(4200);

    const treeRaw = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const chips = [...document.querySelectorAll('[data-canvas-child]')];
        const links = [...document.querySelectorAll('[data-canvas-tree-link]')];
        const trunks = [...document.querySelectorAll('[data-canvas-tree-trunk]')];
        /*
          某个父节点名下有几条横枝。

          ⚠️ 必须按父节点分开数，不能再用"横枝总数 === 子方块数"。
             三层树里**有两个父节点有孩子**：一级 Agent（→ 六道工序）
             和验收（→ 七项检查）。总数是 6 + 7 = 13，
             而子方块只有 7 个 —— 拿总数去比，这条断言必然红，
             而它想守的"没有孤儿方块"其实好好的。
             按父节点数就没这个问题，而且比原来更严：
             现在连"六道工序各自有没有连回一级 Agent"也一起验了。
        */
        const branchesOf = (pid) => {
          const trunk = document.querySelector('[data-canvas-tree-trunk="' + pid + '"]');
          const g = trunk ? trunk.closest('g') : null;
          return g ? g.querySelectorAll('[data-canvas-tree-link]').length : 0;
        };
        return JSON.stringify({
          chips: chips.length,
          links: links.length,
          trunks: trunks.length,
          verifyLinks: branchesOf('verify'),
          // 每张子卡是不是真的"有内容"，而不是只有一个标题
          withStatus: chips.filter(c => c.querySelector('[data-child-status]')).length,
          withDetail: chips.filter(c => c.querySelector('[data-child-detail]')).length,
          withMetric: chips.filter(c => c.querySelector('[data-child-metric]')).length,
          tones: chips.map(c => c.getAttribute('data-child-tone')),
          // 子卡是不是真的和主卡同一套：有边框、有底色、有圆角
          styled: chips.filter(c => {
            const s = getComputedStyle(c);
            return s.borderTopWidth !== '0px' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
          }).length,
        });
      })()`,
      returnByValue: true,
    });
    const tree = JSON.parse(treeRaw.result!.value!) as {
      chips: number;
      links: number;
      trunks: number;
      verifyLinks: number;
      withStatus: number;
      withDetail: number;
      withMetric: number;
      tones: string[];
      styled: number;
    };
    info(
      `子方块 ${tree.chips} 个 · 连线 ${tree.links} 条（其中验收名下 ${tree.verifyLinks} 条）· ` +
        `躯干 ${tree.trunks} 条 · 带状态 ${tree.withStatus} · 带依据 ${tree.withDetail} · 带数值 ${tree.withMetric}`,
    );

    expect_(
      tree.chips === seeded.count,
      `${seeded.count} 项检查长成了 ${seeded.count} 个方块`,
      `只画出了 ${tree.chips} 个方块`,
    );
    /*
      连线数必须等于方块数 —— 少一条就是"孤儿方块"。
      注意退化横枝（孩子横跨脊线）也渲染了零长度的线，
      所以这个等式在最后一行只有 1 个孩子时仍然成立。

      ⚠️ 数的是**验收名下**的横枝（7 条），不是全画布的横枝（13 条）——
         多出来的 6 条是一级 Agent 连给六道工序的。理由见上面 branchesOf 那段。
    */
    expect_(
      tree.verifyLinks === tree.chips,
      `每个方块都有一条线连回父工序（${tree.verifyLinks}/${tree.chips}）`,
      `有 ${tree.chips} 个方块，却只有 ${tree.verifyLinks} 条横枝 —— 会有孤儿`,
    );
    /*
      ⚠️ 这一条从「躯干 = 1」改成了「躯干 = 2」。

      ── 为什么必须改，而不是把这条删掉 ──
        躯干是"父节点连给它所有孩子"的那条竖线，一个父节点一条。
        升级成三层树之前，有孩子的工序只有验收一道，所以是 1 条。
        现在多了一层：一级 Agent 也有孩子（六道工序），
        它同样要有一条躯干把自己的六个孩子连起来 —— **2 条是新的正确值**。

        删掉这条的话，"根和六道工序之间没有连线"就没人守了；
        而那种情况下画面上看起来就是"上面飘着一张卡"（用户反馈过的原话：
        「为什么没有树节点的效果」）。所以是改数字 + 写清楚为什么，不是删。
        第十九步里还会按父节点逐条验一次根名下的 6 条横枝。
    */
    expect_(
      tree.trunks === 2,
      "两个父节点各有一条躯干：一级 Agent → 六道工序、验收 → 七项检查",
      `躯干有 ${tree.trunks} 条，应该是 2（一级 Agent 一条 + 验收一条）`,
    );
    /*
      三样内容都要在。用户的原话：「不能只是一个标题」——
      这条断言守的就是那句话：子卡必须和主卡一样有状态、有依据、有数值。
    */
    expect_(
      tree.withStatus === tree.chips &&
        tree.withDetail === tree.chips &&
        tree.withMetric === tree.chips,
      "每张子卡都有状态胶囊、判定依据和底部数值（不是只有一个标题）",
      `缺内容：状态 ${tree.withStatus}/${tree.chips}、` +
        `依据 ${tree.withDetail}/${tree.chips}、数值 ${tree.withMetric}/${tree.chips}`,
    );
    /*
      颜色按结果走：造的 7 项里故意让一项不过，
      如果全是 pass，说明 tone 根本没读进渲染。
    */
    expect_(
      tree.tones.includes("fail") && tree.tones.includes("pass"),
      "通过和未过的方块颜色是不同的（tone 真的读进去了）",
      `tone 只有 ${JSON.stringify([...new Set(tree.tones)])}`,
    );
    /*
      子卡要有边框和底色 —— 这一条守「和主卡同一套视觉语言」。
      退化成一行文字的话这两个都会是 0。
    */
    expect_(
      tree.styled === tree.chips,
      "每张子卡都有边框和底色（和主卡同一套视觉语言，不是一行文字）",
      `只有 ${tree.styled}/${tree.chips} 张有边框和底色`,
    );

    // 用完就删，别把夹具留在库里
    cleanupVerifyRun(seeded.runId);
    info("夹具已清理");

    /* ---------- 16. 双击聚焦 ---------- */
    /*
      这一条守的是**视角的进出**。

      子树长出来之后，六道工序被撑得很开，一屏看不清细节 ——
      所以双击一个工序应该能把视角收进它那棵树里。
      但它和别的功能不同：**它改的是视口，不改 DOM** ——
      不去断言的话，那个 onDoubleClick 挂错了地方也看不出来。

      断言的是**缩放数字**，不是"某个元素的坐标"：
      视口变了最直接的证据就是缩放值变了
      （装下一棵子树需要的倍率和装下整片森林不一样）。
    */
    heading("第十六步 · 双击聚焦（视角的进出）");

    /** 读当前缩放百分比 */
    const readZoom = async (): Promise<number> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('[data-canvas-zoom]')?.textContent?.trim() ?? ''`,
        returnByValue: true,
      });
      return Number(String(r.result!.value).replace("%", ""));
    };

    /*
      ⚠️ 回到没有子树的那次运行再测。
        刚才那次运行（带夹具的）已经被删了，页面还停在上面 ——
        先用一次导航把状态清干净，否则测的是"上一次的视口"。
    */
    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const zoomFar = await readZoom();
    info(`聚焦前：缩放 ${zoomFar}%`);

    /* 双击有子树的那张卡（验收与交付，第六道） */
    const dbl = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const card = document.querySelector('[data-pipeline-stage="verify"]');
        if (!card) return 'no-card';
        const r = card.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`,
      returnByValue: true,
    });
    const at = JSON.parse(dbl.result!.value!) as { x: number; y: number };
    expect_(
      Number.isFinite(at.x) && Number.isFinite(at.y),
      "找得到「验收与交付」那张卡",
      "页面上没有 [data-pipeline-stage=verify]",
    );

    /* 用手打的两下 dblclick —— CDP 的 Input 事件里没有"双击"这个手势 */
    for (const n of [1, 2]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: n,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: n,
      });
    }
    await sleep(900);

    const zoomNear = await readZoom();
    info(`双击「验收与交付」之后：缩放 ${zoomNear}%`);
    expect_(
      zoomNear > zoomFar,
      `双击一个工序会聚焦到它那棵树（${zoomFar}% → ${zoomNear}%）`,
      `缩放没变（还是 ${zoomNear}%）—— 双击没接上，或者聚焦区域算错了`,
    );

    /* 双击空白处回全局 */
    /*
      ⚠️ 空白点必须落在**画布里**，不能是窗口里的某个坐标。

      四分布局之前画布占满整行，(40, 620) 就是"画布左边的空白处"。
      现在窗口左边 272px 是清单面板 —— 同一个坐标点下去，
      事件落在面板上，画布**根本收不到那次双击**，
      于是视口回不到全局，而症状看起来像"双击空白没接上"。

      所以这里按画布的实际位置取：画布内 (40, 500)。
      纵向取 500 是因为六张工序卡在画布内只占到 220 上下，
      再往下就是空白 —— 双击它才是"回全局"。
    */
    const blankRaw = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const r = document.querySelector('[data-canvas-stage]').getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + 500) });
      })()`,
      returnByValue: true,
    });
    const blank = JSON.parse(blankRaw.result!.value!) as { x: number; y: number };
    info(`双击的"空白处"取画布内 (40, 500)，即页面 (${blank.x}, ${blank.y})`);

    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: blank.x,
      y: blank.y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: blank.x,
      y: blank.y,
      button: "left",
      clickCount: 1,
    });
    for (const n of [1, 2]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: blank.x,
        y: blank.y,
        button: "left",
        clickCount: n,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: blank.x,
        y: blank.y,
        button: "left",
        clickCount: n,
      });
    }
    await sleep(900);

    const zoomBack = await readZoom();
    info(`双击空白之后：缩放 ${zoomBack}%`);
    expect_(
      Math.abs(zoomBack - zoomFar) < 1,
      `双击空白处回到全局视口（${zoomNear}% → ${zoomBack}%，原来是 ${zoomFar}%）`,
      `回到 ${zoomBack}%，和进来之前的 ${zoomFar}% 不一样 —— 出不去，或者回错了地方`,
    );

    /* ---------- 17. 四分布局：左清单 / 中画布 / 右内容 ---------- */
    /*
      这一步验的是**版面**：两侧面板真的占住了宽度、真的在画布两侧、
      右侧那块真的是"明说了尚未接入"的占位，清单在没有 check 事件时
      真的说「待规划」，以及整页不出现横向滚动条。

      ── 为什么"没有横向滚动条"值得一条断言 ──
        它是四分布局最容易踩的坑：两个固定宽度面板 + 一个 min-width:auto
        的 flex 子项，只要少写一个 min-w-0，画布就会被内容撑到 1860 宽，
        整页横向滚动。而画布自己的"自动适应"是按**容器宽度**算的 ——
        容器被撑大之后它还算得"对"，只是对错了地方。
        这条断言用一行 CSS 就能满足，写错一行就会红，性价比很高。
    */
    heading("第十七步 · 四分布局：左清单 / 中画布 / 右内容");

    /** 读版面 + 清单。每个数都从 DOM 和计算样式上量，不看类名 */
    const READ_QUAD = `(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left), right: Math.round(r.right),
          w: Math.round(r.width), h: Math.round(r.height),
        };
      };
      const stage = document.querySelector('[data-canvas-stage]');
      const outline = document.querySelector('[data-planning-outline]');
      const content = document.querySelector('[data-step-content]');
      const runningRow = q('[data-outline-row]').find(
        (el) => el.getAttribute('data-outline-status') === 'running',
      );
      const dot = runningRow ? runningRow.querySelector('[data-outline-dot]') : null;
      return JSON.stringify({
        stage: rect(stage),
        outline: rect(outline),
        content: rect(content),
        rows: q('[data-outline-row]').length,
        level1: q('[data-outline-level="1"]').length,
        placeholders: q('[data-outline-placeholder]').length,
        placeholderTexts: [...new Set(q('[data-outline-placeholder]').map((el) => el.textContent.trim()))],
        runningDot: dot ? getComputedStyle(dot).backgroundColor : null,
        hasEmptyState: !!document.querySelector('[data-outline-empty]'),
        contentPlaceholder: !!document.querySelector('[data-step-content-placeholder]'),
        contentText: content ? content.textContent : '',
        // 窄屏按钮：宽屏上必须**不可见**（面板已经常驻）
        visibleToggles: q('[data-panel-toggle]').filter(
          (el) => el.getBoundingClientRect().width > 0,
        ).length,
        docScrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      });
    })()`;

    const readQuad = async () => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_QUAD,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as {
        stage: { left: number; right: number; w: number; h: number } | null;
        outline: { left: number; right: number; w: number; h: number } | null;
        content: { left: number; right: number; w: number; h: number } | null;
        rows: number;
        level1: number;
        placeholders: number;
        placeholderTexts: string[];
        runningDot: string | null;
        hasEmptyState: boolean;
        contentPlaceholder: boolean;
        contentText: string;
        visibleToggles: number;
        docScrollW: number;
        innerW: number;
      };
    };

    /*
      先看"没有选中运行"这一档（上一步结束后页面就停在 /canvas，
      而这个测试账号一条运行都没有）。

      这一档要验的是：清单不编造内容、右侧如实写着"尚未接入"、
      版面本身是四分布局。
    */
    const quadEmpty = await readQuad();
    info(
      `版面：清单 ${quadEmpty.outline?.w}px · 画布 ${quadEmpty.stage?.w}px · ` +
        `内容 ${quadEmpty.content?.w}px（窗口 ${quadEmpty.innerW}px）`,
    );

    expect_(
      quadEmpty.outline !== null,
      "左侧有任务点清单（[data-planning-outline]）",
      "页面上找不到 [data-planning-outline] —— 左侧面板没有渲染",
    );
    expect_(
      quadEmpty.outline !== null &&
        quadEmpty.stage !== null &&
        quadEmpty.outline.right <= quadEmpty.stage.left + 1 &&
        quadEmpty.outline.w >= 264,
      `清单在画布左边，宽 ${quadEmpty.outline?.w}px（17rem）`,
      `清单位置/宽度不对：清单 right=${quadEmpty.outline?.right}，画布 left=${quadEmpty.stage?.left}，宽 ${quadEmpty.outline?.w}`,
    );
    expect_(
      quadEmpty.content !== null &&
        quadEmpty.stage !== null &&
        quadEmpty.content.left >= quadEmpty.stage.right - 1 &&
        quadEmpty.content.w >= 344,
      `内容面板在画布右边，宽 ${quadEmpty.content?.w}px（22rem）`,
      `内容面板位置/宽度不对：内容 left=${quadEmpty.content?.left}，画布 right=${quadEmpty.stage?.right}，宽 ${quadEmpty.content?.w}`,
    );
    /*
      画布比窗口窄 —— 这一条证明两侧是真的**占了宽度**，
      而不是浮在画布上面（浮层的话画布仍然是整窗宽）。
    */
    expect_(
      quadEmpty.stage !== null &&
        quadEmpty.stage.w > 200 &&
        quadEmpty.stage.w < quadEmpty.innerW - 500,
      `画布在中间，宽 ${quadEmpty.stage?.w}px，比窗口窄（两侧真的占了宽度）`,
      `画布宽 ${quadEmpty.stage?.w}px，窗口 ${quadEmpty.innerW}px —— 两侧面板没有占住版面？`,
    );
    expect_(
      quadEmpty.contentPlaceholder,
      "右侧是明确的占位块（[data-step-content-placeholder]）",
      "右侧没有占位块 —— 分不清是没数据还是没接",
    );
    expect_(
      quadEmpty.contentText.includes("尚未接入"),
      "右侧写着「尚未接入」",
      "右侧没有「尚未接入」四个字 —— 那一栏会看起来像已经接好了",
    );
    /*
      1440 屏 ≥ 1280 断点：两侧常驻，那两个窄屏按钮**不该出现**。
      它们要是露出来了，说明断点判断反了 —— 而画布会因此少一大块宽度。
    */
    expect_(
      quadEmpty.visibleToggles === 0,
      "1440 屏上窄屏按钮不显示（≥1280 两侧常驻）",
      `出现了 ${quadEmpty.visibleToggles} 个窄屏按钮 —— 断点判反了`,
    );
    /*
      没有运行就没有计划：清单给空态，**不编造六道工序**。
      六道工序是"这次运行的六道工序"，连运行都没有的时候凭空列出六个
      「待规划」，就是在描述一件不存在的事。
    */
    expect_(
      quadEmpty.rows === 0 && quadEmpty.hasEmptyState,
      "没有选中运行时清单是空态，不编造六道工序",
      `清单里有 ${quadEmpty.rows} 行（应当 0 行 + 空态）`,
    );
    expect_(
      quadEmpty.docScrollW <= quadEmpty.innerW + 1,
      `没有横向滚动条（内容宽 ${quadEmpty.docScrollW} ≤ 窗口 ${quadEmpty.innerW}）`,
      `出现横向滚动条：内容宽 ${quadEmpty.docScrollW} > 窗口 ${quadEmpty.innerW} —— 少写了 min-w-0？`,
    );

    /*
      ---------- 换成一条"还没有任何 check 事件"的运行 ----------
      见 seedRunningRun 上的说明：这一步要验的正是
      「没到点的那几道工序，清单上说什么」。
    */
    const planRun = seedRunningRun(username);
    info(`造了一条运行 ${planRun.slice(0, 8)}，没有任何 check 事件`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${planRun}` });
    await sleep(4200);

    const quadPlan = await readQuad();
    info(
      `清单 ${quadPlan.rows} 行：一级 ${quadPlan.level1} · 占位 ${quadPlan.placeholders} · ` +
        `占位文字 ${JSON.stringify(quadPlan.placeholderTexts)}`,
    );

    expect_(
      quadPlan.level1 === 6,
      "清单里恰好 6 个一级行（六道工序）",
      `一级行有 ${quadPlan.level1} 个，应该是 6`,
    );
    /*
      ★ 这一条是"没到点就说待规划"的硬证据 ★

      这次运行一条 check 事件都没有，所以六道工序下面一个执行点都没出生。
      六行占位就是界面在说六遍「这里将来会有东西，只是还没到点」——
      而"空白"会被读成"跑完了什么都没有"，那是另一件事。
    */
    expect_(
      quadPlan.placeholders === 6,
      `六道工序都给出了「待规划」占位行（${quadPlan.placeholders}/6）`,
      `只有 ${quadPlan.placeholders} 行占位 —— 那几道工序在清单上是空白，用户分不清"没轮到"和"没东西"`,
    );
    expect_(
      quadPlan.placeholderTexts.length === 1 && quadPlan.placeholderTexts[0] === "待规划",
      "占位行的文字就是「待规划」",
      `占位行的文字是 ${JSON.stringify(quadPlan.placeholderTexts)}，期望「待规划」`,
    );
    /*
      状态色必须**真的按 statusTone 走**，不是随手写个绿点。
      这次运行停在规格化（phase:"spec"），所以有一行是 running ——
      调色板里 running 的色调是 green，对应 rgb(74 222 128)，
      和画布上"正在跑"用的是同一个色值（清单和画布必须说同一句话）。
    */
    expect_(
      quadPlan.runningDot === "rgb(74, 222, 128)",
      `正在跑的那道工序色点是绿色 ${quadPlan.runningDot}（和画布同一套状态色）`,
      `正在跑那一行的色点是 ${quadPlan.runningDot}，期望 rgb(74, 222, 128)`,
    );

    cleanupVerifyRun(planRun);
    info("夹具已清理");

    /* ---------- 18. 窄屏降级：两侧收起成覆盖层 ---------- */
    /*
      这一步补的是一个**端到端覆盖缺口**：窄屏（<1280）那条路径此前
      只在一次临时探针里验过（1100×800，15/15 通过），没有进常驻回归 ——
      因为 e2e-canvas 是以固定 1440 窗口启动 Edge 的（--window-size=1440,900）。

      ── 为什么"验过一次"不算数 ──
        一次性验证不是回归：探针跑完就没了，而这条路径连着三件
        会坏、坏了又不报错的事 ——
          1. 断点判反（本该 <1280 收起、却写成 ≥1280 收起）：
             宽屏上画布白白少掉 624px；
          2. 面板没有真的让开（display:none 退化成 opacity:0 之类）：
             画布看着"展开了"，其实仍然被挤掉一半；
          3. 覆盖层进得去出不来：关闭按钮没接上，用户只能刷新页面。
        三条的症状都是"界面不对劲"，不是异常 —— 没有常驻断言，
        就只能靠人偶然撞见。

      ── 怎么补：CDP 视口覆盖，不动浏览器生命周期 ──
        改窗口大小的做法，每个尺寸都要重启一次浏览器，还得把
        会话、Cookie、导航重来一遍 —— "改视口"这件事就渗进脚本结构里，
        现有步骤全得跟着动。
        Emulation.setDeviceMetricsOverride 是**同一会话内**临时改视口：
        浏览器不重启、Cookie 不重来，所以这一步能干干净净地追加在最后，
        上面十七条步骤一条都不用改（也不该改 —— 它们验的是别的事）。

      ── 为什么最后一定要 clearDeviceMetricsOverride ──
        覆盖是会话级的，留着的话"当下 1100 宽"会跟着后面的流程走。
        清掉之后再断言一次视口**精确回到覆盖之前的那个值**：既留个干净状态，
        也顺带证明中间那些变化**确实是这次覆盖造成的**（不是窗口真变了）。
    */
    heading("第十八步 · 窄屏降级（<1280：两侧收起成覆盖层）");

    /** 窄屏下量版面：每个数都从 getBoundingClientRect / getComputedStyle / matchMedia 上读 */
    const READ_NARROW = `(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          left: Math.round(r.left), top: Math.round(r.top),
          right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height),
          position: cs.position, display: cs.display,
        };
      };
      const one = (sel) => box(document.querySelector(sel));
      const toggle = (side) => {
        const el = document.querySelector('[data-panel-toggle="' + side + '"]');
        return { exists: !!el, text: el ? el.textContent.trim() : '', box: box(el) };
      };
      const close = (side) => {
        const el = document.querySelector('[data-panel-close="' + side + '"]');
        return { exists: !!el, box: box(el) };
      };
      return JSON.stringify({
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        wideMedia: window.matchMedia('(min-width: 1280px)').matches,
        outline: one('[data-planning-outline]'),
        content: one('[data-step-content]'),
        dockLeft: one('[data-panel-dock="left"]'),
        dockRight: one('[data-panel-dock="right"]'),
        shell: one('[data-canvas-shell]'),
        stage: one('[data-canvas-stage]'),
        toggleLeft: toggle('left'),
        toggleRight: toggle('right'),
        closeLeft: close('left'),
        closeRight: close('right'),
        docScrollW: document.documentElement.scrollWidth,
      });
    })()`;

    interface NarrowBox {
      left: number;
      top: number;
      right: number;
      w: number;
      h: number;
      position: string;
      display: string;
    }
    interface NarrowSide {
      exists: boolean;
      text?: string;
      box: NarrowBox | null;
    }
    interface NarrowState {
      innerW: number;
      innerH: number;
      wideMedia: boolean;
      outline: NarrowBox | null;
      content: NarrowBox | null;
      dockLeft: NarrowBox | null;
      dockRight: NarrowBox | null;
      shell: NarrowBox | null;
      stage: NarrowBox | null;
      toggleLeft: NarrowSide;
      toggleRight: NarrowSide;
      closeLeft: NarrowSide;
      closeRight: NarrowSide;
      docScrollW: number;
    }

    const readNarrow = async (): Promise<NarrowState> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_NARROW,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as NarrowState;
    };

    const readInnerW = async (): Promise<number> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: "window.innerWidth",
        returnByValue: true,
      });
      return Number(r.result!.value);
    };

    /**
     * 真点一下某个元素的中心。
     * 和上面各步一样走 Input.dispatchMouseEvent，不用 el.click() ——
     * el.click() 绕过命中测试，一个被覆盖层压住的按钮照样"点得动"，
     * 而这里要验的恰恰是"用户真能点到它"。
     *
     * ⚠️ 元素找不到时**不抛异常**，返回 ok:false 让下面那几条断言去红。
     *    抛异常会一路冒到 main().catch，这一步剩下的检查就全不跑了 ——
     *    而"按钮没了/被断点藏了"正是最需要看到完整红名单的时候：
     *    只看一条错误信息，分不清是左边坏了还是右边也坏了。
     */
    const clickCenter = async (
      selector: string,
    ): Promise<{ ok: boolean; x: number; y: number; w: number; h: number }> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return JSON.stringify({ missing: true });
          const b = el.getBoundingClientRect();
          return JSON.stringify({
            x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
            w: Math.round(b.width), h: Math.round(b.height),
          });
        })()`,
        returnByValue: true,
      });
      const at = JSON.parse(r.result!.value!) as {
        missing?: true;
        x: number;
        y: number;
        w: number;
        h: number;
      };
      if (at.missing) return { ok: false, x: 0, y: 0, w: 0, h: 0 };
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: 1,
      });
      return { ok: true, x: at.x, y: at.y, w: at.w, h: at.h };
    };

    /* ---- 0. 覆盖之前先确认还停在宽屏那个视口 ---- */
    /*
      ⚠️ 对照**不能写死 1440**：e2e-canvas 是 `--window-size=1440,900` 起的，
         但窗口外框尺寸不等于视口尺寸 —— 实测 innerWidth 是 1410
         （第十七步那行 info 一直就是这么打的：窗口 1410px）。
         写死 1440 的话这条断言永远红，而它红的原因和窄屏降级毫无关系。

      所以对照取**第十七步在同一浏览器里量到的那个值**：
      它顺带证明了"从第十七步到这里，视口没有被别的东西动过" ——
      这正是下面"清掉覆盖后回到原样"能成立的前提。
    */
    const wideBefore = await readInnerW();
    info(
      `覆盖之前视口 ${wideBefore}px（第十七步量到的是 ${quadPlan.innerW}px；` +
        `--window-size=1440,900 给的是窗口外框，视口比它窄 ${1440 - quadPlan.innerW}px）`,
    );
    expect_(
      wideBefore === quadPlan.innerW && wideBefore >= 1280,
      `覆盖之前仍停在宽屏视口 ${wideBefore}px（和第十七步量到的是同一个，≥1280）`,
      `覆盖之前视口是 ${wideBefore}px，第十七步量到的是 ${quadPlan.innerW}px —— 中间有东西动过视口，下面的对照就不成立了`,
    );

    /* ---- 1. 同一会话内把视口改成 1100×800 ---- */
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    info("Emulation.setDeviceMetricsOverride：1100×800（浏览器没重启，会话和 Cookie 没重来）");

    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const narrow = await readNarrow();
    info(
      `视口 ${narrow.innerW}×${narrow.innerH} · 清单 ${narrow.outline?.w}px · 画布 ${narrow.stage?.w}px · ` +
        `内容 ${narrow.content?.w}px · 两个窄屏按钮 ${narrow.toggleLeft.box?.w}/${narrow.toggleRight.box?.w}px`,
    );

    expect_(
      narrow.innerW === 1100 && !narrow.wideMedia,
      `视口覆盖生效：innerWidth ${narrow.innerW}，matchMedia('(min-width:1280px)') = false`,
      `视口覆盖没生效：innerWidth ${narrow.innerW}，matchMedia 宽屏匹配 = ${narrow.wideMedia}`,
    );

    /* ---- 2. 两个窄屏按钮可见 ---- */
    expect_(
      narrow.toggleLeft.exists &&
        (narrow.toggleLeft.box?.w ?? 0) > 0 &&
        narrow.toggleLeft.text === "清单",
      `窄屏出现「清单」按钮（${narrow.toggleLeft.box?.w}×${narrow.toggleLeft.box?.h}，文字「${narrow.toggleLeft.text}」）`,
      `「清单」按钮不可见：存在=${narrow.toggleLeft.exists} 宽=${narrow.toggleLeft.box?.w} 文字=${narrow.toggleLeft.text}`,
    );
    expect_(
      narrow.toggleRight.exists &&
        (narrow.toggleRight.box?.w ?? 0) > 0 &&
        narrow.toggleRight.text === "内容",
      `窄屏出现「内容」按钮（${narrow.toggleRight.box?.w}×${narrow.toggleRight.box?.h}，文字「${narrow.toggleRight.text}」）`,
      `「内容」按钮不可见：存在=${narrow.toggleRight.exists} 宽=${narrow.toggleRight.box?.w} 文字=${narrow.toggleRight.text}`,
    );

    /* ---- 3. 两侧默认收起：宽度必须是**真 0** ---- */
    /*
      "收起"最容易被写成"看不见"（opacity:0 / 移出屏幕 / visibility:hidden）——
      那三种都还在占版面，画布仍然只有 1100-624=476px。
      所以这里量的是 getBoundingClientRect().width，必须是 0。
    */
    expect_(
      narrow.outline !== null && narrow.outline.w === 0,
      "窄屏默认收起：左侧清单宽度为 0（不占版面）",
      `左侧清单宽 ${narrow.outline?.w}px —— 窄屏下它没有让开（收起写成了"看不见"？）`,
    );
    expect_(
      narrow.content !== null && narrow.content.w === 0,
      "窄屏默认收起：右侧内容宽度为 0（不占版面）",
      `右侧内容宽 ${narrow.content?.w}px —— 窄屏下它没有让开（收起写成了"看不见"？）`,
    );

    /* ---- 4. 画布铺满整个视口宽 ---- */
    expect_(
      narrow.stage !== null && Math.abs(narrow.stage.w - narrow.innerW) <= 2,
      `画布铺满窄屏全宽（${narrow.stage?.w} ≈ 视口 ${narrow.innerW}）—— 两侧是真让开，不是浮层压着`,
      `画布宽 ${narrow.stage?.w}px，视口 ${narrow.innerW}px（差 ${narrow.innerW - (narrow.stage?.w ?? 0)}px）—— 两侧没有让开`,
    );

    /* ---- 5. 没有横向滚动条 ---- */
    expect_(
      narrow.docScrollW <= narrow.innerW + 1,
      `窄屏没有横向滚动条（内容宽 ${narrow.docScrollW} ≤ 视口 ${narrow.innerW}）`,
      `窄屏出现横向滚动条：内容宽 ${narrow.docScrollW} > 视口 ${narrow.innerW}`,
    );

    /* ---- 6. 点「清单」→ 左侧覆盖层 ---- */
    const leftHit = await clickCenter('[data-panel-toggle="left"]');
    info(
      leftHit.ok
        ? `点了「清单」按钮（页面坐标 ${leftHit.x}, ${leftHit.y}）`
        : "页面上没有「清单」按钮可点 —— 下面这一组会红",
    );
    await sleep(400);

    const leftOpen = await readNarrow();
    info(
      `展开后：dock position ${leftOpen.dockLeft?.position} display ${leftOpen.dockLeft?.display} ` +
        `left ${leftOpen.dockLeft?.left} 宽 ${leftOpen.dockLeft?.w} · 面板宽 ${leftOpen.outline?.w}`,
    );
    expect_(
      leftOpen.dockLeft !== null &&
        leftOpen.dockLeft.position === "fixed" &&
        Math.abs(leftOpen.dockLeft.left) <= 1 &&
        Math.abs(leftOpen.dockLeft.w - 272) <= 8 &&
        Math.abs((leftOpen.outline?.w ?? 0) - 272) <= 8,
      `点「清单」展开成覆盖层：position fixed · left ${leftOpen.dockLeft?.left} · 宽 ${leftOpen.outline?.w}px（17rem = 272，只盖左一条）`,
      `清单覆盖层不对：position=${leftOpen.dockLeft?.position} left=${leftOpen.dockLeft?.left} ` +
        `dock 宽=${leftOpen.dockLeft?.w} 面板宽=${leftOpen.outline?.w}（期望 fixed / 0 / 272）`,
    );
    expect_(
      leftOpen.closeLeft.exists && (leftOpen.closeLeft.box?.w ?? 0) > 0,
      `覆盖层里有关闭按钮（[data-panel-close="left"] ${leftOpen.closeLeft.box?.w}×${leftOpen.closeLeft.box?.h}）`,
      `覆盖层里没有可点的关闭按钮：存在=${leftOpen.closeLeft.exists} 宽=${leftOpen.closeLeft.box?.w}`,
    );
    /*
      覆盖层**不是抽屉**：展开面板不该把画布挤窄。
      抽屉推挤的话画布会从 1100 掉到 828 —— 用户正在看的东西被推走一半，
      而他展开面板往往正是为了对照着画布看。

      ⚠️ 同时要求"它确实展开成了 fixed 覆盖层"：
      不加这一句的话，"压根没展开、画布当然还是全宽"也会让这条变绿 ——
      而那正是上面几条红掉时最容易出现的状态，就是一条假绿。
    */
    expect_(
      leftOpen.dockLeft !== null &&
        leftOpen.dockLeft.position === "fixed" &&
        Math.abs((leftOpen.stage?.w ?? 0) - leftOpen.innerW) <= 2,
      `展开覆盖层时画布仍是全宽 ${leftOpen.stage?.w}px（覆盖层只盖一条，不推挤画布）`,
      `展开清单后画布变成 ${leftOpen.stage?.w}px（视口 ${leftOpen.innerW}）—— 这是抽屉推挤，不是覆盖层` +
        `（面板 position=${leftOpen.dockLeft?.position}：根本没展开成覆盖层时这条也算红）`,
    );

    /* ---- 7. 点关闭 → 收回 ---- */
    const leftCloseHit = await clickCenter('[data-panel-close="left"]');
    info(
      leftCloseHit.ok
        ? `点了关闭（页面坐标 ${leftCloseHit.x}, ${leftCloseHit.y}）`
        : "页面上没有关闭按钮可点 —— 下面这条会红",
    );
    await sleep(400);

    const leftClosed = await readNarrow();
    /*
      ⚠️ 这条同样要求"点之前它**真的**是展开的"。
      只看"关闭之后宽度是 0"的话，一个从来没展开过的面板也能让这条变绿。
    */
    expect_(
      leftOpen.dockLeft !== null &&
        leftOpen.dockLeft.position === "fixed" &&
        leftClosed.outline !== null &&
        leftClosed.outline.w === 0 &&
        leftClosed.closeLeft.exists === false,
      "点关闭后左侧清单收回：宽度回到 0，关闭按钮也随之消失",
      `关闭后清单宽 ${leftClosed.outline?.w}px，关闭按钮还在=${leftClosed.closeLeft.exists}` +
        `（点之前展开成覆盖层了吗：position=${leftOpen.dockLeft?.position}）`,
    );

    /* ---- 8. 右侧「内容」同样走一轮（22rem = 352） ---- */
    const rightHit = await clickCenter('[data-panel-toggle="right"]');
    info(
      rightHit.ok
        ? `点了「内容」按钮（页面坐标 ${rightHit.x}, ${rightHit.y}）`
        : "页面上没有「内容」按钮可点 —— 下面这一组会红",
    );
    await sleep(400);

    const rightOpen = await readNarrow();
    info(
      `展开后：dock position ${rightOpen.dockRight?.position} right ${rightOpen.dockRight?.right} ` +
        `宽 ${rightOpen.dockRight?.w} · 面板宽 ${rightOpen.content?.w}`,
    );
    expect_(
      rightOpen.dockRight !== null &&
        rightOpen.dockRight.position === "fixed" &&
        Math.abs(rightOpen.dockRight.right - rightOpen.innerW) <= 1 &&
        Math.abs(rightOpen.dockRight.w - 352) <= 8 &&
        Math.abs((rightOpen.content?.w ?? 0) - 352) <= 8,
      `点「内容」展开成覆盖层：position fixed · right ${rightOpen.dockRight?.right} ≈ 视口 ${rightOpen.innerW} · ` +
        `宽 ${rightOpen.content?.w}px（22rem = 352，贴右边缘）`,
      `内容覆盖层不对：position=${rightOpen.dockRight?.position} right=${rightOpen.dockRight?.right}` +
        `（视口 ${rightOpen.innerW}）dock 宽=${rightOpen.dockRight?.w} 面板宽=${rightOpen.content?.w}（期望 fixed / 1100 / 352）`,
    );
    expect_(
      rightOpen.closeRight.exists && (rightOpen.closeRight.box?.w ?? 0) > 0,
      `内容覆盖层里有关闭按钮（[data-panel-close="right"] ${rightOpen.closeRight.box?.w}×${rightOpen.closeRight.box?.h}）`,
      `内容覆盖层里没有可点的关闭按钮：存在=${rightOpen.closeRight.exists} 宽=${rightOpen.closeRight.box?.w}`,
    );

    const rightCloseHit = await clickCenter('[data-panel-close="right"]');
    info(
      rightCloseHit.ok
        ? `点了关闭（页面坐标 ${rightCloseHit.x}, ${rightCloseHit.y}）`
        : "页面上没有关闭按钮可点 —— 下面这条会红",
    );
    await sleep(400);

    const rightClosed = await readNarrow();
    expect_(
      rightOpen.dockRight !== null &&
        rightOpen.dockRight.position === "fixed" &&
        rightClosed.content !== null &&
        rightClosed.content.w === 0,
      "点关闭后右侧内容收回：宽度回到 0",
      `关闭后内容面板宽 ${rightClosed.content?.w}px（点之前展开成覆盖层了吗：position=${rightOpen.dockRight?.position}）`,
    );

    /* ---- 9. 窄屏下画布仍然可用（不是"让开了但用不了"） ---- */
    expect_(
      narrow.shell !== null && (narrow.shell.w ?? 0) > 0 && (narrow.shell.h ?? 0) > 0,
      `窄屏下画布容器还在且有真实尺寸（[data-canvas-shell] ${narrow.shell?.w}×${narrow.shell?.h}）`,
      `窄屏下画布容器没了或尺寸为 0：${JSON.stringify(narrow.shell)}`,
    );

    /*
      滚一次滚轮，看**缩放数字**有没有真的变。
      只断言"画布还在"是不够的：容器在、但事件挂错了层的画布，
      尺寸一切正常，滚轮却什么也不做 —— 那条只有真发一次事件才验得出来。
    */
    const zoomBefore = await read(cdp);
    const wheelX = Math.round((narrow.shell?.left ?? 0) + (narrow.shell?.w ?? 0) / 2);
    const wheelY = Math.round((narrow.shell?.top ?? 0) + (narrow.shell?.h ?? 0) / 2);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: wheelX,
      y: wheelY,
      deltaX: 0,
      deltaY: -300,
    });
    await sleep(400);
    const zoomAfter = await read(cdp);
    info(
      `窄屏下在画布中心 (${wheelX}, ${wheelY}) 滚一次：缩放 ${zoomBefore.zoomLabel} → ${zoomAfter.zoomLabel}，` +
        `网格 ${zoomBefore.gridStep} → ${zoomAfter.gridStep}px`,
    );
    expect_(
      zoomAfter.zoomLabel !== zoomBefore.zoomLabel && zoomAfter.gridStep > zoomBefore.gridStep,
      `窄屏下滚轮仍然缩放：${zoomBefore.zoomLabel} → ${zoomAfter.zoomLabel}`,
      `窄屏下滚轮没反应：缩放还是 ${zoomAfter.zoomLabel}（网格 ${zoomBefore.gridStep} → ${zoomAfter.gridStep}px）`,
    );

    /* ---- 10. 收尾：清掉视口覆盖 ---- */
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await sleep(600);

    const wideAfter = await readInnerW();
    const restored = await readNarrow();
    expect_(
      wideAfter === wideBefore && wideAfter === quadPlan.innerW,
      `清掉覆盖后视口精确回到覆盖之前的 ${wideAfter}px（= 第十七步那个宽屏视口）`,
      `清掉覆盖后视口是 ${wideAfter}px，覆盖之前是 ${wideBefore}px（第十七步是 ${quadPlan.innerW}px）—— 没回到干净状态`,
    );
    expect_(
      restored.wideMedia === true &&
        restored.toggleLeft.exists &&
        (restored.toggleLeft.box?.w ?? 0) === 0 &&
        restored.outline !== null &&
        restored.outline.w >= 264,
      `恢复宽屏（${restored.innerW}px）后窄屏降级整体退场：matchMedia 宽屏 = true、两个按钮重新隐藏、清单回到常驻 ${restored.outline?.w}px`,
      `恢复宽屏后版面没回来：视口 ${restored.innerW} matchMedia 宽屏=${restored.wideMedia} 按钮宽=${restored.toggleLeft.box?.w} 清单宽=${restored.outline?.w}`,
    );

    /* ---------- 19. 一级 Agent 根节点：三层树成型 ---------- */
    /*
      这一步补的是**这一期新加的那一层** —— 画布最上面的「一级 Agent」。

      ── 为什么它必须进常驻回归，而不是看一眼截图 ──
        三层树是**结构**，不是配色。结构错了的几种样子都很安静：
          · 根卡没画出来 → 还是六根并列，看着"挺正常"
          · 根卡画了但没有连线 → 上面飘着一张卡（用户反馈过的原话：
            「为什么没有树节点的效果」）
          · 根卡画在了六道工序下面 → 层级反了，一眼看不出，因为卡片长得一样
          · 根卡的状态写死成「已完成」→ 界面在说一句没发生过的事
        这四种没有一种会抛异常。所以只能靠断言钉住。

      ── 最要紧的一条：状态必须是**真的** ──
        一级 Agent 的「总规划」这一步目前还没真接入。它该显示什么，
        完全由 from-run.ts 从这条运行的事件里投影出来的那个点的 status 决定。
        所以这里**造两条状态不同的运行**（一条 done、一条 running），
        断言根卡的 data-root-status 跟着变、颜色跟着变 ——
        写死任何一种状态，都会在其中一条上原形毕露。
        这不是"测颜色好不好看"，是测**界面有没有在说实话**。
    */
    heading("第十九步 · 一级 Agent 根节点（1 根 + 6 工序 + 7 执行点）");

    /**
     * 一次把三层读全：根卡、六道工序、执行点、连线、以及左侧清单的色点。
     *
     * 量的是 getBoundingClientRect（屏幕上真实的位置），不是 style.left ——
     * 世界坐标层的 style.left/top 是**世界坐标**，和屏幕位置差着一个
     * 平移加缩放（第四步那段注释里踩过同一个坑）。
     */
    const READ_TREE3 = `(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left), top: Math.round(r.top),
          right: Math.round(r.right), bottom: Math.round(r.bottom),
          w: Math.round(r.width), h: Math.round(r.height),
        };
      };
      const roots = [...document.querySelectorAll('[data-pipeline-root]')];
      const stages = [...document.querySelectorAll('[data-pipeline-stage]')];
      const chips = [...document.querySelectorAll('[data-canvas-child]')];
      const root = roots[0] ?? null;
      const pill = root ? root.querySelector('[data-root-pill]') : null;
      const rootId = root ? root.getAttribute('data-pipeline-root') : null;
      const trunk = rootId
        ? document.querySelector('[data-canvas-tree-trunk="' + rootId + '"]')
        : null;
      const group = trunk ? trunk.closest('g') : null;
      const text = (el) => (el ? el.textContent.trim() : '');
      return JSON.stringify({
        rootCount: roots.length,
        rootId,
        rootStatus: root ? root.getAttribute('data-root-status') : null,
        rootTone: root ? root.getAttribute('data-root-tone') : null,
        /*
          状态色读 data-root-rgb，**不读计算样式**。
          胶囊那一行是 data-canvas-label="minor"：缩到一定档位时
          它的文字本来就是透明的（"缩小时字让位"，见 globals.css），
          那时候计算出来是 rgba(0,0,0,0) —— 而"颜色配错了"
          和"这一档把字藏了"在读到的值上完全一样。
        */
        rootRgb: root ? root.getAttribute('data-root-rgb') : null,
        rootPillText: text(pill),
        // running 那一档的轻微脉冲：读动画名就知道挂上没有（'none' = 没挂）
        rootPillPulse: pill ? getComputedStyle(pill).animationName : null,
        /*
          标题走 data-root-title，不是 [data-canvas-label="major"]：
          卡里第一个 major 是左上角那个「AGENT」标识（序号那一行的替身），
          querySelector 拿到的会是它。
        */
        rootTitle: text(root ? root.querySelector('[data-root-title]') : null),
        rootSubtitle: text(root ? root.querySelector('[data-root-subtitle]') : null),
        /*
          缩小时的"文字让位"这一档，在根卡上也要成立。
          量的是底部那行**内层** span 的颜色 —— 外层 div 标了 minor 一定会透明，
          而真正会漏的是内层那两个自带文字颜色的 span。
        */
        tier: document.querySelector('[data-canvas-world]')?.getAttribute('data-label-tier') ?? null,
        rootStagesColor: (() => {
          const el = root ? root.querySelector('[data-root-stages] span') : null;
          return el ? getComputedStyle(el).color : null;
        })(),
        rootBox: root ? box(root) : null,
        stageCount: stages.length,
        stageIds: stages.map(el => el.getAttribute('data-pipeline-stage')),
        stageTops: stages.map(el => Math.round(el.getBoundingClientRect().top)),
        chipCount: chips.length,
        trunks: document.querySelectorAll('[data-canvas-tree-trunk]').length,
        trunkFromRoot: trunk ? 1 : 0,
        branchesFromRoot: group ? group.querySelectorAll('[data-canvas-tree-link]').length : 0,
        /*
          左侧清单：每一行的状态 + 色点的实际颜色。
          两个视图必须说同一句话 —— 同一个状态在两处不同色，
          用户会以为是两件事（planning-outline.ts 开头那段）。
        */
        outline: [...document.querySelectorAll('[data-outline-row]')].map(el => {
          const dot = el.querySelector('[data-outline-dot]');
          return {
            status: el.getAttribute('data-outline-status'),
            dot: dot ? getComputedStyle(dot).backgroundColor : null,
          };
        }),
      });
    })()`;

    interface Tree3 {
      rootCount: number;
      rootId: string | null;
      rootStatus: string | null;
      rootTone: string | null;
      rootRgb: string | null;
      rootPillText: string;
      rootPillPulse: string | null;
      rootTitle: string;
      rootSubtitle: string;
      tier: string | null;
      rootStagesColor: string | null;
      rootBox: { left: number; top: number; w: number; h: number } | null;
      stageCount: number;
      stageIds: (string | null)[];
      stageTops: number[];
      chipCount: number;
      trunks: number;
      trunkFromRoot: number;
      branchesFromRoot: number;
      outline: { status: string | null; dot: string | null }[];
    }

    const readTree3 = async (): Promise<Tree3> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_TREE3,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as Tree3;
    };

    /** 清单里所有处于某个状态的行，色点是什么颜色（去重） */
    const dotsOfStatus = (t: Tree3, status: string): string[] => [
      ...new Set(t.outline.filter((r) => r.status === status).map((r) => r.dot ?? "")),
    ];

    /**
     * "96 165 250" → "rgb(96, 165, 250)"。
     *
     * 卡片上写的是调色板里的三段（`r g b`，塞进 `rgb(... / 0.5)` 那种模板用），
     * 而 getComputedStyle 报出来的是带逗号的规范形式。两边是同一种颜色的
     * 两种写法，比之前先把格式对齐 —— 否则这条断言红的原因会是"逗号"，
     * 和它要验的"两个视图是不是同一个色值"毫无关系。
     */
    const asRgb = (triple: string | null): string =>
      triple ? `rgb(${triple.trim().split(/\s+/).join(", ")})` : "";

    /* ---- 19.1 一条跑完的运行：1 根 + 6 工序 + 7 执行点 ---- */
    const doneRun = seedVerifyRun(username);
    info(`造了一条运行 ${doneRun.runId.slice(0, 8)}（status=done，带 ${doneRun.count} 项检查）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${doneRun.runId}` });
    await sleep(4200);

    const done = await readTree3();
    info(
      `三层：根 ${done.rootCount} 个（${done.rootId} / ${done.rootStatus}）· ` +
        `工序 ${done.stageCount} 个 · 执行点 ${done.chipCount} 个 · 躯干 ${done.trunks} 条 · ` +
        `根名下横枝 ${done.branchesFromRoot} 条`,
    );
    info(
      `根卡 ${done.rootBox?.w}×${done.rootBox?.h} 在 top=${done.rootBox?.top}，` +
        `六道工序 top=${done.stageTops.join(",")}`,
    );

    expect_(
      done.rootCount === 1 && done.rootId === PLANNING_ROOT_ID,
      `画布上有且只有 1 个一级 Agent 根节点（[data-pipeline-root="${done.rootId}"]）`,
      `根节点有 ${done.rootCount} 个（id=${done.rootId}）—— 三层树的根必须是唯一的一个`,
    );
    expect_(
      done.stageCount === 6 &&
        done.stageIds.join(",") === "spec,arch,ui,build,assemble,verify",
      "六道工序仍然是 6 个，顺序不变（①②③④⑤⑥）",
      `工序卡有 ${done.stageCount} 个：${done.stageIds.join(" ")} —— 加一层不该动到第 1 层`,
    );
    /*
      ★ 三层同时在 ★
      这一条同时钉住三件事：根还在、六道工序都还在、七个执行点都还在。
      少任何一层，这棵树就不叫三层树了 —— 而少一层在画面上
      看起来只是"东西少了一点"，不报错。
    */
    const layerSum = done.rootCount + done.stageCount + done.chipCount;
    expect_(
      done.rootCount === 1 && done.stageCount === 6 && done.chipCount === doneRun.count,
      `三层同时在：1 根 + 6 工序 + ${doneRun.count} 执行点（共 ${layerSum} 个节点）`,
      `三层不齐：根 ${done.rootCount} + 工序 ${done.stageCount} + 执行点 ${done.chipCount}（执行点应有 ${doneRun.count} 个）`,
    );
    expect_(
      done.rootTitle === "一级 Agent" && done.rootSubtitle === "总规划",
      `根卡的标题和副标题来自投影：「${done.rootTitle}」/「${done.rootSubtitle}」`,
      `根卡文字是「${done.rootTitle}」/「${done.rootSubtitle}」，期望「一级 Agent」/「总规划」`,
    );
    /*
      ★ 根在六道工序**上方** ★
      量的是屏幕坐标（getBoundingClientRect）。层级反了的话，
      这棵树读起来就变成"六道工序管着一个 Agent"—— 而卡片长得一样，
      位置是唯一说得出层级的东西。
    */
    expect_(
      done.rootBox !== null &&
        done.stageTops.length === 6 &&
        done.rootBox.top + done.rootBox.h <= Math.min(...done.stageTops),
      `根卡在六道工序上方（根底边 ${done.rootBox ? done.rootBox.top + done.rootBox.h : "?"} ≤ 工序顶边 ${Math.min(...done.stageTops)}）`,
      `根卡不在上面：根 ${done.rootBox?.top}~${done.rootBox ? done.rootBox.top + done.rootBox.h : "?"}，工序顶边最小 ${Math.min(...done.stageTops)}`,
    );
    /*
      ★ 根和六道工序之间**有线** ★
      没有这条线，三层树在视觉上就只是"上面多了一张卡" ——
      用户的原话「为什么没有树节点的效果」说的正是这个。
      躯干 + 每个孩子一根横枝：6 个孩子就是 6 条。
    */
    expect_(
      done.trunkFromRoot === 1 && done.branchesFromRoot === done.stageCount,
      `根与六道工序之间有连线（1 条躯干 + ${done.branchesFromRoot} 条横枝，每道工序一条）`,
      `根名下的连线不对：躯干 ${done.trunkFromRoot} 条、横枝 ${done.branchesFromRoot} 条（期望 1 条躯干 + ${done.stageCount} 条横枝）`,
    );
    /*
      ★ 状态是投影说的，不是写死的 ★
      run.status = 'done'，from-run.ts 把根节点的状态投影成 done
      （一级 Agent 代表整条运行本身）。界面上就该是「已完成」+ 蓝色，
      而且**不能有脉冲**（脉冲是"还在动"的意思）。
    */
    expect_(
      done.rootStatus === "done" && done.rootPillText === "已完成" && done.rootPillPulse === "none",
      `根卡如实显示这条运行的真实状态：${done.rootStatus} · 胶囊「${done.rootPillText}」· 无脉冲`,
      `根卡显示 ${done.rootStatus} / 「${done.rootPillText}」/ 动画 ${done.rootPillPulse}` +
        ` —— 这条运行是 done，就该是「已完成」且不动`,
    );
    /*
      ★ 状态色与规划数据一致 ★
      两级证据，缺一不可：
        一、色值等于调色板里 done 那一档（蓝 = 96 165 250）；
        二、等于**左侧清单里同状态那一行**的色点颜色 ——
            同一棵树的两种视图，必须说同一句话。
      只有第一条的话，"两处都错成同一个颜色"验不出来；
      只有第二条的话，"两处一起漂到别的颜色上"验不出来。
    */
    /*
      ★ 缩小时"字让位"这条规矩，根卡也要守 ★

      根卡底部那行「下辖 6 道工序」是次要文字：档位掉到 major 以下必须让位
      （globals.css 那条规则，见第十三步）。它特别容易漏 ——
      外层 div 标了 data-canvas-label="minor" 一定会透明，
      **内层那两个自带文字颜色的 span 不在选择器射程里**，照样显示，
      表现是缩小时一行 4 像素的暗色灰渣。
      所以这里量的是内层 span 的颜色，而且跟着**当前档位**判断，
      不写死"必须透明"：屏幕一变、自动适应的倍率就变，档位跟着变 ——
      写死的话这条断言会在别的屏宽上红，而它和"字有没有让位"无关。
    */
    const hidden = done.rootStagesColor === "rgba(0, 0, 0, 0)" || done.rootStagesColor === "transparent";
    expect_(
      done.tier === "all" ? !hidden : hidden,
      `根卡的次要文字跟着档位走（档位 ${done.tier}，底部那行颜色 ${done.rootStagesColor}）`,
      `档位 ${done.tier} 但底部那行的颜色是 ${done.rootStagesColor}` +
        ` —— 该让位的时候没让（内层 span 漏出了选择器射程？）`,
    );

    const doneDots = dotsOfStatus(done, "done");
    expect_(
      done.rootRgb === "96 165 250" &&
        doneDots.length === 1 &&
        doneDots[0] === asRgb(done.rootRgb),
      `根卡状态色 = 蓝 rgb(96, 165, 250)（done），和左侧清单里 done 那一行的色点同色`,
      `根卡色是 ${done.rootRgb}（清单里 done 行的色点是 ${JSON.stringify(doneDots)}）` +
        ` —— 期望一致的 96 165 250`,
    );

    cleanupVerifyRun(doneRun.runId);

    /* ---- 19.2 换一条**还在跑**的运行：根的状态和颜色都得跟着变 ---- */
    /*
      ★ 这一条是"不写死"的硬证据 ★

      同一张卡、同一段代码，只把运行换成 running：
      如果根卡的状态是写死的（"已完成"或"规划中"），
      这里必然和 19.1 一样，两条一对比就露馅。
      它同时证明颜色不是随手挑的：running → green → 74 222 128，
      和左侧清单里正在跑那一行是同一个色值。
    */
    const runningRun = seedRunningRun(username);
    info(`造了一条运行 ${runningRun.slice(0, 8)}（status=running，只有一条 phase:spec）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${runningRun}` });
    await sleep(4200);

    const running = await readTree3();
    info(
      `三层：根 ${running.rootCount} 个（${running.rootId} / ${running.rootStatus}）· ` +
        `工序 ${running.stageCount} 个 · 执行点 ${running.chipCount} 个`,
    );

    expect_(
      running.rootStatus === "running" &&
        running.rootPillText === "正在跑" &&
        running.rootPillPulse !== "none",
      `换成还在跑的运行，根卡跟着变成 running「正在跑」且有脉冲（动画 ${running.rootPillPulse}）`,
      `根卡显示 ${running.rootStatus} /「${running.rootPillText}」/ 动画 ${running.rootPillPulse}` +
        ` —— 这条运行是 running，根卡该是「正在跑」并带一点脉冲`,
    );
    const runningDots = dotsOfStatus(running, "running");
    expect_(
      running.rootRgb === "74 222 128" &&
        runningDots.length === 1 &&
        runningDots[0] === asRgb(running.rootRgb),
      `根卡状态色 = 绿 rgb(74, 222, 128)（running），和清单里正在跑那一行同色`,
      `根卡色是 ${running.rootRgb}，清单里 running 行的色点是 ${JSON.stringify(runningDots)}`,
    );
    /*
      两条运行 → 两种状态、两种颜色。这一条单独列出来，
      是因为它才是"没有写死"这件事最直接的证据：
      上面两条各自也可能在"写死成某一档"的情况下碰巧成立，
      放在一起就不可能了。
    */
    expect_(
      done.rootStatus !== running.rootStatus && done.rootRgb !== running.rootRgb,
      `两条运行下根卡的状态与颜色都不同（${done.rootStatus}/${running.rootStatus}，` +
        `${done.rootRgb} vs ${running.rootRgb}）—— 状态确实来自真实投影`,
      `两条运行的根卡一样（${done.rootStatus} vs ${running.rootStatus}）—— 状态像是写死的`,
    );

    cleanupVerifyRun(runningRun);

    /* ---- 19.3 没有选中运行时：回到六根并列的旧样子 ---- */
    /*
      rootCard 是**可选** prop，不传时画布必须和以前一模一样。
      夹具在这一步之前已经全部删掉，所以 /canvas（不带 run）会落到
      "没有运行"那条分支上 —— 那正是不传 rootCard 的那种情况。

      为什么不干脆把 rootCard 写死成"总是三层"：
      没有运行的时候连"这次运行"都还没有，凭空画一个总规划出来，
      描述的是一个不存在的东西。少画一层，比多画一层假的强。
    */
    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const noRun = await readTree3();
    info(
      `没有选中运行：根 ${noRun.rootCount} 个 · 工序 ${noRun.stageCount} 个 · ` +
        `执行点 ${noRun.chipCount} 个`,
    );
    expect_(
      noRun.rootCount === 0,
      "没有选中运行时画布上**没有**一级 Agent 根节点（不凭空造一个总规划）",
      `没有运行却画出了 ${noRun.rootCount} 个根节点 —— 那描述的是一个不存在的东西`,
    );
    expect_(
      noRun.stageCount === 6,
      "没有选中运行时仍然是六道工序并列（rootCard 不传 = 旧样子）",
      `工序卡有 ${noRun.stageCount} 个 —— 不传 rootCard 时画布该和以前一模一样`,
    );

    /* ---------- 20. 视口策略：「看全」出口 + 步骤推进自动聚焦 ---------- */
    /*
      这一期交付的是**视口策略**，两件事：

        一、「看全」 —— 整棵树装进视口。它**必须忽略 0.45 那条下限**，
            因为用户明确表达了"我要看全局"；代价是字读不清，
            所以按钮的提示语说的是实话（会很小、读不清字）。

        二、步骤推进 → 视口跟过去。它**必须尊重用户**：
            用户自己动过视口之后就不许再跟，否则就是抢镜头。

      ── 为什么这两条都必须进常驻回归 ──
        它们的结果都表现为**一个数字**（画布的倍率 / 平移量），
        而数字错了在画面上往往"看着也挺正常"：
          · 「看全」忘了忽略下限 → 还是 45%，边缘两张卡依旧被切 ——
            和"看全"生效的样子差别很小，肉眼要数边缘像素才看得出来
          · 自动聚焦不尊重用户 → 镜头在用户拖到一半时飞走，
            而那一下永远发生在"你正要看别处"的时候，没人能盯着复现
          · 反过来的错更安静：自动聚焦**从来没生效过**，
            画面一切正常，只是用户永远看到的是旧位置
        所以两条都要有断言，而且断言对象要是**可测的量**：
        画布倍率（从网格间距反算，见第四步）、每张卡的屏幕矩形、平移量。

      ── 怎么制造"一次推进" ──
        改库（删掉当前工序唯一的那条真实痕迹）+ 让页面**重新渲染**
        （点同一条运行的 chip 走客户端导航，或删一条陪跑运行走服务端动作）。
        整页刷新不行 —— 那会重新挂载，而挂载按规矩本来就不聚焦。
        每一步都用**左侧清单的变化**证明"推进真的到了页面上"，
        不让断言有机会在"其实什么都没发生"的情况下变绿。
    */
    heading("第二十步 · 视口策略：「看全」出口与步骤推进自动聚焦");

    /** 一次读全：画布矩形、倍率、平移、每张卡的屏幕矩形与世界矩形、清单、看全按钮 */
    const READ_VIEWPORT = `(() => {
      const stage = document.querySelector('[data-canvas-stage]');
      if (!stage) return JSON.stringify({ missing: true });
      const cs = getComputedStyle(stage);
      const sr = stage.getBoundingClientRect();
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
      };
      /*
        世界坐标从自己的 translate(x,y) 读（世界层那层 scale 不算进来）——
        于是"树到底多大"是可测的，不靠注释里的数字。
      */
      const world = (el) => {
        const m = getComputedStyle(el).transform.match(/matrix\\(([^)]+)\\)/);
        const p = m ? m[1].split(',').map(Number) : [1, 0, 0, 1, NaN, NaN];
        return {
          x: p[4], y: p[5],
          w: parseFloat(el.style.width) || el.offsetWidth,
          h: parseFloat(el.style.height) || el.offsetHeight,
        };
      };
      const nodes = [
        ...document.querySelectorAll('[data-pipeline-root]'),
        ...document.querySelectorAll('[data-pipeline-stage]'),
        ...document.querySelectorAll('[data-canvas-child]'),
      ];
      const idOf = (el) =>
        el.getAttribute('data-pipeline-stage') ??
        el.getAttribute('data-pipeline-root') ??
        el.getAttribute('data-canvas-child');
      const worlds = nodes.map(world);
      const fitAll = document.querySelector('[data-canvas-fit-all]');
      const parts = cs.backgroundPosition.split(' ');
      return JSON.stringify({
        stage: { left: sr.left, top: sr.top, w: sr.width, h: sr.height },
        gridStep: parseFloat(cs.backgroundSize) || 0,
        panX: parseFloat(parts[0]) || 0,
        panY: parseFloat(parts[1]) || 0,
        zoomLabel: document.querySelector('[data-canvas-zoom]')?.textContent.trim() ?? null,
        fitAll: fitAll
          ? { text: fitAll.textContent.trim(), title: fitAll.getAttribute('title') || '' }
          : null,
        nodeIds: nodes.map(idOf),
        nodeBoxes: nodes.map(box),
        worldBounds: worlds.length
          ? {
              x: Math.min(...worlds.map((w) => w.x)),
              y: Math.min(...worlds.map((w) => w.y)),
              right: Math.max(...worlds.map((w) => w.x + w.w)),
              bottom: Math.max(...worlds.map((w) => w.y + w.h)),
            }
          : null,
        /*
          左侧清单：六道工序是 level=1 那几行，**顺序就是 STAGES 顺序**。
          它的状态只由服务端投影决定 —— 所以它一变，就证明页面真的重新渲染过。
        */
        outline: [...document.querySelectorAll('[data-outline-row]')].map((el) => ({
          level: el.getAttribute('data-outline-level'),
          status: el.getAttribute('data-outline-status'),
          text: (el.textContent || '').trim().slice(0, 6),
        })),
      });
    })()`;

    interface ViewportSnap {
      missing?: boolean;
      stage: { left: number; top: number; w: number; h: number };
      gridStep: number;
      panX: number;
      panY: number;
      zoomLabel: string | null;
      fitAll: { text: string; title: string } | null;
      nodeIds: (string | null)[];
      nodeBoxes: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        w: number;
        h: number;
      }[];
      worldBounds: { x: number; y: number; right: number; bottom: number } | null;
      outline: { level: string | null; status: string | null; text: string }[];
    }

    const readViewport = async (): Promise<ViewportSnap> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_VIEWPORT,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as ViewportSnap;
    };

    /** 倍率。和第四步同一个算法：网格间距 = 格宽(160) × 倍率 */
    const scaleOf = (s: ViewportSnap) => s.gridStep / 160;

    /**
     * 「每一个节点都落在画布矩形内」—— 容差 2 像素。
     *
     * 这是「看全」**唯一**的验收标准：它叫看全，就得真的看全。
     * 容差是给亚像素用的（getBoundingClientRect 会带小数、
     * 而画布矩形的宽度也不是整数），不是给"差一点也算"用的。
     */
    const outsideCanvas = (s: ViewportSnap, tol = 2) =>
      s.nodeBoxes
        .map((b, i) => ({ id: s.nodeIds[i], b }))
        .filter(
          ({ b }) =>
            b.left < s.stage.left - tol ||
            b.top < s.stage.top - tol ||
            b.right > s.stage.left + s.stage.w + tol ||
            b.bottom > s.stage.top + s.stage.h + tol,
        );

    /** 六道工序在清单里那一行行的状态（level=1，顺序 = STAGES 顺序） */
    const outlineStages = (s: ViewportSnap) =>
      s.outline.filter((r) => r.level === "1").map((r) => r.status);

    /** 某张工序卡在画布内的位置（相对画布左上角） */
    const cardInCanvas = (s: ViewportSnap, id: string) => {
      const i = s.nodeIds.indexOf(id);
      if (i < 0) return null;
      const b = s.nodeBoxes[i];
      return {
        w: Math.round(b.w),
        h: Math.round(b.h),
        x: Math.round(b.left - s.stage.left),
        y: Math.round(b.top - s.stage.top),
        cx: Math.round((b.left + b.right) / 2 - s.stage.left),
      };
    };

    /*
      夹具：一条"正在跑、带子树"的运行（1 根 + 6 工序 + 7 执行点），
      外加一条只用来被删掉的陪跑运行。
    */
    const advRun = seedAdvancingRun(username);
    const bystander = seedBystanderRun(username, "vp");
    info(`造了一条正在跑的运行 ${advRun.slice(0, 8)}（阶段=构建，带 7 项检查的子节点）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${advRun}` });
    await sleep(4200);

    const mounted = await readViewport();
    const vpW = mounted.stage.w;
    const vpH = mounted.stage.h;
    const treeW = mounted.worldBounds ? Math.round(mounted.worldBounds.right - mounted.worldBounds.x) : 0;
    const treeH = mounted.worldBounds ? Math.round(mounted.worldBounds.bottom - mounted.worldBounds.y) : 0;
    info(
      `画布 ${Math.round(vpW)}×${Math.round(vpH)} · 树 ${treeW}×${treeH}（世界坐标，实测）· ` +
        `打开时倍率 ${mounted.zoomLabel}`,
    );

    /* ---- 20.1 「看全」这个按钮本身 ---- */
    /*
      data-canvas-fit-all 这个属性由按钮自己带着，而上面那条查询用的就是它 ——
      所以"按钮在"和"属性在"是同一件事，读到的元素存在即两者都成立。
    */
    expect_(
      mounted.fitAll !== null && mounted.fitAll.text === "看全",
      "右下角缩放控件里有「看全」按钮（[data-canvas-fit-all]），文案就是「看全」",
      `找不到带 data-canvas-fit-all、文案为「看全」的按钮（读到 ${JSON.stringify(mounted.fitAll)}）`,
    );
    /*
      ★ 提示语必须说实话 ★
      它点下去就是会缩到很小、字读不清。写一句「查看全部」听着体面，
      点下去用户会以为界面坏了 —— 所以断言里要出现"很小"这类实话。
    */
    expect_(
      mounted.fitAll !== null &&
        mounted.fitAll.title.includes("很小") &&
        mounted.fitAll.title.includes("读不清"),
      `「看全」的提示语说了实话：「${mounted.fitAll?.title}」`,
      `提示语没说清代价：「${mounted.fitAll?.title}」—— 应当写明会很小、读不清字`,
    );

    /* ---- 20.2 打开时是默认视图，而且**没有**自动聚焦 ---- */
    /*
      ★ 挂载不许自动聚焦 ★
      这条运行此刻的"当前工序"是第一道（规格化）—— 打开画布如果直接聚焦过去，
      用户一进来就被拽到某张卡上，而他连这棵树有几层都还没看清。
      默认视图该是"装下整棵树"，倍率正好停在下限 0.45 上。
    */
    const mountScale = scaleOf(mounted);
    expect_(
      Math.abs(mountScale - fitFloor("page")) < 0.01,
      `打开时停在默认视口（倍率 ${mounted.zoomLabel} = 下限 ${fitFloor("page")}），没有被自动聚焦拽走`,
      `打开时倍率是 ${mounted.zoomLabel}（期望 ${fitFloor("page")}）—— 挂载时不该自动聚焦`,
    );

    /*
      默认视图**装不下**整棵树 —— 这是那条下限的代价，也是「看全」存在的理由。
      把它写成断言，是为了让下一条（看全装得下）不是白给的：
      如果默认视图本来就装得下，那个按钮就只是个装饰。
    */
    const outsideAtDefault = outsideCanvas(mounted);
    expect_(
      outsideAtDefault.length > 0,
      `默认视图确实装不下：${outsideAtDefault.length} 个节点在画布外` +
        `（树 ${treeW}×${treeH} × ${mountScale.toFixed(3)} = ` +
        `${Math.round(treeW * mountScale)}×${Math.round(treeH * mountScale)}，画布 ${Math.round(vpW)}×${Math.round(vpH)}）` +
        ` —— 这正是「看全」要解决的事`,
      `默认视图下居然一个节点都没出画布 —— 那「看全」就没有存在的理由了（请检查是不是下限被改掉了）`,
    );

    /* ---- 20.3 步骤推进：视口跟着当前工序走 ---- */
    /*
      ⚠️ 顺序要紧：这一条必须在**用户动视口之前**做。

      因为规矩就是"用户一动过，之后就不许再自动聚焦"（见 core/canvas/focus-follow.ts）——
      而「看全」「回到原点」都算用户动过视口。
      先点它们再来测自动聚焦的话，测到的是那条禁令，不是跟随本身。
      （第一版就是这么写的，红了两条：倍率停在 45%，卡片还在老位置上。）

      推进是这样造出来的：删掉规格化唯一的那条真实痕迹 →
      投影里第一个 running 的工序就从"规格化"变成"并行构建"。
      然后让页面重新渲染（点同一条运行的 chip 是一次客户端导航）。
    */
    const beforeAdvance = outlineStages(mounted);
    info(`推进前：清单里六道工序的状态 ${beforeAdvance.join(",")}`);
    dropRunEvent(advRun, 0);
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-run-chip="${advRun}"] a').click()`,
    });
    await sleep(3500);
    const afterAdvance = await readViewport();
    const afterAdvanceOutline = outlineStages(afterAdvance);
    info(`推进后：清单里六道工序的状态 ${afterAdvanceOutline.join(",")}`);

    /*
      先证明"这一次推进真的到了页面上"。
      没有这一条，下面"视口跟过去了"可能是被别的原因造成的；
      而反过来（在没推进的情况下断言视口不动）也会变成一条永远绿的假断言。
    */
    expect_(
      beforeAdvance[0] === "running" &&
        afterAdvanceOutline[0] === "pending" &&
        afterAdvanceOutline[3] === "running",
      "改库 + 重新渲染之后，当前工序从①规格化推进到了④并行构建（清单是投影算的，它变了就证明确实重渲染过）",
      `清单没按预期变化：推进前 ${beforeAdvance.join(",")} / 推进后 ${afterAdvanceOutline.join(",")}` +
        ` —— 这一条不过，后面关于视口的断言都不算数`,
    );

    const buildCard = cardInCanvas(afterAdvance, "build");
    const advScale = scaleOf(afterAdvance);
    /*
      ★ 视口跟过去了 ★
      两个证据一起看：
        倍率从 0.45 涨到 1 以上（收进了一张卡，而不是还看着整棵树）
        并行构建那张卡落在画布**水平中线**上（聚焦到它的子树，所以它居中）
      只看倍率的话，"放大了别的地方"也会通过。
    */
    expect_(
      buildCard !== null && advScale > 1 && Math.abs(buildCard.cx - vpW / 2) < 6,
      `推进到④并行构建：视口聚焦过去（倍率 ${afterAdvance.zoomLabel}，那张卡在画布内 x=${buildCard?.cx}，中线 ${Math.round(vpW / 2)}）`,
      `视口没跟过去：倍率 ${afterAdvance.zoomLabel}（期望 > 1），` +
        `并行构建那张卡在画布内 x=${buildCard?.cx}（期望落在中线 ${Math.round(vpW / 2)}）`,
    );
    /*
      而且聚焦的是**那一道工序的子树**，不是整棵树：
      别的工序卡这时应该已经在画布外了 —— 这正是"聚焦"和"看全"的区别。
    */
    const specCard = cardInCanvas(afterAdvance, "spec");
    expect_(
      specCard !== null && (specCard.x + specCard.w < 0 || specCard.x > vpW),
      `聚焦是收进④那一道，不是整棵树：①规格化的卡已经在画布外（画布内 x=${specCard?.x}）`,
      `①规格化的卡还在画布里（x=${specCard?.x}，宽 ${specCard?.w}）—— 这说明视口没有真正收进去`,
    );

    /* ---- 20.4 点「看全」：整棵树都要在画布里 ---- */
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-fit-all]').click()`,
    });
    await sleep(600);
    const fitAllSnap = await readViewport();
    const fitAllScale = scaleOf(fitAllSnap);
    const outsideAtFitAll = outsideCanvas(fitAllSnap);
    info(
      `看全之后：倍率 ${fitAllSnap.zoomLabel}（${fitAllScale.toFixed(4)}）· ` +
        `树在屏幕上 ${Math.round(treeW * fitAllScale)}×${Math.round(treeH * fitAllScale)}`,
    );

    /*
      ★★★ 本期最重要的一条 ★★★
      每一个节点都落在画布矩形里（容差 2px）。
      少了它，"看全"这个名字就是一句没有依据的话 ——
      而它看起来完全正常：缩是缩了，就是边缘那几张卡还在屏幕外，
      这种事不数像素是发现不了的。
    */
    expect_(
      outsideAtFitAll.length === 0,
      `★ 看全之后整棵树都在视口内：${fitAllSnap.nodeBoxes.length} 个节点全部落在画布矩形里（容差 2px）`,
      `看全之后还有 ${outsideAtFitAll.length} 个节点在画布外：` +
        outsideAtFitAll
          .map(
            ({ id, b }) =>
              `${id}(左${Math.round(b.left - fitAllSnap.stage.left)} 上${Math.round(b.top - fitAllSnap.stage.top)} ` +
              `右${Math.round(b.right - (fitAllSnap.stage.left + fitAllSnap.stage.w))} ` +
              `下${Math.round(b.bottom - (fitAllSnap.stage.top + fitAllSnap.stage.h))})`,
          )
          .join(" "),
    );
    /*
      节点数要对得上，否则上面那条会在"画布上什么都没有"时也变绿。
      这条运行该有 1 根 + 6 工序 + 7 执行点 = 14 个。
    */
    expect_(
      fitAllSnap.nodeIds.filter((id) => id && !id.startsWith("verify:")).length === 7 &&
        fitAllSnap.nodeBoxes.length === 14,
      `看全时画的是一整棵树：1 根 + 6 工序 + 7 执行点 = ${fitAllSnap.nodeBoxes.length} 个节点`,
      `节点数不对：共 ${fitAllSnap.nodeBoxes.length} 个 —— 上面那条"全在视口里"就不算数了`,
    );
    /*
      ★ 忽略下限的硬证据 ★
      默认路径停在下限 0.45 上；看全要能装下整棵树就必须缩到它下面。
      只断言"比之前小"是不够的 —— 0.449 也比之前小，而那样根本装不下。
    */
    expect_(
      fitAllScale < 0.4,
      `看全的倍率 ${fitAllSnap.zoomLabel} 明显小于下限 ${fitFloor("page")} —— 确实忽略了下限`,
      `看全只缩到 ${fitAllSnap.zoomLabel}，没有低过 ${fitFloor("page")} —— 下限没被忽略，装不下是必然的`,
    );

    /* ---- 20.5 回到默认：「回到原点」仍然守着下限 ---- */
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-zoom]').click()`,
    });
    await sleep(500);
    const backHome = await readViewport();
    expect_(
      scaleOf(backHome) >= 0.45 - 1e-6,
      `「回到原点」回到 ${backHome.zoomLabel}（≥ 下限 0.45 = fitFloor("page")）—— 默认路径仍然守着下限`,
      `回到原点后倍率是 ${backHome.zoomLabel}，低于下限 0.45 —— 下限被「看全」带坏了`,
    );

    /* ---- 20.6 不跟用户抢镜头 ---- */
    /*
      先点一次「看全」—— 这就是"用户自己动过视口"。
      然后**再推进一次**（删掉并行构建那条 phase，当前工序走到⑥验收）。
      这一次视口必须一个像素都不动：镜头是用户的。

      ⚠️ 这一条和 20.3 一样，必须先用清单证明"推进真的发生了"。
         否则"视口没动"的成因可能只是"页面根本没重新渲染"——
         那就是一条永远绿的假断言。
         这里的重新渲染由**服务端动作**触发：删掉那条陪跑运行
         （deleteRunAction → revalidatePath + redirect），那是一次客户端导航。
    */
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-fit-all]').click()`,
    });
    await sleep(600);
    const beforeSteal = await readViewport();
    const userMovedScale = scaleOf(beforeSteal);
    info(
      `用户动过视口（点了看全）：倍率 ${beforeSteal.zoomLabel}，平移 ${Math.round(beforeSteal.panX)},${Math.round(beforeSteal.panY)}`,
    );

    dropRunEvent(advRun, 2);
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-run-chip="${bystander}"] button[aria-label="删除这次构建"]').click()`,
    });
    await sleep(4200);
    const afterSteal = await readViewport();
    const stealOutline = outlineStages(afterSteal);
    info(`再推进一次之后：清单里六道工序的状态 ${stealOutline.join(",")}`);

    expect_(
      stealOutline[3] === "pending" && stealOutline[5] === "running",
      "又推进了一次：当前工序从④并行构建走到⑥验收与交付（清单变了 → 页面确实重新渲染过）",
      `清单没按预期变化：${stealOutline.join(",")} —— 这一条不过，下面"视口没被抢"就不算数`,
    );
    /*
      ★ 镜头没被抢 ★
      倍率和平移**一个都不许变**（比浮点相等，不是"差不多"）：
      视口每一步都是 setViewport 写进去的确定值，
      自动聚焦一旦发生就会写出完全不同的数 —— 不存在"变了一点点"。
    */
    expect_(
      afterSteal.gridStep === beforeSteal.gridStep &&
        afterSteal.panX === beforeSteal.panX &&
        afterSteal.panY === beforeSteal.panY,
      `★ 用户动过视口之后不再自动聚焦：推进到⑥时视口纹丝不动` +
        `（倍率 ${afterSteal.zoomLabel}、平移 ${Math.round(afterSteal.panX)},${Math.round(afterSteal.panY)}）`,
      `视口被抢了：${beforeSteal.zoomLabel}(${Math.round(beforeSteal.panX)},${Math.round(beforeSteal.panY)}) → ` +
        `${afterSteal.zoomLabel}(${Math.round(afterSteal.panX)},${Math.round(afterSteal.panY)})` +
        ` —— 用户自己动过视口之后就不该再自动聚焦`,
    );
    /*
      顺带把它和"看全"的倍率对上：用户动过之后停在看全那个倍率上，
      说明这一次推进没有偷偷把画面拉回 0.45 或拉到 1.x。
    */
    expect_(
      Math.abs(userMovedScale - fitAllScale) < 1e-9 && userMovedScale < 0.4,
      `推进前后都停在「看全」的倍率上（${beforeSteal.zoomLabel}）`,
      `倍率不是看全那个值：推进前 ${beforeSteal.zoomLabel}，看全时是 ${fitAllSnap.zoomLabel}`,
    );

    cleanupVerifyRun(advRun);
    cleanupVerifyRun(bystander);

    cdp.close();
    ok("画布交互、详情、面板、顶栏一致性、缩放让位、退役页面、子树与双击聚焦全部通过");
    ok("窄屏降级（<1280）：两侧收起为 0 宽、覆盖层 272/352 可开可关、画布全宽且滚轮仍能缩放 —— 全部通过");
    ok(
      "一级 Agent 根节点：三层树 1 根 + 6 工序 + 7 执行点、根在工序上方且有连线、" +
        "状态与颜色随真实投影变化（done/running 两种运行验过）—— 全部通过",
    );
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
  /*
    用 expect_ 把异常也计入失败数，这样 finish 会以退出码 1 结束 ——
    直接 console.error 再 return 的话，退出码是 0，等于「崩了也算通过」。
  */
  expect_(false, "端到端脚本没有异常退出", err instanceof Error ? err.message : String(err));
  finish(Date.now());
});
