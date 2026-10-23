import { tintVarAt } from "@/core/domain/appearance";
import { HUB_ID, sortSteps, type Loop, type LoopStep } from "@/core/blueprint/loop";
import {
  DEFAULT_GEOMETRY,
  HUB_SLOT,
  cellOrigin,
  loopCanvasSize,
  loopSlot,
  routeEdge,
  type LoopGeometry,
} from "@/core/blueprint/loop-layout";
import { StepCard } from "./step-card";

/**
 * 闭环主图
 * ============================================================
 * 七步摆成一圈，中间是那个管流程的角色。
 * 版式和落位照参考图 —— 落位规则在 core/blueprint/loop-layout.ts，
 * 那里有 20 条单测钉着"01 在左下、04 在上中"这些事。
 *
 * ── 为什么用绝对定位而不是 CSS 网格 ──
 *   连线要画在卡片之间。用网格布局的话，线的端点得先量 DOM 才知道，
 *   而"量 DOM"意味着首帧会闪一下、窗口变化要重算、测试也测不了。
 *   几何是确定的（三列三行、格宽格高都是常数），
 *   那就直接用算出来的坐标 —— 线和卡片永远对得上。
 *   阶段 3 搬上画布时也是这套坐标，不用重写。
 *
 * ── 连线的一条规则：声明过的去向优先 ──
 *   参考图上 03 的去向不是 04，而是中间的 CEO（「建议先交 CEO」）；
 *   04 的输入也不是 03，而是 CEO 报上来的（「汇总报店主」）。
 *   所以不能简单地"把相邻两步连起来"——
 *   某一步如果声明了去向，就用声明的；没声明才连到下一步。
 */

export interface LoopMapProps {
  loop: Loop;
  geometry?: LoopGeometry;
  /** 高亮的步骤。其余变暗 */
  activeStepId?: string | null;
  className?: string;
}

interface Placed {
  step: LoopStep;
  tintIndex: number;
  col: number;
  row: number;
}

interface EdgeSpec {
  from: { col: number; row: number };
  to: { col: number; row: number };
  label?: string;
  /** 声明的转换（带标签）画亮一点，顺次连线画淡一点 */
  declared: boolean;
  /**
   * 是不是"回到起点"那条。
   *
   * 它的标签**不画** —— 下中那一格已经放了闭合说明的胶囊，
   * 而这条线的中点正好也在那里，两个东西会叠在一起。
   * 第一版就是这么叠的，截图上一眼看出来。
   */
  closure?: boolean;
  key: string;
}

