import { ref } from "vue";
import { workbenchStore } from "./useWorkbenchStore";
import type { WorkbenchStage, WorkbenchTask } from "../types/workbench-engine";

const STAGE_ORDER = ["plan", "design", "build", "assemble", "test", "deliver"];

const STAGES: WorkbenchStage[] = [
  { id: "plan", no: "01", name: "需求分析", short: "需求", note: "5 条验收标准", state: "wait" },
  { id: "design", no: "02", name: "架构设计", short: "架构", note: "4 个模块", state: "wait" },
  { id: "build", no: "03", name: "自主开发", short: "自主", note: "按依赖逐个写", state: "wait" },
  { id: "assemble", no: "04", name: "集成装配", short: "装配", note: "等待上游", state: "wait" },
  { id: "test", no: "05", name: "自动测试", short: "测试", note: "等待上游", state: "wait" },
  { id: "deliver", no: "06", name: "验收交付", short: "验收", note: "等待上游", state: "wait" },
];

/** 五个离散播放档位，界面与键盘共用同一份定义 */
export const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1] as const;

/** 档位显示：0.25 不能被 toFixed(1) 四舍五入成 0.3 */
export function speedLabel(value: number): string {
  return Number(value.toFixed(2)).toString();
}

const store = workbenchStore;
const speed = ref(0.5);

/** 已换行文本的暂存：等待逐字吐出后再按行落到 file.lines */
const buffers = new Map<string, string>();
/** 还没吐出的原始文本（后端一次给 400 字，这里拆成逐字） */
const pending = new Map<string, string>();
/** 已经收到 done、等最后一字吐完再收尾的文件 */
const donePending = new Set<string>();
let timer: number | null = null;
let instant = false;

export function initWorkbenchModel() {
  if (!store.stages.length) store.stages = STAGES.map((stage) => ({ ...stage, note: "—" }));
  // 先把默认档位的动画时长写进 CSS 变量：不调用的话节点/连线还是 1× 的默认节奏，
  // 会和文字流速对不上（0.5× 时文字慢、树动画照旧快）。
  applySpeedVars(speed.value);
  try {
    const saved = Number(localStorage.getItem("nexus-speed-v2"));
    // 只接受当前档位表里的值：旧版本存过 0.3，现在不该继续生效
    if ((SPEEDS as readonly number[]).includes(saved)) setSpeed(saved);
  } catch {
    /* 隐私模式读不到就按默认 0.5 处理 */
  }
}

export function setStage(index: number) {
  store.stages = store.stages.map((stage, i) => ({
    ...stage,
    state: i < index ? "done" : i === index ? "live" : "wait",
    note: i < index && !/^\d/.test(stage.note) ? "完成" : stage.note,
  }));
  store.sync({ stageIndex: index });
}

export function setPrompt(value: string) {
  store.prompt = value;
  store.started = true;
}

export function setProgress(percent: number) {
  store.sync({ progress: percent });
}

export function setBranches(items: unknown[]) {
  store.stages = store.stages.map((stage, i) =>
    i === 2 ? { ...stage, note: items.length + " 个开发任务" } : stage,
  );
}

export function addTask(task: WorkbenchTask) {
  if (!task?.id) return;
  const index = store.tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) store.tasks[index] = { ...store.tasks[index], ...task };
  else store.tasks.push({ ...task });
  // 只要有任务就展开对应工序 —— 折叠是用户的选择，不该成为默认状态
  store.autoOpen(task.stage);
}

export function clearTasks() {
  store.tasks = [];
  store.progress = 0;
  // 新一轮开始，之前手动折叠的偏好不沿用
  store.manualClosed = [];
}

export function setCost(value: number) {
  store.cost = Number(value) || 0;
}

export function addCall() {
  store.calls += 1;
}

export function setEvent(text: string) {
  store.eventLine = text;
}

