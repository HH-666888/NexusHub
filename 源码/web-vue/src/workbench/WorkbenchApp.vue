<script setup lang="ts">
import { onMounted } from "vue";
import TaskPanel from "./components/TaskPanel.vue";
import TaskDetail from "./components/TaskDetail.vue";
import CanvasPanel from "./components/CanvasPanel.vue";
import CodePane from "./components/CodePane.vue";
import StatusBar from "./components/StatusBar.vue";
import GateModal from "./components/GateModal.vue";
import { useWorkbenchRun } from "./useWorkbenchRun";
import { initWorkbenchModel } from "./workbenchModel";

initWorkbenchModel();
const run = useWorkbenchRun();

function bindChrome() {
  document.getElementById("toggle-tasks")?.addEventListener("click", () => {
    document.getElementById("work")?.classList.toggle("no-tasks");
  });
  document.getElementById("toggle-code")?.addEventListener("click", () => {
    document.getElementById("work")?.classList.toggle("no-code");
  });
}

onMounted(async () => {
  bindChrome();
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