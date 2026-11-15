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

const store = workbenchStore;
const speed = ref(1);
const buffers = new Map<string, string>();

export function initWorkbenchModel() {
  if (!store.stages.length) store.stages = STAGES.map((stage) => ({ ...stage, note: "—" }));
  try {
    const saved = Number(localStorage.getItem("nexus-speed"));
    if (saved >= 0.1 && saved <= 1) setSpeed(saved);
  } catch {
    /* 隐私模式读不到就按 1 处理 */
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
  if (task.state === "running") {
    store.openStages = [task.stage];
  }
}

export function clearTasks() {
  store.tasks = [];
  store.progress = 0;
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

export function feedFile(
  path: string,
  lang: string,
  delta: string,
  done: boolean,
  replace: boolean,
) {
  let file = store.files.find((item) => item.path === path);
  if (!file) {
    file = { path, lang: lang || "text", state: "live", lines: [] };
    store.files = [...store.files, file];
  }
  if (replace) {
    file.lines = [];
    file.state = "live";
    buffers.set(path, "");
  }
  const merged = (buffers.get(path) || "") + (delta || "");
  const parts = merged.split("\n");
  const rest = parts.pop() || "";
  file.lines = [...file.lines, ...parts];
  buffers.set(path, rest);
  if (done) {
    if (rest) file.lines = [...file.lines, rest];
    buffers.set(path, "");
    file.state = "done";
    if (store.livePath === path) store.livePath = "";
  }
  if (!store.activePath) {
    store.activePath = path;
    store.livePath = done ? "" : path;
    store.dotWarn = !done;
  }
}

export function showFile(path: string, review = false) {
  const file = store.files.find((item) => item.path === path);
  if (!file) return;
  store.activePath = path;
  const streaming = !review && file.state === "live";
  store.livePath = streaming ? path : "";
  store.reviewMode = !streaming;
  store.reviewText = streaming ? "正在写这个文件" : "回看 · " + path + " 已生成完毕";
  store.dotWarn = streaming;
}

export function resetFiles() {
  store.files = [];
  store.activePath = "";
  store.livePath = "";
  store.reviewMode = false;
  store.reviewText = "";
  store.dotWarn = false;
  buffers.clear();
}

export function resetFile(path: string) {
  const file = store.files.find((item) => item.path === path);
  if (!file) return;
  file.lines = [];
  file.state = "live";
  buffers.set(path, "");
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

export function setSpeed(value: number) {
  const next = Math.min(1, Math.max(0.1, Number(value) || 1));
  speed.value = next;
  document.documentElement.style.setProperty("--node-dur", (0.28 / next).toFixed(2) + "s");
  try {
    localStorage.setItem("nexus-speed", String(next));
  } catch {
    /* ignore */
  }
}

export { speed, STAGE_ORDER, STAGES };