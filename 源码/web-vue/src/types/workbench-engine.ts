export interface WorkbenchRun {
  id: string;
  prompt?: string;
  stage: string;
  status: string;
  totalCostCny?: number;
}

export interface WorkbenchEvent {
  kind: string;
  payload: Record<string, any>;
  createdAt?: number;
  seq?: number;
}

export interface WorkbenchStage {
  id: string;
  no: string;
  name: string;
  short?: string;
  note: string;
  state: string;
  icon?: string;
}

export interface WorkbenchFile {
  path: string;
  lang: string;
  state: string;
  lines: string[];
  written?: number;
}

export interface WorkbenchTask {
  id: string;
  title: string;
  stage: string;
  state: string;
  file?: string;
  note?: string;
  startedAt?: number;
  finishedAt?: number;
  ms?: number;
}

export interface WorkbenchEngineApi {
  isLive: boolean;
  getSpeed(): number;
  setSpeed(value: number): void;
  stopTimeline(): void;
  setStage(index: number): void;
  setProgress(percent: number): void;
  setBranches(items: unknown[]): void;
  addTask(task: WorkbenchTask): void;
  updateTask(id: string, patch: Partial<WorkbenchTask>): void;
  clearTasks(): void;
  feedFile(path: string, lang: string, delta: string, done: boolean, replace: boolean): void;
  focusFile(path: string): void;
  setCost(cny: number): void;
  addCall(): void;
  setEvent(text: string): void;
  setStatus(status: string): void;
  resetFile(path: string): void;
  markBranchDone(path: string): void;
  resetFiles(): void;
  showFile(path: string): void;
}

declare global {
  interface Window {
    __wb?: WorkbenchEngineApi;
    __treeDone?: boolean;
  }
}

export {};