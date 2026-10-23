import { tintVarAt } from "@/core/domain/appearance";
import { actorBadge } from "@/core/blueprint/loop";
import { linkBetween, type OrgNode, type OrgTree } from "@/core/blueprint/org";
import {
  DEFAULT_ORG_GEOMETRY,
  layoutOrg,
  orgEdgePath,
  type OrgGeometry,
  type PlacedOrgNode,
} from "@/core/blueprint/org-layout";

/**
 * 组织结构图
 * ============================================================
 * 参考图（第一张「公司运转图」）的形状：人 → 总管 → 若干领域 → 各自的资产。
 *
 * ── 和闭环图的根本差别 ──
 *   闭环图是**固定九宫格**：七步、位置固定、一屏看全。
 *   组织结构图是**列数不定**的：几个领域、每个领域下挂几个资产，
 *   都由生成决定。所以这里的位置全是算出来的（见 org-layout.ts）。
 *
 * ── 连线画成"一束"，不是"一把扇" ──
 *   总管居中、领域散开，画直线的话是六条斜线。
 *   参考图上是从总管脚下竖直下来、走同一条水平走廊、再竖直进去 ——
 *   所有线共享那段走廊，看起来是一束。这是"层级"的视觉表达：
 *   它们都从同一个地方发出来。
 *
 * ── 每对节点之间是两条线，不是一条 ──
 *   往下一份活（派活）、往上一份进展（日报）。
 *   参考图用颜色区分方向：蓝往下、橙往上。
 *   这不是装饰 —— 它表达的是**这条关系是双向的**，
 *   而不是"上级命令下级"的单向管道。
 */

export interface OrgMapProps {
  tree: OrgTree;
  geometry?: OrgGeometry;
  /** 高亮的节点 id。其余变暗 */
  activeId?: string | null;
  className?: string;
}

export function OrgMap({
  tree,
  geometry = DEFAULT_ORG_GEOMETRY,
  activeId = null,
  className = "",
}: OrgMapProps) {
  const g = geometry;
  const layout = layoutOrg(tree, g);
  const dimOthers = activeId !== null;

  /**
   * 连谁到谁。
   *
   * 只连"总管/根 → 横排那一层"。资产之间的连线不画 ——
   * 参考图上资产是**贴在领域卡下面**的，靠位置表达从属，
   * 不靠线。每个资产都画一条线的话，那一块会密成一片。
   */
  const edges = buildEdges(layout.nodes);

  return (
    <div
      data-org-map
      className={`relative ${className}`}
      style={{ width: layout.width, height: layout.height }}
    >
      {/* ---------- 连线 ---------- */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0"
        width={layout.width}
        height={layout.height}
      >
        {edges.map((e) => {
          const path = orgEdgePath(e.from, e.to, g);
          const touchesActive =
            !dimOthers || e.from.node.id === activeId || e.to.node.id === activeId;

          return (
            <path
              key={`${e.from.node.id}->${e.to.node.id}`}
              d={path}
              fill="none"
              stroke="var(--color-border-soft)"
              strokeWidth={1}
              strokeLinejoin="round"
              opacity={touchesActive ? 1 : 0.18}
            />
          );
        })}
      </svg>

      {/* ---------- 节点 ---------- */}
      {layout.nodes.map((p) => {
        const active = activeId === p.node.id;
        return (
          <div
            key={p.node.id}
            data-org-node={p.node.id}
            className="absolute overflow-hidden"
            style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
          >
            <OrgNodeCard placed={p} active={active} dimmed={dimOthers && !active} />
          </div>
        );
      })}

      {/* ---------- 图例 ---------- */}
      <Legend tree={tree} edges={edges} geometry={g} />
    </div>
  );
}

/* ============================================================
   连谁到谁
   ============================================================ */

function buildEdges(nodes: PlacedOrgNode[]) {
  const roots = nodes.filter((n) => n.kind === "root" || n.kind === "hub");
  const agents = nodes.filter((n) => n.kind === "agent");
  const out: Array<{ from: PlacedOrgNode; to: PlacedOrgNode }> = [];

  for (const agent of agents) {
    // 优先连总管；没有总管就连根
    const from = roots.find((r) => r.kind === "hub") ?? roots[0];
    if (from) out.push({ from, to: agent });
  }
  return out;
}

/* ============================================================
   节点卡
   ============================================================ */

function OrgNodeCard({
  placed,
  active,
  dimmed,
}: {
  placed: PlacedOrgNode;
  active: boolean;
  dimmed: boolean;
}) {
  const { node, kind, col } = placed;
  // 按列分配配色：同一列的卡同色，一眼能看出"这几张是一伙的"
  const tint = tintVarAt(Math.max(col, 0));

  const style = {
    borderColor: active ? `rgb(${tint} / 0.7)` : `rgb(${tint} / 0.3)`,
    backgroundColor: kind === "asset" ? "var(--color-surface-2)" : "var(--color-surface)",
    opacity: dimmed ? 0.3 : 1,
  };

  /* ---------- 根：人 ---------- */
  if (kind === "root") {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 rounded-xl border px-3 transition-opacity duration-200"
        style={style}
      >
        <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-orange-500/90 text-[10px] text-orange-950">
          ◇
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] leading-tight font-medium text-slate-100">
            {node.role}
          </span>
          {node.actions.length > 0 && (
            <span className="block truncate text-[10px] text-slate-500">
              {node.actions.join(" · ")}
            </span>
          )}
        </span>
      </div>
    );
  }

  /* ---------- 资产：最下面那一层的小卡 ---------- */
  if (kind === "asset") {
    return (
      <div
        className="flex h-full flex-col justify-center gap-0.5 rounded-lg border px-2.5 transition-opacity duration-200"
        style={style}
      >
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 flex-none rounded-full"
            style={{ backgroundColor: `rgb(${tint} / 0.9)` }}
          />
          <span className="min-w-0 truncate text-[11.5px] text-slate-300">{node.role}</span>
        </span>
        {/* 资产**必须**有看什么数 —— 这条由校验保证，这里只管画 */}
        <span className="truncate pl-3 text-[10px] text-slate-600">
          {node.watches.map((w) => w.label).join(" · ")}
        </span>
      </div>
    );
  }

  /* ---------- 总管和领域：正式的角色卡 ---------- */
  return (
    <div
      className="h-full rounded-xl border px-3 py-2 transition-opacity duration-200"
      style={style}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-2 w-2 flex-none rounded-full"
          style={{ backgroundColor: `rgb(${tint})` }}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] leading-tight font-medium text-slate-100">
          {node.role}
        </span>
        <span className="flex-none">
          <ActorChip node={node} />
        </span>
      </div>

      {node.actions.length > 0 && (
        <div className="mt-1.5 truncate text-[11px] text-slate-400">
          {node.actions.join(" · ")}
        </div>
      )}

      {node.watches.length > 0 && (
        <div className="mt-1 truncate text-[10px] text-slate-600">
          {node.watches.map((w) => w.label).join(" · ")}
        </div>
      )}

      {node.note && (
        <div className="mt-1 truncate text-[10px] text-slate-600">{node.note}</div>
      )}
    </div>
  );
}

