<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from "vue";
import { workbenchStore } from "../useWorkbenchStore";
import type { WorkbenchStage, WorkbenchTask } from "../../types/workbench-engine";
import { showTaskDetail } from "../workbenchModel";

const store = workbenchStore;
const scrollKey = "nexus-wb-task-scroll:" + (new URLSearchParams(location.search).get("run") || "new");

onMounted(() => {
  const list = document.getElementById("task-list");
  if (!list) return;
  try {
    const saved = Number(localStorage.getItem(scrollKey));
    if (Number.isFinite(saved)) list.scrollTop = saved;
  } catch {
    /* 忽略 */
  }
  list.addEventListener(
    "scroll",
    () => {
      try {
        localStorage.setItem(scrollKey, String(list.scrollTop));
      } catch {
        /* 忽略 */
      }
    },
    { passive: true },
  );
});

/** 只要某道工序已经有任务，默认展开，别让用户面对一排折叠箭头 */
watch(
  () => store.tasks.length,
  () => {
    for (const stage of store.stages) {
      if (store.tasks.some((task) => task.stage === stage.id)) store.autoOpen(stage.id);
    }
  },
  { immediate: true },
);

/** 工序切换时把当前位置滚进视野；只在运行中跟随，回看已完成任务时别乱跳 */
watch(
  () => store.stageIndex,
  async () => {
    if (store.status !== "running") return;
    await nextTick();
    const stage = store.stages[store.stageIndex];
    if (!stage) return;
    const row = document.querySelector<HTMLElement>(`.t-stage[data-stage="${stage.id}"] .t-stage-row`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  },
);

const currentTask = computed(() => store.tasks.find((task) => task.state === "running") || null);

/** 主控状态跟着真实运行状态走，不再永远显示"待命" */
const masterState = computed(() => {
  if (store.status === "running") {
    // 还没开始（没输入需求、也没任务）就别谎报"运行中"
    return store.started || store.tasks.length ? "运行中" : "待命";
  }
  if (store.status === "paused") return "已暂停";
  if (store.status === "done") return "已完成";
  if (store.status === "failed") return "失败";
  if (store.status === "cancelled") return "已取消";
  return "待命";
});

const progressLabel = computed(() => {
  if (!store.stages.length) return "等待开始";
  const stage = store.stages[store.stageIndex];
  const place = stage ? `第 ${store.stageIndex + 1} 道 · ${stage.name}` : "等待开始";
  return currentTask.value ? place + " · " + currentTask.value.title : place;
});

/** 真实进度：按六道工序的状态算，已完成各算满，正在跑的那道算半道 */
const runProgress = computed(() => {
  const total = store.stages.length;
  if (!total) return 0;
  const done = store.stages.filter((stage) => stage.state === "done").length;
  const half = store.stages.some((stage) => stage.state === "live") ? 0.5 : 0;
  return Math.min(100, Math.round(((done + half) / total) * 100));
});

function stageState(stage: WorkbenchStage) {
  return stage.state === "done" ? "完成" : stage.state === "live" ? "进行中" : "等待";
}

function tasksOf(stageId: string) {
  return store.tasks.filter((task) => task.stage === stageId);
}

function taskLabel(task: WorkbenchTask) {
  const short = String(task.file || "").split("/").pop();
  return task.title + (short ? " · " + short : task.note ? " · " + task.note : "");
}

function taskState(task: WorkbenchTask) {
  return task.state === "done"
    ? "完成"
    : task.state === "running"
      ? "进行中"
      : task.state === "failed"
        ? "失败"
        : "等待";
}

function taskClass(task: WorkbenchTask) {
  return (
    "t-item" +
    (task.state === "running" ? " is-live" : task.state === "failed" ? " is-fail" : "")
  );
}
</script>

<template>
  <aside class="tasks">
    <div class="tasks-head">
      <h2>
        任务清单
        <span class="pill pill-plain" style="font-weight: 500; font-size: 11px; padding: 1px 8px;">{{ store.tasks.length }} 项</span>
      </h2>
      <p>主控一边分析一边往下派活</p>
      <div class="stage-progress">
        <div class="label"><span>{{ progressLabel }}</span><span id="pct">{{ runProgress }}%</span></div>
        <div class="bar"><i id="bar" :style="{ width: runProgress + '%' }"></i></div>
      </div>
    </div>

    <div class="task-list" id="task-list">
      <div class="t-group">
        <button
          type="button"
          class="t-item t-master"
          id="t-master"
          :class="{ 'is-live': store.status === 'running' }"
          @click="store.toggleAll()"
        >
          <span class="no">L1</span>
          <span class="name">主控 Agent</span>
          <span class="state">{{ masterState }}</span>
          <span class="chev">▾</span>
        </button>
      </div>
      <div class="t-group" id="stage-groups">
        <div
          v-for="stage in store.stages"
          :key="stage.id"
          class="t-stage"
          :class="{ 'is-open': store.isOpen(stage.id) }"
          :data-stage="stage.id"
        >
          <button
            type="button"
            class="t-item t-stage-row"
            :class="{ 'is-live': stage.state === 'live' }"
            :data-stage="stage.id"
            @click="store.toggleStage(stage.id)"
          >
            <span class="no">{{ stage.no }}</span>
            <span class="name">{{ stage.name }}</span>
            <span class="state">{{ stageState(stage) }}</span>
            <span class="chev">▸</span>
          </button>
          <div v-if="store.isOpen(stage.id)" class="t-sub" :data-stage="stage.id">
            <div
              v-for="task in tasksOf(stage.id)"
              :key="task.id"
              :class="taskClass(task)"
              :data-task="task.id"
              @click="showTaskDetail(task.id)"
            >
              <span class="name">{{ taskLabel(task) }}</span>
              <span class="state">{{ taskState(task) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="evidence" id="evidence" :hidden="!store.evidence.length">
      <div class="evidence-head">参考依据 <span id="evidence-count">{{ store.evidence.length }}</span></div>
      <div class="evidence-list" id="evidence-list">
        <div v-for="(hit, index) in store.evidence" :key="index" class="evidence-row">
          <b>{{ hit.source || "知识库" }}</b>
          <small>{{ hit.snippet || "" }}</small>
        </div>
      </div>
    </div>
  </aside>
</template>