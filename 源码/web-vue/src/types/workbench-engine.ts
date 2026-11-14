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
  reason?: string;
  progress?: number;
  startedAt?: number;
  finishedAt?: number;
  ms?: number;
}

