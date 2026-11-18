import { computed, reactive, ref, watch } from "vue";
import { workbenchStore } from "./useWorkbenchStore";
import type { WorkbenchStage, WorkbenchTask } from "../types/workbench-engine";

export interface TreeCard {
  id: string;
  title: string;
  file: string;
  group?: string;
  note: string;
  state: string;
  progress: number;
}

interface TaskGroup {
  name: string;
  kids: TreeCard[];
}

interface LRRow {
  stage: WorkbenchStage;
  index: number;
  kids: TreeCard[];
  groups: TaskGroup[] | null;
  m: { n: number; h: number; gap: number; stackH: number; dense: boolean };
  rowH: number;
  bandH: number;
  center: number;
  y: number;
}

interface TDCol {
  stage: WorkbenchStage;
  index: number;
  kids: TreeCard[];
  hidden: number;
  kidsW: number;
  colW: number;
  sw: number;
  tw: number;
  x: number;
  center: number;
}

export interface TreeNode {
  kind: "root" | "stage" | "group" | "task" | "chip" | "other";
  x: number;
  y: number;
  w: number;
  h: number;
  compact?: boolean;
  dense?: boolean;
  stageIndex?: number;
  data?: WorkbenchStage | TreeCard;
  title?: string;
  note?: string;
}

/** 一条连线：id 用于增量动画，to 指向它在等哪个节点入场 */
export interface TreePath {
  id: string;
  to: string;
  d: string;
}

const ICONS: Record<string, string> = {
  "01": "M6 4h9l3 3v13H6z M9 11h6 M9 15h4",
  "02": "M4 5h16v5H4z M4 14h9v5H4z M17 14h3v5h-3z",
  "03": "M4 18V6l6 3 4-3 6 3v9 M4 18h16",
  "04": "M7 3h10v7H7z M3 14h8v7H3z M13 14h8v7h-8z",
  "05": "M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12 M15.5 15.5L20 20",
  "06": "M12 3l8 4.5v9L12 21l-8-4.5v-9z M9 12l2 2 4-4",
};

interface SavedTreeView {
  layout?: "lr" | "td";
  edges?: "curve" | "elbow";
  focus?: number | null;
  expanded?: number[];
}

function treeStorageKey() {
  const runId = new URLSearchParams(location.search).get("run") || "new";
  return "nexus-wb-tree:" + runId;
}

function readTreeView(): SavedTreeView | null {
  try {
    const raw = localStorage.getItem(treeStorageKey());
    if (!raw) return null;
    const data = JSON.parse(raw) as SavedTreeView;
    return {
      layout: data.layout === "td" ? "td" : "lr",
      edges: data.edges === "elbow" ? "elbow" : "curve",
      focus: typeof data.focus === "number" ? data.focus : null,
      expanded: Array.isArray(data.expanded)
        ? data.expanded.filter((value): value is number => typeof value === "number")
        : [],
    };
  } catch {
    return null;
  }
}