export function LoopMap({
  loop,
  geometry = DEFAULT_GEOMETRY,
  activeStepId = null,
  className = "",
}: LoopMapProps) {
  const g = geometry;
  const size = loopCanvasSize(g);
  const steps = sortSteps(loop.steps);

  /* ---------- 落位 ---------- */
  const placed: Placed[] = steps.map((s, i) => {
    const slot = loopSlot(i);
    return { step: s, tintIndex: i, col: slot.col, row: slot.row };
  });

  const slotOf = (id: string): { col: number; row: number } | null => {
    if (id === HUB_ID) return HUB_SLOT;
    const hit = placed.find((p) => p.step.id === id);
    return hit ? { col: hit.col, row: hit.row } : null;
  };

  /* ---------- 连线 ---------- */
  const edges = buildEdges(loop, placed, slotOf);
  const planned = planEdges(edges, g);

  /* ---------- 变暗逻辑 ---------- */
  // 选中某一步时，只有它自己和直接与它相连的线保持正常
  const dimOthers = activeStepId !== null;

  return (
    <div
      data-loop-map
      className={`relative ${className}`}
      style={{ width: size.width, height: size.height }}
    >
      {/* ---------- 线 ---------- */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0"
        width={size.width}
        height={size.height}
      >
        {planned.map((p) => {
          const touchesActive =
            !dimOthers ||
            pointIsAt(p.edge.from, placed, activeStepId) ||
            pointIsAt(p.edge.to, placed, activeStepId);

          return (
            <path
              key={p.edge.key}
              d={p.routed.d}
              fill="none"
              stroke={
                p.edge.declared ? "rgb(var(--tint-2) / 0.55)" : "var(--color-border-soft)"
              }
              strokeWidth={p.edge.declared ? 1.5 : 1}
              strokeLinejoin="round"
              // 声明的转换是虚线 —— 参考图上那几条斜穿的都是虚线，
              // 和"顺次往下走"的实线区分开
              strokeDasharray={p.edge.declared ? "4 4" : undefined}
              opacity={touchesActive ? 1 : 0.22}
            />
          );
        })}
      </svg>

      {/* ---------- 线上的小标签 ---------- */}
      <EdgeLabels planned={planned} placed={placed} activeStepId={activeStepId} />

      {/* ---------- 步骤卡 ---------- */}
      {placed.map((p) => {
        const o = cellOrigin(p.col, p.row, g);
        const active = activeStepId === p.step.id;
        return (
          <div
            key={p.step.id}
            className="absolute overflow-hidden"
            style={{ left: o.x, top: o.y, width: g.cellW, height: g.cellH }}
          >
            <StepCard
              step={p.step}
              tintIndex={p.tintIndex}
              active={active}
              dimmed={dimOthers && !active}
              className="h-full"
            />
          </div>
        );
      })}

      {/* ---------- 中间那个管流程的 ---------- */}
      <div
        className="absolute overflow-hidden"
        style={{
          left: cellOrigin(HUB_SLOT.col, HUB_SLOT.row, g).x,
          top: cellOrigin(HUB_SLOT.col, HUB_SLOT.row, g).y,
          width: g.cellW,
          height: g.cellH,
        }}
      >
        <HubCard loop={loop} />
      </div>

      {/* ---------- 闭合说明，摆在下中那格（七步时它空着）---------- */}
      {loop.closure && (
        <div
          data-loop-closure
          className="absolute flex flex-col items-center justify-center gap-1 text-center"
          style={{
            left: cellOrigin(1, 2, g).x,
            top: cellOrigin(1, 2, g).y,
            width: g.cellW,
            height: g.cellH,
          }}
        >
          <span className="rounded-full border border-[var(--color-border-soft)] px-2.5 py-1 text-[10.5px] text-slate-500">
            {loop.closure.label}
          </span>
          {loop.closure.hint && (
            <span className="text-[10px] text-slate-600">{loop.closure.hint}</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   中心角色
   ============================================================ */

/**
 * 站在流程边上的那个角色。
 *
 * 它不属于 01–07 任何一步，但几乎每条线都从它出发或回到它。
 * 参考图上它列的是三件小事：汇总 / 派活 / 验收 ——
 * 都不是"产生东西"，而是**在步骤之间搬东西**。
 */
function HubCard({ loop }: { loop: Loop }) {
  const tint = tintVarAt(1);
  return (
    <div
      data-loop-hub
      className="h-full rounded-xl border p-3"
      style={{
        borderColor: `rgb(${tint} / 0.55)`,
        backgroundColor: "var(--color-surface-2)",
        // 中心那块是这张图唯一有外发光的东西 ——
        // 它得"浮"在其余卡片之上，因为它是那个把圈串起来的角色
        boxShadow: `0 0 26px -10px rgb(${tint} / 0.7)`,
      }}
    >
      <header className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex h-4 w-4 flex-none items-center justify-center rounded-full text-[9px] text-white"
          style={{ backgroundColor: `rgb(${tint})` }}
        >
          ◉
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[13px] leading-tight font-medium text-slate-100">
          {loop.hub.role}
        </h3>
        {loop.hub.note && (
          <span className="flex-none text-[10px] text-slate-500">{loop.hub.note}</span>
        )}
      </header>

      {loop.hub.duties.length > 0 && (
        <ul className="mt-2 space-y-1">
          {loop.hub.duties.map((d) => (
            <li key={d.label} className="flex gap-1.5 rounded-md px-1.5 py-1 text-[10.5px]">
              <span
                className="h-fit flex-none rounded px-1.5 py-0.5 text-[10px] leading-tight"
                style={{
                  backgroundColor: `rgb(${tint} / 0.16)`,
                  color: `rgb(${tint})`,
                }}
              >
                {d.label}
              </span>
              <span className="leading-relaxed text-slate-400">{d.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
   连线怎么连
   ============================================================ */

/**
 * 排出所有连线。规则见文件头：**声明过的去向优先**。
 *
 * 顺次连线只有在该步没有声明去向时才补上 ——
 * 否则 03 会既连 CEO 又连 04，图上多出一条穿过中心的线。
 */
function buildEdges(
  loop: Loop,
  placed: Placed[],
  slotOf: (id: string) => { col: number; row: number } | null,
): EdgeSpec[] {
  const out: EdgeSpec[] = [];
  const seen = new Set<string>();

  /*
    哪一条是"回到起点"。
    判据：从最后一步出发、并且回到第一步（或经中心中转回去）。
    这条的标签不画 —— 下中那格已经放了闭合说明的胶囊，
    而它的中点正好也在那里。
  */
  const ordered = placed.map((p) => p.step.id);
  const firstId = ordered[0];
  const lastId = ordered[ordered.length - 1];

  const push = (e: EdgeSpec) => {
    // 同一条线不画两遍（声明里可能和顺次连线重合）
    const key = `${e.from.col},${e.from.row}->${e.to.col},${e.to.row}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };

  // 一、声明的转换
  for (const t of loop.transitions) {
    const from = slotOf(t.from);
    const to = slotOf(t.to);
    if (!from || !to) continue;
    push({
      from,
      to,
      label: t.label,
      declared: true,
      closure: t.from === lastId && (t.to === firstId || t.to === HUB_ID),
      key: `${t.from}->${t.to}`,
    });
  }

  // 二、没声明去向的步骤，顺次连到下一步
  for (let i = 0; i < placed.length - 1; i++) {
    const cur = placed[i].step.id;
    const hasDeclaredExit = loop.transitions.some((t) => t.from === cur);
    if (hasDeclaredExit) continue;

    push({
      from: { col: placed[i].col, row: placed[i].row },
      to: { col: placed[i + 1].col, row: placed[i + 1].row },
      declared: false,
      key: `seq-${cur}`,
    });
  }

  return out;
}

/** 这条线是不是连着当前选中的那一步 */
function pointIsAt(
  p: { col: number; row: number },
  placed: Placed[],
  activeStepId: string | null,
): boolean {
  if (!activeStepId) return false;
  if (activeStepId === HUB_ID) return p.col === HUB_SLOT.col && p.row === HUB_SLOT.row;
  const hit = placed.find((x) => x.step.id === activeStepId);
  return !!hit && hit.col === p.col && hit.row === p.row;
}

/* ============================================================
   分车道
   ============================================================ */

/** 一条已经算好车道、可以直接画的线 */
interface PlannedEdge {
  edge: EdgeSpec;
  routed: ReturnType<typeof routeEdge>;
  /** 标签在线的垂直方向上还要再错开多少 */
  labelShift: number;
}

/**
 * 给所有线分车道，并算出标签要错开多少。
 *
 * ── 两个问题要一起解决 ──
 *
 * 一、**同一个缝里有多条线。**
 *    参考图上「派活」（hub→05）和「做完整交编排」（05→hub）
 *    是 hub↔05 的两个方向。不分子道的话两条线完全重合。
 *    真实道路也是这么解决的：对向车道分左右。
 *
 * 二、**两个标签会叠在一起。**
 *    光分车道不够 —— 缝只有 56 像素宽，而一个标签约 50 像素，
 *    两个并排放不下。
 *    参考图的做法是**沿线的方向错开**：
 *    那条竖线有一百多像素长，两个标签上下排完全放得下。
 *    第一版按 16 像素横向分车道，结果两个标签还是叠着 ——
 *    因为横向的空间本来就不够。
 */
function planEdges(edges: EdgeSpec[], g: LoopGeometry): PlannedEdge[] {
  const LANE_GAP = 16;
  const LABEL_GAP = 24;

  // 一、先按无车道算一遍，拿到每条线的落点
  const rough = edges.map((e) => ({ e, r: routeEdge(e.from, e.to, g) }));

  /*
    二、按"线在哪条道上"分组。
    竖直走的按 y 分（同一条竖线上），横着走的按 x 分。
    **忽略垂直方向上的坐标差** —— 差那十几个像素还是同一条道，
    这正是第一版分组太细、于是没能错开的原因。
  */
  const groups = new Map<string, number[]>();
  rough.forEach((it, i) => {
    const key = it.r.vertical
      ? `v${Math.round(it.r.label.y / 30)}`
      : `h${Math.round(it.r.label.x / 30)}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });

  // 三、组内编车道号 + 错位量
  const lane = new Array<number>(edges.length).fill(0);
  const shift = new Array<number>(edges.length).fill(0);

  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    idxs.forEach((edgeIdx, i) => {
      const centered = i - (idxs.length - 1) / 2;
      lane[edgeIdx] = centered * LANE_GAP;
      shift[edgeIdx] = centered * LABEL_GAP;
    });
  }

  return edges.map((e, i) => ({
    edge: e,
    routed: routeEdge(e.from, e.to, g, lane[i]),
    labelShift: shift[i],
  }));
}

/* ============================================================
   线上的小标签
   ============================================================ */

/**
 * 画在连线上的那行小字：「建议先交编排」「汇总报我」「派活」。
 *
 * 标签的位置**由走线器给**（routeEdge 的 label），不算两端点的中点。
 * 因为斜着连的时候走的是三段折线，两端点的中点会落在卡片上 ——
 * 第一版就是这么压到 02 卡片角上的，截图上一眼看出来。
 * 走线器知道线从哪儿绕，也就知道标签该挂在哪。
 *
 * ── 为什么还要"岔开"这一步 ──
 *   参考图上「同意」（04→CEO）和「汇总报店主」（CEO→04）
 *   是**同一条缝里的两个方向**，标签位置完全重合。
 *   不岔开的话两个标签摞在一起，谁也看不清。
 */
function EdgeLabels({
  planned,
  placed,
  activeStepId,
}: {
  planned: PlannedEdge[];
  placed: Placed[];
  activeStepId: string | null;
}) {
  const dimOthers = activeStepId !== null;

  return (
    <>
      {planned
        .filter((p) => p.edge.label && !p.edge.closure)
        .map((p) => {
          const touchesActive =
            !dimOthers ||
            pointIsAt(p.edge.from, placed, activeStepId) ||
            pointIsAt(p.edge.to, placed, activeStepId);

          return (
            <span
              key={`lbl-${p.edge.key}`}
              data-edge-label={p.edge.label}
              className="absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded border border-[var(--color-border-soft)] bg-[var(--color-canvas)] px-1.5 py-0.5 text-[10px] whitespace-nowrap text-slate-400 transition-opacity duration-200"
              style={{
                // 沿线的方向错开：竖线上下错，横线左右错。
                // 见 planEdges 里第二个问题的说明 ——
                // 横向的空间根本放不下两个标签，纵向才有。
                left: p.routed.label.x + (p.routed.vertical ? 0 : p.labelShift),
                top: p.routed.label.y + (p.routed.vertical ? p.labelShift : 0),
                opacity: touchesActive ? 1 : 0.25,
              }}
            >
              {p.edge.label}
            </span>
          );
        })}
    </>
  );
}
