<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useWorkbenchTree, type TreeNode } from "../useWorkbenchTree";
import { workbenchStore } from "../useWorkbenchStore";
import type { WorkbenchStage } from "../../types/workbench-engine";
import type { TreeCard } from "../useWorkbenchTree";
import { showTaskDetail, speed, setSpeed } from "../workbenchModel";

const emit = defineEmits<{ openAgent: [] }>();

const tree = useWorkbenchTree();
const { view, nodes, paths, height, width } = tree;
const inner = ref<HTMLElement | null>(null);
const ready = ref(false);
const speedOpen = ref(false);
const offsetY = ref(0);
const scrollKey = "nexus-wb-tree-scroll:" + (new URLSearchParams(location.search).get("run") || "new");
let observer: ResizeObserver | null = null;

const focusName = computed(() => {
  if (view.focus === null) return "—";
  const stage = workbenchStore.stages[view.focus];
  return stage ? stage.no + " " + stage.name : "—";
});

function stageOf(node: TreeNode) {
  return node.data as WorkbenchStage;
}

function taskOf(node: TreeNode) {
  return node.data as TreeCard;
}

function compactName(stage: WorkbenchStage) {
  return width.value < 900 ? stage.short || stage.name : stage.name;
}

function nodeStyle(node: TreeNode) {
  return {
    left: node.x + "px",
    top: node.y + offsetY.value + "px",
    width: node.w + "px",
    ...(node.kind === "stage" && node.compact ? { minHeight: node.h + "px" } : {}),
    ...(node.kind === "task" || node.kind === "chip" ? { height: node.h + "px" } : {}),
  };
}

function stageClass(node: TreeNode) {
  const stage = stageOf(node);
  return ["node-stage", stage?.state || "wait", { focus: view.focus !== null }];
}

function stageGrid(node: TreeNode) {
  return node.compact ? "18px minmax(0,1fr)" : undefined;
}

function taskClass(node: TreeNode) {
  const task = taskOf(node);
  return ["node-task", task.state, { dense: node.dense }];
}

function focusStage(index: number | undefined) {
  if (typeof index === "number") tree.focusStage(index);
}

function expandStage(index: number | undefined) {
  if (typeof index === "number") tree.expandStage(index);
}

function closeSpeed(event: MouseEvent) {
  if (!(event.target as HTMLElement).closest(".speed-pop")) speedOpen.value = false;
}

function showTasks() {
  document.getElementById("work")?.classList.remove("no-tasks");
  onResize();
}

function showCode() {
  document.getElementById("work")?.classList.remove("no-code");
  onResize();
}

function onResize() {
  if (!inner.value) return;
  width.value = inner.value.clientWidth || 720;
  const canvas = inner.value.parentElement;
  const head = canvas?.querySelector(".canvas-head");
  const available = (canvas?.clientHeight || inner.value.clientHeight) - (head?.getBoundingClientRect().height || 0);
  offsetY.value = Math.max(0, Math.round((available - height.value) / 2));
}

function saveScroll() {
  const canvas = inner.value?.parentElement;
  if (!canvas) return;
  try {
    localStorage.setItem(scrollKey, JSON.stringify({ top: canvas.scrollTop, left: canvas.scrollLeft }));
  } catch {
    /* 隐私模式下忽略 */
  }
}

function restoreScroll() {
  const canvas = inner.value?.parentElement;
  if (!canvas) return;
  try {
    const saved = JSON.parse(localStorage.getItem(scrollKey) || "null") as { top?: number; left?: number } | null;
    if (!saved) return;
    canvas.scrollTop = Number(saved.top) || 0;
    canvas.scrollLeft = Number(saved.left) || 0;
  } catch {
    /* 忽略损坏的本地状态 */
  }
}

onMounted(async () => {
  document.addEventListener("click", closeSpeed);
  observer = new ResizeObserver(onResize);
  if (inner.value) {
    observer.observe(inner.value);
    if (inner.value.parentElement) {
      observer.observe(inner.value.parentElement);
      inner.value.parentElement.addEventListener("scroll", saveScroll, { passive: true });
    }
  }
  await nextTick();
  onResize();
  ready.value = true;
  window.requestAnimationFrame(restoreScroll);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  document.removeEventListener("click", closeSpeed);
  inner.value?.parentElement?.removeEventListener("scroll", saveScroll);
});

watch(
  () => view.focus,
  (focus) => {
    document.getElementById("work")?.classList.toggle("is-focus", focus !== null);
  },
);
</script>

