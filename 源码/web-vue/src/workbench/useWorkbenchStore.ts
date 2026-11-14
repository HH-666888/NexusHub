import { reactive } from "vue";
import type { WorkbenchStage, WorkbenchTask } from "../types/workbench-engine";

export interface WorkbenchSync {
  stages?: WorkbenchStage[];
  tasks?: WorkbenchTask[];
  progress?: number;
  eventLine?: string;
  cost?: number;
  calls?: number;
  status?: string;
  stageIndex?: number;
}

export interface WorkbenchStoreApi {
  stages: WorkbenchStage[];
  tasks: WorkbenchTask[];
  progress: number;
  eventLine: string;
  cost: number;
  calls: number;
  status: string;
  stageIndex: number;
  openStages: string[];
  sync(payload: WorkbenchSync): void;
  isOpen(stageId: string): boolean;
  toggleStage(stageId: string): void;
  toggleAll(): void;
}

export const workbenchStore: WorkbenchStoreApi = reactive({
  stages: [] as WorkbenchStage[],
  tasks: [] as WorkbenchTask[],
  progress: 0,
  eventLine: "等待事件…",
  cost: 0,
  calls: 0,
  status: "running",
  stageIndex: 0,
  openStages: [] as string[],
  sync(payload: WorkbenchSync) {
    if (payload.stages) this.stages = payload.stages.map((stage) => ({ ...stage }));
    if (payload.tasks) this.tasks = payload.tasks.map((task) => ({ ...task }));
    if (typeof payload.progress === "number") this.progress = payload.progress;
    if (typeof payload.eventLine === "string") this.eventLine = payload.eventLine;
    if (typeof payload.cost === "number") this.cost = payload.cost;
    if (typeof payload.calls === "number") this.calls = payload.calls;
    if (typeof payload.status === "string") this.status = payload.status;
    if (typeof payload.stageIndex === "number") {
      this.stageIndex = payload.stageIndex;
      const current = this.stages[payload.stageIndex];
      this.openStages = current ? [current.id] : [];
    }
  },
  isOpen(stageId: string) {
    return this.openStages.includes(stageId);
  },
  toggleStage(stageId: string) {
    const index = this.openStages.indexOf(stageId);
    if (index >= 0) this.openStages.splice(index, 1);
    else this.openStages.push(stageId);
  },
  toggleAll() {
    if (this.openStages.length) this.openStages.splice(0);
    else this.openStages = this.stages.map((stage) => stage.id);
  },
});

declare global {
  interface Window {
    __wbStore?: WorkbenchStoreApi;
  }
}

export {};