import { reactive } from "vue";
import type { WorkbenchFile, WorkbenchStage, WorkbenchTask } from "../types/workbench-engine";

export interface GateQuestion {
  id: string;
  text: string;
  type?: string;
  options?: string[];
  default?: string;
}

export interface EvidenceHit {
  source?: string;
  snippet?: string;
}

export interface WorkbenchGate {
  visible: boolean;
  round: number;
  title: string;
  questions: GateQuestion[];
}

export interface WorkbenchTaskDetail {
  visible: boolean;
  stage: string;
  title: string;
  state: string;
  stateClass: string;
  ms: string;
  file: string;
  note: string;
  openFile: string;
}

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
  taskDetail: WorkbenchTaskDetail;
  gate: WorkbenchGate;
  evidence: EvidenceHit[];
  openStages: string[];
  setEvidence(hits: EvidenceHit[]): void;
  showGate(gate: { round?: number; questions?: GateQuestion[] }): void;
  hideGate(): void;
  showTaskDetail(detail: Omit<WorkbenchTaskDetail, "visible">): void;
  hideTaskDetail(): void;
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
  taskDetail: {
    visible: false as boolean,
    stage: "第 — 道",
    title: "任务",
    state: "—",
    stateClass: "",
    ms: "—",
    file: "—",
    note: "",
    openFile: "",
  },
  showTaskDetail(detail) {
    this.taskDetail = { ...detail, visible: true };
  },
  hideTaskDetail() {
    this.taskDetail = { ...this.taskDetail, visible: false };
  },
  gate: {
    visible: false as boolean,
    round: 1,
    title: "需要你确认",
    questions: [] as GateQuestion[],
  },
  showGate(gate) {
    const questions = gate.questions || [];
    this.gate = {
      visible: true,
      round: gate.round || 1,
      title: `需要你确认（第 ${gate.round || 1} 轮 · ${questions.length} 个问题）`,
      questions,
    };
  },
  hideGate() {
    this.gate = { ...this.gate, visible: false };
  },
  evidence: [] as EvidenceHit[],
  setEvidence(hits) {
    this.evidence = hits.map((hit) => ({ source: hit.source, snippet: hit.snippet }));
  },
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