export function setStatus(status: string) {
  store.status = status;
  if (status === "done") {
    store.stages = store.stages.map((stage) => ({
      ...stage,
      state: "done",
      note: !/^\d/.test(stage.note) ? "完成" : stage.note,
    }));
  }
  const pill = document.querySelector(".appbar-center .pill");
  if (!pill) return;
  const map: Record<string, string> = {
    running: "运行中",
    paused: "已暂停",
    done: "已完成",
    failed: "已失败",
    cancelled: "已取消",
  };
  const label = map[status] || status;
  let done = store.stages.filter((stage) => stage.state === "done").length;
  if (store.stages.some((stage) => stage.state === "live")) done += 1;
  if (status === "done") done = 6;
  (pill as HTMLElement).dataset.lock = "1";
  if (status === "running") delete (pill as HTMLElement).dataset.lock;
  pill.className =
    "pill " + (status === "running" ? "pill-live" : status === "done" ? "pill-ok" : "pill-warn");
  pill.innerHTML =
    (status === "running" ? '<i class="pulse-dot"></i>' : "") + label + " · 第 " + done + " / 6 道";
}

/* ───────── 逐字打印 ───────── */

/** 每个节拍吐出的字数：1× 约 2900 字/秒，0.5× 正好是一半，0.1× 约 290 字/秒 */
function charsPerTick() {
  const value = speed.value;
  return Math.max(1, Math.round(70 * value));
}

function fileOf(path: string) {
  return store.files.find((item) => item.path === path);
}

function pushText(path: string, text: string) {
  const file = fileOf(path);
  if (!file || !text) return;
  const merged = (buffers.get(path) || "") + text;
  const parts = merged.split("\n");
  const rest = parts.pop() ?? "";
  if (parts.length) file.lines = [...file.lines, ...parts];
  buffers.set(path, rest);
  file.partial = rest;
}

function finalize(path: string) {
  const file = fileOf(path);
  donePending.delete(path);
  const rest = buffers.get(path) || "";
  if (file) {
    if (rest) file.lines = [...file.lines, rest];
    file.partial = "";
    file.state = "done";
  }
  buffers.delete(path);
  pending.delete(path);
  if (store.livePath === path) store.livePath = "";
  if (store.activePath === path) store.dotWarn = false;
  markBranchDone(path);
}

function tick() {
  timer = null;
  let target: string | null = null;
  for (const [path, text] of pending) {
    if (text.length) {
      target = path;
      break;
    }
  }
  if (target) {
    const text = pending.get(target) || "";
    const take = text.slice(0, Math.min(text.length, charsPerTick()));
    pending.set(target, text.slice(take.length));
    pushText(target, take);
    if (!pending.get(target)) pending.delete(target);
  } else {
    for (const path of Array.from(donePending)) finalize(path);
  }
  if (hasWork()) schedule();
}

function hasWork() {
  for (const [, text] of pending) if (text.length) return true;
  return donePending.size > 0;
}

function schedule() {
  if (timer !== null || instant) return;
  timer = window.setTimeout(tick, 24);
}