/** 小一号的权限标记。用核心层那条规则算文案，这里只换样式 */
function ActorChip({ node }: { node: OrgNode }) {
  const label = actorBadge({ actor: node.actor, mode: undefined });
  const style: Record<string, string> = {
    程序自动: "text-slate-600",
    "AI · 干活": "text-amber-300",
    人: "text-orange-300",
    "AI · 只读": "text-cyan-300/80",
  };
  return <span className={`text-[10px] ${style[label] ?? ""}`}>{label}</span>;
}

/* ============================================================
   图例
   ============================================================ */

/**
 * 右上角的图例。
 *
 * ── 那两个词从哪来 ──
 *   不是写死的，是从**声明过的边**里取的（linkBetween）。
 *   参考图上人和总管之间写的是「拍板 定方向 / 汇报」，
 *   总管和领域之间写的是「派活 / 日报」—— 同一棵树里不同层的
 *   边说的是不同的话。写死"派活/日报"的话，第一层就标错了。
 *
 * ⚠️ 这里**只写已经做出来的东西**。
 *    参考图的图例还有第三行「边框转圈＝正在干活」——
 *    那个状态要等接上真实生成过程才有意义（任务 1.7），
 *    现在写上去就是一句做不到的承诺。
 *    这条纪律和「未接入的工序不许标成已通过」是同一条。
 */
function Legend({
  tree,
  edges,
  geometry: g,
}: {
  tree: OrgTree;
  edges: Array<{ from: PlacedOrgNode; to: PlacedOrgNode }>;
  geometry: OrgGeometry;
}) {
  const first = edges[0];
  const link = first ? linkBetween(tree, first.from.node.id, first.to.node.id) : null;

  return (
    <div
      data-org-legend
      className="absolute flex flex-col gap-1 text-[10px] text-slate-500"
      style={{ right: 0, top: 0, maxWidth: g.nodeW * 1.6 }}
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="text-cyan-400">
          ↓
        </span>
        {`往下：${link?.down.label ?? "派活"}`}
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="text-orange-400">
          ↑
        </span>
        {`往上：${link?.up.label ?? "日报"}${link?.up.hint ? `（${link.up.hint}）` : ""}`}
      </span>
    </div>
  );
}