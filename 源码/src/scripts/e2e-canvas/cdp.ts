/**
 * e2e-canvas 的浏览器通道：起 Edge、连 CDP、在页面里取值。
 */
/**
 * 画布端到端：用 CDP 真的滚轮、拖拽、点击，再读计算样式确认变了。
 * 平移缩放只体现在计算样式里，服务端 HTML 没有视口信息，所以必须驱动浏览器。
 * 运行：npm run e2e:canvas（需先启动 http://localhost:3000）
 */

export const BASE = process.env.NEXUS_BASE ?? "http://localhost:3000";
export const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
export const PORT = 9337;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 极简 CDP 客户端

export async function waitForTarget() {
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
      // 页面还没起来，下一轮再试
    }
    await sleep(250);
  }
  throw new Error("调试端口没有就绪");
}

export interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<{ result?: { value?: string } }>;
  close(): void;
}

export function connect(wsUrl: string): Promise<Cdp> {
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

// 读画布状态

export interface CanvasState {
  bgPos: string;
  bgSize: string;
  gridStep: number;
  panX: number;
  panY: number;
  originX: number;
  originY: number;
  zoomLabel: string;
  /** 画布尺寸不要假设等于窗口尺寸 */
  stageW: number;
  stageH: number;
}

export const READ = `(() => {
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

export async function read(cdp: Cdp): Promise<CanvasState> {
  const r = await cdp.send("Runtime.evaluate", { expression: READ, returnByValue: true });
  return JSON.parse(r.result!.value!) as CanvasState;
}

// 主流程