function stopTyping() {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

/** 历史回放 / 回到实时时直接落地，不再逐字重放 */
export function setInstant(value: boolean) {
  instant = value;
  if (value) stopTyping();
}

/** 把某个文件还没吐完的内容一次性落地（切到瞬时模式或收尾时用） */
function flushPath(path: string) {
  const text = pending.get(path) || "";
  pending.delete(path);
  if (text) pushText(path, text);
  if (donePending.has(path)) finalize(path);
}

export function feedFile(
  path: string,
  lang: string,
  delta: string,
  done: boolean,
  replace: boolean,
) {
  let file = fileOf(path);
  const fresh = !file;
  if (!file) {
    file = { path, lang: lang || "text", state: "live", lines: [] };
    store.files = [...store.files, file];
  }
  if (fresh) {
    // 新文件开始写入：跟随模式下自动把视线切过去，不再停在上一份文件
    store.livePath = done ? "" : path;
    store.dotWarn = !done;
    if (store.follow) {
      store.activePath = path;
      store.reviewMode = false;
      store.reviewText = "";
    }
  }
  if (replace) {
    file.lines = [];
    file.partial = "";
    file.state = "live";
    buffers.delete(path);
    pending.delete(path);
  }
  if (delta) pending.set(path, (pending.get(path) || "") + delta);
  if (done) donePending.add(path);
  if (instant) flushPath(path);
  else schedule();
}

export function showFile(path: string, review = false, manual = true) {
  const file = store.files.find((item) => item.path === path);
  if (!file) return;
  store.activePath = path;
  if (manual) store.follow = false;
  const streaming = !review && file.state === "live";
  store.livePath = streaming ? path : "";
  store.reviewMode = !streaming;
  store.reviewText = streaming ? "正在写这个文件" : "回看 · " + path + " 已生成完毕";
  store.dotWarn = streaming;
}

/** 回到「跟着最新文件走」的观看方式 */
export function followLatest() {
  store.follow = true;
  const live = store.livePath || "";
  const target = live || (store.files.length ? store.files[store.files.length - 1].path : "");
  if (target) {
    const file = fileOf(target);
    store.activePath = target;
    const streaming = Boolean(file && file.state === "live");
    store.livePath = streaming ? target : "";
    store.reviewMode = !streaming;
    store.reviewText = streaming ? "正在写这个文件" : "回看 · " + target + " 已生成完毕";
    store.dotWarn = streaming;
  }
}

export function resetFiles() {
  stopTyping();
  pending.clear();
  donePending.clear();
  buffers.clear();
  store.files = [];
  store.activePath = "";
  store.livePath = "";
  store.follow = true;
  store.reviewMode = false;
  store.reviewText = "";
  store.dotWarn = false;
}

export function resetFile(path: string) {
  const file = store.files.find((item) => item.path === path);
  if (!file) return;
  file.lines = [];
  file.partial = "";
  file.state = "live";
  buffers.delete(path);
  pending.delete(path);
  donePending.delete(path);
  if (store.activePath === path) {
    store.livePath = path;
    store.reviewMode = false;
    store.dotWarn = true;
  }
}

export function markBranchDone(path: string) {
  const task = store.tasks.find((item) => item.file === path);
  if (task) {
    task.state = "done";
    task.progress = 100;
  }
}

export function showTaskDetail(id: string) {
  const task = store.tasks.find((item) => item.id === id);
  if (!task) return;
  const index = STAGE_ORDER.indexOf(task.stage);
  store.showTaskDetail({
    stage: index >= 0 ? "第 " + (index + 1) + " 道 · " + STAGES[index].name : task.stage,
    title: task.title || "任务",
    state:
      task.state === "done" ? "完成" : task.state === "running" ? "进行中" : task.state === "failed" ? "失败" : "等待",
    stateClass: task.state === "failed" ? "is-fail" : "",
    ms: task.ms === undefined ? "—" : task.ms < 1000 ? task.ms + " ms" : (task.ms / 1000).toFixed(1) + " s",
    file: task.file || "—",
    note: task.reason ? "原因：" + task.reason : task.note ? "说明：" + task.note : "",
    openFile: task.file && store.files.some((file) => file.path === task.file) ? task.file : "",
  });
}

export function hideTaskDetail() {
  store.hideTaskDetail();
}

export function getSpeed() {
  return speed.value;
}

/** 树节点入场与连线描绘跟着档位一起放慢，0.1× 时能看清每一步 */
function applySpeedVars(value: number) {
  document.documentElement.style.setProperty("--node-dur", (0.28 + (1 - value) * 0.55).toFixed(2) + "s");
  document.documentElement.style.setProperty("--edge-dur", (0.5 + (1 - value) * 0.9).toFixed(2) + "s");
}

export function setSpeed(value: number) {
  const next = Math.min(1, Math.max(0.1, Number(value) || 1));
  speed.value = next;
  applySpeedVars(next);
  try {
    localStorage.setItem("nexus-speed-v2", String(next));
  } catch {
    /* ignore */
  }
  if (!instant) schedule();
}

export { speed, STAGE_ORDER, STAGES };
