<script setup lang="ts">
import { onMounted } from "vue";
import TaskPanel from "./components/TaskPanel.vue";
import TaskDetail from "./components/TaskDetail.vue";
import CanvasPanel from "./components/CanvasPanel.vue";
import CodePane from "./components/CodePane.vue";
import StatusBar from "./components/StatusBar.vue";
import GateModal from "./components/GateModal.vue";
import { workbenchStore } from "./useWorkbenchStore";
import { useWorkbenchRun } from "./useWorkbenchRun";

window.__wbStore = workbenchStore;
const run = useWorkbenchRun();

onMounted(async () => {
  // 树模型先就绪，SSE 数据层再把 run/事件写进 store 与模型。
  await import("./engine/tree.js");
  await run.boot();
});
</script>

<template>
  <TaskPanel />
  <TaskDetail />
  <CanvasPanel />
  <CodePane />
  <StatusBar />
  <GateModal />
</template>