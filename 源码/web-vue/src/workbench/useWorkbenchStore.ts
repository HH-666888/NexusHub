import { reactive } from "vue";
import type { WorkbenchFile, WorkbenchStage, WorkbenchTask } from "../types/workbench-engine";

export interface WorkbenchSync {
  stages?: WorkbenchStage[];
  tasks?: WorkbenchTask[];
  progress?: number;
  eventLine?: string;
  cost?: number;
  calls?: number;
  status?: string;
  stageIndex?: number;
  files?: WorkbenchFile[];
  activePath?: string;
  livePath?: string;
  reviewMode?: boolean;
  reviewText?: string;
  dotWarn?: boolean;
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
  files: WorkbenchFile[];
  activePath: string;
  livePath: string;
  reviewMode: boolean;
  reviewText: string;
  dotWarn: boolean;
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
  files: [] as WorkbenchFile[],
  activePath: "",
  livePath: "",
  reviewMode: false as boolean,
  reviewText: "",
  dotWarn: false as boolean,
  openStages: [] as string[],
  sync(payload: WorkbenchSync) {
    if (payload.stages) this.stages = payload.stages.map((stage) => ({ ...stage }));
    if (payload.tasks) this.tasks = payload.tasks.map((task) => ({ ...task }));
    if (typeof payload.progress === "number") this.progress = payload.progress;
    if (typeof payload.eventLine === "string") this.eventLine = payload.eventLine;
    if (typeof payload.cost === "number") this.cost = payload.cost;
    if (typeof payload.calls === "number") this.calls = payload.calls;
    if (typeof payload.status === "string") this.status = payload.status;
    if (payload.files) {
      this.files = payload.files.map((file) => ({ ...file, lines: file.lines.slice() }));
    }
    if (typeof payload.activePath === "string") this.activePath = payload.activePath;
    if (typeof payload.livePath === "string") this.livePath = payload.livePath;
    if (typeof payload.reviewMode === "boolean") this.reviewMode = payload.reviewMode;
    if (typeof payload.reviewText === "string") this.reviewText = payload.reviewText;
    if (typeof payload.dotWarn === "boolean") this.dotWarn = payload.dotWarn;
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