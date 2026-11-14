/**
 * 前端用到的接口形状。
 *
 * 这里只描述真正读写的字段：字段是否必填按现有后端返回的最保守情况写，
 * 避免类型比运行时更"乐观"。后端业务接口本身没有改动。
 */

export interface ApiError {
  code?: string;
  message?: string;
}

export interface ApiResult<T> {
  ok: boolean;
  offline: boolean;
  status: number;
  data: (T & { error?: ApiError }) | null;
}

export interface User {
  id: string;
  username: string;
}

export interface SettingsInfo {
  apiKeySet?: boolean;
}

export interface MemoryStats {
  total: number;
  today: number;
  dailyLimit: number;
  week: number;
  lastAt?: number | null;
}

export interface MemoryEntry {
  id: string;
  title: string;
  body: string;
  reason?: string;
  sourceType?: string;
  confidence?: number;
  pinned?: boolean;
  createdAt: number;
}

export interface MemoryGroup {
  day: string;
  entries: MemoryEntry[];
}

export interface MemoryData {
  stats: MemoryStats;
  groups?: MemoryGroup[];
}

export interface Run {
  id: string;
  prompt: string;
  stage: string;
  status: string;
  totalCostCny?: number;
  createdAt: number;
}

export interface TodayUsage {
  totalCny?: number;
}

export interface AssistFinding {
  id: string;
  severity: string;
  message: string;
  path: string;
  line: number;
  stageLabel: string;
  status?: string;
}

export interface AssistFile {
  path: string;
  content: string;
}

export interface AssistStage {
  id: string;
  label: string;
}

export interface AssistTest {
  id: string;
  title: string;
  expected?: string;
  status: "pass" | "fail" | "todo" | string;
}

export interface DeliverableCheck {
  name: string;
  detail: string;
  pass: boolean;
}

export interface Deliverable {
  passed: number;
  total: number;
  checks: DeliverableCheck[];
}

export interface AssistProject {
  id: string;
  title: string;
  goal?: string;
  stage: string;
  stages: AssistStage[];
  files: AssistFile[];
  findings?: { open?: number };
  stageLabel?: string;
  mode?: string;
}

export interface AssistProjectList {
  projects: AssistProject[];
}

export interface Skill {
  name: string;
  version: string;
  stages?: string[];
}

export interface Citation {
  title: string;
}

export interface CoachReply {
  reply: string;
  citations?: Citation[];
  costCny?: number;
  model?: string;
}

export interface AgentTool {
  name: string;
  arguments?: Record<string, unknown>;
  result?: string;
  ms?: number;
}

export interface AgentReply extends CoachReply {
  tools?: AgentTool[];
}

export interface ApplyResult {
  path: string;
  content: string;
  previous: string | null;
  note?: string;
  error?: ApiError;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

export interface AssistFileData {
  path: string;
  content: string;
}

export interface NexusApi {
  base: string;
  me(): Promise<User | null>;
  login(username: string, password: string): Promise<ApiResult<unknown>>;
  register(username: string, password: string, confirmPassword?: string): Promise<ApiResult<unknown>>;
  logout(): Promise<ApiResult<null>>;
  runs(limit?: number): Promise<Run[] | null>;
  deleteRun(id: string): Promise<ApiResult<null>>;
  createRun(prompt: string, fast?: boolean): Promise<ApiResult<{ id: string }>>;
  run(runId: string): Promise<unknown | null>;
  gate(runId: string): Promise<unknown | null>;
  answerGate(runId: string, payload: unknown): Promise<ApiResult<unknown>>;
  events(runId: string): Promise<unknown[] | null>;
  assistProjects(): Promise<AssistProjectList | null>;
  createAssist(goal: string): Promise<ApiResult<{ id: string }>>;
  assistProject(id: string): Promise<AssistProject | null>;
  updateAssist(id: string, patch: Partial<AssistProject>): Promise<ApiResult<null>>;
  deleteAssist(id: string): Promise<ApiResult<null>>;
  saveAssistFile(id: string, path: string, content: string): Promise<ApiResult<null>>;
  assistFile(id: string, path: string): Promise<AssistFileData | null>;
  analyzeAssist(id: string): Promise<ApiResult<unknown>>;
  assistFindings(id: string, status?: string): Promise<AssistFinding[] | null>;
  updateFinding(id: string, status: string): Promise<ApiResult<null>>;
  applyAssist(
    id: string,
    path: string,
    instruction: string,
    dryRun?: boolean,
  ): Promise<ApiResult<ApplyResult>>;
  assistTests(id: string): Promise<AssistTest[] | null>;
  createAssistTest(id: string, payload: { title: string; expected?: string }): Promise<ApiResult<unknown>>;
  updateAssistTest(testId: string, patch: Partial<AssistTest>): Promise<ApiResult<null>>;
  deleteAssistTest(testId: string): Promise<ApiResult<null>>;
  assistDeliverable(id: string): Promise<Deliverable | null>;
  assistCoach(id: string, message: string, stage: string, mode: string): Promise<CoachReply | null>;
  assistCoachStream(
    id: string,
    message: string,
    stage: string,
    mode: string,
    onDelta?: (delta: string) => void,
  ): Promise<CoachReply | null>;
  assistVision(id: string, message: string, stage: string, image: string): Promise<CoachReply | null>;
  assistAgent(id: string, message: string, stage: string): Promise<AgentReply | null>;
  skills(): Promise<Skill[] | null>;
  memory(days?: number): Promise<MemoryData | null>;
  usageToday(): Promise<TodayUsage | null>;
  memoryStats(): Promise<MemoryStats | null>;
  updateMemory(id: string, pinned: boolean): Promise<ApiResult<null>>;
  deleteMemory(id: string): Promise<ApiResult<null>>;
  clearMemory(): Promise<ApiResult<null>>;
  settings(): Promise<SettingsInfo | null>;
  saveSettings(patch: { apiKey?: string }): Promise<ApiResult<null>>;
  testConnection(payload: { provider: string; apiKey: string }): Promise<TestConnectionResult>;
}

declare global {
  interface Window {
    api?: NexusApi;
    __treeDone?: boolean;
  }
}

export {};