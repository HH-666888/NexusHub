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
  /** 正在逐字写入、尚未换行的那一小段文本；用于流式光标 */
  partial?: string;
  written?: number;
}

export interface WorkbenchTask {
  id: string;
  title: string;
  stage: string;
  state: string;
  file?: string;
  group?: string;
  note?: string;
  reason?: string;
  progress?: number;
  startedAt?: number;
  finishedAt?: number;
  ms?: number;
}

