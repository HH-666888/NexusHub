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
}

declare global {
  interface Window {
    __wb?: WorkbenchEngineApi;
    __treeDone?: boolean;
  }
}

export {};