<template>
  <main class="canvas" id="canvas">
    <div class="canvas-head">
      <h3>工作流树</h3>
      <span class="hint">一级主控 → 六道工序 → 按需分析出的任务</span>
      <span class="spacer"></span>
      <div class="layout-switch" role="group" aria-label="连线样式">
        <button type="button" data-edges="curve" :class="{ 'is-on': view.edges === 'curve' }" @click="tree.setEdges('curve')">曲线</button>
        <button type="button" data-edges="elbow" :class="{ 'is-on': view.edges === 'elbow' }" @click="tree.setEdges('elbow')">折线</button>
      </div>
      <div class="layout-switch" role="group" aria-label="树的排布">
        <button type="button" data-layout="lr" :class="{ 'is-on': view.layout === 'lr' }" @click="tree.setLayout('lr')">左右树</button>
        <button type="button" data-layout="td" :class="{ 'is-on': view.layout === 'td' }" @click="tree.setLayout('td')">上下树</button>
      </div>
      <button class="btn btn-sm btn-ghost show-tasks" type="button" id="show-tasks" @click="showTasks">
        <svg viewBox="0 0 24 24" aria-hidden style="width: 14px; height: 14px;"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
        显示清单
      </button>
      <button class="btn btn-sm btn-ghost show-code" type="button" id="show-code" @click="showCode">显示代码</button>
      <div class="speed-pop" id="speed-pop" :class="{ open: speedOpen }">
        <button type="button" class="speed-btn" id="speed-btn" title="播放速度（1 是真实速度）" @click.stop="speedOpen = !speedOpen">
          {{ speed === 1 ? "1" : speed.toFixed(1) }}×
        </button>
        <div class="speed-menu" id="speed-menu" @click.stop>
          <div class="speed-row">
            <span>0.1×</span>
            <input
              type="range"
              id="speed"
              min="0.1"
              max="1"
              step="0.1"
              :value="speed"
              @input="setSpeed(Number(($event.target as HTMLInputElement).value))"
            />
            <span>1×</span>
          </div>
          <p>只影响呈现，不影响后端与花费</p>
        </div>
      </div>
      <button class="btn btn-sm btn-ghost" type="button" id="replay">
        <svg viewBox="0 0 24 24" aria-hidden style="width: 14px; height: 14px;"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
        重播生成
      </button>
    </div>

    <div class="focus-bar" id="focus-bar">
      聚焦：<b id="focus-name">{{ focusName }}</b>
      <span id="focus-note">其余工序在后台继续</span>
      <button type="button" id="exit-focus" @click="tree.clearFocus()">退出聚焦</button>
    </div>

    <div class="canvas-inner" id="canvas-inner" ref="inner" :style="{ minHeight: height + 'px' }">
      <svg
        class="tree-svg"
        id="tree-svg"
        aria-hidden
        :viewBox="`0 0 ${width} ${height + offsetY}`"
        preserveAspectRatio="none"
        :style="{ height: height + offsetY + 'px' }"
      >
        <g :transform="`translate(0 ${offsetY})`">
          <path
            v-for="(path, index) in paths"
            :key="index"
            :d="path"
            pathLength="1"
            :class="{ draw: ready }"
          />
        </g>
      </svg>

      <template v-for="(node, index) in nodes" :key="index">
        <div
          v-if="node.kind === 'root'"
          class="node-root"
          :class="{ in: ready }"
          :style="[nodeStyle(node), { cursor: 'pointer' }]"
          @click="emit('openAgent')"
        >
          <b>{{ node.title }}</b><small>{{ node.note }}</small>
        </div>

        <div
          v-else-if="node.kind === 'stage'"
          :class="[...stageClass(node), { in: ready }]"
          :style="[nodeStyle(node), { gridTemplateColumns: stageGrid(node) }]"
          :data-stage="node.stageIndex"
          @click="focusStage(node.stageIndex)"
        >
          <template v-if="node.compact">
            <span class="no">{{ stageOf(node).no }}</span>
            <span class="txt"><b>{{ compactName(stageOf(node)) }}</b><small>{{ stageOf(node).note }}</small></span>
          </template>
          <template v-else>
            <span class="no">{{ stageOf(node).no }}</span>
            <svg viewBox="0 0 24 24"><path :d="tree.iconOf(stageOf(node))" /></svg>
            <span class="txt"><b>{{ stageOf(node).name }}</b><small>{{ stageOf(node).note }}</small></span>
          </template>
        </div>

        <div
          v-else-if="node.kind === 'task'"
          :class="[...taskClass(node), { in: ready }]"
          :style="nodeStyle(node)"
          :data-task="taskOf(node).id"
          @click="showTaskDetail(taskOf(node).id)"
        >
          <b>{{ taskOf(node).title }}</b>
          <code v-if="!node.dense">{{ taskOf(node).file }}</code>
          <span class="mini"><i :style="{ width: (taskOf(node).state === 'done' ? 100 : taskOf(node).state === 'running' ? 45 : 0) + '%' }"></i></span>
        </div>

        <div
          v-else-if="node.kind === 'chip'"
          class="node-task ghost chip"
          :class="{ in: ready }"
          :style="nodeStyle(node)"
          :data-expand="node.stageIndex"
          @click="expandStage(node.stageIndex)"
        >
          <b>{{ node.title }}</b><code>{{ node.note }}</code>
        </div>

        <div
          v-else-if="node.kind === 'other'"
          class="node-task ghost other"
          :class="{ in: ready }"
          :style="nodeStyle(node)"
        >
          <b>{{ node.title }}</b><code>{{ node.note }}</code>
        </div>
      </template>
    </div>
  </main>
</template>