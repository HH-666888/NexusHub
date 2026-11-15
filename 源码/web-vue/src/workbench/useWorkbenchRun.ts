import { onBeforeUnmount } from "vue";
import { workbenchStore } from "./useWorkbenchStore";
import * as model from "./workbenchModel";
import type { WorkbenchRun } from "../types/workbench-engine";

const STAGE_OF: Record<string, number> = {
  plan: 0,
  design: 1,
  build: 2,
  assemble: 3,
  test: 4,
  deliver: 5,
};

const PHASE_OF: Record<string, number> = {
  spec: 0,
  arch: 1,
  ui: 1,
  building: 2,
  generating: 2,
  saving: 3,
  checking: 4,
  deliver: 5,
  done: 5,
  awaiting: 2,
  failed: 2,
};

interface QueuedEvent {
  kind: string;
  payload: Record<string, any>;
  at: number;
}

interface RunState {
  events: QueuedEvent[];
  run: WorkbenchRun | null;
  cost: number;
  lastSeq: number;
  timer: number | null;
}

export function useWorkbenchRun() {
  const params = new URLSearchParams(location.search);
  const id = params.get("run") || "";
  const prompt = params.get("prompt") || "";
  const store = workbenchStore;
  const state: RunState = { events: [], run: null, cost: 0, lastSeq: 0, timer: null };
  const queue: { items: QueuedEvent[]; timer: number | null } = { items: [], timer: null };
  let source: EventSource | null = null;
  let finished = false;

  function speed() {
    return model.getSpeed() || 1;
  }

  function timeOf(ms: number) {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function clearQueue() {
    queue.items.length = 0;
    if (queue.timer !== null) {
      window.clearTimeout(queue.timer);
      queue.timer = null;
    }
  }

  function drain() {
    queue.timer = null;
    const item = queue.items.shift();
    if (!item) return;
    apply(item.kind, item.payload, item.at);
    const next = queue.items[0];
    const gap = next ? Math.max(24, next.at - item.at) : 120;
    queue.timer = window.setTimeout(drain, Math.min(5000, gap / Math.max(0.1, speed())));
  }

  function enqueue(kind: string, payload: Record<string, any>, at: number) {
    if (speed() >= 0.99) {
      apply(kind, payload, at);
      return;
    }
    queue.items.push({ kind, payload, at });
    if (queue.timer === null) queue.timer = window.setTimeout(drain, 30);
  }

  function apply(kind: string, payload: Record<string, any>, at: number, record = true) {
    if (record) state.events.push({ kind, payload, at });

    if (kind === "phase") {
      const index = PHASE_OF[payload.phase] ?? 2;
      if (payload.phase === "done") {
        model.setStage(5);
        model.setProgress(100);
      } else {
        model.setStage(index);
      }
      model.setEvent(timeOf(at) + " · " + (payload.label || payload.phase));
      return;
    }

    if (kind === "reasoning" || kind === "text") {
      const text = String(payload.delta || "").slice(0, 40);
      if (text) model.setEvent(timeOf(at) + " · " + text);
      return;
    }

    if (kind === "gate") {
      store.showGate(payload);
      return;
    }

    if (kind === "gate.answered") {
      store.hideGate();
      return;
    }

    if (kind === "spec" || kind === "arch") {
      model.setEvent(timeOf(at) + " · " + (kind === "spec" ? "需求分析完成" : "架构设计完成"));
      return;
    }

    if (kind === "retrieval") {
      const hits = payload.hits || [];
      store.setEvidence(hits);
      model.setEvent(timeOf(at) + " · 检索到 " + hits.length + " 条依据");
      return;
    }

    if (kind === "task") {
      if (payload.task) model.addTask(payload.task);
      return;
    }

    if (kind === "modules") {
      const items = payload.batch?.modules || [];
      if (items.length) model.setBranches(items);
      model.setEvent(timeOf(at) + " · 拆出 " + items.length + " 个开发任务，逐个写");
      return;
    }

    if (kind === "file") {
      model.feedFile(
        payload.path,
        payload.lang,
        payload.delta || "",
        Boolean(payload.done),
        Boolean(payload.replace),
      );
      if (payload.done) {
        model.markBranchDone(payload.path);
        model.setEvent(timeOf(at) + " · " + payload.path + " 写完");
      }
      return;
    }

    if (kind === "cost") {
      state.cost = payload.totalCny || state.cost;
      model.setCost(state.cost);
      return;
    }

    if (kind === "usage") {
      model.addCall();
      return;
    }

    if (kind === "check") {
      const summary = payload.summary || {};
      model.setEvent(timeOf(at) + " · 自测 " + (summary.passed || 0) + " / " + (summary.total || 0) + " 通过");
      return;
    }

    if (kind === "verdict") {
      model.setEvent(timeOf(at) + " · 验收 " + (payload.passed || 0) + " / " + (payload.total || 0));
      return;
    }

    if (kind === "artifact") {
      model.setEvent(timeOf(at) + " · 产物已生成：" + (payload.artifact?.name || ""));
      return;
    }

    if (kind === "error") {
      model.setStatus("failed");
      model.setEvent("出错：" + (payload.message || "未知错误"));
    }
  }

  function applyRun(run: WorkbenchRun) {
    state.run = run;
    model.setPrompt(run.prompt || "");
    state.cost = Number(run.totalCostCny || 0);
    model.setCost(state.cost);
    const index = STAGE_OF[run.stage];
    if (typeof index === "number" && run.status !== "done") {
      model.setStage(index);
      model.setProgress(Math.min(96, 12 + index * 15));
    }
    if (run.status === "done") {
      model.setStage(5);
      model.setProgress(100);
    }
    model.setStatus(run.status);
    const crumb = document.querySelector(".crumb b");
    if (crumb && run.prompt) {
      crumb.textContent = run.prompt.length > 18 ? run.prompt.slice(0, 18) + "…" : run.prompt;
    }
  }

  function subscribe() {
    if (typeof EventSource === "undefined") return;
    source = new EventSource("/api/runs/" + encodeURIComponent(id) + "/stream");
    source.onmessage = (message: MessageEvent) => {
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      const kind = payload.kind;
      if (!kind) return;
      if (payload.seq) {
        if (payload.seq <= state.lastSeq) return;
        state.lastSeq = payload.seq;
      }
      enqueue(kind, payload, payload.at || Date.now());
      if (kind === "phase" && payload.phase === "done") {
        finished = true;
        model.setStatus("done");
        source?.close();
      }
    };
    source.onerror = () => {
      if (finished) return;
      if (state.run && ["done", "failed", "cancelled"].includes(state.run.status)) return;
      model.setEvent("连接中断，正在重连…");
    };
  }

  function wireControls() {
    const pause = document.querySelector<HTMLButtonElement>('.appbar-right button[aria-label="暂停"]');
    if (pause) {
      pause.addEventListener("click", async () => {
        const paused = pause.getAttribute("aria-label") === "继续";
        const path = paused ? "/resume" : "/pause";
        const result = await fetch("/api/runs/" + encodeURIComponent(id) + path, {
          method: "POST",
          credentials: "include",
        });
        if (!result.ok) return;
        pause.setAttribute("aria-label", paused ? "暂停" : "继续");
        pause.innerHTML = paused
          ? '<svg viewBox="0 0 24 24" aria-hidden><path d="M9 5v14M15 5v14" stroke-width="2" /></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden><path d="M8 5l11 7-11 7z" stroke-width="2" /></svg>';
        model.setStatus(paused ? "running" : "paused");
      });
    }

    const right = document.querySelector(".appbar-right");
    if (right && !document.getElementById("cancel-run")) {
      const cancel = document.createElement("button");
      cancel.className = "btn btn-sm btn-ghost";
      cancel.type = "button";
      cancel.id = "cancel-run";
      cancel.textContent = "取消";
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        await fetch("/api/runs/" + encodeURIComponent(id) + "/cancel", {
          method: "POST",
          credentials: "include",
        });
        model.setStatus("cancelled");
        cancel.textContent = "已取消";
      });
      right.insertBefore(cancel, pause || right.firstChild);
    }
  }

  function wireBottomTabs() {
    const bottom = document.querySelector(".statusbar .tabs");
    if (!bottom) return;
    Array.from(bottom.children).forEach((btn) => {
      btn.addEventListener("click", async () => {
        Array.from(bottom.children).forEach((item) => item.classList.toggle("is-on", item === btn));
        const which = btn.textContent?.trim();
        if (which === "终端") {
          model.setEvent("预览由交付阶段启动；当前没有运行中的进程");
          return;
        }
        if (which === "验收") {
          const result = await fetch("/api/runs/" + encodeURIComponent(id) + "/verdict", {
            credentials: "include",
          });
          if (!result.ok) {
            model.setEvent("还没有验收结果");
            return;
          }
          const body = await result.json();
          const verdict = body.verdict || body;
          model.setEvent("验收：" + (verdict.passed || 0) + " / " + (verdict.total || 0) + " 通过");
          return;
        }
        model.setEvent("事件 " + state.events.length + " 条");
      });
    });
  }

  function stopReplay() {
    if (state.timer !== null) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
  }

  function replayAll() {
    stopReplay();
    clearQueue();
    model.resetFiles();
    model.clearTasks();
    model.setStage(0);
    model.setProgress(0);
    model.setStatus("running");
    let index = 0;
    const step = () => {
      if (index >= state.events.length) {
        stopReplay();
        model.setStatus("done");
        model.setProgress(100);
        return;
      }
      const item = state.events[index++];
      apply(item.kind, item.payload, item.at, false);
      const next = state.events[index];
      const gap = next ? Math.max(20, next.at - item.at) : 120;
      state.timer = window.setTimeout(step, Math.min(4000, gap / Math.max(0.1, speed())));
    };
    step();
  }

  function replayFile() {
    stopReplay();
    const path = store.activePath;
    if (!path) return;
    const items = state.events.filter((item) => item.kind === "file" && item.payload?.path === path);
    if (!items.length) return;
    model.resetFile(path);
    let index = 0;
    const step = () => {
      if (index >= items.length) {
        stopReplay();
        return;
      }
      const item = items[index++];
      model.feedFile(
        item.payload.path,
        item.payload.lang,
        item.payload.delta || "",
        Boolean(item.payload.done),
        false,
      );
      const next = items[index];
      const gap = next ? Math.max(20, next.at - item.at) : 100;
      state.timer = window.setTimeout(step, Math.min(3000, gap / Math.max(0.1, speed())));
    };
    step();
  }

  function backToLive() {
    stopReplay();
    clearQueue();
    model.resetFiles();
    model.clearTasks();
    state.events.forEach((item) => apply(item.kind, item.payload, item.at, false));
    if (state.run) applyRun(state.run);
  }

  function bindReplay() {
    const bind = (elementId: string, handler: () => void) => {
      const element = document.getElementById(elementId);
      if (!element) return;
      const clone = element.cloneNode(true) as HTMLElement;
      element.parentNode?.replaceChild(clone, element);
      clone.addEventListener("click", handler);
    };
    bind("replay", replayAll);
    bind("replay-file", replayFile);
    bind("back-live", backToLive);
  }

  async function boot() {
    if (!window.api) return;
    if (id === "new" && !prompt) {
      document.body.classList.add("is-blank");
      model.setEvent("还没有任务；在项目页输入一句话后，这里会出现派发记录");
      return;
    }
    if (id === "new" && prompt) {
      const result = await window.api.createRun(prompt, params.get("fast") === "1");
      if (result.ok && result.data) {
        location.replace("./?run=" + encodeURIComponent(result.data.id) + "&prompt=" + encodeURIComponent(prompt));
      }
      return;
    }
    if (!id) return;

    document.documentElement.dataset.live = "1";
    model.resetFiles();
    document.body.classList.add("is-live");
    model.setEvent("已连接，等待第一个事件…");

    const run = (await window.api.run(id)) as WorkbenchRun | null;
    if (!run) {
      document.body.classList.add("is-blank");
      model.setStatus("failed");
      model.setEvent("这次运行不存在或已被删除，请回项目页重新开始");
      return;
    }
    applyRun(run);

    const events = (await window.api.events(id)) as Array<{
      kind: string;
      payload: Record<string, any>;
      createdAt?: number;
      seq?: number;
    }> | null;
    if (Array.isArray(events)) {
      events.forEach((item) => {
        apply(item.kind, item.payload, item.createdAt || Date.now());
        if (item.seq) state.lastSeq = Math.max(state.lastSeq, item.seq);
      });
      applyRun(run);
    }

    wireControls();
    wireBottomTabs();
    bindReplay();
    subscribe();
    if (state.run?.status === "paused" && window.api.gate) {
      const data = (await window.api.gate(id)) as { gate?: Record<string, any> } | null;
      if (data?.gate) store.showGate(data.gate);
    }
  }

  onBeforeUnmount(() => {
    source?.close();
    stopReplay();
    clearQueue();
  });

  return { boot, replayAll, replayFile, backToLive };
}