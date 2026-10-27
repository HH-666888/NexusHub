/**
 * 画布端到端：用 CDP 真的滚轮、拖拽、点击，再读计算样式确认变了。
 * 平移缩放只体现在计算样式里，服务端 HTML 没有视口信息，所以必须驱动浏览器。
 * 运行：npm run e2e:canvas（需先启动 http://localhost:3000）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PLANNING_ROOT_ID } from "@/core/planning/from-run";

import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { fitFloor } from "@/core/canvas/viewport";
import { check, finish, heading, info, ok, signUp } from "./e2e-kit";
import {
  seedVerifyRun,
  cleanupVerifyRun,
  seedAdvancingRun,
  dropRunEvent,
  seedBystanderRun,
  seedRunningRun,
  STEP_CHECKS,
  stepPhase,
  stepText,
  stepReasoning,
  stepUsage,
  stepCheck,
  seedStepRun,
  appendStepEvents,
  TEXT_ONLY_BODY,
  ARCH_MODULES,
  ARCH_CHECK,
  UI_PAGES,
  UI_CHECK,
  seedArchRun,
  seedUiRun,
  MODULES_BATCH,
  FAILED_DOT,
  DONE_DOT,
  seedModulesRun,
  DONE_LABEL,
  PICK_THINKING,
  PICK_BODY,
  LAST_STEP_BODY,
  PORTABLE_PROMPT,
  PORTABLE_HTML,
  seedPortableRun,
  cleanupPortableRun,
} from "./e2e-canvas/fixtures";
import {
  BASE,
  EDGE,
  PORT,
  sleep,
  waitForTarget,
  connect,
  read,
} from "./e2e-canvas/cdp";

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
    heading("第一步 · 注册一个测试账号");
    const username = `ec_${Date.now().toString(36)}`;
    // 注册页是 Server Action 表单：直接 POST 会拿到 200 但没有 Cookie，看起来像成功了。
    const cookie = await signUp(BASE, username);
    const token = cookie.replace(/^nexus_session=/, "");
    check(token.length > 0, "注册成功并拿到会话", "没拿到 Cookie");

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
    check(!("missing" in initial), "画布元素存在", "页面上找不到 [data-canvas-stage]");

    // 期望值从画布真实尺寸算，不能从窗口尺寸推：外框、视口、画布差着两截。
    const vw = initial.stageW;
    const vh = initial.stageH;
    info(
      `画布实际尺寸 ${vw}×${vh}，网格间距 ${initial.gridStep}px，倍率 ${initial.zoomLabel}`,
    );

    // 打开时该把整条流水线装进视口；停在 100% 的话右边那道要自己滚才看得见。
    heading("第三步 · 初始视口装下整条流水线");

    check(
      initial.zoomLabel !== "100%",
      `打开时自动缩放（${initial.zoomLabel}），整条看得下`,
      "打开时还是 100% —— 六道工序一屏装不下",
    );
    check(
      initial.gridStep > 60 && initial.gridStep < 160,
      `网格间距 ${initial.gridStep}px，说明确实缩小了`,
      `网格间距是 ${initial.gridStep}px，看着不像缩过`,
    );

    // 原点标记落在视口内即可，具体位置由 fitViewport 决定（它有自己的单测）。
    check(
      initial.originX > 0 &&
        initial.originX < vw &&
        initial.originY > 0 &&
        initial.originY < vh,
      "原点标记落在视口里",
      `原点跑到了视口外：(${Math.round(initial.originX)}, ${Math.round(initial.originY)})`,
    );

    heading("第四步 · 滚轮缩放（以光标为锚点）");

    const anchorX = 400;
    const anchorY = 300;

    // 滚轮事件的 x/y 是页面坐标，锚点用画布内坐标，两者差着清单面板的宽度。
    // 纵向不用换算：四分布局只动了左右。
    const stageLeftRaw = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const r = document.querySelector('[data-canvas-stage]').getBoundingClientRect();
        return JSON.stringify({ left: r.left, top: r.top });
      })()`,
      returnByValue: true,
    });
    const stageAt = JSON.parse(stageLeftRaw.result!.value!) as {
      left: number;
      top: number;
    };
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

    check(
      zoomedIn.gridStep > initial.gridStep,
      `向上滚放大：网格 ${initial.gridStep}px → ${zoomedIn.gridStep}px`,
      `网格没有变大：还是 ${zoomedIn.gridStep}px`,
    );
    check(
      zoomedIn.zoomLabel !== initial.zoomLabel,
      `倍率显示跟着变：${initial.zoomLabel} → ${zoomedIn.zoomLabel}`,
      `倍率显示没变：还是 ${zoomedIn.zoomLabel}`,
    );

    // 锚点不动：光标下的世界点在缩放前后落在同一屏幕位置。
    const worldX = (anchorLocalX - initial.panX) / (initial.gridStep / 160);
    const expectPanX = anchorLocalX - worldX * (zoomedIn.gridStep / 160);
    check(
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
    check(
      zoomedBack.gridStep <= zoomedIn.gridStep,
      `向下滚缩小：网格 ${zoomedIn.gridStep}px → ${zoomedBack.gridStep}px`,
      `网格没有变小：还是 ${zoomedBack.gridStep}px`,
    );

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
    check(
      Math.abs(afterDrag.panX - beforeDrag.panX - 100) < 3,
      `拖动向右 100px，平移跟着走（${Math.round(beforeDrag.panX)} → ${Math.round(afterDrag.panX)}）`,
      `横向平移不对：期望 +100，实际 ${Math.round(afterDrag.panX - beforeDrag.panX)}`,
    );
    check(
      Math.abs(afterDrag.panY - beforeDrag.panY - 60) < 3,
      `拖动向下 60px，平移跟着走`,
      `纵向平移不对：期望 +60，实际 ${Math.round(afterDrag.panY - beforeDrag.panY)}`,
    );
    check(
      Math.abs(afterDrag.originX - beforeDrag.originX - 100) < 3,
      "原点标记跟着一起动（它属于画布内容，不是屏幕装饰）",
      `原点没跟着动：${Math.round(beforeDrag.originX)} → ${Math.round(afterDrag.originX)}`,
    );

    // 回到原点 = 回到初始视口（重新装下整条流水线），不是把倍率复位成 100%。
    heading("第六步 · 回到原点（重新装下整条流水线）");

    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-zoom]').click()`,
    });
    await sleep(400);
    const home = await read(cdp);

    check(
      home.zoomLabel === initial.zoomLabel,
      `回到原点后倍率回到初始值 ${initial.zoomLabel}`,
      `实际 ${home.zoomLabel}，初始是 ${initial.zoomLabel}`,
    );
    check(
      Math.abs(home.originX - initial.originX) < 2 &&
        Math.abs(home.originY - initial.originY) < 2,
      "回到原点后画面回到初始位置",
      `回到 (${Math.round(home.originX)}, ${Math.round(home.originY)})，初始是 (${Math.round(initial.originX)}, ${Math.round(initial.originY)})`,
    );

    heading("第七步 · 缩放按钮");

    await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '放大').click()`,
    });
    await sleep(300);
    const afterPlus = await read(cdp);
    check(
      afterPlus.gridStep > home.gridStep,
      `点“+”放大：${home.gridStep}px → ${afterPlus.gridStep}px`,
      `点“+”没放大：还是 ${afterPlus.gridStep}px`,
    );

    await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '缩小').click()`,
    });
    await sleep(300);
    const afterMinus = await read(cdp);
    check(
      Math.abs(afterMinus.gridStep - home.gridStep) < 1,
      `点“−”缩回来：${afterPlus.gridStep}px → ${afterMinus.gridStep}px`,
      `没缩回来：${afterMinus.gridStep}px，期望 ${home.gridStep}px`,
    );

    // 六道工序必须真的画在画布上，顺序、权限、连线都要对。
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

    check(pl.hasWorld, "画布有世界坐标层", "没有世界坐标层 —— 内容无处安放");
    check(pl.hasPipeline, "画布上有流水线", "画布上还是一片空白");
    check(
      pl.ids.length === 6,
      "六道工序都画出来了",
      `只有 ${pl.ids.length} 道：${pl.ids.join(" ")}`,
    );
    check(
      pl.ids.join(",") === "spec,arch,ui,build,assemble,verify",
      "顺序是 ①②③④⑤⑥",
      `顺序不对：${pl.ids.join(" ")}`,
    );
    check(
      pl.hasGrid && pl.hasOrigin,
      "网格和原点标记都还在",
      "画布本体的网格或原点标记没了",
    );

    // 权限四件套也要上画布：那张图上有的，搬过来不能丢。
    const flowVerifyActor = pl.actors.find((a) => a.id === "verify");
    check(
      flowVerifyActor?.label === "AI · 只读",
      "验收在画布上也是“AI · 只读”",
      `验收标成了“${flowVerifyActor?.label}”—— 判定者不该参与生产`,
    );
    check(
      pl.gates.length === 1 && pl.gates[0] === "on",
      "只有规格化带门禁，且是“会停下问人”",
      `门禁标记：${pl.gates.join(" ") || "（无）"}`,
    );
    check(
      pl.watches === 6,
      "六道工序都写了“看什么数”",
      `只有 ${pl.watches} 道写了看什么数`,
    );

    // 只画顺序流转的实线：回退是流程内部机制，不画在画布上。
    // 机制本身还在（fallbackTo 照建、详情面板照列），只是不再画弧线。
    const edgeCheck = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const paths = [...document.querySelectorAll('[data-canvas-pipeline] svg path')];
        const dashed = paths.filter(p => p.getAttribute('stroke-dasharray'));
        return JSON.stringify({ total: paths.length, dashed: dashed.length });
      })()`,
      returnByValue: true,
    });
    const ed = JSON.parse(edgeCheck.result!.value!) as {
      total: number;
      dashed: number;
    };
    info(`连线：共 ${ed.total} 条，其中虚线 ${ed.dashed} 条`);

    check(
      ed.total >= 5,
      `顺序流转的实线还在（共 ${ed.total} 条）`,
      `连一条线都没有（${ed.total}）—— 画布不该连"谁接谁"都不画`,
    );
    check(
      ed.dashed === 0,
      "画布上没有回退弧线（回退留在流程内部，不显示）",
      `出现了 ${ed.dashed} 条虚线 —— 回退弧线不该再画出来`,
    );

    // 子方块必须和父工序连起来，否则子树只是另一堆漂着的卡片。
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
      check(
        lk.links === lk.chips,
        `每个子方块都有一条线连回父工序（${lk.links}/${lk.chips}）`,
        `有 ${lk.chips} 个子方块，却只有 ${lk.links} 条父子连线 —— 会有孤儿方块`,
      );
    }

    // 打开时自动适应到看得全，不必让用户先滚一下滚轮。
    const zoomCheck = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-zoom]')?.textContent?.trim() ?? ''`,
      returnByValue: true,
    });
    const pct = Number(String(zoomCheck.result!.value).replace("%", ""));
    info(`打开时的缩放：${pct}%`);
    check(
      pct > 40 && pct < 100,
      `打开时自动缩到 ${pct}%，整条看得全`,
      `打开时是 ${pct}% —— 六道工序应该一屏看得下`,
    );

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

    // 点验收：它的上游是全部五道，六个都该亮着。
    const allLit = await clickAndRead("verify");
    const dim1 = allLit.filter((c) => c.opacity < 0.5).map((c) => c.id);
    check(
      dim1.length === 0,
      "点“验收”时六道全亮（它的上游是全部）",
      `这几道被压暗了：${dim1.join(" ")}`,
    );

    // 线性流水线的 chain = 自己 + 全部上游 + 全部下游，点谁都是六个，
    // 所以点击的用处是选中它、让详情面板显示那一道，不是压暗别人。
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
    const sel = JSON.parse(selected.result!.value!) as {
      boxShadow: string;
      opacity: number;
    };
    check(
      sel.boxShadow !== "none",
      "点中的那一道有外发光",
      `没有外发光：boxShadow=${sel.boxShadow}`,
    );
    check(
      sel.opacity > 0.9,
      `点中的那一道没有被压暗（opacity=${sel.opacity}）`,
      `点中之后它是暗的（opacity=${sel.opacity}）—— 最需要看清的时候它最暗，是反的`,
    );

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

    check(!dt.missing, "点开工序后有详情面板", "点了却没出现详情面板");
    check(
      dt.hasRationale === true,
      "详情里有“这一步为什么存在”",
      "详情里没有原理那一段",
    );
    // 卡片上只放得下几个字，权限与看什么数只能放进详情。
    check(dt.hasAuthority === true, "详情里有权限说明", "详情里缺权限说明");
    check(dt.hasWatches === true, "详情里有“看什么数”", "详情里缺看什么数");

    // 工作台面板与 /canvas 用同一个组件：换回别的实现这里就找不到节点。
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

    check(
      pn.hasWorld,
      "面板里也用的是自绘画布",
      "面板里没有世界坐标层 —— 换回别的实现了？",
    );
    check(
      pn.ids.length === 6,
      "面板里也是六道工序",
      `只有 ${pn.ids.length} 道：${pn.ids.join(" ")}`,
    );

    // 面板 808×371，三列两行时卡片 149 宽，字才读得清；再小就读不出。
    check(
      pn.cardW !== null && pn.cardW >= 130,
      `面板里的卡片宽 ${pn.cardW}px，字读得清`,
      `卡片只有 ${pn.cardW}px 宽 —— 字会缩到看不清`,
    );

    // 顶栏位置必须完全一致：以前三套顶栏页边距不同，换页时导航会横向跳一下。
    heading("第十二步 · 顶栏在所有页面上位置一致");

    const routes = ["/", "/canvas", "/studio?tab=graph", "/settings", "/welcome"];
    const seen: Array<{ route: string; brandLeft: number | null; navCount: number }> =
      [];

    for (const route of routes) {
      await cdp.send("Page.navigate", { url: `${BASE}${route}` });
      await sleep(2200);
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          /*
            按 data-app-nav 认顶栏，**不能**按"页面里第一个 header"。
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
      const v = JSON.parse(r.result!.value!) as {
        brandLeft: number | null;
        navCount: number;
      };
      seen.push({ route, ...v });
    }

    info(seen.map((s) => `${s.route}=${s.brandLeft}`).join("  "));

    const missing = seen.filter((s) => s.brandLeft === null);
    check(
      missing.length === 0,
      "五个页面都有顶栏",
      `这几个页面没有顶栏：${missing.map((s) => s.route).join(" ")}`,
    );

    // 位置必须完全一样：差一像素就说明有人自己写了一层顶栏
    const lefts = new Set(seen.map((s) => s.brandLeft));
    check(
      lefts.size === 1,
      `顶栏品牌在所有页面都落在同一个 x（${[...lefts][0]}px）`,
      `品牌位置不一致：${seen.map((s) => `${s.route}=${s.brandLeft}`).join(" ")}`,
    );

    // 一页只能有一个顶栏：两个多半是 layout 和页面各写了一个
    const doubled = seen.filter((s) => s.navCount > 1);
    check(
      doubled.length === 0,
      "每个页面只有一个顶栏",
      `这几个页面出现了多个顶栏：${doubled.map((s) => `${s.route}(${s.navCount})`).join(" ")}`,
    );

    // 缩到很小时藏的是字，不是信息：色块、边框、状态色都留着。
    // 用 color: transparent 而不是 display: none，否则文字会从可访问性树里摘掉。
    heading("第十三步 · 缩小时文字让位（但信息不消失）");

    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    /** 读当前档位与次要文字颜色 */
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

    // 按固定次数写死会越过中间档位，所以按“档位变了就停”来找。
    const shrinkUntilTierChanges = async (max = 8) => {
      for (let i = 0; i < max; i++) {
        await clickZoom("缩小", 1);
        const t = await readTier();
        if (t.tier !== "all") return { ...t, clicks: i + 1 };
      }
      return { ...(await readTier()), clicks: max };
    };

    // 先把倍率放大回 all 再测阶梯：打开时的档位取决于版面宽度，会随屏宽变。
    // 阶梯本身是 all → major → none → 再放大回 all。
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
    check(
      start.tier === "all",
      `放大到字全都在（缩放 ${start.zoom}）`,
      `放大 ${start.clicks} 次后档位还是 ${start.tier} —— 字没能全回来`,
    );
    check(
      (start.minor ?? "").startsWith("rgb") || (start.minor ?? "").startsWith("#"),
      "倍率够大时次要文字是有颜色的",
      `次要文字的颜色是 ${start.minor}`,
    );

    // 缩到中间档
    const mid = await shrinkUntilTierChanges();
    info(`缩 ${mid.clicks} 次后：缩放 ${mid.zoom}，档位 ${mid.tier}`);
    check(
      mid.tier === "major",
      `缩到 ${mid.zoom} 时只剩次要文字被藏（档位 ${mid.tier}）`,
      `档位是 ${mid.tier}，期望 major`,
    );
    check(
      mid.minor === "rgba(0, 0, 0, 0)" || mid.minor === "transparent",
      "次要文字变成了透明",
      `次要文字的颜色还是 ${mid.minor} —— 缩小后它会糊成一层灰渣`,
    );
    check(
      mid.major !== null &&
        mid.major !== "rgba(0, 0, 0, 0)" &&
        mid.major !== "transparent",
      "工序名和序号还留着（这一档还要看得见是哪一道",
      `连工序名也没了（颜色 ${mid.major}）—— 那就不是"让位"，是把信息一起藏了`,
    );

    // 再缩到只剩色块
    await clickZoom("缩小", 3);
    const far = await readTier();
    info(`再缩三次后：缩放 ${far.zoom}，档位 ${far.tier}`);
    check(
      far.tier === "none",
      `缩到 ${far.zoom} 时文字全藏（档位 ${far.tier}）`,
      `档位是 ${far.tier}，期望 none`,
    );
    check(
      far.minorCount > 0,
      "文字只是看不见，元素仍然在 DOM 里（屏幕阅读器还读得到）",
      "次要文字从 DOM 里消失了 —— 那是把无障碍做成了功能缺失",
    );

    // 放大回来，字要自己回来
    await clickZoom("放大", 6);
    const back = await readTier();
    info(`放大回来：缩放 ${back.zoom}，档位 ${back.tier}`);
    check(
      back.tier === "all",
      "放大之后文字自己回来了",
      `放大到 ${back.zoom} 档位还是 ${back.tier}`,
    );

    // 退役页面最怕的不是入口没了，是还有人指着它；这类问题靠人工 grep 守不住。
    // 断言的是界面上没有链接指向 /studio，不是路由打不开（文件仍保留）。
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

    check(
      stray.length === 0,
      `${liveRoutes.length} 个页面上都没有指向 /studio 的链接`,
      `这些页面还指着退役的工作台：${stray.join("  |  ")}`,
    );

    check(
      navLinkCount === 4,
      "顶栏是 品牌 + 三项（首页 / 构建 / 设置）",
      `顶栏有 ${navLinkCount} 个链接`,
    );

    // 前十四步的测试账号没有任何运行记录，子节点数永远是 0，子树断言全在空转。
    // 这里插一条带检查结果的运行，把“子树真的长出来”验掉。
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

          必须按父节点分开数，不能再用"横枝总数 === 子方块数"。
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

    check(
      tree.chips === seeded.count,
      `${seeded.count} 项检查长成了 ${seeded.count} 个方块`,
      `只画出了 ${tree.chips} 个方块`,
    );
    // 数的是验收名下的横枝（7 条），不是全画布的 13 条。
    check(
      tree.verifyLinks === tree.chips,
      `每个方块都有一条线连回父工序（${tree.verifyLinks}/${tree.chips}）`,
      `有 ${tree.chips} 个方块，却只有 ${tree.verifyLinks} 条横枝 —— 会有孤儿`,
    );
    // 两个父节点各一条躯干：一级 Agent 连六道工序、验收连七项检查。
    check(
      tree.trunks === 2,
      "两个父节点各有一条躯干：一级 Agent → 六道工序、验收 → 七项检查",
      `躯干有 ${tree.trunks} 条，应该是 2（一级 Agent 一条 + 验收一条）`,
    );
    // 子卡要有状态、依据、数值，不能只是一个标题。
    check(
      tree.withStatus === tree.chips &&
        tree.withDetail === tree.chips &&
        tree.withMetric === tree.chips,
      "每张子卡都有状态胶囊、判定依据和底部数值（不是只有一个标题）",
      `缺内容：状态 ${tree.withStatus}/${tree.chips}、` +
        `依据 ${tree.withDetail}/${tree.chips}、数值 ${tree.withMetric}/${tree.chips}`,
    );
    // 造的七项里故意让一项不过，全是 pass 就看不出 tone 有没有读进去。
    check(
      tree.tones.includes("fail") && tree.tones.includes("pass"),
      "通过和未过的方块颜色是不同的（tone 真的读进去了）",
      `tone 只有 ${JSON.stringify([...new Set(tree.tones)])}`,
    );
    // 子卡要有边框和底色，和主卡同一套视觉语言。
    check(
      tree.styled === tree.chips,
      "每张子卡都有边框和底色（和主卡同一套视觉语言，不是一行文字）",
      `只有 ${tree.styled}/${tree.chips} 张有边框和底色`,
    );

    // 用完就删，别把夹具留在库里
    cleanupVerifyRun(seeded.runId);
    info("夹具已清理");

    // 双击把视角收进那棵子树；它只改视口不改 DOM，所以要断言缩放数字。
    heading("第十六步 · 双击聚焦（视角的进出）");

    /** 读当前缩放百分比 */
    const readZoom = async (): Promise<number> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('[data-canvas-zoom]')?.textContent?.trim() ?? ''`,
        returnByValue: true,
      });
      return Number(String(r.result!.value).replace("%", ""));
    };

    // 先导航回没有夹具的那次运行，否则测到的是上一次的视口。
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
    check(
      Number.isFinite(at.x) && Number.isFinite(at.y),
      "找得到“验收与交付”那张卡",
      "页面上没有 [data-pipeline-stage=verify]",
    );

    /* 手打两下 dblclick：CDP 的 Input 事件里没有双击手势 */
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
    info(`双击“验收与交付”之后：缩放 ${zoomNear}%`);
    check(
      zoomNear > zoomFar,
      `双击一个工序会聚焦到它那棵树（${zoomFar}% → ${zoomNear}%）`,
      `缩放没变（还是 ${zoomNear}%）—— 双击没接上，或者聚焦区域算错了`,
    );

    /* 双击空白处回全局 */
    // 空白点要按画布位置取：左边 272px 是清单面板，用页面坐标会打在面板上。
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
    check(
      Math.abs(zoomBack - zoomFar) < 1,
      `双击空白处回到全局视口（${zoomNear}% → ${zoomBack}%，原来是 ${zoomFar}%）`,
      `回到 ${zoomBack}%，和进来之前的 ${zoomFar}% 不一样 —— 出不去，或者回错了地方`,
    );

    // 四分布局：两侧真占宽度、右侧是占位、整页不横向滚动。
    // 少写一个 min-w-0 画布就会被内容撑到 1860 宽，自动适应也跟着算错。
    heading("第十七步 · 四分布局：左清单 / 中画布 / 右内容");

    /** 读版面与清单，从 DOM 和计算样式上量，不看类名 */
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

    // 先看没有选中运行这一档：清单不编造内容，右侧写实情，版面仍是四分。
    const quadEmpty = await readQuad();
    info(
      `版面：清单 ${quadEmpty.outline?.w}px · 画布 ${quadEmpty.stage?.w}px · ` +
        `内容 ${quadEmpty.content?.w}px（窗口 ${quadEmpty.innerW}px）`,
    );

    check(
      quadEmpty.outline !== null,
      "左侧有任务点清单（[data-planning-outline]）",
      "页面上找不到 [data-planning-outline] —— 左侧面板没有渲染",
    );
    check(
      quadEmpty.outline !== null &&
        quadEmpty.stage !== null &&
        quadEmpty.outline.right <= quadEmpty.stage.left + 1 &&
        quadEmpty.outline.w >= 264,
      `清单在画布左边，宽 ${quadEmpty.outline?.w}px（17rem）`,
      `清单位置/宽度不对：清单 right=${quadEmpty.outline?.right}，画布 left=${quadEmpty.stage?.left}，宽 ${quadEmpty.outline?.w}`,
    );
    check(
      quadEmpty.content !== null &&
        quadEmpty.stage !== null &&
        quadEmpty.content.left >= quadEmpty.stage.right - 1 &&
        quadEmpty.content.w >= 344,
      `内容面板在画布右边，宽 ${quadEmpty.content?.w}px（22rem）`,
      `内容面板位置/宽度不对：内容 left=${quadEmpty.content?.left}，画布 right=${quadEmpty.stage?.right}，宽 ${quadEmpty.content?.w}`,
    );
    // 画布比窗口窄，证明两侧是占了宽度而不是浮在上面。
    check(
      quadEmpty.stage !== null &&
        quadEmpty.stage.w > 200 &&
        quadEmpty.stage.w < quadEmpty.innerW - 500,
      `画布在中间，宽 ${quadEmpty.stage?.w}px，比窗口窄（两侧真的占了宽度）`,
      `画布宽 ${quadEmpty.stage?.w}px，窗口 ${quadEmpty.innerW}px —— 两侧面板没有占住版面？`,
    );
    check(
      quadEmpty.contentPlaceholder,
      "右侧是明确的空态块（[data-step-content-placeholder]）",
      "右侧没有空态块 —— 分不清是没数据还是没接",
    );
    // 空态写明“这次运行还没有产生任何过程事件”，指向的是数据，不是功能没做。
    check(
      quadEmpty.contentText.includes("这次运行还没有产生任何过程事件"),
      "右侧说的是实话：“这次运行还没有产生任何过程事件”",
      `右侧没有这句空态文案 —— 读到的是“${quadEmpty.contentText.slice(0, 40)}”`,
    );
    // 1440 屏在断点之上，窄屏按钮不该出现。
    check(
      quadEmpty.visibleToggles === 0,
      "1440 屏上窄屏按钮不显示（≥1280 两侧常驻）",
      `出现了 ${quadEmpty.visibleToggles} 个窄屏按钮 —— 断点判反了`,
    );
    // 没有运行就没有计划：清单给空态，不编造六道工序。
    check(
      quadEmpty.rows === 0 && quadEmpty.hasEmptyState,
      "没有选中运行时清单是空态，不编造六道工序",
      `清单里有 ${quadEmpty.rows} 行（应当 0 行 + 空态）`,
    );
    check(
      quadEmpty.docScrollW <= quadEmpty.innerW + 1,
      `没有横向滚动条（内容宽 ${quadEmpty.docScrollW} ≤ 窗口 ${quadEmpty.innerW}）`,
      `出现横向滚动条：内容宽 ${quadEmpty.docScrollW} > 窗口 ${quadEmpty.innerW} —— 少写了 min-w-0？`,
    );

    // 换成一条没有任何 check 事件的运行，验“没到点的那几道说什么”。
    const planRun = seedRunningRun(username);
    info(`造了一条运行 ${planRun.slice(0, 8)}，没有任何 check 事件`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${planRun}` });
    await sleep(4200);

    const quadPlan = await readQuad();
    info(
      `清单 ${quadPlan.rows} 行：一级 ${quadPlan.level1} · 占位 ${quadPlan.placeholders} · ` +
        `占位文字 ${JSON.stringify(quadPlan.placeholderTexts)}`,
    );

    check(
      quadPlan.level1 === 6,
      "清单里恰好 6 个一级行（六道工序）",
      `一级行有 ${quadPlan.level1} 个，应该是 6`,
    );
    // 六行占位是界面在说“将来会有，只是还没到点”；空白会被读成跑完了什么都没有。
    check(
      quadPlan.placeholders === 6,
      `六道工序都给出了“待规划”占位行（${quadPlan.placeholders}/6）`,
      `只有 ${quadPlan.placeholders} 行占位 —— 那几道工序在清单上是空白，用户分不清"没轮到"和"没东西"`,
    );
    check(
      quadPlan.placeholderTexts.length === 1 &&
        quadPlan.placeholderTexts[0] === "待规划",
      "占位行的文字就是“待规划”",
      `占位行的文字是 ${JSON.stringify(quadPlan.placeholderTexts)}，期望“待规划”`,
    );
    // running 的色点是 green，和画布上“正在跑”用同一个色值。
    check(
      quadPlan.runningDot === "rgb(74, 222, 128)",
      `正在跑的那道工序色点是绿色 ${quadPlan.runningDot}（和画布同一套状态色）`,
      `正在跑那一行的色点是 ${quadPlan.runningDot}，期望 rgb(74, 222, 128)`,
    );

    cleanupVerifyRun(planRun);
    info("夹具已清理");

    // 窄屏（<1280）两侧收起成覆盖层：此前只有一次性探针验过，没进常驻回归。
    // 用 Emulation.setDeviceMetricsOverride 在同一会话内改视口，浏览器不用重启。
    // 结束时必须清掉，再断言视口精确回到覆盖前的值。
    heading("第十八步 · 窄屏降级（<1280：两侧收起成覆盖层）");

    /** 窄屏下量版面，从 rect / 计算样式 / matchMedia 上读 */
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

    // 走 dispatchMouseEvent 而不是 el.click()：后者绕过命中测试，被覆盖层压住的按钮也点得动。
    // 元素找不到时返回 ok:false，不抛异常，让这一组检查全都红出来，而不是只看到一条错误。
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

    // 0. 覆盖之前先确认还停在宽屏那个视口
    // 对照不能写死 1440：窗口外框不等于视口，取第十七步在同一浏览器量到的值。
    const wideBefore = await readInnerW();
    info(
      `覆盖之前视口 ${wideBefore}px（第十七步量到的是 ${quadPlan.innerW}px；` +
        `--window-size=1440,900 给的是窗口外框，视口比它窄 ${1440 - quadPlan.innerW}px）`,
    );
    check(
      wideBefore === quadPlan.innerW && wideBefore >= 1280,
      `覆盖之前仍停在宽屏视口 ${wideBefore}px（和第十七步量到的是同一个，≥1280）`,
      `覆盖之前视口是 ${wideBefore}px，第十七步量到的是 ${quadPlan.innerW}px —— 中间有东西动过视口，下面的对照就不成立了`,
    );

    // 1. 同一会话内把视口改成 1100×800
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    info(
      "Emulation.setDeviceMetricsOverride：1100×800（浏览器没重启，会话和 Cookie 没重来）",
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const narrow = await readNarrow();
    info(
      `视口 ${narrow.innerW}×${narrow.innerH} · 清单 ${narrow.outline?.w}px · 画布 ${narrow.stage?.w}px · ` +
        `内容 ${narrow.content?.w}px · 两个窄屏按钮 ${narrow.toggleLeft.box?.w}/${narrow.toggleRight.box?.w}px`,
    );

    check(
      narrow.innerW === 1100 && !narrow.wideMedia,
      `视口覆盖生效：innerWidth ${narrow.innerW}，matchMedia('(min-width:1280px)') = false`,
      `视口覆盖没生效：innerWidth ${narrow.innerW}，matchMedia 宽屏匹配 = ${narrow.wideMedia}`,
    );

    // 2. 两个窄屏按钮可见
    check(
      narrow.toggleLeft.exists &&
        (narrow.toggleLeft.box?.w ?? 0) > 0 &&
        narrow.toggleLeft.text === "清单",
      `窄屏出现“清单”按钮（${narrow.toggleLeft.box?.w}×${narrow.toggleLeft.box?.h}，文字“${narrow.toggleLeft.text}”）`,
      `“清单”按钮不可见：存在=${narrow.toggleLeft.exists} 宽=${narrow.toggleLeft.box?.w} 文字=${narrow.toggleLeft.text}`,
    );
    check(
      narrow.toggleRight.exists &&
        (narrow.toggleRight.box?.w ?? 0) > 0 &&
        narrow.toggleRight.text === "内容",
      `窄屏出现“内容”按钮（${narrow.toggleRight.box?.w}×${narrow.toggleRight.box?.h}，文字“${narrow.toggleRight.text}”）`,
      `“内容”按钮不可见：存在=${narrow.toggleRight.exists} 宽=${narrow.toggleRight.box?.w} 文字=${narrow.toggleRight.text}`,
    );

    // 3. 两侧默认收起：宽度必须是真的 0
    // “收起”必须是真的 0 宽：opacity 0 / 移出屏幕 / visibility hidden 都还占版面。
    check(
      narrow.outline !== null && narrow.outline.w === 0,
      "窄屏默认收起：左侧清单宽度为 0（不占版面）",
      `左侧清单宽 ${narrow.outline?.w}px —— 窄屏下它没有让开（收起写成了"看不见"？）`,
    );
    check(
      narrow.content !== null && narrow.content.w === 0,
      "窄屏默认收起：右侧内容宽度为 0（不占版面）",
      `右侧内容宽 ${narrow.content?.w}px —— 窄屏下它没有让开（收起写成了"看不见"？）`,
    );

    // 4. 画布铺满整个视口宽
    check(
      narrow.stage !== null && Math.abs(narrow.stage.w - narrow.innerW) <= 2,
      `画布铺满窄屏全宽（${narrow.stage?.w} ≈ 视口 ${narrow.innerW}）—— 两侧是真让开，不是浮层压着`,
      `画布宽 ${narrow.stage?.w}px，视口 ${narrow.innerW}px（差 ${narrow.innerW - (narrow.stage?.w ?? 0)}px）—— 两侧没有让开`,
    );

    // 5. 没有横向滚动条
    check(
      narrow.docScrollW <= narrow.innerW + 1,
      `窄屏没有横向滚动条（内容宽 ${narrow.docScrollW} ≤ 视口 ${narrow.innerW}）`,
      `窄屏出现横向滚动条：内容宽 ${narrow.docScrollW} > 视口 ${narrow.innerW}`,
    );

    // 6. 点“清单”展开左侧覆盖层
    const leftHit = await clickCenter('[data-panel-toggle="left"]');
    info(
      leftHit.ok
        ? `点了“清单”按钮（页面坐标 ${leftHit.x}, ${leftHit.y}）`
        : "页面上没有“清单”按钮可点 —— 下面这一组会红",
    );
    await sleep(400);

    const leftOpen = await readNarrow();
    info(
      `展开后：dock position ${leftOpen.dockLeft?.position} display ${leftOpen.dockLeft?.display} ` +
        `left ${leftOpen.dockLeft?.left} 宽 ${leftOpen.dockLeft?.w} · 面板宽 ${leftOpen.outline?.w}`,
    );
    check(
      leftOpen.dockLeft !== null &&
        leftOpen.dockLeft.position === "fixed" &&
        Math.abs(leftOpen.dockLeft.left) <= 1 &&
        Math.abs(leftOpen.dockLeft.w - 272) <= 8 &&
        Math.abs((leftOpen.outline?.w ?? 0) - 272) <= 8,
      `点“清单”展开成覆盖层：position fixed · left ${leftOpen.dockLeft?.left} · 宽 ${leftOpen.outline?.w}px（17rem = 272，只盖左一条）`,
      `清单覆盖层不对：position=${leftOpen.dockLeft?.position} left=${leftOpen.dockLeft?.left} ` +
        `dock 宽=${leftOpen.dockLeft?.w} 面板宽=${leftOpen.outline?.w}（期望 fixed / 0 / 272）`,
    );
    check(
      leftOpen.closeLeft.exists && (leftOpen.closeLeft.box?.w ?? 0) > 0,
      `覆盖层里有关闭按钮（[data-panel-close="left"] ${leftOpen.closeLeft.box?.w}×${leftOpen.closeLeft.box?.h}）`,
      `覆盖层里没有可点的关闭按钮：存在=${leftOpen.closeLeft.exists} 宽=${leftOpen.closeLeft.box?.w}`,
    );
    // 覆盖层不是抽屉：展开时画布仍是全宽，而且必须真的是 fixed 覆盖层。
    check(
      leftOpen.dockLeft !== null &&
        leftOpen.dockLeft.position === "fixed" &&
        Math.abs((leftOpen.stage?.w ?? 0) - leftOpen.innerW) <= 2,
      `展开覆盖层时画布仍是全宽 ${leftOpen.stage?.w}px（覆盖层只盖一条，不推挤画布）`,
      `展开清单后画布变成 ${leftOpen.stage?.w}px（视口 ${leftOpen.innerW}）—— 这是抽屉推挤，不是覆盖层` +
        `（面板 position=${leftOpen.dockLeft?.position}：根本没展开成覆盖层时这条也算红）`,
    );

    // 7. 点关闭收回
    const leftCloseHit = await clickCenter('[data-panel-close="left"]');
    info(
      leftCloseHit.ok
        ? `点了关闭（页面坐标 ${leftCloseHit.x}, ${leftCloseHit.y}）`
        : "页面上没有关闭按钮可点 —— 下面这条会红",
    );
    await sleep(400);

    const leftClosed = await readNarrow();
    // 同样要求点之前它真的展开过，否则没展开过也能变绿。
    check(
      leftOpen.dockLeft !== null &&
        leftOpen.dockLeft.position === "fixed" &&
        leftClosed.outline !== null &&
        leftClosed.outline.w === 0 &&
        leftClosed.closeLeft.exists === false,
      "点关闭后左侧清单收回：宽度回到 0，关闭按钮也随之消失",
      `关闭后清单宽 ${leftClosed.outline?.w}px，关闭按钮还在=${leftClosed.closeLeft.exists}` +
        `（点之前展开成覆盖层了吗：position=${leftOpen.dockLeft?.position}）`,
    );

    // 8. 右侧“内容”同样走一轮（22rem = 352）
    const rightHit = await clickCenter('[data-panel-toggle="right"]');
    info(
      rightHit.ok
        ? `点了“内容”按钮（页面坐标 ${rightHit.x}, ${rightHit.y}）`
        : "页面上没有“内容”按钮可点 —— 下面这一组会红",
    );
    await sleep(400);

    const rightOpen = await readNarrow();
    info(
      `展开后：dock position ${rightOpen.dockRight?.position} right ${rightOpen.dockRight?.right} ` +
        `宽 ${rightOpen.dockRight?.w} · 面板宽 ${rightOpen.content?.w}`,
    );
    check(
      rightOpen.dockRight !== null &&
        rightOpen.dockRight.position === "fixed" &&
        Math.abs(rightOpen.dockRight.right - rightOpen.innerW) <= 1 &&
        Math.abs(rightOpen.dockRight.w - 352) <= 8 &&
        Math.abs((rightOpen.content?.w ?? 0) - 352) <= 8,
      `点“内容”展开成覆盖层：position fixed · right ${rightOpen.dockRight?.right} ≈ 视口 ${rightOpen.innerW} · ` +
        `宽 ${rightOpen.content?.w}px（22rem = 352，贴右边缘）`,
      `内容覆盖层不对：position=${rightOpen.dockRight?.position} right=${rightOpen.dockRight?.right}` +
        `（视口 ${rightOpen.innerW}）dock 宽=${rightOpen.dockRight?.w} 面板宽=${rightOpen.content?.w}（期望 fixed / 1100 / 352）`,
    );
    check(
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
    check(
      rightOpen.dockRight !== null &&
        rightOpen.dockRight.position === "fixed" &&
        rightClosed.content !== null &&
        rightClosed.content.w === 0,
      "点关闭后右侧内容收回：宽度回到 0",
      `关闭后内容面板宽 ${rightClosed.content?.w}px（点之前展开成覆盖层了吗：position=${rightOpen.dockRight?.position}）`,
    );

    // 9. 窄屏下画布仍然可用，不是让开了但用不了
    check(
      narrow.shell !== null && (narrow.shell.w ?? 0) > 0 && (narrow.shell.h ?? 0) > 0,
      `窄屏下画布容器还在且有真实尺寸（[data-canvas-shell] ${narrow.shell?.w}×${narrow.shell?.h}）`,
      `窄屏下画布容器没了或尺寸为 0：${JSON.stringify(narrow.shell)}`,
    );

    // 只断言画布还在不够：容器在、事件挂错层的画布，滚轮不会动。
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
    check(
      zoomAfter.zoomLabel !== zoomBefore.zoomLabel &&
        zoomAfter.gridStep > zoomBefore.gridStep,
      `窄屏下滚轮仍然缩放：${zoomBefore.zoomLabel} → ${zoomAfter.zoomLabel}`,
      `窄屏下滚轮没反应：缩放还是 ${zoomAfter.zoomLabel}（网格 ${zoomBefore.gridStep} → ${zoomAfter.gridStep}px）`,
    );

    // 10. 收尾：清掉视口覆盖
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await sleep(600);

    const wideAfter = await readInnerW();
    const restored = await readNarrow();
    check(
      wideAfter === wideBefore && wideAfter === quadPlan.innerW,
      `清掉覆盖后视口精确回到覆盖之前的 ${wideAfter}px（= 第十七步那个宽屏视口）`,
      `清掉覆盖后视口是 ${wideAfter}px，覆盖之前是 ${wideBefore}px（第十七步是 ${quadPlan.innerW}px）—— 没回到干净状态`,
    );
    check(
      restored.wideMedia === true &&
        restored.toggleLeft.exists &&
        (restored.toggleLeft.box?.w ?? 0) === 0 &&
        restored.outline !== null &&
        restored.outline.w >= 264,
      `恢复宽屏（${restored.innerW}px）后窄屏降级整体退场：matchMedia 宽屏 = true、两个按钮重新隐藏、清单回到常驻 ${restored.outline?.w}px`,
      `恢复宽屏后版面没回来：视口 ${restored.innerW} matchMedia 宽屏=${restored.wideMedia} 按钮宽=${restored.toggleLeft.box?.w} 清单宽=${restored.outline?.w}`,
    );

    // 三层树是结构不是配色，四种错法都不抛异常：没画根、没连线、层级反了、状态写死。
    // 所以造一条 done、一条 running，断言根卡的状态与颜色跟着数据变。
    heading("第十九步 · 一级 Agent 根节点（1 根 + 6 工序 + 7 执行点）");

    // 量屏幕坐标（rect）：世界坐标层的 style.left 差着一个平移加缩放。
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
          卡里第一个 major 是左上角那个“AGENT”标识（序号那一行的替身），
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

    // 调色板写的是 "96 165 250"，计算样式给的是 "rgb(96, 165, 250)"，比之前先对齐格式。
    const asRgb = (triple: string | null): string =>
      triple ? `rgb(${triple.trim().split(/\s+/).join(", ")})` : "";

    // 19.1 一条跑完的运行：1 根 + 6 工序 + 7 执行点
    const doneRun = seedVerifyRun(username);
    info(
      `造了一条运行 ${doneRun.runId.slice(0, 8)}（status=done，带 ${doneRun.count} 项检查）`,
    );

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

    check(
      done.rootCount === 1 && done.rootId === PLANNING_ROOT_ID,
      `画布上有且只有 1 个一级 Agent 根节点（[data-pipeline-root="${done.rootId}"]）`,
      `根节点有 ${done.rootCount} 个（id=${done.rootId}）—— 三层树的根必须是唯一的一个`,
    );
    check(
      done.stageCount === 6 &&
        done.stageIds.join(",") === "spec,arch,ui,build,assemble,verify",
      "六道工序仍然是 6 个，顺序不变（①②③④⑤⑥）",
      `工序卡有 ${done.stageCount} 个：${done.stageIds.join(" ")} —— 加一层不该动到第 1 层`,
    );
    // 三层同时在：根、六道工序、七个执行点；少一层画面只是少点东西，不报错。
    const layerSum = done.rootCount + done.stageCount + done.chipCount;
    check(
      done.rootCount === 1 && done.stageCount === 6 && done.chipCount === doneRun.count,
      `三层同时在：1 根 + 6 工序 + ${doneRun.count} 执行点（共 ${layerSum} 个节点）`,
      `三层不齐：根 ${done.rootCount} + 工序 ${done.stageCount} + 执行点 ${done.chipCount}（执行点应有 ${doneRun.count} 个）`,
    );
    check(
      done.rootTitle === "一级 Agent" && done.rootSubtitle === "总规划",
      `根卡的标题和副标题来自投影：“${done.rootTitle}”/“${done.rootSubtitle}”`,
      `根卡文字是“${done.rootTitle}”/“${done.rootSubtitle}”，期望“一级 Agent”/“总规划”`,
    );
    // 根要在六道工序上方：卡片长得一样，位置是唯一说得出层级的东西。
    check(
      done.rootBox !== null &&
        done.stageTops.length === 6 &&
        done.rootBox.top + done.rootBox.h <= Math.min(...done.stageTops),
      `根卡在六道工序上方（根底边 ${done.rootBox ? done.rootBox.top + done.rootBox.h : "?"} ≤ 工序顶边 ${Math.min(...done.stageTops)}）`,
      `根卡不在上面：根 ${done.rootBox?.top}~${done.rootBox ? done.rootBox.top + done.rootBox.h : "?"}，工序顶边最小 ${Math.min(...done.stageTops)}`,
    );
    // 根和六道工序之间要有线：一条躯干 + 每个孩子一条横枝。
    check(
      done.trunkFromRoot === 1 && done.branchesFromRoot === done.stageCount,
      `根与六道工序之间有连线（1 条躯干 + ${done.branchesFromRoot} 条横枝，每道工序一条）`,
      `根名下的连线不对：躯干 ${done.trunkFromRoot} 条、横枝 ${done.branchesFromRoot} 条（期望 1 条躯干 + ${done.stageCount} 条横枝）`,
    );
    // 状态来自投影：run.status = done 就该是“已完成”，且不能有脉冲。
    check(
      done.rootStatus === "done" &&
        done.rootPillText === "已完成" &&
        done.rootPillPulse === "none",
      `根卡如实显示这条运行的真实状态：${done.rootStatus} · 胶囊“${done.rootPillText}”· 无脉冲`,
      `根卡显示 ${done.rootStatus} / “${done.rootPillText}”/ 动画 ${done.rootPillPulse}` +
        ` —— 这条运行是 done，就该是“已完成”且不动`,
    );
    // 状态色两级证据：调色板里 done 的蓝，和左侧清单同状态那一行的色点同色。
    // 根卡底部的次要文字要跟着档位让位，量的是内层 span 的颜色。
    const hidden =
      done.rootStagesColor === "rgba(0, 0, 0, 0)" ||
      done.rootStagesColor === "transparent";
    check(
      done.tier === "all" ? !hidden : hidden,
      `根卡的次要文字跟着档位走（档位 ${done.tier}，底部那行颜色 ${done.rootStagesColor}）`,
      `档位 ${done.tier} 但底部那行的颜色是 ${done.rootStagesColor}` +
        ` —— 该让位的时候没让（内层 span 漏出了选择器射程？）`,
    );

    const doneDots = dotsOfStatus(done, "done");
    check(
      done.rootRgb === "96 165 250" &&
        doneDots.length === 1 &&
        doneDots[0] === asRgb(done.rootRgb),
      `根卡状态色 = 蓝 rgb(96, 165, 250)（done），和左侧清单里 done 那一行的色点同色`,
      `根卡色是 ${done.rootRgb}（清单里 done 行的色点是 ${JSON.stringify(doneDots)}）` +
        ` —— 期望一致的 96 165 250`,
    );

    cleanupVerifyRun(doneRun.runId);

    // 19.2 换一条还在跑的运行：根的状态和颜色都得跟着变
    // 同一条运行换成 running：状态与颜色都得跟着变，写死的会露馅。
    const runningRun = seedRunningRun(username);
    info(
      `造了一条运行 ${runningRun.slice(0, 8)}（status=running，只有一条 phase:spec）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${runningRun}` });
    await sleep(4200);

    const running = await readTree3();
    info(
      `三层：根 ${running.rootCount} 个（${running.rootId} / ${running.rootStatus}）· ` +
        `工序 ${running.stageCount} 个 · 执行点 ${running.chipCount} 个`,
    );

    check(
      running.rootStatus === "running" &&
        running.rootPillText === "正在跑" &&
        running.rootPillPulse !== "none",
      `换成还在跑的运行，根卡跟着变成 running“正在跑”且有脉冲（动画 ${running.rootPillPulse}）`,
      `根卡显示 ${running.rootStatus} /“${running.rootPillText}”/ 动画 ${running.rootPillPulse}` +
        ` —— 这条运行是 running，根卡该是“正在跑”并带一点脉冲`,
    );
    const runningDots = dotsOfStatus(running, "running");
    check(
      running.rootRgb === "74 222 128" &&
        runningDots.length === 1 &&
        runningDots[0] === asRgb(running.rootRgb),
      `根卡状态色 = 绿 rgb(74, 222, 128)（running），和清单里正在跑那一行同色`,
      `根卡色是 ${running.rootRgb}，清单里 running 行的色点是 ${JSON.stringify(runningDots)}`,
    );
    // 两条运行两种状态、两种颜色放在一起，才排除“碰巧写死成某一档”。
    check(
      done.rootStatus !== running.rootStatus && done.rootRgb !== running.rootRgb,
      `两条运行下根卡的状态与颜色都不同（${done.rootStatus}/${running.rootStatus}，` +
        `${done.rootRgb} vs ${running.rootRgb}）—— 状态确实来自真实投影`,
      `两条运行的根卡一样（${done.rootStatus} vs ${running.rootStatus}）—— 状态像是写死的`,
    );

    cleanupVerifyRun(runningRun);

    // 19.3 没有选中运行：回到六根并列
    // 不带 run 时 rootCard 不传，画布要和以前一模一样。
    // 没有运行就连“这次运行”都还没有，凭空多画一层总规划是在描述不存在的东西。
    await cdp.send("Page.navigate", { url: `${BASE}/canvas` });
    await sleep(3500);

    const noRun = await readTree3();
    info(
      `没有选中运行：根 ${noRun.rootCount} 个 · 工序 ${noRun.stageCount} 个 · ` +
        `执行点 ${noRun.chipCount} 个`,
    );
    check(
      noRun.rootCount === 0,
      "没有选中运行时画布上**没有**一级 Agent 根节点（不凭空造一个总规划）",
      `没有运行却画出了 ${noRun.rootCount} 个根节点 —— 那描述的是一个不存在的东西`,
    );
    check(
      noRun.stageCount === 6,
      "没有选中运行时仍然是六道工序并列（rootCard 不传 = 旧样子）",
      `工序卡有 ${noRun.stageCount} 个 —— 不传 rootCard 时画布该和以前一模一样`,
    );

    // 视口策略两件事：“看全”要忽略 0.45 下限把整棵树装进视口；
    // 步骤推进要跟过去，但用户动过视口之后就不许再跟，否则是抢镜头。
    // 推进靠改库 + 让页面重新渲染（整页刷新会重挂，挂载本来就不聚焦）。
    heading("第二十步 · 视口策略：“看全”出口与步骤推进自动聚焦");

    /** 一次读全：画布矩形、倍率、平移、卡片矩形、清单、看全按钮 */
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

    /** 倍率 = 网格间距 / 160 */
    const scaleOf = (s: ViewportSnap) => s.gridStep / 160;

    // 落在画布矩形外的节点；容差 2px 给亚像素，不是给“差一点也算”。
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

    // 夹具：一条正在跑、带子树的运行，外加一条只用来被删掉的陪跑运行。
    const advRun = seedAdvancingRun(username);
    const bystander = seedBystanderRun(username, "vp");
    info(
      `造了一条正在跑的运行 ${advRun.slice(0, 8)}（阶段=构建，带 7 项检查的子节点）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${advRun}` });
    await sleep(4200);

    const mounted = await readViewport();
    const vpW = mounted.stage.w;
    const vpH = mounted.stage.h;
    const treeW = mounted.worldBounds
      ? Math.round(mounted.worldBounds.right - mounted.worldBounds.x)
      : 0;
    const treeH = mounted.worldBounds
      ? Math.round(mounted.worldBounds.bottom - mounted.worldBounds.y)
      : 0;
    info(
      `画布 ${Math.round(vpW)}×${Math.round(vpH)} · 树 ${treeW}×${treeH}（世界坐标，实测）· ` +
        `打开时倍率 ${mounted.zoomLabel}`,
    );

    // 20.1 “看全”这个按钮本身
    // 按钮自己带着 data-canvas-fit-all，查询用的也是它，元素存在即两件事都成立。
    check(
      mounted.fitAll !== null && mounted.fitAll.text === "看全",
      "右下角缩放控件里有“看全”按钮（[data-canvas-fit-all]），文案就是“看全”",
      `找不到带 data-canvas-fit-all、文案为“看全”的按钮（读到 ${JSON.stringify(mounted.fitAll)}）`,
    );
    // 提示语要说实话：点下去会很小、读不清，别写成“查看全部”。
    check(
      mounted.fitAll !== null &&
        mounted.fitAll.title.includes("很小") &&
        mounted.fitAll.title.includes("读不清"),
      `“看全”的提示语说了实话：“${mounted.fitAll?.title}”`,
      `提示语没说清代价：“${mounted.fitAll?.title}”—— 应当写明会很小、读不清字`,
    );

    // 20.2 打开时是默认视图，而且没有自动聚焦
    // 挂载不许自动聚焦：打开画布就把用户拽到某张卡上，他连这棵树有几层还没看清。
    // 默认视图该装下整棵树，倍率停在下限 0.45 上。
    const mountScale = scaleOf(mounted);
    check(
      Math.abs(mountScale - fitFloor("page")) < 0.01,
      `打开时停在默认视口（倍率 ${mounted.zoomLabel} = 下限 ${fitFloor("page")}），没有被自动聚焦拽走`,
      `打开时倍率是 ${mounted.zoomLabel}（期望 ${fitFloor("page")}）—— 挂载时不该自动聚焦`,
    );

    // 默认视图装不下整棵树，这正是“看全”存在的理由。
    const outsideAtDefault = outsideCanvas(mounted);
    check(
      outsideAtDefault.length > 0,
      `默认视图确实装不下：${outsideAtDefault.length} 个节点在画布外` +
        `（树 ${treeW}×${treeH} × ${mountScale.toFixed(3)} = ` +
        `${Math.round(treeW * mountScale)}×${Math.round(treeH * mountScale)}，画布 ${Math.round(vpW)}×${Math.round(vpH)}）` +
        ` —— 这正是“看全”要解决的事`,
      `默认视图下居然一个节点都没出画布 —— 那“看全”就没有存在的理由了（请检查是不是下限被改掉了）`,
    );

    // 20.3 步骤推进：视口跟着当前工序走
    // 顺序要紧：必须在用户动视口之前测跟随，“看全”“回到原点”都算用户动过。
    // 推进靠删掉规格化那条事件，再点 chip 走客户端导航重新渲染。
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

    // 先证明这次推进真的到了页面上，否则后面的视口断言不算数。
    check(
      beforeAdvance[0] === "running" &&
        afterAdvanceOutline[0] === "pending" &&
        afterAdvanceOutline[3] === "running",
      "改库 + 重新渲染之后，当前工序从①规格化推进到了④并行构建（清单是投影算的，它变了就证明确实重渲染过）",
      `清单没按预期变化：推进前 ${beforeAdvance.join(",")} / 推进后 ${afterAdvanceOutline.join(",")}` +
        ` —— 这一条不过，后面关于视口的断言都不算数`,
    );

    const buildCard = cardInCanvas(afterAdvance, "build");
    const advScale = scaleOf(afterAdvance);
    // 两个证据一起看：倍率涨到 1 以上，且那张卡落在画布水平中线上。
    check(
      buildCard !== null && advScale > 1 && Math.abs(buildCard.cx - vpW / 2) < 6,
      `推进到④并行构建：视口聚焦过去（倍率 ${afterAdvance.zoomLabel}，那张卡在画布内 x=${buildCard?.cx}，中线 ${Math.round(vpW / 2)}）`,
      `视口没跟过去：倍率 ${afterAdvance.zoomLabel}（期望 > 1），` +
        `并行构建那张卡在画布内 x=${buildCard?.cx}（期望落在中线 ${Math.round(vpW / 2)}）`,
    );
    // 聚焦的是那一道的子树，别的工序卡这时该已经在画布外。
    const specCard = cardInCanvas(afterAdvance, "spec");
    check(
      specCard !== null && (specCard.x + specCard.w < 0 || specCard.x > vpW),
      `聚焦是收进④那一道，不是整棵树：①规格化的卡已经在画布外（画布内 x=${specCard?.x}）`,
      `①规格化的卡还在画布里（x=${specCard?.x}，宽 ${specCard?.w}）—— 这说明视口没有真正收进去`,
    );

    // 20.4 点“看全”：整棵树都要在画布里
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

    // “看全”的唯一验收标准：每个节点都落在画布矩形里。
    check(
      outsideAtFitAll.length === 0,
      `看全之后整棵树都在视口内：${fitAllSnap.nodeBoxes.length} 个节点全部落在画布矩形里（容差 2px）`,
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
    // 节点数要对得上，否则“全在视口里”在画布空着时也会绿。
    check(
      fitAllSnap.nodeIds.filter((id) => id && !id.startsWith("verify:")).length === 7 &&
        fitAllSnap.nodeBoxes.length === 14,
      `看全时画的是一整棵树：1 根 + 6 工序 + 7 执行点 = ${fitAllSnap.nodeBoxes.length} 个节点`,
      `节点数不对：共 ${fitAllSnap.nodeBoxes.length} 个 —— 上面那条"全在视口里"就不算数了`,
    );
    // 看全必须缩到下限以下；只断言“比之前小”不够，0.449 也会通过。
    check(
      fitAllScale < 0.4,
      `看全的倍率 ${fitAllSnap.zoomLabel} 明显小于下限 ${fitFloor("page")} —— 确实忽略了下限`,
      `看全只缩到 ${fitAllSnap.zoomLabel}，没有低过 ${fitFloor("page")} —— 下限没被忽略，装不下是必然的`,
    );

    // 20.5 回到默认：“回到原点”仍然守着下限
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-canvas-zoom]').click()`,
    });
    await sleep(500);
    const backHome = await readViewport();
    check(
      scaleOf(backHome) >= 0.45 - 1e-6,
      `“回到原点”回到 ${backHome.zoomLabel}（≥ 下限 0.45 = fitFloor("page")）—— 默认路径仍然守着下限`,
      `回到原点后倍率是 ${backHome.zoomLabel}，低于下限 0.45 —— 下限被“看全”带坏了`,
    );

    // 20.6 不跟用户抢镜头
    // 先点“看全”= 用户动过视口，再推进一次，视口必须一个像素都不动。
    // 重新渲染由删掉陪跑运行触发（服务端动作 → 客户端导航）。
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

    check(
      stealOutline[3] === "pending" && stealOutline[5] === "running",
      "又推进了一次：当前工序从④并行构建走到⑥验收与交付（清单变了 → 页面确实重新渲染过）",
      `清单没按预期变化：${stealOutline.join(",")} —— 这一条不过，下面"视口没被抢"就不算数`,
    );
    // 倍率和平移一个都不许变：setViewport 写的是确定值，动了就说明自动聚焦发生了。
    check(
      afterSteal.gridStep === beforeSteal.gridStep &&
        afterSteal.panX === beforeSteal.panX &&
        afterSteal.panY === beforeSteal.panY,
      `用户动过视口之后不再自动聚焦：推进到⑥时视口纹丝不动` +
        `（倍率 ${afterSteal.zoomLabel}、平移 ${Math.round(afterSteal.panX)},${Math.round(afterSteal.panY)}）`,
      `视口被抢了：${beforeSteal.zoomLabel}(${Math.round(beforeSteal.panX)},${Math.round(beforeSteal.panY)}) → ` +
        `${afterSteal.zoomLabel}(${Math.round(afterSteal.panX)},${Math.round(afterSteal.panY)})` +
        ` —— 用户自己动过视口之后就不该再自动聚焦`,
    );
    // 推进前后都停在“看全”那个倍率上，说明没被拉回 0.45 或拉到 1.x。
    check(
      Math.abs(userMovedScale - fitAllScale) < 1e-9 && userMovedScale < 0.4,
      `推进前后都停在“看全”的倍率上（${beforeSteal.zoomLabel}）`,
      `倍率不是看全那个值：推进前 ${beforeSteal.zoomLabel}，看全时是 ${fitAllSnap.zoomLabel}`,
    );

    cleanupVerifyRun(advRun);
    cleanupVerifyRun(bystander);

    // 清单两个新交互：点一行聚焦到那个任务点（?focus=），点圆点折叠（原生 details）。
    // 坏法都不报错：占位行被做成可点、链接丢掉 ?run=、折叠默认写反、计数一起藏了。
    // 夹具 seedVerifyRun 让可点行与占位行同屏，正好对比。
    heading("第二十一步 · 清单可点击跳转（?focus=）与一级行折叠（<details>）");

    // 行是否可点看有没有 href，折叠状态看 <details> 的 open 属性。
    // 折叠后的可见性三者取或：checkVisibility / offsetParent / 尺寸为 0。
    // 新版 Chromium 用 content-visibility 藏折叠内容，不用 display:none。
    const READ_OUTLINE_SHELL = `(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const rows = q('[data-outline-row]').map((el) => {
        const a = el.querySelector('a[href]');
        const dot = el.querySelector('[data-outline-dot]');
        return {
          level: el.getAttribute('data-outline-level'),
          status: el.getAttribute('data-outline-status'),
          placeholder: el.hasAttribute('data-outline-placeholder'),
          // 行上那个"点下去聚焦到谁"的标记；占位行没有
          focusAttr: el.getAttribute('data-outline-focus'),
          href: a ? a.getAttribute('href') : null,
          text: (el.textContent || '').trim(),
          dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
        };
      });
      const groups = q('[data-outline-group]').map((g) => {
        const summary = g.querySelector('summary');
        const countEl = g.querySelector('[data-outline-count]');
        const kids = [...g.querySelectorAll('[data-outline-row][data-outline-level="2"]')];
        const gr = g.getBoundingClientRect();
        // 折叠内容的可见性由 ::details-content 这一层决定，读出来当证据
        let pseudoCV = null;
        try { pseudoCV = getComputedStyle(g, '::details-content').contentVisibility; } catch (e) { pseudoCV = null; }
        return {
          id: g.getAttribute('data-outline-group'),
          tag: g.tagName.toLowerCase(),
          open: g.open === true,
          openAttr: g.hasAttribute('open'),
          hasSummary: !!summary,
          summaryText: summary ? (summary.textContent || '').trim() : '',
          countText: countEl ? (countEl.textContent || '').trim() : null,
          countAttr: countEl ? countEl.getAttribute('data-outline-count') : null,
          countVisible: countEl ? countEl.checkVisibility() : false,
          // 这一组自己有多高：折叠必须真的把它收掉，不能只改一个属性
          height: Math.round(gr.height),
          pseudoContentVisibility: pseudoCV,
          kidCount: kids.length,
          /** 折叠之后二级行是不是真的看不见了（三个判据取或，见上面那段） */
          kidsHidden: kids.map((el) => {
            const r = el.getBoundingClientRect();
            return (
              el.checkVisibility() === false ||
              el.offsetParent === null ||
              r.height === 0 ||
              r.width === 0
            );
          }),
          /** 同上，但只取 checkVisibility —— 展开时它必须是 true（防"判据永远为真"） */
          kidsCheckVisible: kids.map((el) => el.checkVisibility()),
        };
      });
      return JSON.stringify({
        url: location.pathname + location.search,
        rows,
        groups,
        level1: rows.filter((r) => r.level === '1').length,
        level2: rows.filter((r) => r.level === '2').length,
        placeholders: rows.filter((r) => r.placeholder).length,
        hasStage: !!document.querySelector('[data-canvas-stage]'),
        stages: q('[data-pipeline-stage]').length,
      });
    })()`;

    interface OutlineRowSnap {
      level: string | null;
      status: string | null;
      placeholder: boolean;
      focusAttr: string | null;
      href: string | null;
      text: string;
      dotColor: string | null;
    }
    interface OutlineGroupSnap {
      id: string | null;
      tag: string;
      open: boolean;
      openAttr: boolean;
      hasSummary: boolean;
      summaryText: string;
      countText: string | null;
      countAttr: string | null;
      countVisible: boolean;
      height: number;
      pseudoContentVisibility: string | null;
      kidCount: number;
      kidsHidden: boolean[];
      kidsCheckVisible: boolean[];
    }
    interface OutlineShell {
      url: string;
      rows: OutlineRowSnap[];
      groups: OutlineGroupSnap[];
      level1: number;
      level2: number;
      placeholders: number;
      hasStage: boolean;
      stages: number;
    }

    const readOutlineShell = async (): Promise<OutlineShell> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_OUTLINE_SHELL,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as OutlineShell;
    };

    /** href 里到底带了什么。浏览器会把中文编码，所以解一遍再比 */
    const hrefOf = (row: OutlineRowSnap): string =>
      row.href ? decodeURIComponent(row.href) : "";

    /** 真点某个元素，先滚进可视区：清单可滚动，不滚会点到别的东西 */
    const clickReal = async (selector: string) => {
      await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) el.scrollIntoView({ block: 'center' });
          return !!el;
        })()`,
        returnByValue: true,
      });
      await sleep(250);
      return clickCenter(selector);
    };

    // 21.1 一条带七项检查的运行：三种行同时在清单里
    const outlineRun = seedVerifyRun(username);
    info(
      `造了一条运行 ${outlineRun.runId.slice(0, 8)}（status=done，带 ${outlineRun.count} 项检查）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${outlineRun.runId}` });
    await sleep(4200);

    const shellDefault = await readOutlineShell();
    const viewDefault = await readViewport();
    info(
      `清单 ${shellDefault.rows.length} 行：一级 ${shellDefault.level1} · 二级 ${shellDefault.level2}` +
        ` · 占位 ${shellDefault.placeholders} · 折叠组 ${shellDefault.groups.length}`,
    );
    info(
      `三种行的 href：` +
        `一级“${shellDefault.rows.find((r) => r.level === "1")?.href}”· ` +
        `二级实体“${shellDefault.rows.find((r) => r.level === "2" && !r.placeholder)?.href}”· ` +
        `占位“${shellDefault.rows.find((r) => r.placeholder)?.href}”`,
    );

    check(
      shellDefault.level1 === 6 &&
        shellDefault.placeholders === 5 &&
        shellDefault.level2 === outlineRun.count + 5,
      `清单结构对得上：6 个一级行 + ${outlineRun.count} 个二级实体行 + 5 个占位行`,
      `清单结构不对：一级 ${shellDefault.level1}（期望 6）· 占位 ${shellDefault.placeholders}（期望 5）· ` +
        `二级共 ${shellDefault.level2}（期望 ${outlineRun.count + 5}）`,
    );

    // 21.2 可点的行才有 href，而且不许丢掉 ?run=
    const level1Rows = shellDefault.rows.filter((r) => r.level === "1");
    const realLevel2 = shellDefault.rows.filter(
      (r) => r.level === "2" && !r.placeholder,
    );
    const placeholders = shellDefault.rows.filter((r) => r.placeholder);

    // 一级行的 href 要同时带 run 和 focus；用行自己的 data-outline-focus 对账。
    const level1Bad = level1Rows.filter(
      (r) =>
        !r.focusAttr ||
        !hrefOf(r).includes(`run=${outlineRun.runId}`) ||
        !hrefOf(r).includes(`focus=${r.focusAttr}`),
    );
    check(
      level1Rows.length === 6 && level1Bad.length === 0,
      `六个一级行都有 href，且同时带着 ?run=（${outlineRun.runId.slice(0, 8)}…）和 focus=<自己的节点 id>`,
      `${level1Bad.length} 个一级行的 href 不对：` +
        (level1Bad.map((r) => `${r.text}→${r.href}`).join(" ") || "一个一级行都没有"),
    );

    const level2Bad = realLevel2.filter(
      (r) =>
        !r.focusAttr ||
        !hrefOf(r).includes(`run=${outlineRun.runId}`) ||
        !hrefOf(r).includes(`focus=${r.focusAttr}`),
    );
    check(
      realLevel2.length === outlineRun.count && level2Bad.length === 0,
      `${realLevel2.length} 个二级实体行（画布上有卡片的执行点）也都有 href 且带着 focus=`,
      `${level2Bad.length} 个二级行的 href 不对：` +
        level2Bad.map((r) => `${r.text}→${r.href}`).join(" "),
    );

    // 占位行没有对应节点，必须既无 href 也无 data-outline-focus。
    // 少了后者，“不可点但看起来能点”照样能通过。
    const clickablePlaceholders = placeholders.filter(
      (r) => r.href !== null || r.focusAttr !== null,
    );
    check(
      placeholders.length === 5 && clickablePlaceholders.length === 0,
      `五个占位行都没有 href、也没有 data-outline-focus（不可点，不是"假装可点"）`,
      `${clickablePlaceholders.length} 个占位行被做成了可点：` +
        clickablePlaceholders
          .map((r) => `${r.text}→href=${r.href} focus=${r.focusAttr}`)
          .join(" "),
    );
    // 对照：同一份清单里确实有可点的行，否则“所有行都没 href”也会绿。
    const hrefCount = shellDefault.rows.filter((r) => r.href !== null).length;
    check(
      hrefCount === 6 + outlineRun.count,
      `同一份清单里有 ${6 + outlineRun.count} 行带 href（可点性不是"全都没有"）`,
      `带 href 的行只有 ${hrefCount} 个，期望 ${6 + outlineRun.count}`,
    );

    // 21.3 点一个二级行：URL 带 focus= 且视口真的动过去
    // 顺序要紧：必须在用户点击前记下默认视口，点完就算用户动过视口。
    // 只断言 URL 变了不够：URL 对了而视口没动，就是点了没反应。
    const defaultScale = scaleOf(viewDefault);
    info(
      `点击前：URL ${shellDefault.url} · 倍率 ${viewDefault.zoomLabel} · ` +
        `平移 ${Math.round(viewDefault.panX)},${Math.round(viewDefault.panY)}`,
    );
    check(
      Math.abs(defaultScale - fitFloor("page")) < 0.01,
      `点击前停在默认视图（倍率 ${viewDefault.zoomLabel} = 下限 ${fitFloor("page")}）`,
      `点击前倍率是 ${viewDefault.zoomLabel}（期望 ${fitFloor("page")}）—— 打开时该装下整棵树`,
    );

    // 清单行的 id 就是画布节点 id：verify:<检查项名字>，两条路径共用这个约定。
    const targetRow = realLevel2[0];
    const targetId = targetRow.focusAttr as string;
    const targetTitle = targetRow.text;
    check(
      targetId === `verify:${targetTitle}`,
      `清单里那一行的 id 就是画布上的节点 id（${targetId}）`,
      `行 id 和检查项名字对不上：focus=${targetId}，行文字=${targetTitle}`,
    );

    const rowSelector = `[data-outline-row][data-outline-focus="${targetId}"] a[href]`;
    const rowHit = await clickReal(rowSelector);
    info(
      rowHit.ok
        ? `点了二级行“${targetTitle}”（页面坐标 ${rowHit.x}, ${rowHit.y}）`
        : "清单里没有那条链接可点 —— 下面这一组会红",
    );
    await sleep(1600);

    const shellAfterClick = await readOutlineShell();
    const viewAfterClick = await readViewport();
    info(
      `点击后：URL ${shellAfterClick.url} · 倍率 ${viewAfterClick.zoomLabel} · ` +
        `平移 ${Math.round(viewAfterClick.panX)},${Math.round(viewAfterClick.panY)}`,
    );

    check(
      decodeURIComponent(shellAfterClick.url).includes(`focus=${targetId}`) &&
        shellAfterClick.url.includes(`run=${outlineRun.runId}`),
      `URL 带上了 focus=${targetId}，而且原来的 ?run= 还在`,
      `URL 是 ${shellAfterClick.url} —— 期望同时含 focus=${targetId} 和 run=${outlineRun.runId}`,
    );
    check(
      viewAfterClick.gridStep !== viewDefault.gridStep ||
        viewAfterClick.panX !== viewDefault.panX ||
        viewAfterClick.panY !== viewDefault.panY,
      `画布视口真的动了：倍率 ${viewDefault.zoomLabel} → ${viewAfterClick.zoomLabel}，` +
        `平移 ${Math.round(viewDefault.panX)},${Math.round(viewDefault.panY)} → ` +
        `${Math.round(viewAfterClick.panX)},${Math.round(viewAfterClick.panY)}`,
      `URL 变了但视口一个像素都没动（还是 ${viewAfterClick.zoomLabel}）—— ` +
        `这就是"点了没反应"，而它在 URL 断言里是绿的`,
    );

    // 点完那一行，目标节点得落在画布矩形内，容差 2px 给亚像素。
    const targetIdx = viewAfterClick.nodeIds.indexOf(targetId);
    const targetBox = targetIdx >= 0 ? viewAfterClick.nodeBoxes[targetIdx] : null;
    const st = viewAfterClick.stage;
    const inside =
      targetBox !== null &&
      targetBox.left >= st.left - 2 &&
      targetBox.top >= st.top - 2 &&
      targetBox.right <= st.left + st.w + 2 &&
      targetBox.bottom <= st.top + st.h + 2;
    info(
      targetBox
        ? `目标节点在屏幕 (${Math.round(targetBox.left)}, ${Math.round(targetBox.top)}) ` +
            `${Math.round(targetBox.w)}×${Math.round(targetBox.h)}，画布 ` +
            `(${Math.round(st.left)}, ${Math.round(st.top)}) ${Math.round(st.w)}×${Math.round(st.h)}`
        : `画布上找不到 ${targetId} 这个节点`,
    );
    check(
      inside,
      `聚焦目标落在画布矩形里（${targetId} 四边都在画布内）`,
      `目标不在画布内：${targetId} → ` +
        (targetBox
          ? `节点 (${Math.round(targetBox.left)}, ${Math.round(targetBox.top)}, ` +
            `${Math.round(targetBox.right)}, ${Math.round(targetBox.bottom)})，` +
            `画布 (${Math.round(st.left)}, ${Math.round(st.top)}, ` +
            `${Math.round(st.left + st.w)}, ${Math.round(st.top + st.h)})`
          : "画布上压根没有这个节点"),
    );

    // 21.4 一级行的标题也是一条能跳的链接
    // 一级行是 summary，点标题是跳转还是折叠要看浏览器实现，只能实测。
    // 这里断言跳转确实发生了，折叠状态只打印不断言。
    const specGroupBefore = shellAfterClick.groups.find((g) => g.id === "spec");
    const level1Hit = await clickReal(`[data-outline-group="spec"] summary a[href]`);
    info(
      level1Hit.ok
        ? `点了一级行“规格化”的标题（页面坐标 ${level1Hit.x}, ${level1Hit.y}）`
        : "一级行的标题不是链接 —— 下面这条会红",
    );
    await sleep(1600);

    const shellAfterLevel1 = await readOutlineShell();
    const specGroupAfter = shellAfterLevel1.groups.find((g) => g.id === "spec");
    info(
      `点一级行标题之后：URL ${shellAfterLevel1.url} · ` +
        `“规格化”那一组 open=${specGroupBefore?.open} → ${specGroupAfter?.open}` +
        `（点标题是跳转还是折叠，实测数据）`,
    );
    check(
      decodeURIComponent(shellAfterLevel1.url).includes("focus=spec") &&
        shellAfterLevel1.url.includes(`run=${outlineRun.runId}`),
      `点一级行的标题也能跳（URL 带 focus=spec，原来的 ?run= 还在）`,
      `URL 是 ${shellAfterLevel1.url} —— 期望含 focus=spec 和 run=${outlineRun.runId}`,
    );

    // 21.5 点一个不存在的节点：页面正常渲染，画布停在默认视图
    // 两种输入：URL 写了不存在的 id，或清单里有、画布上没画的行。
    // 要求都是什么都不做：不许崩，也不许随便聚焦一个。
    const bogus = "根本不存在的东西";
    await cdp.send("Page.navigate", {
      url: `${BASE}/canvas?run=${outlineRun.runId}&focus=${encodeURIComponent(bogus)}`,
    });
    await sleep(4200);

    const shellBogus = await readOutlineShell();
    const viewBogus = await readViewport();
    info(
      `?focus=${bogus} → URL ${shellBogus.url} · 倍率 ${viewBogus.zoomLabel} · ` +
        `平移 ${Math.round(viewBogus.panX)},${Math.round(viewBogus.panY)} · ` +
        `清单 ${shellBogus.rows.length} 行 · 画布上 ${shellBogus.stages} 道工序`,
    );

    check(
      shellBogus.hasStage &&
        shellBogus.stages === 6 &&
        shellBogus.rows.length === shellDefault.rows.length &&
        shellBogus.level1 === 6,
      `点不存在的 focus：页面正常渲染（画布在、六道工序在、清单 ${shellBogus.rows.length} 行一行不少）`,
      `页面渲染不正常：画布=${shellBogus.hasStage} 工序=${shellBogus.stages} ` +
        `清单行=${shellBogus.rows.length}（正常是 ${shellDefault.rows.length}）`,
    );
    // 视口要和“打开这条运行、不带 focus”逐值相等：自动适应是确定值，聚焦过就不一样。
    check(
      viewBogus.gridStep === viewDefault.gridStep &&
        viewBogus.panX === viewDefault.panX &&
        viewBogus.panY === viewDefault.panY,
      `视口停在默认视图（倍率 ${viewBogus.zoomLabel}、平移 ` +
        `${Math.round(viewBogus.panX)},${Math.round(viewBogus.panY)}，和不带 focus 时逐值相等）`,
      `视口被一个不存在的 id 带跑了：` +
        `${viewBogus.zoomLabel}(${Math.round(viewBogus.panX)},${Math.round(viewBogus.panY)}) ≠ ` +
        `${viewDefault.zoomLabel}(${Math.round(viewDefault.panX)},${Math.round(viewDefault.panY)})`,
    );

    // 21.6 一级行可折叠：原生 details，默认全开
    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${outlineRun.runId}` });
    await sleep(4200);

    const shellGroups = await readOutlineShell();
    info(
      `折叠组 ${shellGroups.groups.length} 个，默认 open：` +
        shellGroups.groups.map((g) => `${g.id}=${g.open}`).join(" "),
    );

    // 六个组都该是原生 <details> 且默认 open：默认收起的话首屏只剩六行标题。
    const notDetails = shellGroups.groups.filter(
      (g) => g.tag !== "details" || !g.hasSummary,
    );
    check(
      shellGroups.groups.length === 6 && notDetails.length === 0,
      `六个一级行各是一个原生 <details> + <summary>（服务端可用、零 JS、键盘可达）`,
      `${notDetails.length} 个组不是 <details>+<summary>：` +
        notDetails.map((g) => `${g.id}(${g.tag})`).join(" ") +
        `（组共 ${shellGroups.groups.length} 个，期望 6）`,
    );
    check(
      shellGroups.groups.every((g) => g.open && g.openAttr),
      `默认全部展开（${shellGroups.groups.length}/6 个组的 open 都是 true）—— 第一眼看到全貌`,
      `有 ${shellGroups.groups.filter((g) => !g.open).length} 个组默认是收起的：` +
        shellGroups.groups
          .filter((g) => !g.open)
          .map((g) => g.id)
          .join(" "),
    );

    // summary 里要有状态点、标题、二级点计数：收起后计数是唯一还看得见的线索。
    const verifyGroup = shellGroups.groups.find((g) => g.id === "verify");
    const specGroup = shellGroups.groups.find((g) => g.id === "spec");
    check(
      verifyGroup?.countAttr === String(outlineRun.count) &&
        verifyGroup?.kidCount === outlineRun.count &&
        specGroup?.countAttr === "1" &&
        specGroup?.kidCount === 1,
      `summary 里带着"下面有几个二级点"：验收=${verifyGroup?.countAttr}（${outlineRun.count} 项检查）· ` +
        `规格化=${specGroup?.countAttr}（1 行“待规划”）`,
      `计数不对：验收 ${verifyGroup?.countAttr}/${verifyGroup?.kidCount}（期望 ${outlineRun.count}）· ` +
        `规格化 ${specGroup?.countAttr}/${specGroup?.kidCount}（期望 1）`,
    );

    // 21.7 折叠后二级行真的不可见，再点又可见
    // 点的是前面的圆点，不是标题：标题是链接会跳，圆点才是折叠开关。
    // 用真鼠标点，el.click() 会绕过命中测试。
    const dotHit = await clickReal(
      `[data-outline-group="verify"] > summary [data-outline-dot]`,
    );
    info(
      dotHit.ok
        ? `点了“验收与交付”前面的圆点（页面坐标 ${dotHit.x}, ${dotHit.y}）`
        : "找不到那个圆点 —— 下面这一组会红",
    );
    await sleep(500);

    const collapsed = await readOutlineShell();
    const verifyCollapsed = collapsed.groups.find((g) => g.id === "verify");
    info(
      `折叠后：“验收”组 open=${verifyCollapsed?.open} · 组高 ` +
        `${verifyGroup?.height} → ${verifyCollapsed?.height}px · ::details-content ` +
        `${verifyGroup?.pseudoContentVisibility} → ${verifyCollapsed?.pseudoContentVisibility} · ` +
        `二级行 ${verifyCollapsed?.kidCount} 个，不可见的 ` +
        `${verifyCollapsed?.kidsHidden.filter(Boolean).length} 个 · ` +
        `计数还看得见=${verifyCollapsed?.countVisible}（${verifyCollapsed?.countText}）`,
    );

    check(
      verifyCollapsed?.open === false &&
        verifyCollapsed.kidCount === outlineRun.count &&
        verifyCollapsed.kidsHidden.every(Boolean),
      `折叠之后 ${outlineRun.count} 个二级行全部不可见` +
        `（checkVisibility 为 false / offsetParent 为 null / 高度为 0，三者取或）`,
      `折叠没生效：open=${verifyCollapsed?.open}，` +
        `${verifyCollapsed?.kidsHidden.filter((h) => !h).length} 个二级行还看得见 —— ` +
        `"折叠"不能写成 opacity:0 那种还画在屏幕上的隐藏`,
    );
    // 折叠还要真的把地方让出来，否则标题下面是一大片空白。
    // 二级行的几何在折叠后仍然保留，所以判可见性只能看这一组自己的高度。
    check(
      verifyCollapsed !== undefined &&
        verifyGroup !== undefined &&
        verifyCollapsed.height <= verifyGroup.height - outlineRun.count * 20,
      `折叠把地方真的让出来了：组高 ${verifyGroup?.height} → ${verifyCollapsed?.height}px` +
        `（${outlineRun.count} 行二级点，约 ${outlineRun.count * 27}px）`,
      `组高没变：${verifyGroup?.height} → ${verifyCollapsed?.height}px —— ` +
        `属性改了但内容还占着地方，用户看到的是折叠标题下面一大片空白`,
    );
    // 收起不等于这里什么都没有：计数跟着藏了，用户就没线索判断这一组值不值得展开。
    check(
      verifyCollapsed?.countVisible === true &&
        verifyCollapsed?.countText === String(outlineRun.count),
      `收起之后计数仍然可见（“${verifyCollapsed?.countText}”）—— 还看得出这一组下面有 ${outlineRun.count} 个点`,
      `收起之后计数也看不见了（可见=${verifyCollapsed?.countVisible}）—— 那就成了"这一组什么都没有"的样子`,
    );

    const dotHit2 = await clickReal(
      `[data-outline-group="verify"] > summary [data-outline-dot]`,
    );
    info(
      dotHit2.ok
        ? `又点了一下同一个圆点（页面坐标 ${dotHit2.x}, ${dotHit2.y}）`
        : "第二次点的时候圆点不见了 —— 下面这条会红",
    );
    await sleep(500);

    const expanded = await readOutlineShell();
    const verifyExpanded = expanded.groups.find((g) => g.id === "verify");
    info(
      `再展开后：“验收”组 open=${verifyExpanded?.open} · 组高 ${verifyExpanded?.height}px · ` +
        `::details-content ${verifyExpanded?.pseudoContentVisibility} · ` +
        `checkVisibility 全为 true 的二级行 ${verifyExpanded?.kidsCheckVisible.filter(Boolean).length}/${outlineRun.count}`,
    );
    check(
      verifyExpanded?.open === true &&
        verifyExpanded.kidCount === outlineRun.count &&
        verifyExpanded.kidsHidden.every((h) => !h),
      `再点一下又展开：${outlineRun.count} 个二级行重新可见`,
      `没能展开：open=${verifyExpanded?.open}，` +
        `${verifyExpanded?.kidsHidden.filter(Boolean).length} 个二级行还是看不见`,
    );
    // 展开时同一判据要给 true，否则一个恒真的判据能让上面三条一起绿。
    check(
      verifyExpanded?.kidsCheckVisible.length === outlineRun.count &&
        verifyExpanded.kidsCheckVisible.every(Boolean),
      `展开时同一个判据给出相反的结果（${outlineRun.count}/${outlineRun.count} 个 checkVisibility 为 true）` +
        `—— 可见性判据不是恒真的`,
      `展开时判定为可见的只有 ${verifyExpanded?.kidsCheckVisible.filter(Boolean).length}/${outlineRun.count} 个 —— ` +
        `判据分不开两种状态，上面"折叠后不可见"那两条就不算数`,
    );

    cleanupVerifyRun(outlineRun.runId);
    info("夹具已清理");

    // 这一步验三件事：两个页签切的是两种不同事件；旧的块不销毁；没有思考要明说。
    // “不销毁”得断言到 DOM 节点本身，页面上“还有两个字”是看不出来的。
    // 夹具直接插库，事件逐字段照真实事件写，用完就删。
    heading("第二十二步 · 右侧面板（思考 / 结果）与按步骤分块的过程流");

    /** 读过程流的块与右侧面板的两个页签 */
    const READ_STEPS = `(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const text = (el) => (el ? el.textContent.trim() : '');
      const blocks = q('[data-process-block]');
      const container = document.querySelector('[data-process-blocks]');
      const body = document.querySelector('[data-step-body]');
      const tabs = q('[data-step-tab]');
      const active = document.querySelector('[data-step-tab-active]');
      return JSON.stringify({
        blockIds: blocks.map((b) => b.getAttribute('data-process-block')),
        blockTitles: blocks.map((b) => text(b.querySelector('[data-process-block-title]'))),
        blockTones: blocks.map((b) => b.getAttribute('data-process-tone')),
        // 屏幕纵向位置：用来证明"新的长在旧的下面"，而不是只看数组顺序
        blockTops: blocks.map((b) => Math.round(b.getBoundingClientRect().top)),
        borderTops: blocks.map((b) => getComputedStyle(b).borderTopWidth),
        currentIds: blocks
          .filter((b) => b.hasAttribute('data-process-block-current'))
          .map((b) => b.getAttribute('data-process-block')),
        lastChildIsBlock: container
          ? !!container.lastElementChild && container.lastElementChild.hasAttribute('data-process-block')
          : null,
        emptyLine: text(document.querySelector('[data-process-blocks-empty]')),
        tabs: tabs.map((t) => ({
          key: t.getAttribute('data-step-tab'),
          label: t.textContent.trim(),
          active: t.hasAttribute('data-step-tab-active'),
        })),
        activeTab: active ? active.getAttribute('data-step-tab') : null,
        panelTitle: text(document.querySelector('[data-step-title]')),
        position: text(document.querySelector('[data-step-position]')),
        bodyText: body ? body.textContent : null,
        reasoningEmpty: !!document.querySelector('[data-step-reasoning-empty]'),
        textShown: !!document.querySelector('[data-step-text]'),
        checks: q('[data-step-check]').map((el) => ({
          name: el.getAttribute('data-step-check'),
          pass: el.getAttribute('data-step-check-pass'),
          color: getComputedStyle(el).color,
        })),
        usage: (() => {
          const el = document.querySelector('[data-step-usage]');
          return el
            ? {
                cost: el.getAttribute('data-step-usage-cost'),
                input: el.getAttribute('data-step-usage-input'),
                output: el.getAttribute('data-step-usage-output'),
                reasoning: el.getAttribute('data-step-usage-reasoning'),
                text: el.textContent,
              }
            : null;
        })(),
      });
    })()`;

    interface StepsSnap {
      blockIds: (string | null)[];
      blockTitles: string[];
      blockTones: (string | null)[];
      blockTops: number[];
      borderTops: string[];
      currentIds: (string | null)[];
      lastChildIsBlock: boolean | null;
      emptyLine: string;
      tabs: { key: string | null; label: string; active: boolean }[];
      activeTab: string | null;
      panelTitle: string;
      position: string;
      bodyText: string | null;
      reasoningEmpty: boolean;
      textShown: boolean;
      checks: { name: string | null; pass: string | null; color: string }[];
      usage: {
        cost: string | null;
        input: string | null;
        output: string | null;
        reasoning: string | null;
        text: string;
      } | null;
    }

    const readSteps = async (): Promise<StepsSnap> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_STEPS,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as StepsSnap;
    };

    /** 点一个页签。用真鼠标点（走命中测试），不用 el.click() */
    const clickTab = async (key: "reasoning" | "result") => {
      const hit = await clickCenter(`[data-step-tab="${key}"]`);
      await sleep(350);
      return hit;
    };

    // 22.1 一条正在生成的运行：两块，当前块是正在生成
    // 事件顺序照 generate/service.ts 真正会吐的顺序；正文故意写成多段 delta。
    const stepsRun = seedStepRun(username, "gen", "running", [
      ["phase", stepPhase("spec", "正在把你的需求整理成规格")],
      ["reasoning", stepReasoning("先把这句话读成需求")],
      ["usage", stepUsage(0.0012, 800, 120, 60)],
      ["phase", stepPhase("generating", "正在生成")],
      ["reasoning", stepReasoning("先想清楚结构")],
      ["reasoning", stepReasoning("，再动手写")],
      ["text", stepText("第一行正文\n")],
      ["text", stepText("第二行正文\n第三行正文\n第四行正文\n第五行正文")],
      ["usage", stepUsage(0.0345, 1200, 3000, 0)],
    ]);
    info(
      `造了一条运行 ${stepsRun.slice(0, 8)}（2 条 phase、2 段思考、5 行正文、2 次记账）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${stepsRun}` });
    await sleep(4200);

    const steps = await readSteps();
    info(
      `过程流 ${steps.blockIds.length} 块：` +
        steps.blockTitles.map((t, i) => `[${i + 1}]${t}`).join(" · "),
    );
    info(
      `右侧面板：页签 ${steps.tabs.map((t) => `${t.label}${t.active ? "(选中)" : ""}`).join(" / ")} · ` +
        `标题“${steps.panelTitle}”· ${steps.position}`,
    );

    check(
      steps.tabs.length === 2 &&
        steps.tabs.map((t) => t.label).join(",") === "思考,结果" &&
        steps.tabs.filter((t) => t.active).length === 1 &&
        steps.activeTab === "reasoning",
      "右侧面板有两个页签（思考 / 结果），打开时默认选中“思考”，且只有一个选中态",
      `页签不对：${JSON.stringify(steps.tabs)}（选中 ${steps.activeTab}）`,
    );
    check(
      steps.panelTitle === "正在生成" && steps.position === "第 2 步 / 共 2 步",
      `面板标题是当前块（最后一条 phase）“${steps.panelTitle}”，位置写着“${steps.position}”`,
      `面板显示的是“${steps.panelTitle}”/“${steps.position}”—— 期望“正在生成”/“第 2 步 / 共 2 步”`,
    );
    // 思考页签必须是真思考，且没混进正文；两条一起断言才挡得住“两边都显示正文”。
    check(
      (steps.bodyText ?? "").includes("先想清楚结构，再动手写") &&
        !(steps.bodyText ?? "").includes("第一行正文"),
      "“思考”页签显示的是真实 reasoning（两段 delta 按序拼起来），且没有混进正文",
      `思考页签里读到的是：“${(steps.bodyText ?? "").slice(0, 80)}”`,
    );
    check(
      steps.blockIds.length === 2,
      "过程流按两条真实 phase 切成 2 块（没有凭空造步骤）",
      `切出来 ${steps.blockIds.length} 块：${steps.blockIds.join(",")}`,
    );
    check(
      steps.borderTops[0] === "0px" &&
        steps.borderTops.slice(1).every((w) => w !== "0px"),
      `块之间有分隔线（第 1 块 ${steps.borderTops[0]}、第 2 块 ${steps.borderTops[1]}）`,
      `分隔线不对：${JSON.stringify(steps.borderTops)} —— 期望第一块 0px、其余非 0`,
    );
    check(
      steps.currentIds.length === 1 &&
        steps.currentIds[0] === steps.blockIds[steps.blockIds.length - 1],
      "“当前块”就是最后一块 —— 和右侧面板显示的是同一块（同一个口径）",
      `当前块是 ${JSON.stringify(steps.currentIds)}，最后一块是 ${steps.blockIds[steps.blockIds.length - 1]}`,
    );

    // 22.2 点“结果”：内容必须真的换掉
    const thoughtBody = steps.bodyText ?? "";
    const resultHit = await clickTab("result");
    info(
      resultHit.ok
        ? `点了“结果”页签（页面坐标 ${resultHit.x}, ${resultHit.y}）`
        : "找不到“结果”页签 —— 下面这一组会红",
    );
    const result = await readSteps();
    const resultBody = result.bodyText ?? "";

    check(
      result.activeTab === "result" && result.tabs.filter((t) => t.active).length === 1,
      "点“结果”之后选中态真的搬过去了（两个页签仍然只有一个选中）",
      `选中态不对：activeTab=${result.activeTab}，选中数=${result.tabs.filter((t) => t.active).length}`,
    );
    check(
      resultBody !== thoughtBody &&
        resultBody.includes("第二行正文") &&
        result.textShown &&
        !resultBody.includes("先想清楚结构"),
      "点“结果”内容真的换了：思考那一段不见了，换成了正文（含“第二行正文…”）",
      `内容没换：思考页签“${thoughtBody.slice(0, 40)}”/ 结果页签“${resultBody.slice(0, 40)}”`,
    );
    // 花费与 token 只能来自这一块自己的 usage 事件：累加别块或张冠李戴都会露馅。
    check(
      result.usage !== null &&
        result.usage.cost === "0.0345" &&
        result.usage.input === "1200" &&
        result.usage.output === "3000" &&
        result.usage.reasoning === "0" &&
        result.usage.text.includes("¥0.0345"),
      "花费与 token 原样来自这一块的真实 usage 事件：¥0.0345 · 输入 1200 · 输出 3000 · 其中思考 0",
      `用量明细不对：${JSON.stringify(result.usage)} —— 期望原样显示 0.0345 / 1200 / 3000 / 0（不估算、不累加别块）`,
    );

    // 22.3 痕迹保留：同一条运行多出一步，旧块必须在原地不动
    // 痕迹保留：追加一条 phase + 一条 check，再点 chip 走客户端导航重新渲染。
    // 要验三件事：旧块还在且是同一个 DOM 节点、新块在下面、最后一块之下没有别的块。
    const firstIdBefore = steps.blockIds[0];
    const firstTitleBefore = steps.blockTitles[0];
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-process-block="${firstIdBefore}"]');
        window.__firstBlockNode = el;
        const digest = el ? el.querySelector('[data-process-block-digest]') : null;
        window.__firstBlockDigest = digest ? digest.textContent : '';
        return !!el;
      })()`,
      returnByValue: true,
    });

    appendStepEvents(stepsRun, 9, [
      ["phase", stepPhase("checking", "正在检查产物")],
      ["check", stepCheck()],
    ]);
    info(
      "往同一条运行追加了第 3 步（phase:checking + 一次 check），再点运行 chip 触发服务端重新渲染",
    );

    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-run-chip="${stepsRun}"] a').click()`,
    });
    await sleep(3800);

    const kept = await readSteps();
    const nodeProbe = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-process-block="${firstIdBefore}"]');
        const digest = el ? el.querySelector('[data-process-block-digest]') : null;
        return JSON.stringify({
          stillSameNode: window.__firstBlockNode === el,
          stillConnected: !!(window.__firstBlockNode && window.__firstBlockNode.isConnected),
          digestUnchanged: (digest ? digest.textContent : '') === window.__firstBlockDigest,
        });
      })()`,
      returnByValue: true,
    });
    const probe = JSON.parse(nodeProbe.result!.value!) as {
      stillSameNode: boolean;
      stillConnected: boolean;
      digestUnchanged: boolean;
    };
    info(
      `追加之后 ${kept.blockIds.length} 块：` +
        kept.blockTitles.map((t, i) => `[${i + 1}]${t}`).join(" · ") +
        ` · 屏幕纵坐标 ${kept.blockTops.join(",")}`,
    );
    info(
      `第 1 块（${firstIdBefore}）：同一个 DOM 节点=${probe.stillSameNode} · ` +
        `仍挂在文档里=${probe.stillConnected} · 内容一字未变=${probe.digestUnchanged}`,
    );

    check(
      kept.blockIds.length === 3 &&
        kept.blockIds.slice(0, 2).join(",") === steps.blockIds.join(","),
      `新块追加在下面，旧的块一个不少、顺序不变（${steps.blockIds.join(",")} → ${kept.blockIds.join(",")}）`,
      `块列表不对：${kept.blockIds.join(",")} —— 期望前两块仍是 ${steps.blockIds.join(",")}，末尾多一块`,
    );
    check(
      kept.blockIds[0] === firstIdBefore &&
        kept.blockTitles[0] === firstTitleBefore &&
        probe.digestUnchanged,
      `第 1 个块仍在 DOM 里，标题和内容一字未变（${firstIdBefore} /“${firstTitleBefore}”）`,
      `第 1 个块变了或被顶掉了：id=${kept.blockIds[0]} 标题=${kept.blockTitles[0]} 内容未变=${probe.digestUnchanged}`,
    );
    check(
      probe.stillSameNode && probe.stillConnected,
      "第 1 个块是**同一个 DOM 节点**（没被销毁重建）—— 这正是“旧的留在上方”的硬证据",
      `第 1 个块换了节点（同一个=${probe.stillSameNode} 还在文档里=${probe.stillConnected}）：` +
        `新块一来整列被重建了，"往上滚还能看到历史"就不成立`,
    );
    check(
      kept.blockTops.length === 3 &&
        kept.blockTops[1] > kept.blockTops[0] &&
        kept.blockTops[2] > kept.blockTops[1] &&
        kept.lastChildIsBlock === true &&
        kept.currentIds.join(",") === kept.blockIds[kept.blockIds.length - 1],
      `新块长在最下面（纵坐标 ${kept.blockTops.join(" < ")}），最后一块之下没有别的块，且它就是当前块`,
      `纵向顺序不对：${kept.blockTops.join(",")}；最后一个是块=${kept.lastChildIsBlock}；` +
        `当前块=${kept.currentIds.join(",")}（最后一块是 ${kept.blockIds[kept.blockIds.length - 1]}）`,
    );

    // 面板要跟着走到新那一步，并列出这一块的检查；绿红必须是两个不同的值。
    const checked = await readSteps();
    info(
      `右侧面板现在停在“${checked.panelTitle}”${checked.position} · ` +
        `检查项 ${checked.checks.length} 条（通过 ${checked.checks.filter((c) => c.pass === "1").length}）`,
    );
    check(
      checked.panelTitle === "正在检查产物" && checked.position === "第 3 步 / 共 3 步",
      `面板跟着走到第 3 步“${checked.panelTitle}”（${checked.position}）`,
      `面板没跟着走：${checked.panelTitle} / ${checked.position}`,
    );
    check(
      checked.checks.length === STEP_CHECKS.length &&
        checked.checks.filter((c) => c.pass === "1").length === 6,
      `“结果”页签列出了这一块的 ${STEP_CHECKS.length} 项检查（6 通过 / 1 未过）`,
      `检查清单不对：${checked.checks.length} 条，通过 ${checked.checks.filter((c) => c.pass === "1").length} 条`,
    );
    const passColors = [
      ...new Set(checked.checks.filter((c) => c.pass === "1").map((c) => c.color)),
    ];
    const failColors = [
      ...new Set(checked.checks.filter((c) => c.pass !== "1").map((c) => c.color)),
    ];
    check(
      passColors.length === 1 &&
        passColors[0] === "rgb(74, 222, 128)" &&
        failColors.length === 1 &&
        failColors[0] === "rgb(248, 113, 113)",
      `通过的是绿 ${passColors[0]}、未过的是红 ${failColors[0]}（两种都真的出现在页面上）`,
      `检查项颜色不对：通过 ${JSON.stringify(passColors)}、未过 ${JSON.stringify(failColors)}`,
    );

    // 22.4 没有思考就明说没有，而且不拿正文顶上
    // 一条 reasoning 都没有的运行：要明说“没有返回思考内容”，且不拿正文冒充。
    // 正文本身不能丢，切到“结果”还得看得到。
    const textOnlyRun = seedStepRun(username, "text", "running", [
      ["phase", stepPhase("spec", "正在把你的需求整理成规格")],
      ["phase", stepPhase("generating", "正在生成")],
      ["text", stepText(TEXT_ONLY_BODY)],
    ]);
    info(`造了一条运行 ${textOnlyRun.slice(0, 8)}（只有正文、一条 reasoning 都没有）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${textOnlyRun}` });
    await sleep(4200);

    const emptyThink = await readSteps();
    info(
      `思考页签：明说没有=${emptyThink.reasoningEmpty} · ` +
        `读到的第一句“${(emptyThink.bodyText ?? "").trim().slice(0, 30)}”`,
    );

    check(
      emptyThink.reasoningEmpty &&
        (emptyThink.bodyText ?? "").includes("没有返回思考内容"),
      "这一步没有 reasoning 片段时，面板**明说**：“这一步没有返回思考内容”（不是留白）",
      `没有明说：标记=${emptyThink.reasoningEmpty}，读到的是“${(emptyThink.bodyText ?? "").slice(0, 60)}”`,
    );
    check(
      !(emptyThink.bodyText ?? "").includes(TEXT_ONLY_BODY),
      "而且没有拿正文冒充思考（那段正文不在“思考”页签里）",
      "“思考”页签里出现了正文内容 —— 那是把生成结果说成模型的思考过程",
    );

    const onlyResultHit = await clickTab("result");
    const onlyResult = await readSteps();
    check(
      onlyResultHit.ok &&
        (onlyResult.bodyText ?? "").includes(TEXT_ONLY_BODY) &&
        onlyResult.textShown,
      "切到“结果”就能看到那段真正文（正文没丢，只是不在“思考”那一页）",
      `结果页签里没有正文：${(onlyResult.bodyText ?? "").slice(0, 60)}`,
    );

    cleanupVerifyRun(stepsRun);
    cleanupVerifyRun(textOnlyRun);

    // 22.5 实时流没被弄坏：点一次“开始生成”，块真的在流里长出来
    // 实时流：上面几步验的是落库后切出来的块，这里验事件一边来、块一边长。
    // 用已有成品的幂等回放分支造一条真 SSE，不调模型、不花钱。
    // 用 MutationObserver 抓那一瞬间：流结束后客户端会刷新，sleep 再读就读不到了。
    const liveRun = seedStepRun(username, "live", "running", [
      ["phase", stepPhase("generating", "正在生成")],
    ]);
    await fsArtifactStore.save({
      runId: liveRun,
      kind: "html",
      path: `${liveRun}/index.html`,
      content:
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>端到端夹具</title></head><body><h1>夹具</h1></body></html>',
    });
    info(
      `造了一条"已有成品"的运行 ${liveRun.slice(0, 8)}（点生成走幂等回放：不调模型、不花钱）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${liveRun}` });
    await sleep(4200);

    // 有成品时工作台默认停在“成品”那一页，先切回“生成过程”
    await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '生成过程').click()`,
    });
    await sleep(700);

    const liveBefore = await readSteps();
    info(
      `点之前过程流里 ${liveBefore.blockIds.length} 块：${liveBefore.blockIds.join(",")}`,
    );

    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        window.__liveSeen = [];
        window.__liveTitles = [];
        window.__liveMax = 0;
        window.__liveFirstNode = document.querySelector('[data-process-block]');
        const scan = () => {
          const all = document.querySelectorAll('[data-process-block]');
          if (all.length > window.__liveMax) window.__liveMax = all.length;
          all.forEach((el) => {
            const id = el.getAttribute('data-process-block') || '';
            // step-1000000 是实时事件专用的号段（服务端那份从 step-0 开始）
            if (id.indexOf('step-1000000') === 0 && window.__liveSeen.indexOf(id) < 0) {
              window.__liveSeen.push(id);
              const t = el.querySelector('[data-process-block-title]');
              window.__liveTitles.push(t ? t.textContent.trim() : '');
            }
          });
        };
        window.__liveObserver = new MutationObserver(scan);
        window.__liveObserver.observe(document.body, { childList: true, subtree: true });
        scan();
        return true;
      })()`,
      returnByValue: true,
    });

    /* 真点那个按钮：它没有 data-* 把手，按文字找、按坐标点 */
    const genBox = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const b = [...document.querySelectorAll('button')].find((el) => /开始生成|重新生成/.test(el.textContent));
        if (!b) return JSON.stringify({ missing: true });
        const r = b.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          label: b.textContent.trim(),
        });
      })()`,
      returnByValue: true,
    });
    const genAt = JSON.parse(genBox.result!.value!) as {
      missing?: true;
      x: number;
      y: number;
      label: string;
    };
    if (genAt.missing) {
      info("页面上找不到“开始生成 / 重新生成”按钮 —— 下面这一组会红");
    } else {
      info(
        `点了“${genAt.label}”（页面坐标 ${genAt.x}, ${genAt.y}）—— 走的是幂等回放分支，不会调模型`,
      );
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: genAt.x,
        y: genAt.y,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: genAt.x,
        y: genAt.y,
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(4000);

    const liveProbeRaw = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        window.__liveObserver && window.__liveObserver.disconnect();
        const first = document.querySelector('[data-process-block]');
        return JSON.stringify({
          seen: window.__liveSeen,
          titles: window.__liveTitles,
          maxBlocks: window.__liveMax,
          firstNodePreserved:
            !!window.__liveFirstNode && window.__liveFirstNode === first && first.isConnected,
        });
      })()`,
      returnByValue: true,
    });
    const liveProbe = JSON.parse(liveProbeRaw.result!.value!) as {
      seen: string[];
      titles: string[];
      maxBlocks: number;
      firstNodePreserved: boolean;
    };
    const liveAfter = await readSteps();
    info(
      `流里出现过 ${liveProbe.seen.length} 个实时块（${liveProbe.seen.join(",") || "无"}）· ` +
        `那一刻块数最多到 ${liveProbe.maxBlocks}（点之前是 ${liveBefore.blockIds.length}）· ` +
        `流结束后 ${liveAfter.blockIds.length} 块：${liveAfter.blockIds.join(",")}`,
    );

    check(
      !genAt.missing && liveProbe.seen.length > 0,
      `点下去之后块**实时**长出来了（DOM 里出现过 ${liveProbe.seen.length} 个实时块：${liveProbe.seen.join(",")}）`,
      "整条流跑完了，DOM 里却从没出现过实时块（step-1000000 号段）—— " +
        "SSE 可能还连着，但块列表没有跟着流走（实时行为被弄坏了）",
    );
    check(
      liveProbe.titles.some((t) => t.includes("已有成品，直接回放")),
      `而且实时块的内容来自真实事件：“${liveProbe.titles[0] ?? ""}”`,
      `实时块的标题不是流里那条 phase：${JSON.stringify(liveProbe.titles)}`,
    );
    check(
      liveProbe.maxBlocks === liveBefore.blockIds.length + 1,
      `实时块是**追加**上去的（最多时 ${liveProbe.maxBlocks} 块 = 点之前 ${liveBefore.blockIds.length} + 1），旧块那一刻还在`,
      `实时期间块数最多到 ${liveProbe.maxBlocks}，期望 ${liveBefore.blockIds.length + 1} —— ` +
        `块可能被整列换掉了（那就不是"追加在下面"）`,
    );
    check(
      liveProbe.firstNodePreserved,
      "实时那一段过去之后，原来那个块还是**同一个 DOM 节点**（实时追加没有重建整列）",
      "实时流一来，原来的块就被销毁重建了 —— 那“旧的留在上方”在真实运行里不成立",
    );
    check(
      liveAfter.blockIds.join(",") === liveBefore.blockIds.join(",") &&
        liveAfter.blockIds.every((id) => !(id ?? "").startsWith("step-1000000")),
      "流结束、服务端数据刷新回来之后，实时块退场、落库块接手（同一批事件不会显示两遍）",
      `落定之后是 ${liveAfter.blockIds.join(",")}（期望 ${liveBefore.blockIds.join(",")}，且不含实时号段）`,
    );

    await fsArtifactStore.removeByRun(liveRun);
    cleanupVerifyRun(liveRun);
    info("夹具已清理");

    // 面板默认停在最后一个有内容的块：跑完的运行最后一块是收尾 done，没有任何输出。
    // 这样仍然诚实，靠三条断言盯着：显示真实内容、标明第 N / 共 M 步且 N < M、
    // 不是最后一块时明说“后面还有 N 步没有输出”，反例里那句话不许出现。
    heading("第二十二步之六 · 面板默认停在最后一个有内容的块（并明说它不是最后一步）");

    /** 读过程流、面板当前块与“不是最后一步”那句小字 */
    const READ_TAIL_PICK = `(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const text = (el) => (el ? el.textContent.trim() : '');
      const blocks = q('[data-process-block]');
      const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
      const body = document.querySelector('[data-step-body]');
      const note = document.querySelector('[data-step-not-last]');
      return JSON.stringify({
        blockIds: blocks.map((b) => b.getAttribute('data-process-block')),
        blockTitles: blocks.map((b) => text(b.querySelector('[data-process-block-title]'))),
        // 最后一块是不是"只有阶段事件、什么都没输出"
        lastBlockEmpty: !!(last && last.querySelector('[data-process-block-empty]')),
        // 过程流里标的"当前块"（它和右侧面板必须指同一块）
        currentIds: q('[data-process-block-current]').map((b) =>
          b.getAttribute('data-process-block'),
        ),
        panelTitle: text(document.querySelector('[data-step-title]')),
        position: text(document.querySelector('[data-step-position]')),
        bodyText: body ? body.textContent : null,
        textShown: !!document.querySelector('[data-step-text]'),
        notLastPresent: !!note,
        notLastText: text(note),
        notLastCount: note ? note.getAttribute('data-step-not-last-count') : null,
      });
    })()`;

    interface TailPickSnap {
      blockIds: (string | null)[];
      blockTitles: string[];
      lastBlockEmpty: boolean;
      currentIds: (string | null)[];
      panelTitle: string;
      position: string;
      bodyText: string | null;
      textShown: boolean;
      notLastPresent: boolean;
      notLastText: string;
      notLastCount: string | null;
    }

    const readTailPick = async (): Promise<TailPickSnap> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_TAIL_PICK,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as TailPickSnap;
    };

    // 抠不出“第 N 步 / 共 M 步”就返回 null：这里不造默认值，否则读数坏了也会绿。
    const parsePosition = (s: string): { n: number; m: number } | null => {
      const hit = /^第 (\d+) 步 \/ 共 (\d+) 步$/.exec(s.trim());
      return hit ? { n: Number(hit[1]), m: Number(hit[2]) } : null;
    };

    // 22.6.1 最后一块是空的（收尾 done），面板停在前一个有内容的那一步
    const pickRun = seedStepRun(username, "pick", "done", [
      ["phase", stepPhase("generating", "正在生成")],
      ["reasoning", stepReasoning(PICK_THINKING)],
      ["text", stepText(PICK_BODY)],
      ["phase", stepPhase("done", DONE_LABEL)],
    ]);
    info(
      `造了一条运行 ${pickRun.slice(0, 8)}：有内容的那一步之后，` +
        `再来一条没有任何输出的 phase:"done"（“${DONE_LABEL}”）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${pickRun}` });
    await sleep(4200);

    /* 这次读数在任何交互之前：验的是打开面板第一眼看到什么 */
    const picked = await readTailPick();
    const pickedPos = parsePosition(picked.position);
    info(
      `过程流 ${picked.blockIds.length} 块：${picked.blockTitles.join(" · ")} · ` +
        `最后一块没有输出=${picked.lastBlockEmpty} · 当前块标记=${JSON.stringify(picked.currentIds)}`,
    );
    info(
      `面板（还没点过任何东西）：标题“${picked.panelTitle}”· ${picked.position} · ` +
        `"不是最后一步"的提示=${picked.notLastPresent}` +
        `${picked.notLastPresent ? `“${picked.notLastText}”` : ""}`,
    );

    check(
      picked.blockIds.length === 2 &&
        picked.lastBlockEmpty &&
        picked.blockTitles[1] === DONE_LABEL,
      `夹具确实是"最后一块没有输出"：第 2 块“${picked.blockTitles[1]}”只有阶段事件、没有内容`,
      `夹具形状不对：${picked.blockIds.length} 块 ${JSON.stringify(picked.blockTitles)}，` +
        `最后一块没有输出=${picked.lastBlockEmpty} —— 期望 2 块且最后一块是空的“${DONE_LABEL}”`,
    );
    // 面板要停在有内容的那一步，第一屏读到的是那一段真实 reasoning。
    check(
      picked.panelTitle === "正在生成" &&
        (picked.bodyText ?? "").includes(PICK_THINKING) &&
        !(picked.bodyText ?? "").includes("没有返回"),
      `面板打开时停在有内容的那一步“${picked.panelTitle}”：` +
        `第一屏就是那一步真实的思考（不是"这一步没有返回思考内容"）`,
      `面板停错地方了：标题“${picked.panelTitle}”，正文读到的是` +
        `“${(picked.bodyText ?? "").trim().slice(0, 50)}”`,
    );
    /* 标题写明这是哪一步，而且 N < M */
    check(
      pickedPos !== null && pickedPos.m === 2 && pickedPos.n < pickedPos.m,
      `标题里写明这是哪一步，而且确实是"不是最后一步"：“${picked.position}”（N < M）`,
      `位置读数不对：“${picked.position}”—— 期望“第 N 步 / 共 M 步”且 N < M（M=2）`,
    );
    /* “不是最后一步”这件事要明说 */
    check(
      picked.notLastPresent &&
        picked.notLastCount === "1" &&
        picked.notLastText.includes("后面还有 1 步没有输出"),
      `面板明说它不是最后一步：“${picked.notLastText}”（[data-step-not-last]）`,
      `没有明说"后面还有 N 步没有输出"：present=${picked.notLastPresent} ` +
        `count=${picked.notLastCount} 文字“${picked.notLastText}”`,
    );
    // 面板和过程流要指同一块，各指一处就是“标着的和右边读的不是同一步”。
    check(
      picked.currentIds.length === 1 && picked.currentIds[0] === picked.blockIds[0],
      `过程流标的当前块也是那一块（${picked.currentIds.join(",")}）—— 和右侧面板指同一块，不是最后一块`,
      `当前块标记不对：${JSON.stringify(picked.currentIds)}，有内容的是 ${picked.blockIds[0]}、` +
        `最后一块是 ${picked.blockIds[picked.blockIds.length - 1]}`,
    );

    /* 切到“结果”：那一步的正文也必须是真实的、看得到的 */
    const pickResultHit = await clickTab("result");
    const pickResult = await readTailPick();
    check(
      pickResultHit.ok &&
        pickResult.textShown &&
        (pickResult.bodyText ?? "").includes(PICK_BODY) &&
        !(pickResult.bodyText ?? "").includes("没有返回"),
      `切到“结果”看得到那一步真正的正文（“${PICK_BODY}”）—— 来自事件流，不是拼出来的`,
      `“结果”页签里没有那段正文：命中=${pickResultHit.ok} ` +
        `读到“${(pickResult.bodyText ?? "").slice(0, 60)}”`,
    );

    // 22.6.2 反例：最后一块自己有内容时，那句提示不许出现
    // 反例：把 data-step-not-last 写成恒挂的话上面几条照样绿，所以换一条
    // 最后一块自己有内容的运行，面板该停在最后一步且一个提示都没有。
    const lastContentRun = seedStepRun(username, "last-content", "running", [
      ["phase", stepPhase("spec", "正在把你的需求整理成规格")],
      ["reasoning", stepReasoning("先把这句话读成需求")],
      ["phase", stepPhase("generating", "正在生成")],
      ["text", stepText(LAST_STEP_BODY)],
    ]);
    info(`造了一条反例运行 ${lastContentRun.slice(0, 8)}（最后一块自己有正文）`);

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${lastContentRun}` });
    await sleep(4200);

    const lastContent = await readTailPick();
    const lastPos = parsePosition(lastContent.position);
    info(
      `反例：${lastContent.blockIds.length} 块 ${lastContent.blockTitles.join(" · ")} · ` +
        `最后一块没有输出=${lastContent.lastBlockEmpty} · 面板“${lastContent.panelTitle}”· ` +
        `${lastContent.position} · 提示=${lastContent.notLastPresent}`,
    );

    check(
      lastContent.blockIds.length === 2 &&
        !lastContent.lastBlockEmpty &&
        lastPos !== null &&
        lastPos.n === 2 &&
        lastPos.m === 2,
      `反例夹具成立：最后一块自己有内容（没有输出=${lastContent.lastBlockEmpty}），` +
        `面板就停在最后一步“${lastContent.position}”`,
      `反例夹具形状不对：${lastContent.blockIds.length} 块、最后一块没有输出=` +
        `${lastContent.lastBlockEmpty}、位置“${lastContent.position}”`,
    );
    check(
      !lastContent.notLastPresent && lastContent.notLastText === "",
      `反例：最后一块自己有内容时，[data-step-not-last] **不出现** —— 那句话不是恒真的`,
      `最后一块自己有内容，面板却还写着“${lastContent.notLastText}”—— ` +
        `那句提示成了恒真的装饰，防不住"以为它就是最后一步"`,
    );

    const lastResultHit = await clickTab("result");
    const lastResult = await readTailPick();
    check(
      lastResultHit.ok &&
        lastResult.panelTitle === "正在生成" &&
        (lastResult.bodyText ?? "").includes(LAST_STEP_BODY),
      `反例：面板停在最后一步“${lastResult.panelTitle}”，显示的正是它自己的正文`,
      `反例里显示的不是最后一步的内容：“${lastResult.panelTitle}”/` +
        `“${(lastResult.bodyText ?? "").slice(0, 60)}”`,
    );

    cleanupVerifyRun(pickRun);
    cleanupVerifyRun(lastContentRun);
    info("夹具已清理");

    // 第二道工序接上后，清单里 arch 那道下面该逐个列出模块，而不是“待规划”。
    // 坏法都不报错：不再投影 arch 事件、id 规则漂了、状态口径漂了。
    // 另跑一条没有 arch 事件的运行做对照，否则“占位行规则被删掉”也会让它绿。
    heading("第二十三步 · 架构定型：清单里 arch 那道自己长出模块子树");

    // 夹具自身要先成立：三条检查全过，否则下面的“状态是 done”验的是另一档。
    check(
      ARCH_CHECK.total === 3 && ARCH_CHECK.passed === 3,
      `夹具自身成立：三条本地检查 ${ARCH_CHECK.passed}/${ARCH_CHECK.total} 通过（由真的 inspectArch 现算）`,
      `夹具不成立：三条检查只有 ${ARCH_CHECK.passed}/${ARCH_CHECK.total} 通过 —— 下面的断言会验到另一档状态`,
    );

    const archRun = seedArchRun(username);
    info(
      `造了一条运行 ${archRun.slice(0, 8)}（stage=arch、status=done，带 ` +
        `${ARCH_MODULES.length} 个模块：${ARCH_MODULES.map((m) => m.id).join(" ")}）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${archRun}` });
    await sleep(4200);

    /** 只读 arch 那一组：它的二级行、每行的 id / 状态 / 标题 / 色点，以及它自己的状态 */
    const READ_ARCH_SUB = `(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const group = document.querySelector('[data-outline-group="arch"]');
      const kids = group
        ? [...group.querySelectorAll('[data-outline-row][data-outline-level="2"]')]
        : [];
      const countEl = group ? group.querySelector('[data-outline-count]') : null;
      const summary = group ? group.querySelector('summary') : null;
      const level1 = q('[data-outline-row][data-outline-level="1"]').find(
        (el) => el.getAttribute('data-outline-focus') === 'arch',
      );
      return JSON.stringify({
        exists: !!group,
        open: group ? group.open === true : false,
        summaryText: summary ? summary.textContent.trim() : '',
        countText: countEl ? countEl.textContent.trim() : null,
        level1Status: level1 ? level1.getAttribute('data-outline-status') : null,
        kids: kids.map((el) => {
          const dot = el.querySelector('[data-outline-dot]');
          return {
            focus: el.getAttribute('data-outline-focus'),
            status: el.getAttribute('data-outline-status'),
            placeholder: el.hasAttribute('data-outline-placeholder'),
            text: el.textContent.trim(),
            dot: dot ? getComputedStyle(dot).backgroundColor : null,
          };
        }),
      });
    })()`;

    interface ArchSubSnap {
      exists: boolean;
      open: boolean;
      summaryText: string;
      countText: string | null;
      level1Status: string | null;
      kids: {
        focus: string | null;
        status: string | null;
        placeholder: boolean;
        text: string;
        dot: string | null;
      }[];
    }

    const readArchSub = async (): Promise<ArchSubSnap> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_ARCH_SUB,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as ArchSubSnap;
    };

    const archSub = await readArchSub();
    info(
      `“架构定型”那一组：存在=${archSub.exists} · 组内二级行 ${archSub.kids.length} 个 · ` +
        `占位 ${archSub.kids.filter((k) => k.placeholder).length} 个 · 计数“${archSub.countText}”`,
    );
    info(
      `组里的行：` +
        archSub.kids
          .map(
            (k) => `${k.focus}[${k.status}]${k.text}${k.placeholder ? "(占位)" : ""}`,
          )
          .join(" · "),
    );

    /* 1. arch 那道下面每个模块一行 */
    check(
      archSub.exists && archSub.kids.length === ARCH_MODULES.length,
      `“架构定型”下面有 ${ARCH_MODULES.length} 个二级行（每个模块一行）`,
      `“架构定型”下面只有 ${archSub.kids.length} 个二级行，期望 ${ARCH_MODULES.length}` +
        `（那一组存在=${archSub.exists}）—— 架构事件没有投影成任务点？`,
    );
    /* 2. 没有待规划占位行 */
    check(
      archSub.kids.length > 0 && archSub.kids.every((k) => !k.placeholder),
      "这几行里一个“待规划”占位行都没有 —— 那道工序这次真的跑过",
      `还有 ${archSub.kids.filter((k) => k.placeholder).length} 行占位：` +
        archSub.kids
          .filter((k) => k.placeholder)
          .map((k) => k.text)
          .join("、"),
    );
    /* 3. 行 id 形如 arch:* */
    check(
      archSub.kids.map((k) => k.focus).join(",") ===
        ARCH_MODULES.map((m) => `arch:${m.id}`).join(","),
      `行 id 形如 arch:*，且顺序就是模块顺序（${archSub.kids.map((k) => k.focus).join(" ")}）`,
      `行 id 不对：读到的 ${JSON.stringify(archSub.kids.map((k) => k.focus))}，` +
        `期望 ${JSON.stringify(ARCH_MODULES.map((m) => `arch:${m.id}`))}`,
    );
    /* 4. 每行的标题就是模块名（人可读的那一列） */
    check(
      archSub.kids.map((k) => k.text).join(",") ===
        ARCH_MODULES.map((m) => m.name).join(","),
      `每行的标题就是模块名（${archSub.kids.map((k) => k.text).join("、")}）`,
      `标题不对：${JSON.stringify(archSub.kids.map((k) => k.text))}`,
    );
    /* 5. 三条检查全过 → done（蓝），绝不是 running */
    check(
      archSub.kids.every((k) => k.status === "done") &&
        archSub.kids.every((k) => k.dot === "rgb(96, 165, 250)"),
      "三条检查全过，所以每个模块行都是 done（蓝色 96 165 250）—— 模块没有被说成“正在跑”",
      `状态不对：${JSON.stringify(archSub.kids.map((k) => `${k.status}/${k.dot}`))}` +
        ` —— 期望全是 done 且色点为 rgb(96, 165, 250)`,
    );
    /* 6. 收起之后还看得见计数，它得等于模块数 */
    check(
      archSub.countText === String(ARCH_MODULES.length),
      `summary 上的计数是 ${archSub.countText}（收起时也看得出这一组下面有几个点）`,
      `计数是“${archSub.countText}”，期望 ${ARCH_MODULES.length}`,
    );
    // 7. 那一级行自己也是 done：长出子树没把工序自己的状态带偏。
    check(
      archSub.level1Status === "done",
      "“架构定型”那一级行自己是 done（这条运行跑完了，而它确实留下了产物）",
      `一级行状态是 ${archSub.level1Status}，期望 done`,
    );

    // 对照：没有 arch 事件的运行，那一道仍是“待规划”
    const noArchRun = seedRunningRun(username);
    info(
      `对照：造了一条只有 phase:spec 的运行 ${noArchRun.slice(0, 8)}（没有任何 arch 事件）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${noArchRun}` });
    await sleep(4200);

    const noArchSub = await readArchSub();
    info(
      `对照组“架构定型”那一组：二级行 ${noArchSub.kids.length} 个 · ` +
        `占位 ${noArchSub.kids.filter((k) => k.placeholder).length} 个 · ` +
        `文字 ${JSON.stringify(noArchSub.kids.map((k) => k.text))}`,
    );

    check(
      noArchSub.kids.length === 1 && noArchSub.kids[0].placeholder,
      "对照：没有 arch 事件时，那一道下面是一行“待规划”占位行（子树不是白给的）",
      `对照组的二级行是 ${JSON.stringify(noArchSub.kids.map((k) => ({ text: k.text, placeholder: k.placeholder })))}` +
        ` —— 期望恰好 1 行占位`,
    );
    check(
      noArchSub.kids.every((k) => !(k.focus ?? "").startsWith("arch:")),
      "对照：一个 arch:* 的点都没有 —— 没有事件就是没有，不是“有计划但没跑”",
      `对照组里出现了模块行：${JSON.stringify(noArchSub.kids.map((k) => k.focus))}`,
    );

    cleanupVerifyRun(archRun);
    cleanupVerifyRun(noArchRun);
    info("夹具已清理");

    ok(
      "架构定型（第二道工序）接上之后：清单里“架构定型”那道**自己长出**模块子树 ——" +
        `这种运行里 ${ARCH_MODULES.length} 个模块各一行、id 形如 arch:*、` +
        "三条本地检查全过所以是 done（不是 running）；" +
        "而没有 arch 事件的运行那一道仍是“待规划”占位行（对照组验过，不是恒真的）—— 全部通过",
    );

    // 第三道工序接上后，清单里 ui 那道下面该逐个列出页面，而不是“待规划”。
    // 与上一步同形：结构、id、状态三件一起钉，另跑一条没有 ui 事件的做对照。
    heading("第二十四步 · 界面设计：清单里 ui 那道自己长出页面子树");

    // 夹具自身要先成立：三条检查全过，否则下面的“状态是 done”验的是另一档。
    check(
      UI_CHECK.total === 3 && UI_CHECK.passed === 3,
      `夹具自身成立：三条本地检查 ${UI_CHECK.passed}/${UI_CHECK.total} 通过（由真的 inspectUi 现算）`,
      `夹具不成立：三条检查只有 ${UI_CHECK.passed}/${UI_CHECK.total} 通过 —— 下面的断言会验到另一档状态`,
    );

    const uiRun = seedUiRun(username);
    info(
      `造了一条运行 ${uiRun.slice(0, 8)}（stage=ui、status=done，带 ` +
        `${UI_PAGES.length} 个页面：${UI_PAGES.map((p) => p.id).join(" ")}）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${uiRun}` });
    await sleep(4200);

    /** 只读某一组工序（ui / arch）的二级行、每行的 id / 状态 / 标题 / 色点，以及它自己的状态 */
    const readGroupSub = async (stageId: string): Promise<ArchSubSnap> => {
      const expr = `(() => {
        const q = (s) => [...document.querySelectorAll(s)];
        const group = document.querySelector('[data-outline-group="${stageId}"]');
        const kids = group
          ? [...group.querySelectorAll('[data-outline-row][data-outline-level="2"]')]
          : [];
        const countEl = group ? group.querySelector('[data-outline-count]') : null;
        const summary = group ? group.querySelector('summary') : null;
        const level1 = q('[data-outline-row][data-outline-level="1"]').find(
          (el) => el.getAttribute('data-outline-focus') === '${stageId}',
        );
        return JSON.stringify({
          exists: !!group,
          open: group ? group.open === true : false,
          summaryText: summary ? summary.textContent.trim() : '',
          countText: countEl ? countEl.textContent.trim() : null,
          level1Status: level1 ? level1.getAttribute('data-outline-status') : null,
          kids: kids.map((el) => {
            const dot = el.querySelector('[data-outline-dot]');
            return {
              focus: el.getAttribute('data-outline-focus'),
              status: el.getAttribute('data-outline-status'),
              placeholder: el.hasAttribute('data-outline-placeholder'),
              text: el.textContent.trim(),
              dot: dot ? getComputedStyle(dot).backgroundColor : null,
            };
          }),
        });
      })()`;

      const r = await cdp.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as ArchSubSnap;
    };

    const uiSub = await readGroupSub("ui");
    info(
      `“界面设计”那一组：存在=${uiSub.exists} · 组内二级行 ${uiSub.kids.length} 个 · ` +
        `占位 ${uiSub.kids.filter((k) => k.placeholder).length} 个 · 计数“${uiSub.countText}”`,
    );
    info(
      `组里的行：` +
        uiSub.kids
          .map(
            (k) => `${k.focus}[${k.status}]${k.text}${k.placeholder ? "(占位)" : ""}`,
          )
          .join(" · "),
    );

    /* 1. ui 那道下面每个页面一行 */
    check(
      uiSub.exists && uiSub.kids.length === UI_PAGES.length,
      `“界面设计”下面有 ${UI_PAGES.length} 个二级行（每个页面一行）`,
      `“界面设计”下面只有 ${uiSub.kids.length} 个二级行，期望 ${UI_PAGES.length}` +
        `（那一组存在=${uiSub.exists}）—— ui 事件没有投影成任务点？`,
    );
    /* 2. 没有待规划占位行 */
    check(
      uiSub.kids.length > 0 && uiSub.kids.every((k) => !k.placeholder),
      "这几行里一个“待规划”占位行都没有 —— 那道工序这次真的跑过",
      `还有 ${uiSub.kids.filter((k) => k.placeholder).length} 行占位：` +
        uiSub.kids
          .filter((k) => k.placeholder)
          .map((k) => k.text)
          .join("、"),
    );
    /* 3. 行 id 形如 ui:* */
    check(
      uiSub.kids.map((k) => k.focus).join(",") ===
        UI_PAGES.map((p) => `ui:${p.id}`).join(","),
      `行 id 形如 ui:*，且顺序就是页面顺序（${uiSub.kids.map((k) => k.focus).join(" ")}）`,
      `行 id 不对：读到的 ${JSON.stringify(uiSub.kids.map((k) => k.focus))}，` +
        `期望 ${JSON.stringify(UI_PAGES.map((p) => `ui:${p.id}`))}`,
    );
    /* 4. 每行的标题就是页面名（人可读的那一列） */
    check(
      uiSub.kids.map((k) => k.text).join(",") === UI_PAGES.map((p) => p.name).join(","),
      `每行的标题就是页面名（${uiSub.kids.map((k) => k.text).join("、")}）`,
      `标题不对：${JSON.stringify(uiSub.kids.map((k) => k.text))}`,
    );
    /* 5. 三条检查全过 → done（蓝），绝不是 running */
    check(
      uiSub.kids.every((k) => k.status === "done") &&
        uiSub.kids.every((k) => k.dot === "rgb(96, 165, 250)"),
      "三条检查全过，所以每个页面行都是 done（蓝色 96 165 250）—— 页面没有被说成“正在跑”",
      `状态不对：${JSON.stringify(uiSub.kids.map((k) => `${k.status}/${k.dot}`))}` +
        ` —— 期望全是 done 且色点为 rgb(96, 165, 250)`,
    );
    /* 6. 收起之后还看得见计数，它得等于页面数 */
    check(
      uiSub.countText === String(UI_PAGES.length),
      `summary 上的计数是 ${uiSub.countText}（收起时也看得出这一组下面有几个点）`,
      `计数是“${uiSub.countText}”，期望 ${UI_PAGES.length}`,
    );
    // 7. 那一级行自己也是 done：长出子树没把工序自己的状态带偏。
    check(
      uiSub.level1Status === "done",
      "“界面设计”那一级行自己是 done（这条运行跑完了，而它确实留下了产物）",
      `一级行状态是 ${uiSub.level1Status}，期望 done`,
    );
    // 8. 两棵子树同时在：重读 arch 那一组，只加不减。
    const archStillThere = await readGroupSub("arch");
    check(
      archStillThere.kids.length === ARCH_MODULES.length &&
        archStillThere.kids.every((k) => !k.placeholder),
      `同一页上“架构定型”那道仍是 ${ARCH_MODULES.length} 个模块行 —— 新子树没有挤掉老子树`,
      `“架构定型”那组现在是 ${archStillThere.kids.length} 行（期望 ${ARCH_MODULES.length}）`,
    );

    // 对照：没有 ui 事件的运行，那一道仍是“待规划”
    const noUiRun = seedRunningRun(username);
    info(
      `对照：造了一条只有 phase:spec 的运行 ${noUiRun.slice(0, 8)}（没有任何 ui 事件）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${noUiRun}` });
    await sleep(4200);

    const noUiSub = await readGroupSub("ui");
    info(
      `对照组“界面设计”那一组：二级行 ${noUiSub.kids.length} 个 · ` +
        `占位 ${noUiSub.kids.filter((k) => k.placeholder).length} 个 · ` +
        `文字 ${JSON.stringify(noUiSub.kids.map((k) => k.text))}`,
    );

    check(
      noUiSub.kids.length === 1 && noUiSub.kids[0].placeholder,
      "对照：没有 ui 事件时，那一道下面是一行“待规划”占位行（子树不是白给的）",
      `对照组的二级行是 ${JSON.stringify(noUiSub.kids.map((k) => ({ text: k.text, placeholder: k.placeholder })))}` +
        ` —— 期望恰好 1 行占位`,
    );
    check(
      noUiSub.kids.every((k) => !(k.focus ?? "").startsWith("ui:")),
      "对照：一个 ui:* 的点都没有 —— 没有事件就是没有，不是“有计划但没跑”",
      `对照组里出现了页面行：${JSON.stringify(noUiSub.kids.map((k) => k.focus))}`,
    );

    cleanupVerifyRun(uiRun);
    cleanupVerifyRun(noUiRun);
    info("夹具已清理");

    ok(
      "界面设计（第三道工序）接上之后：清单里“界面设计”那道**自己长出**页面子树 ——" +
        `这种运行里 ${UI_PAGES.length} 个页面各一行、id 形如 ui:*、` +
        "三条本地检查全过所以是 done（不是 running）、同一页上第二道的模块子树照旧在；" +
        "而没有 ui 事件的运行那一道仍是“待规划”占位行（对照组验过，不是恒真的）—— 全部通过",
    );

    // 第四道工序接上后，清单里 build 那道下面该逐个列出模块构建结果，含失败的。
    // 前两次长出来的是“将来要做的活”，这次是“刚做过的活”，所以有 failed 这一档。
    // 只列成功的两个就是粉饰部分失败，所以夹具固定三个、其中一个红。
    heading("第二十五步 · 并行构建：清单里 build 那道自己长出模块构建子树");

    // 夹具自身要先成立：两个成功一个失败，否则下面的“恰好有一个红”验不到。
    check(
      MODULES_BATCH.modules.length === 2 && MODULES_BATCH.failed.length === 1,
      "夹具自身成立：三个模块里两个成功、一个失败（不是全绿的假夹具）",
      `夹具不成立：成功 ${MODULES_BATCH.modules.length} 个、失败 ${MODULES_BATCH.failed.length} 个`,
    );

    const modulesRun = seedModulesRun(username);
    info(
      `造了一条运行 ${modulesRun.slice(0, 8)}（stage=build、status=done，` +
        `带 ${ARCH_MODULES.length} 个模块的构建结果：` +
        `${MODULES_BATCH.modules.map((m) => m.moduleId).join(" ")} 成功、` +
        `${MODULES_BATCH.failed.map((f) => f.moduleId).join(" ")} 失败）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${modulesRun}` });
    await sleep(4200);

    const buildSub = await readGroupSub("build");
    info(
      `“并行构建”那一组：存在=${buildSub.exists} · 组内二级行 ${buildSub.kids.length} 个 · ` +
        `占位 ${buildSub.kids.filter((k) => k.placeholder).length} 个 · 计数“${buildSub.countText}”`,
    );
    info(
      `组里的行：` +
        buildSub.kids
          .map(
            (k) => `${k.focus}[${k.status}]${k.text}${k.placeholder ? "(占位)" : ""}`,
          )
          .join(" · "),
    );

    /* 1. build 那道下面每个模块一行，含失败的那个 */
    check(
      buildSub.exists && buildSub.kids.length === ARCH_MODULES.length,
      `“并行构建”下面有 ${ARCH_MODULES.length} 个二级行（每个模块一行，含失败的那个）`,
      `“并行构建”下面只有 ${buildSub.kids.length} 个二级行，期望 ${ARCH_MODULES.length}` +
        `（那一组存在=${buildSub.exists}）—— modules 事件没有投影成任务点？`,
    );
    /* 2. 没有待规划占位行 */
    check(
      buildSub.kids.length > 0 && buildSub.kids.every((k) => !k.placeholder),
      "这几行里一个“待规划”占位行都没有 —— 那道工序这次真的跑过",
      `还有 ${buildSub.kids.filter((k) => k.placeholder).length} 行占位：` +
        buildSub.kids
          .filter((k) => k.placeholder)
          .map((k) => k.text)
          .join("、"),
    );
    /* 3. 行 id 形如 build:*，顺序就是架构里的模块顺序 */
    check(
      buildSub.kids.map((k) => k.focus).join(",") ===
        ARCH_MODULES.map((m) => `build:${m.id}`).join(","),
      `行 id 形如 build:*，且顺序就是架构里的模块顺序（${buildSub.kids.map((k) => k.focus).join(" ")}）`,
      `行 id 不对：读到的 ${JSON.stringify(buildSub.kids.map((k) => k.focus))}，` +
        `期望 ${JSON.stringify(ARCH_MODULES.map((m) => `build:${m.id}`))}`,
    );
    /* 4. 每行的标题就是模块名（人可读的那一列，从 arch 查） */
    check(
      buildSub.kids.map((k) => k.text).join(",") ===
        ARCH_MODULES.map((m) => m.name).join(","),
      `每行的标题就是模块名（${buildSub.kids.map((k) => k.text).join("、")}）`,
      `标题不对：${JSON.stringify(buildSub.kids.map((k) => k.text))}`,
    );
    /* 5. 成功的 done（蓝），失败的是 failed（红），一个 running 都没有 */
    const expectedStatus = ARCH_MODULES.map((m) =>
      MODULES_BATCH.failed.some((f) => f.moduleId === m.id) ? "failed" : "done",
    );
    check(
      buildSub.kids.map((k) => k.status).join(",") === expectedStatus.join(","),
      `状态按各自的成败走（${buildSub.kids.map((k) => `${k.focus}=${k.status}`).join("、")}）` +
        "—— 部分失败如实呈现，没有被抹平成全绿",
      `状态不对：读到的 ${JSON.stringify(buildSub.kids.map((k) => k.status))}，` +
        `期望 ${JSON.stringify(expectedStatus)}`,
    );
    check(
      buildSub.kids.every(
        (k) => k.dot === (k.status === "failed" ? FAILED_DOT : DONE_DOT),
      ) && buildSub.kids.some((k) => k.status === "failed"),
      `色点真的按状态走：失败那个是红（${FAILED_DOT}）、成功那些是蓝（${DONE_DOT}）`,
      `色点不对：${JSON.stringify(buildSub.kids.map((k) => `${k.status}/${k.dot}`))}` +
        ` —— 期望失败的红、成功的蓝，且至少有一个失败的`,
    );
    check(
      buildSub.kids.every((k) => k.status !== "running"),
      "一个 running 都没有 —— 构建已经结束了，这里没有任何东西还在跑",
      `出现了 running：${JSON.stringify(buildSub.kids.map((k) => k.status))}`,
    );
    /* 6. 收起之后还看得见计数，它得等于模块数 */
    check(
      buildSub.countText === String(ARCH_MODULES.length),
      `summary 上的计数是 ${buildSub.countText}（收起时也看得出这一组下面有几个点）`,
      `计数是“${buildSub.countText}”，期望 ${ARCH_MODULES.length}`,
    );
    // 7. 那一级行自己也是 done：长出子树没把工序自己的状态带偏。
    check(
      buildSub.level1Status === "done",
      "“并行构建”那一级行自己是 done（这条运行跑完了，而它确实留下了产物）",
      `一级行状态是 ${buildSub.level1Status}，期望 done`,
    );

    // 对照：没有 modules 事件的运行，那一道仍是“待规划”
    const noModulesRun = seedRunningRun(username);
    info(
      `对照：造了一条只有 phase:spec 的运行 ${noModulesRun.slice(0, 8)}（没有任何 modules 事件）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${noModulesRun}` });
    await sleep(4200);

    const noModulesSub = await readGroupSub("build");
    info(
      `对照组“并行构建”那一组：二级行 ${noModulesSub.kids.length} 个 · ` +
        `占位 ${noModulesSub.kids.filter((k) => k.placeholder).length} 个 · ` +
        `文字 ${JSON.stringify(noModulesSub.kids.map((k) => k.text))}`,
    );

    check(
      noModulesSub.kids.length === 1 && noModulesSub.kids[0].placeholder,
      "对照：没有 modules 事件时，那一道下面是一行“待规划”占位行（子树不是白给的）",
      `对照组的二级行是 ${JSON.stringify(noModulesSub.kids.map((k) => ({ text: k.text, placeholder: k.placeholder })))}` +
        ` —— 期望恰好 1 行占位`,
    );
    check(
      noModulesSub.kids.every((k) => !(k.focus ?? "").startsWith("build:")) &&
        noModulesSub.level1Status === "pending",
      "对照：一个 build:* 的点都没有，而且那一道自己是 pending —— " +
        "没有事件就是没有，不是“有计划但没跑”",
      `对照组里出现了模块行或状态不对：` +
        `${JSON.stringify(noModulesSub.kids.map((k) => k.focus))} / level1=${noModulesSub.level1Status}`,
    );

    cleanupVerifyRun(modulesRun);
    cleanupVerifyRun(noModulesRun);
    info("夹具已清理");

    ok(
      "并行构建（第四道工序）接上之后：清单里“并行构建”那道**自己长出**模块构建子树 ——" +
        `这种运行里 ${ARCH_MODULES.length} 个模块各一行、id 形如 build:*、顺序与架构一致、` +
        "成功的 done（蓝）而**失败的是 failed（红）**（部分失败如实呈现，没有被抹平）；" +
        "而没有 modules 事件的运行那一道仍是“待规划”占位行（对照组验过，不是恒真的）—— 全部通过",
    );

    // “集成装配”是 planned（没有沙箱，三条验收标准无法检查），占位行要说清卡在哪：
    // data-outline-blocked-by 与 title 带原因，行尾一个 CSS 生成的 ⓘ。
    // 对照读一条已接入工序的占位行：它必须没有这个属性，否则标注就是恒挂的。
    heading("第二十六步 · 待规划行说清卡在哪（集成装配：需要沙箱）");

    const blockedRun = seedRunningRun(username);
    info(
      `造了一条运行 ${blockedRun.slice(0, 8)}（只有一条 phase:spec，六道工序下面都是占位行）`,
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${blockedRun}` });
    await sleep(4200);

    /** 读某一组的占位行：文字、blockedBy、title、行尾标记 */
    const READ_BLOCKED = `(() => {
      const rowOf = (stageId) => {
        const group = document.querySelector('[data-outline-group="' + stageId + '"]');
        if (!group) return null;
        const el = group.querySelector('[data-outline-row][data-outline-placeholder]');
        if (!el) return null;
        const mark = el.querySelector('[data-outline-blocked-mark]');
        return {
          stageId,
          text: el.textContent.trim(),
          hasAttr: el.hasAttribute('data-outline-blocked-by'),
          blockedBy: el.getAttribute('data-outline-blocked-by'),
          title: el.getAttribute('title'),
          markAfter: mark ? getComputedStyle(mark, '::after').content : null,
        };
      };
      return JSON.stringify({
        assemble: rowOf('assemble'),
        arch: rowOf('arch'),
        placeholders: document.querySelectorAll('[data-outline-placeholder]').length,
      });
    })()`;

    interface BlockedSnap {
      stageId: string;
      text: string;
      hasAttr: boolean;
      blockedBy: string | null;
      title: string | null;
      markAfter: string | null;
    }

    const blockedRaw = await cdp.send("Runtime.evaluate", {
      expression: READ_BLOCKED,
      returnByValue: true,
    });
    const blocked = JSON.parse(blockedRaw.result!.value!) as {
      assemble: BlockedSnap | null;
      arch: BlockedSnap | null;
      placeholders: number;
    };

    info(
      `占位行 ${blocked.placeholders} 行 · “集成装配”那行：` +
        `属性=${blocked.assemble?.hasAttr} 文字“${blocked.assemble?.text}”· ` +
        `行尾标记 ::after=${JSON.stringify(blocked.assemble?.markAfter)}`,
    );
    info(`那行的 title：“${blocked.assemble?.title}”`);
    info(
      `对照“架构定型”那行（已接入、这次没有 arch 事件）：` +
        `属性=${blocked.arch?.hasAttr} 文字“${blocked.arch?.text}”`,
    );

    /* 1. 前提：这一组确实是占位行 */
    check(
      blocked.placeholders === 6 && blocked.assemble !== null && blocked.arch !== null,
      "夹具成立：六道工序下面各有一行占位行（含“集成装配”与对照用的“架构定型”）",
      `夹具形状不对：占位行 ${blocked.placeholders} 行，assemble=${blocked.assemble !== null}、` +
        `arch=${blocked.arch !== null} —— 期望 6 行且两组都在`,
    );
    /* 2. “集成装配”那行带着原因，值里有“沙箱” */
    check(
      blocked.assemble?.hasAttr === true &&
        (blocked.assemble?.blockedBy ?? "").includes("沙箱"),
      `“集成装配”的占位行带 data-outline-blocked-by，值里说到了“沙箱”`,
      `那行没有带出原因：hasAttr=${blocked.assemble?.hasAttr}、` +
        `值=“${blocked.assemble?.blockedBy ?? "(空)"}”`,
    );
    /* 3. hover 的 title 里也有那句话 */
    check(
      (blocked.assemble?.title ?? "").includes("沙箱"),
      `它的 title 里也有这句话 —— 鼠标停一下就能看到卡在哪`,
      `title 里没有原因：“${blocked.assemble?.title ?? "(空)"}”`,
    );
    /* 4. 行尾的 ⓘ 渲染出来了，文字仍是“待规划” */
    check(
      (blocked.assemble?.markAfter ?? "").includes("ⓘ") &&
        blocked.assemble?.text === "待规划",
      `行尾的 ⓘ 真的渲染出来了（::after=${JSON.stringify(blocked.assemble?.markAfter)}），` +
        `而文字仍然是“${blocked.assemble?.text}”—— 那三个字一个字都没改`,
      `标记没渲染或文字被改了：::after=${JSON.stringify(blocked.assemble?.markAfter)}、` +
        `文字“${blocked.assemble?.text}”`,
    );
    /* 5. 对照：已接入的工序没有这个属性 */
    check(
      blocked.arch?.hasAttr === false &&
        blocked.arch?.blockedBy === null &&
        blocked.arch?.text === "待规划",
      "对照：已接入的“架构定型”（这次没有 arch 事件）那行**没有**这个属性 —— " +
        "“卡住了”和“还没轮到”没有被说成同一件事",
      `对照组也带上了属性：hasAttr=${blocked.arch?.hasAttr}、` +
        `值=“${blocked.arch?.blockedBy ?? "(空)"}”—— 那说明标注不是跟着卡点走的`,
    );

    cleanupVerifyRun(blockedRun);
    info("夹具已清理");

    ok(
      "待规划行说清卡在哪：“集成装配”（planned）的占位行带 data-outline-blocked-by 与 title、" +
        "值里说到“沙箱”、行尾渲染出 ⓘ 而文字仍是“待规划”；" +
        "而已接入的“架构定型”占位行没有这个属性（对照组验过，不是恒真的）—— 全部通过",
    );

    // 第二十七步验的是搬回来之后东西还在不在：清单每一行、画布每个节点、产物、事件。
    // 走页面内的 fetch：会话是 httpOnly Cookie，脚本这边拿不到值，303 也是浏览器真跟的。
    // 还要看原运行还在、产物没被覆盖：照原 id 写回去也能让“新页面一致”通过。
    heading("第二十七步 · 导出成一个文件、再导入回来（清单 / 画布 / 产物 / 事件一致）");

    const portable = await seedPortableRun(username);
    info(
      `造了一条有内容的运行 ${portable.slice(0, 8)}：` +
        "spec / arch / ui / modules / check 事件各就位 + 两份产物 + 一笔成本流水",
    );

    await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${portable}` });
    await sleep(4200);

    interface PortableSnap {
      rows: { text: string; status: string | null; placeholder: boolean }[];
      stages: number;
      children: number;
      roots: number;
    }

    // 清单取每一行的文字而不是行数：某一行写成“待规划”正是要抓的坏。
    // 画布取三层节点数，少一层都说明投影没走通。
    const READ_PORTABLE = `(() => {
      const rows = [...document.querySelectorAll('[data-outline-row]')].map((el) => ({
        text: el.textContent.trim(),
        status: el.getAttribute('data-outline-status'),
        placeholder: el.hasAttribute('data-outline-placeholder'),
      }));
      return JSON.stringify({
        rows,
        stages: document.querySelectorAll('[data-pipeline-stage]').length,
        children: document.querySelectorAll('[data-canvas-child]').length,
        roots: document.querySelectorAll('[data-pipeline-root]').length,
      });
    })()`;

    const readPortable = async (): Promise<PortableSnap> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: READ_PORTABLE,
        returnByValue: true,
      });
      return JSON.parse(r.result!.value!) as PortableSnap;
    };

    /** 页面里跑一段异步 IIFE 并把它的返回值取回来 */
    const inPage = async (expression: string): Promise<string> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return r.result!.value!;
    };

    const before = await readPortable();
    info(
      `导入前：清单 ${before.rows.length} 行 · ` +
        `画布 根 ${before.roots} + 工序 ${before.stages} + 执行点 ${before.children}`,
    );

    /* 1. 前提：这条运行有内容，不是一条空运行 */
    check(
      before.rows.length >= 6 &&
        before.roots === 1 &&
        before.stages === 6 &&
        before.children > 0,
      `前提成立：导入前这条运行是有内容的（清单 ${before.rows.length} 行、根 ${before.roots}、` +
        `工序 ${before.stages}、执行点 ${before.children}）—— 空运行比不出东西来`,
      `夹具形状不对，这一步会变成空转：清单 ${before.rows.length} 行、根 ${before.roots}、` +
        `工序 ${before.stages}、执行点 ${before.children}`,
    );

    /* 2. 走完整条路：导出 → 变成文件 → 导入 → 跟随 303 */
    const transferRaw = await inPage(`(async () => {
      const exp = await fetch('/api/runs/${portable}/export');
      const body = await exp.text();

      const fd = new FormData();
      fd.append('file', new File([body], 'portable.nexus.json', { type: 'application/json' }));
      const res = await fetch('/api/runs/import', { method: 'POST', body: fd, redirect: 'follow' });
      const landed = await res.text();

      return JSON.stringify({
        exportStatus: exp.status,
        contentType: exp.headers.get('content-type'),
        disposition: exp.headers.get('content-disposition'),
        body,
        importRedirected: res.redirected,
        finalUrl: res.url,
        landedLooksLikeCanvas: landed.includes('data-canvas-stage'),
      });
    })()`);

    const transfer = JSON.parse(transferRaw) as {
      exportStatus: number;
      contentType: string | null;
      disposition: string | null;
      body: string;
      importRedirected: boolean;
      finalUrl: string;
      landedLooksLikeCanvas: boolean;
    };

    /* 3. 导出是一份能存下来的文件，不是一段裸 JSON */
    check(
      transfer.exportStatus === 200 &&
        (transfer.contentType ?? "").includes("application/json") &&
        (transfer.disposition ?? "").includes("attachment") &&
        (transfer.disposition ?? "").includes("filename*=UTF-8''"),
      `导出返回 200，是 application/json 的**附件下载**（带中文名的 filename*）：` +
        `${transfer.disposition}`,
      `导出响应不对：status=${transfer.exportStatus}、type=${transfer.contentType}、` +
        `disposition=${transfer.disposition}`,
    );

    /* 4. 文件本身过形状校验 */
    interface ExportBundle {
      format?: unknown;
      version?: unknown;
      run?: { id?: unknown; prompt?: unknown };
      events?: unknown[];
      artifacts?: unknown[];
      skipped?: unknown[];
    }
    let bundle: ExportBundle | null = null;
    try {
      bundle = JSON.parse(transfer.body) as ExportBundle;
    } catch {
      bundle = null;
    }

    check(
      bundle !== null &&
        bundle.format === "nexus-run" &&
        bundle.version === 1 &&
        Array.isArray(bundle.events) &&
        (bundle.events?.length ?? 0) > 0,
      `导出文件形状对：format=${bundle?.format}、version=${bundle?.version}、` +
        `events ${bundle?.events?.length} 条`,
      `导出文件形状不对：${transfer.body.slice(0, 220)}`,
    );

    /* 5. 用户那句话原样保留在文件里 */
    check(
      bundle?.run?.prompt === PORTABLE_PROMPT,
      `run.prompt 原样在文件里：“${bundle?.run?.prompt}”`,
      `run.prompt 被改写了：文件里是“${bundle?.run?.prompt}”，期望“${PORTABLE_PROMPT}”`,
    );

    /* 6. 两份产物都在文件里，一份没被跳过 */
    check(
      bundle?.artifacts?.length === 2 && bundle?.skipped?.length === 0,
      `两份产物都装进了文件（artifacts ${bundle?.artifacts?.length} 份），skipped 为空 —— 没有悄悄丢东西`,
      `产物没带全：artifacts ${bundle?.artifacts?.length} 份、skipped ${bundle?.skipped?.length} 条 —— ` +
        `这一步的产物对照会因此失真`,
    );

    /* 7. 导入之后 303 落在画布上，而且是一条新运行 */
    const newRunId = /[?&]run=([^&]+)/.exec(transfer.finalUrl)?.[1] ?? "";
    check(
      transfer.importRedirected === true &&
        newRunId !== "" &&
        transfer.finalUrl.includes("/canvas?run=") &&
        transfer.landedLooksLikeCanvas,
      `导入后浏览器真的跟了一次重定向，落在画布上（新运行 ${newRunId.slice(0, 8)}）`,
      `导入没有按预期重定向到画布：redirected=${transfer.importRedirected}、` +
        `finalUrl=${transfer.finalUrl}、落到画布=${transfer.landedLooksLikeCanvas}`,
    );

    /* 8. 新运行与原运行是两条记录：导入是留一份，不是搬过来 */
    const isNewRun = newRunId !== "" && newRunId !== portable;
    check(
      isNewRun,
      `新运行（${newRunId.slice(0, 8)}）与原运行（${portable.slice(0, 8)}）是两条记录 —— ` +
        "导入没有覆盖原来那一条",
      newRunId === ""
        ? "没能从重定向地址里解析出新运行 id，下面的对照不可信"
        : `新运行 id 和原运行相同（${newRunId}）—— 那是覆盖，不是导入`,
    );

    /* 9. 打开新运行，逐项对照清单与画布 */
    if (isNewRun) {
      await cdp.send("Page.navigate", { url: `${BASE}/canvas?run=${newRunId}` });
      await sleep(4200);
    }
    const after = isNewRun
      ? await readPortable()
      : { rows: [], stages: -1, children: -1, roots: -1 };

    info(
      `导入后：清单 ${after.rows.length} 行 · ` +
        `画布 根 ${after.roots} + 工序 ${after.stages} + 执行点 ${after.children}`,
    );

    // 先算出从第几行开始不一样，失败信息才能说出具体哪一行。
    const firstDiff = before.rows.findIndex(
      (r, i) => JSON.stringify(r) !== JSON.stringify(after.rows[i]),
    );

    check(
      isNewRun &&
        after.roots === before.roots &&
        after.stages === before.stages &&
        after.children === before.children &&
        JSON.stringify(after.rows) === JSON.stringify(before.rows),
      `导入回来的运行与导出前**逐项一致**：清单 ${after.rows.length} 行（每行文字与状态都比过）、` +
        `画布 根 ${after.roots} + 工序 ${after.stages} + 执行点 ${after.children}`,
      `导入前后对不上：清单 ${before.rows.length} → ${after.rows.length} 行、` +
        `根 ${before.roots} → ${after.roots}、工序 ${before.stages} → ${after.stages}、` +
        `执行点 ${before.children} → ${after.children}；` +
        (firstDiff >= 0
          ? `清单第 ${firstDiff + 1} 行：${JSON.stringify(before.rows[firstDiff])} → ` +
            `${JSON.stringify(after.rows[firstDiff])}`
          : "清单行内容一致（差在行数或画布节点上）"),
    );

    /* 10. 原运行还在，事件一条不少 */
    const origEventsRaw = await inPage(`(async () => {
      const r = await fetch('/api/runs/${portable}/events');
      const j = await r.json();
      return JSON.stringify({ status: r.status, count: j.count });
    })()`);
    const origEvents = JSON.parse(origEventsRaw) as { status: number; count: number };

    check(
      origEvents.status === 200 && origEvents.count === bundle?.events?.length,
      `原运行还在，事件一条不少（${origEvents.count} 条）—— 导入没有动它`,
      `原运行被动了：HTTP ${origEvents.status}、事件 ${origEvents.count} 条，` +
        `而导出时是 ${bundle?.events?.length} 条`,
    );

    /* 11. 导出那条运行的产物没被覆盖 */
    const origArtifactRaw = await inPage(`(async () => {
      const r = await fetch('/api/runs/${portable}/artifact');
      const t = await r.text();
      return JSON.stringify({ status: r.status, body: t });
    })()`);
    const origArtifact = JSON.parse(origArtifactRaw) as {
      status: number;
      body: string;
    };

    check(
      origArtifact.status === 200 && origArtifact.body === PORTABLE_HTML,
      "导出那条运行的产物一个字没变 —— 导入写的是新运行自己的目录",
      `原运行的产物被改了：HTTP ${origArtifact.status}、` +
        `内容${origArtifact.body === PORTABLE_HTML ? "一致" : "不一致（很可能被导入的产物覆盖了）"}`,
    );

    /* 12. 新运行也有自己的产物，内容与原来相同 */
    const newArtifactRaw = isNewRun
      ? await inPage(`(async () => {
          const r = await fetch('/api/runs/${newRunId}/artifact');
          const t = await r.text();
          return JSON.stringify({ status: r.status, body: t });
        })()`)
      : JSON.stringify({ status: 0, body: "" });
    const newArtifact = JSON.parse(newArtifactRaw) as { status: number; body: string };

    check(
      isNewRun && newArtifact.status === 200 && newArtifact.body === PORTABLE_HTML,
      "新运行自己的产物也读得到，而且内容与原来逐字相同 —— 产物真的搬过来了",
      `新运行的产物不对：HTTP ${newArtifact.status}、` +
        `内容${newArtifact.body === PORTABLE_HTML ? "一致" : "与原来不同或为空"}`,
    );

    /* 清理：原运行与导入的运行都删掉 */
    if (isNewRun) await cleanupPortableRun(newRunId);
    await cleanupPortableRun(portable);
    info("两条夹具（原运行 + 导入进来的那条）都已清理");

    ok(
      "导出 / 导入单文件：导出是带中文名的附件下载、文件形状与 prompt 原样、" +
        "两份产物一份没跳；导入后 303 落到**新**运行的画布上，" +
        "清单每行文字与状态、画布根 / 工序 / 执行点三层节点数与导出前逐项一致；" +
        "原运行仍在、事件一条不少、产物一个字没被覆盖 —— 全部通过",
    );

    cdp.close();
    ok("画布交互、详情、面板、顶栏一致性、缩放让位、退役页面、子树与双击聚焦全部通过");
    ok(
      "窄屏降级（<1280）：两侧收起为 0 宽、覆盖层 272/352 可开可关、画布全宽且滚轮仍能缩放 —— 全部通过",
    );
    ok(
      "一级 Agent 根节点：三层树 1 根 + 6 工序 + 7 执行点、根在工序上方且有连线、" +
        "状态与颜色随真实投影变化（done/running 两种运行验过）—— 全部通过",
    );
    ok(
      "右侧面板接真实事件：思考 / 结果两个页签切的是两种不同的事件、默认停在思考、" +
        "没有思考就明说“没有返回思考内容”且不拿正文冒充、花费与 token 原样来自 usage 事件 —— 全部通过",
    );
    ok(
      "生成过程按步骤分块：块数 = 真实 phase 数、块间有分隔线、追加新步骤时旧的块" +
        "**仍是同一个 DOM 节点**（不销毁）、新块长在最下面 —— 全部通过",
    );
    ok(
      "实时流没被弄坏：点一次“开始生成”（幂等回放分支，不花钱），块真的在流里**追加**长出来、" +
        "旧块仍是同一个 DOM 节点、流结束后实时块退场由落库块接手 —— 全部通过",
    );
    ok(
      '面板默认停在最后一个**有内容**的块（收尾的 phase:"done" 没有输出，不再挡住第一屏）：' +
        "第一屏就是那一步真实的思考与正文、标题写明第 N 步 / 共 M 步且 N < M、" +
        "不是最后一步时明说“后面还有 N 步没有输出”——" +
        "而最后一块自己有内容时那句提示**不出现**（反例验过，不是恒真的）—— 全部通过",
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
  // 把异常也计入失败数，finish 才会以退出码 1 结束；直接 return 的话退出码是 0。
  check(
    false,
    "端到端脚本没有异常退出",
    err instanceof Error ? err.message : String(err),
  );
  finish(Date.now());
});