export function useWorkbenchTree() {
  const saved = readTreeView();
  const view = reactive({
    layout: saved?.layout || ("lr" as "lr" | "td"),
    edges: saved?.edges || ("curve" as "curve" | "elbow"),
    focus: saved?.focus ?? (null as number | null),
    expanded: saved?.expanded || ([] as number[]),
  });
  const width = ref(720);

  watch(
    view,
    () => {
      try {
        localStorage.setItem(treeStorageKey(), JSON.stringify(view));
      } catch {
        /* 隐私模式下仍保持当前页面状态 */
      }
    },
    { deep: true },
  );

  const stages = computed(() => workbenchStore.stages);
  const tasks = computed(() => workbenchStore.tasks);

  function childrenOf(index: number, limit = 10) {
    const stage = stages.value[index];
    if (!stage) return [];
    return tasks.value.filter((task) => task.stage === stage.id).slice(0, limit);
  }

  function taskCountOf(index: number) {
    const stage = stages.value[index];
    if (!stage) return 0;
    return tasks.value.filter((task) => task.stage === stage.id).length;
  }

  function cardOf(task: WorkbenchTask): TreeCard {
    const state =
      task.state === "done"
        ? "done"
        : task.state === "running"
          ? "live"
          : task.state === "failed"
            ? "fail"
            : "wait";
    return {
      id: task.id,
      title: task.title,
      file: task.file || task.note || "",
      group: task.group,
      note: task.note || "",
      state,
      progress: state === "done" ? 100 : state === "live" ? 45 : 0,
    };
  }

  function childMetrics(list: unknown[]) {
    const n = list.length;
    const dense = n > 6;
    const h = dense ? 40 : 52;
    const gap = dense ? 8 : 10;
    return { n, h, gap, stackH: n * h + Math.max(0, n - 1) * gap, dense };
  }

  const GROUP_NAMES: Record<string, string> = { db: "数据库", api: "接口", web: "前端" };
  const GROUP_HEAD_H = 26;
  const GROUP_CHILD_H = 44;
  const GROUP_CHILD_GAP = 6;
  const GROUP_GAP = 12;
  const GROUP_INSET = 18;

  /** 第三层：架构模块。文件任务按模块归组，形成「工序 → 模块 → 文件」的第 4 层。 */
  function groupsOf(kids: TreeCard[], stageId: string): TaskGroup[] | null {
    if (stageId !== "build" || kids.length < 2) return null;
    const map = new Map<string, TaskGroup>();
    for (const card of kids) {
      const prefix = card.file ? card.file.split("/")[0] : "";
      const key = card.group || prefix;
      if (!key) continue;
      const name = card.group || GROUP_NAMES[prefix] || prefix;
      const group = map.get(key);
      if (group) group.kids.push(card);
      else map.set(key, { name, kids: [card] });
    }
    const list = [...map.values()];
    return list.length ? list : null;
  }

  function groupedStackH(groups: TaskGroup[]) {
    return (
      groups.reduce(
        (sum, group) =>
          sum +
          GROUP_HEAD_H +
          GROUP_CHILD_GAP +
          group.kids.length * GROUP_CHILD_H +
          Math.max(0, group.kids.length - 1) * GROUP_CHILD_GAP,
        0,
      ) + groups.length * GROUP_GAP
    );
  }

  function roundedPath(points: Array<[number, number]>, radius = 10) {
    const pts = points.filter((point, index) => {
      if (index === 0) return true;
      const prev = points[index - 1];
      return Math.abs(point[0] - prev[0]) > 0.01 || Math.abs(point[1] - prev[1]) > 0.01;
    });
    if (pts.length < 2) return "";
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      const inLen = Math.hypot(x1 - x0, y1 - y0);
      const outLen = Math.hypot(x2 - x1, y2 - y1);
      const r = Math.min(radius, inLen / 2, outLen / 2);
      if (r < 0.6) {
        d += ` L ${x1} ${y1}`;
        continue;
      }
      const ux = (x1 - x0) / inLen;
      const uy = (y1 - y0) / inLen;
      const vx = (x2 - x1) / outLen;
      const vy = (y2 - y1) / outLen;
      d += ` L ${x1 - ux * r} ${y1 - uy * r}`;
      d += ` Q ${x1} ${y1} ${x1 + vx * r} ${y1 + vy * r}`;
    }
    const last = pts[pts.length - 1];
    d += ` L ${last[0]} ${last[1]}`;
    return d;
  }

  function curveH(x0: number, y0: number, x1: number, y1: number) {
    const dx = Math.max(56, Math.abs(x1 - x0) * 0.8);
    return `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x1 - dx} ${y1}, ${x1} ${y1}`;
  }

  function curveV(x0: number, y0: number, x1: number, y1: number) {
    const dy = Math.max(44, Math.abs(y1 - y0) * 0.55);
    return `M ${x0} ${y0} C ${x0} ${y0 + dy}, ${x1} ${y1 - dy}, ${x1} ${y1}`;
  }

  function layoutLR() {
    const nodes: TreeNode[] = [];
    const paths: TreePath[] = [];
    const curved = view.edges === "curve";
    const ROOT = { x: 20, y: 14, w: curved ? 168 : 200, h: 58 };
    const STAGE_X = curved ? 316 : 268;
    const STAGE_W = curved ? 180 : 200;
    const STAGE_H = 56;
    const GAP = 18;
    const TASK_X = STAGE_X + STAGE_W + (curved ? 54 : 44);
    const TASK_W = 150;
    const BUS_X = STAGE_X - 26;
    const TASK_BUS_X = STAGE_X + STAGE_W + 20;
    const list = view.focus === null ? stages.value : [stages.value[view.focus]];
    const rows = list.map((stage, i) => {
      const index = view.focus === null ? i : view.focus;
      const kids = childrenOf(index).map(cardOf);
      const groups = groupsOf(kids, stage.id);
      const m = groups
        ? { n: kids.length, h: GROUP_CHILD_H, gap: GROUP_CHILD_GAP, stackH: groupedStackH(groups), dense: true }
        : childMetrics(kids);
      return { stage, index, kids, groups, m, rowH: Math.max(STAGE_H + GAP, m.stackH + 32) };
    }) as LRRow[];
    let cursor = 30;
    rows.forEach((row) => {
      row.bandH = Math.max(STAGE_H, row.m.stackH);
      row.center = cursor + row.bandH / 2;
      row.y = row.center - STAGE_H / 2;
      cursor += row.bandH + GAP;
    });
    if (!rows.length) return { nodes, paths, width: width.value, height: 300 };
    const blockTop = rows[0].center - rows[0].bandH / 2;
    const blockBottom = rows[rows.length - 1].center + rows[rows.length - 1].bandH / 2;
    ROOT.y = Math.max(14, (blockTop + blockBottom) / 2 - ROOT.h / 2);
    nodes.push({ kind: "root", ...ROOT, title: "主控 Agent", note: "拆需求 · 派活 · 收口" });
    const rootCy = ROOT.y + ROOT.h / 2;
    rows.forEach((row) => {
      const firstTop = row.center - row.m.stackH / 2;
      const stageY = row.y;
      const stageCy = row.center;
      nodes.push({
        kind: "stage",
        x: STAGE_X,
        y: stageY,
        w: STAGE_W,
        h: STAGE_H,
        stageIndex: row.index,
        data: row.stage,
      });
      paths.push({
        id: "e:stage:" + row.index,
        to: "stage:" + row.index,
        d: curved
          ? curveH(ROOT.x + ROOT.w - 4, rootCy, STAGE_X + 6, stageCy)
          : roundedPath(
              [
                [ROOT.x + ROOT.w - 8, rootCy],
                [BUS_X, rootCy],
                [BUS_X, stageCy],
                [STAGE_X + 10, stageCy],
              ],
              12,
            ),
      });
      if (row.groups) {
        let top = firstTop;
        row.groups.forEach((group) => {
          const groupKey = `group:${row.index}:${group.name}`;
          nodes.push({
            kind: "group",
            x: TASK_X,
            y: top,
            w: TASK_W,
            h: GROUP_HEAD_H,
            stageIndex: row.index,
            title: group.name,
            note: `${group.kids.length} 个文件`,
          });
          const cy = top + GROUP_HEAD_H / 2;
          paths.push({
            id: `e:${groupKey}`,
            to: groupKey,
            d: curved
              ? curveH(STAGE_X + STAGE_W - 4, stageCy, TASK_X + 6, cy)
              : roundedPath(
                  [
                    [STAGE_X + STAGE_W, stageCy],
                    [TASK_BUS_X, stageCy],
                    [TASK_BUS_X, cy],
                    [TASK_X + 10, cy],
                  ],
                  10,
                ),
          });
          let childTop = top + GROUP_HEAD_H + GROUP_CHILD_GAP;
          group.kids.forEach((task, ki) => {
            nodes.push({
              kind: "task",
              x: TASK_X + GROUP_INSET,
              y: childTop,
              w: TASK_W - GROUP_INSET * 2,
              h: GROUP_CHILD_H,
              dense: true,
              data: { ...task, title: task.file ? task.file.split("/").pop() || task.title : task.title },
            });
            const childCy = childTop + GROUP_CHILD_H / 2;
            paths.push({
              id: "e:task:" + task.id,
              to: "task:" + task.id,
              d: roundedPath(
                [
                  [TASK_X + 8, top + GROUP_HEAD_H],
                  [TASK_X + 8, childCy],
                  [TASK_X + GROUP_INSET + 2, childCy],
                ],
                6,
              ),
            });
            childTop += GROUP_CHILD_H + (ki < group.kids.length - 1 ? GROUP_CHILD_GAP : 0);
          });
          top = childTop + GROUP_GAP;
        });
      } else {
        row.kids.forEach((task, k) => {
          const top = firstTop + k * (row.m.h + row.m.gap);
          nodes.push({
            kind: "task",
            x: TASK_X,
            y: top,
            w: TASK_W,
            h: row.m.h,
            dense: row.m.dense,
            data: task,
          });
          paths.push({
            id: "e:task:" + task.id,
            to: "task:" + task.id,
            d: curved
              ? curveH(STAGE_X + STAGE_W - 4, stageCy, TASK_X + 6, top + row.m.h / 2)
              : roundedPath(
                  [
                    [STAGE_X + STAGE_W, stageCy],
                    [TASK_BUS_X, stageCy],
                    [TASK_BUS_X, top + row.m.h / 2],
                    [TASK_X + 10, top + row.m.h / 2],
                  ],
                  10,
                ),
          });
        });
      }
      const stackEnd = firstTop + row.m.stackH;
      const hidden = taskCountOf(row.index) - row.kids.length;
      if (hidden > 0) {
        const top = stackEnd + 6;
        nodes.push({
          kind: "chip",
          x: TASK_X,
          y: top,
          w: TASK_W,
          h: row.m.h,
          stageIndex: row.index,
          title: `还有 ${hidden} 个分支`,
          note: "点开展开",
        });
        paths.push({
          id: "e:chip:" + row.index,
          to: "chip:" + row.index,
          d: curved
            ? curveH(STAGE_X + STAGE_W - 4, stageCy, TASK_X + 6, top + row.m.h / 2)
            : roundedPath(
                [
                  [STAGE_X + STAGE_W, stageCy],
                  [TASK_BUS_X, stageCy],
                  [TASK_BUS_X, top + row.m.h / 2],
                  [TASK_X + 10, top + row.m.h / 2],
                ],
                10,
              ),
        });
      }
    });
    if (view.focus !== null && rows.length) {
      nodes.push({
        kind: "other",
        x: STAGE_X,
        y: rows[0].y + STAGE_H + 18,
        w: STAGE_W,
        h: 44,
        title: `其余 ${stages.value.length - 1} 道工序在后台继续`,
        note: "聚焦不打断执行",
      });
    }
    return { nodes, paths, width: width.value, height: Math.max(cursor + 40, ROOT.y + ROOT.h + 40) };
  }

  function layoutTD() {
    const nodes: TreeNode[] = [];
    const paths: TreePath[] = [];
    const ROOT_W = 240;
    const ROOT_H = 60;
    const STAGE_H = 64;
    const GAP = 16;
    const list = view.focus === null ? stages.value : [stages.value[view.focus]];
    const wide = width.value >= 900;
    const stageW = wide ? 138 : 104;
    const taskW = wide ? 132 : 118;
    const taskH = 52;
    const taskGap = 12;
    const measure = (limit: number, sw: number, tw: number) =>
      list.map((stage, i) => {
        const index = view.focus === null ? i : view.focus;
        const kids = childrenOf(index, limit).map(cardOf);
        const hidden = taskCountOf(index) - kids.length;
        const slots = kids.length + (hidden > 0 ? 1 : 0);
        const kidsW = slots ? slots * tw + (slots - 1) * taskGap : 0;
        return { stage, index, kids, hidden, kidsW, colW: Math.max(sw, kidsW), sw, tw };
      }) as TDCol[];
    const fits = (items: ReturnType<typeof measure>, gap: number) =>
      items.reduce((sum, col) => sum + col.colW, 0) + (items.length - 1) * gap <= width.value - 16;
    const attempts = [
      [4, stageW, taskW, GAP],
      [3, stageW, taskW, GAP],
      [2, stageW, taskW, GAP],
      [1, 96, 104, 10],
      [1, 86, 96, 8],
    ];
    let cols: TDCol[] = measure(4, stageW, taskW);
    let usedGap = GAP;
    for (const [limit, sw, tw, gap] of attempts) {
      const next = measure(limit, sw, tw);
      cols = next;
      usedGap = gap;
      if (fits(next, gap)) break;
    }
    const stageWUsed = cols[0]?.sw || stageW;
    const taskWUsed = cols[0]?.tw || taskW;
    const totalW = cols.reduce((sum, col) => sum + col.colW, 0) + (cols.length - 1) * usedGap;
    let x = Math.max(10, (width.value - totalW) / 2);
    cols.forEach((col) => {
      col.x = x;
      col.center = x + col.colW / 2;
      x += col.colW + usedGap;
    });
    const stageY = 138;
    const busY = stageY - 28;
    const blockLeft = cols[0].center - cols[0].colW / 2;
    const blockRight = cols[cols.length - 1].center + cols[cols.length - 1].colW / 2;
    const rootX = (blockLeft + blockRight) / 2 - ROOT_W / 2;
    const rootCx = rootX + ROOT_W / 2;
    nodes.push({ kind: "root", x: rootX, y: 14, w: ROOT_W, h: ROOT_H, title: "主控 Agent", note: "拆需求 · 派活 · 收口" });
    cols.forEach((col) => {
      nodes.push({
        kind: "stage",
        compact: true,
        x: col.center - stageWUsed / 2,
        y: stageY,
        w: stageWUsed,
        h: STAGE_H,
        stageIndex: col.index,
        data: col.stage,
      });
      paths.push({
        id: "e:stage:" + col.index,
        to: "stage:" + col.index,
        d:
          view.edges === "curve"
            ? curveV(rootCx, 14 + ROOT_H - 4, col.center, stageY + 6)
            : roundedPath(
                [
                  [rootCx, 14 + ROOT_H - 8],
                  [rootCx, busY],
                  [col.center, busY],
                  [col.center, stageY + 10],
                ],
                12,
              ),
      });
    });
    const taskY = stageY + STAGE_H + 52;
    const taskBusY = taskY - 24;
    cols.forEach((col) => {
      if (!col.kids.length) return;
      const kidsW = col.kids.length * taskWUsed + (col.kids.length - 1) * taskGap;
      const kx0 = col.center - kidsW / 2;
      paths.push({
        id: "e:trunk:" + col.index,
        to: "task:" + (col.kids[0]?.id || "chip:" + col.index),
        d: `M ${col.center} ${stageY + STAGE_H} V ${taskBusY}`,
      });
      paths.push({
        id: "e:bus:" + col.index,
        to: "task:" + (col.kids[0]?.id || "chip:" + col.index),
        d: `M ${kx0 + taskWUsed / 2} ${taskBusY} H ${kx0 + kidsW - taskWUsed / 2}`,
      });
      col.kids.forEach((task, k) => {
        const kx = kx0 + k * (taskWUsed + taskGap);
        nodes.push({ kind: "task", x: kx, y: taskY, w: taskWUsed, h: taskH, data: task });
        paths.push({
          id: "e:task:" + task.id,
          to: "task:" + task.id,
          d:
            view.edges === "curve"
              ? curveV(col.center, stageY + STAGE_H - 4, kx + taskWUsed / 2, taskY + 6)
              : roundedPath(
                  [
                    [col.center, taskBusY],
                    [kx + taskWUsed / 2, taskBusY],
                    [kx + taskWUsed / 2, taskY + 10],
                  ],
                  10,
                ),
        });
      });
      if (col.hidden > 0) {
        const kx = kx0 + col.kids.length * (taskWUsed + taskGap);
        nodes.push({
          kind: "chip",
          x: kx,
          y: taskY,
          w: taskWUsed,
          h: taskH,
          stageIndex: col.index,
          title: `还有 ${col.hidden} 个分支`,
          note: "点开展开",
        });
        paths.push({
          id: "e:chip:" + col.index,
          to: "chip:" + col.index,
          d:
            view.edges === "curve"
              ? curveV(col.center, stageY + STAGE_H - 4, kx + taskWUsed / 2, taskY + 6)
              : roundedPath(
                  [
                    [col.center, taskBusY],
                    [kx + taskWUsed / 2, taskBusY],
                    [kx + taskWUsed / 2, taskY + 10],
                  ],
                  10,
                ),
        });
      }
    });
    if (view.focus !== null) {
      nodes.push({
        kind: "other",
        x: Math.max(12, cols[0].center - 100),
        y: taskY + taskH + 26,
        w: 200,
        h: 40,
        title: `其余 ${stages.value.length - 1} 道工序在后台继续`,
        note: "聚焦不打断执行",
      });
    }
    return { nodes, paths, width: width.value, height: taskY + taskH + 200 };
  }

  const layout = computed(() => (view.layout === "lr" ? layoutLR() : layoutTD()));
  const nodes = computed(() => layout.value.nodes);
  const paths = computed(() => layout.value.paths);
  const height = computed(() => layout.value.height);

  function focusStage(index: number) {
    view.focus = view.focus === index ? null : index;
  }

  function expandStage(index: number) {
    if (!view.expanded.includes(index)) view.expanded.push(index);
  }

  function setLayout(value: "lr" | "td") {
    view.layout = value;
  }

  function setEdges(value: "curve" | "elbow") {
    view.edges = value;
  }

  function clearFocus() {
    view.focus = null;
  }

  function iconOf(stage: WorkbenchStage) {
    return ICONS[stage.no] || "";
  }

  return {
    view,
    width,
    nodes,
    paths,
    height,
    focusStage,
    expandStage,
    setLayout,
    setEdges,
    clearFocus,
    iconOf,
  };
}