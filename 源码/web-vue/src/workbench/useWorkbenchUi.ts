import { watch } from "vue";
import { workbenchStore } from "./useWorkbenchStore";
import { showFile } from "./workbenchModel";

interface SavedUi {
  openStages?: string[];
  activePath?: string;
}

function storageKey() {
  const runId = new URLSearchParams(location.search).get("run") || "new";
  return "nexus-wb-ui:" + runId;
}

function readUi(): SavedUi | null {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return null;
    const data = JSON.parse(raw) as SavedUi;
    return {
      openStages: Array.isArray(data.openStages)
        ? data.openStages.filter((value): value is string => typeof value === "string")
        : undefined,
      activePath: typeof data.activePath === "string" ? data.activePath : undefined,
    };
  } catch {
    return null;
  }
}

function saveUi() {
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({ openStages: workbenchStore.openStages.slice(), activePath: workbenchStore.activePath }),
    );
  } catch {
    /* 隐私模式不阻塞页面 */
  }
}

export function useWorkbenchUi() {
  let enabled = false;

  function restore() {
    const saved = readUi();
    if (!saved) {
      enabled = true;
      return;
    }
    const validStages = new Set(workbenchStore.stages.map((stage) => stage.id));
    if (saved.openStages && saved.openStages.length) {
      const open = saved.openStages.filter((id) => validStages.has(id));
      if (open.length) workbenchStore.openStages = open;
    }
    // 已加载的任务所在工序一律保证展开，恢复旧折叠状态时也不留一排收起箭头
    for (const stage of workbenchStore.stages) {
      if (workbenchStore.tasks.some((task) => task.stage === stage.id)) workbenchStore.autoOpen(stage.id);
    }
    if (saved.activePath && !workbenchStore.activePath && workbenchStore.files.some((file) => file.path === saved.activePath)) {
      showFile(saved.activePath, false, false);
    }
    enabled = true;
  }

  watch(
    () => [workbenchStore.openStages.slice(), workbenchStore.activePath],
    () => {
      if (enabled) saveUi();
    },
    { deep: true },
  );

  return { restore };
}