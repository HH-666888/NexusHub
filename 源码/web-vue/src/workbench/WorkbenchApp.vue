<script setup lang="ts">
import { onMounted } from "vue";
import TaskPanel from "./components/TaskPanel.vue";
import TaskDetail from "./components/TaskDetail.vue";
import CanvasPanel from "./components/CanvasPanel.vue";
import CodePane from "./components/CodePane.vue";
import StatusBar from "./components/StatusBar.vue";

onMounted(async () => {
  // 树布局与 SSE 是独立的图形/数据引擎，生命周期绑定在页面挂载之后。
  await import("./engine/tree.js");
  await import("./engine/live.js");
});
</script>

<template>
  <TaskPanel />
  <TaskDetail />
  <CanvasPanel />
  <CodePane />
  <StatusBar />
</template>