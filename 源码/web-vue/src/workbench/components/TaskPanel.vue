<script setup lang="ts">
import { computed } from "vue";
import { workbenchStore } from "../useWorkbenchStore";
import type { WorkbenchStage, WorkbenchTask } from "../../types/workbench-engine";

const store = workbenchStore;

const progressLabel = computed(() => {
  if (!store.stages.length) return "等待开始";
  const stage = store.stages[store.stageIndex];
  return stage ? `第 ${store.stageIndex + 1} 道 · ${stage.name}` : "等待开始";
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
        <div class="label"><span>{{ progressLabel }}</span><span id="pct">{{ store.progress }}%</span></div>
        <div class="bar"><i id="bar" :style="{ width: store.progress + '%' }"></i></div>
      </div>
    </div>

    <div class="task-list" id="task-list">
      <div class="t-group">
        <button type="button" class="t-item t-master" id="t-master" @click="store.toggleAll()">
          <span class="no">L1</span>
          <span class="name">主控 Agent</span>
          <span class="state">待命</span>
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