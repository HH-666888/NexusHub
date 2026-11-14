import { computed, nextTick, onBeforeUnmount, reactive, ref } from "vue";
import type {
  AgentTool,
  AssistFinding,
  AssistProject,
  AssistTest,
  Citation,
  CoachReply,
  Deliverable,
  MemoryStats,
  Skill,
} from "../types/api";

export interface CoachMessage {
  id: number;
  kind: "user" | "ai";
  text: string;
  streaming?: boolean;
  citations?: Citation[];
  tools?: AgentTool[];
  answer?: string;
  undo?: boolean;
  suggestApply?: boolean;
}

const STAGE_HINTS: Record<string, string> = {
  design: "先把模块和文件定下来，再写代码；右边可以问 AI「还缺哪个模块」。",
  build: "你自己写代码，AI 只审查不代写；保存后点“检查”。",
  assemble: "把入口、依赖、启动方式补齐；检查会看静态资源与外部引用。",
  test: "从验收标准出发写用例；失败原因贴到右边问 AI。",
  deliver: "过一遍上线前清单：依赖、密钥、错误处理、README。",
};

export function useWorkspace(projectId: string) {
  const api = window.api;
  const project = ref<AssistProject | null>(null);
  const stage = ref("plan");
  const currentPath = ref("");
  const content = ref("");
  const dirty = ref(false);
  const findings = ref<AssistFinding[]>([]);
  const tests = ref<AssistTest[]>([]);
  const testsLoaded = ref(false);
  const deliverable = ref<Deliverable | null>(null);
  const deliverableLoaded = ref(false);
  const memoryStats = ref<MemoryStats | null>(null);
  const skills = ref<Skill[]>([]);
  const error = ref("");
  const loading = ref(true);
  const saving = ref(false);
  const analyzing = ref(false);
  const image = ref("");
  const imageName = ref("");
  const messages = ref<CoachMessage[]>([]);
  const mode = ref("suggest");
  const citeCount = ref("");

  let stageTimer: number | undefined;
  let stageInitialized = false;
  let messageSeq = 0;
  let modeSelect: HTMLSelectElement | null = null;
  let modeHandler: (() => void) | null = null;

  const stages = computed(() => project.value?.stages || []);
  const stageIndex = computed(() => stages.value.findIndex((item) => item.id === stage.value));
  const stageLabel = computed(() => {
    return stages.value.find((item) => item.id === stage.value)?.label || stage.value;
  });
  const stageHint = computed(() => STAGE_HINTS[stage.value] || "");
  const editorHint = computed(() => {
    if (!currentPath.value) return "还没有选择文件。先新建一个，比如 app.py。";
    return (
      currentPath.value +
      " · " +
      langHint(currentPath.value) +
      (dirty.value ? " · 有未保存修改" : " · 已保存")
    );
  });
  const isCodeStage = computed(() => stage.value !== "plan");
  const isLastStage = computed(() => stageIndex.value === stages.value.length - 1);

  function langHint(path: string) {
    if (/\.py$/.test(path)) return "Python";
    if (/\.java$/.test(path)) return "Java";
    if (/\.js$/.test(path)) return "JavaScript";
    if (/\.html?$/.test(path)) return "HTML";
    if (/\.css$/.test(path)) return "CSS";
    if (/\.sql$/.test(path)) return "SQL";
    return "文本";
  }

  function setChrome() {
    if (!project.value) return;
    const title = document.getElementById("crumb-title");
    if (title) title.textContent = project.value.title;
    const stagePill = document.getElementById("stage-pill");
    if (stagePill) {
      stagePill.textContent = `第 ${stageIndex.value + 1} 道 · ${stageLabel.value}`;
    }
    if (modeSelect) modeSelect.value = mode.value;
    document.title = project.value.title + " · 辅助开发";
  }

  function bindChrome() {
    modeSelect = document.getElementById("mode") as HTMLSelectElement | null;
    modeHandler = () => {
      if (!modeSelect || modeSelect.value === mode.value) return;
      void setMode(modeSelect.value);
    };
    modeSelect?.addEventListener("change", modeHandler);
  }

  async function loadMemoryStats() {
    if (!api) return;
    const stats = await api.memoryStats();
    if (!stats) return;
    memoryStats.value = stats;
    const pill = document.getElementById("memory-pill");
    if (pill) pill.textContent = "记忆 " + stats.total + " 条 · 今日 " + stats.today + "/" + stats.dailyLimit;
  }

  async function loadSkill() {
    if (!api) return;
    const items = await api.skills();
    skills.value = items || [];
    const pill = document.getElementById("skill-pill");
    if (pill && items?.length) {
      pill.textContent = "Skill " + items[0].version;
      pill.title = items[0].name + " · " + (items[0].stages || []).length + " 道工序";
    }
  }

  async function loadFile(path: string) {
    if (!api) return;
    const file = await api.assistFile(projectId, path);
    currentPath.value = path;
    content.value = file ? file.content : "";
    dirty.value = false;
  }

  async function loadFindings() {
    if (!api) return;
    findings.value = (await api.assistFindings(projectId, "open")) || [];
  }

  async function loadTests() {
    if (!api) return;
    tests.value = (await api.assistTests(projectId)) || [];
    testsLoaded.value = true;
  }

  async function loadDeliverable() {
    if (!api) return;
    deliverable.value = await api.assistDeliverable(projectId);
    deliverableLoaded.value = true;
  }

  async function ensureStageData() {
    if (stage.value === "test") await loadTests();
    if (stage.value === "deliver") await loadDeliverable();
  }

  async function loadProject() {
    if (!api) {
      error.value = "加载失败，请刷新重试。";
      loading.value = false;
      return;
    }
    const data = await api.assistProject(projectId);
    if (!data) {
      error.value = "项目不存在或已被删除。";
      loading.value = false;
      return;
    }
    project.value = data;
    if (!stageInitialized) {
      stage.value = data.stage;
      stageInitialized = true;
    }
    mode.value = data.mode || "suggest";
    if (!currentPath.value && data.files.length) {
      await loadFile(data.files[0].path);
    }
    setChrome();
    await loadFindings();
    await ensureStageData();
    loading.value = false;
  }

  async function boot() {
    if (!projectId) {
      location.replace("../");
      return;
    }
    bindChrome();
    await loadProject();
    await loadMemoryStats();
    await loadSkill();
  }

  function goStage(id: string, persist = false) {
    if (stage.value === id) return;
    stage.value = id;
    setChrome();
    void ensureStageData();
    if (!persist) return;
    window.clearTimeout(stageTimer);
    stageTimer = window.setTimeout(async () => {
      if (!api) return;
      await api.updateAssist(projectId, { stage: id });
      await loadMemoryStats();
    }, 250);
  }

  function advance() {
    const index = stageIndex.value;
    if (index >= 0 && index < stages.value.length - 1) {
      goStage(stages.value[index + 1].id, true);
    }
  }

  async function selectFile(path: string) {
    if (path === currentPath.value) return;
    if (dirty.value && !confirm("当前文件还没保存，切换会丢掉修改，继续？")) return;
    await loadFile(path);
  }

  function markDirty(value: string) {
    content.value = value;
    dirty.value = true;
  }

  async function saveFile() {
    if (!api || !currentPath.value || saving.value) return;
    saving.value = true;
    try {
      const result = await api.saveAssistFile(projectId, currentPath.value, content.value);
      if (result.ok) {
        dirty.value = false;
        await loadProject();
      }
    } finally {
      saving.value = false;
    }
  }

  async function addFile(path: string) {
    const nextPath = path.trim();
    if (!api || !nextPath) return;
    const result = await api.saveAssistFile(projectId, nextPath, "");
    if (result.ok) {
      currentPath.value = nextPath;
      content.value = "";
      dirty.value = false;
      await loadProject();
    }
  }

  async function deleteFile() {
    if (!api || !currentPath.value) return;
    if (!confirm("删除文件 " + currentPath.value + "？")) return;
    const response = await fetch(
      "/api/assist/projects/" +
        encodeURIComponent(projectId) +
        "/file?path=" +
        encodeURIComponent(currentPath.value),
      { method: "DELETE", credentials: "include" },
    );
    if (response.ok) {
      currentPath.value = "";
      content.value = "";
      await loadProject();
    }
  }

  async function analyze() {
    if (!api || !currentPath.value || analyzing.value) return;
    analyzing.value = true;
    try {
      if (dirty.value) await saveFile();
      const result = await api.analyzeAssist(projectId);
      if (!result.ok) {
        alert("检查失败，请重试");
        return;
      }
      await loadFindings();
      await loadProject();
    } finally {
      analyzing.value = false;
    }
  }

  async function updateFinding(id: string, status: string) {
    if (!api) return;
    await api.updateFinding(id, status);
    await loadFindings();
  }

  async function saveGoal(goal: string) {
    if (!api) return;
    await api.updateAssist(projectId, { goal });
    await loadProject();
  }

  async function addTest(title: string, expected: string) {
    if (!api) return;
    await api.createAssistTest(projectId, { title, expected });
    await loadTests();
  }

  async function updateTest(id: string, status: string) {
    if (!api) return;
    await api.updateAssistTest(id, { status });
    await loadTests();
  }

  async function deleteTest(id: string) {
    if (!api) return;
    if (!confirm("删除这条测试用例？")) return;
    await api.deleteAssistTest(id);
    await loadTests();
  }

  async function setMode(value: string) {
    if (!api) return;
    mode.value = value;
    await api.updateAssist(projectId, { mode: value });
    if (value === "auto") {
      addCoach("ai", "自动模式：会直接修改当前文件，改完可以撤销。");
    }
  }

  function addCoach(kind: "user" | "ai", text: string, citations?: Citation[]) {
    const message = reactive<CoachMessage>({
      id: ++messageSeq,
      kind,
      text,
      citations,
    });
    messages.value.push(message);
    return message;
  }

  function addStreamBubble() {
    return addCoach("ai", "");
  }

  function addCitations(message: CoachMessage, citations?: Citation[]) {
    if (!citations?.length) return;
    message.citations = citations;
    citeCount.value = "记忆 " + citations.length + " 条";
  }

  function appendUser(text: string) {
    if (text) addCoach("user", text);
  }

  async function streamCoach(text: string, echoUser = true) {
    if (!api) return;
    if (echoUser) appendUser(text);
    const bubble = addStreamBubble();
    bubble.streaming = true;
    let result: CoachReply | null = null;
    try {
      result = await api.assistCoachStream(projectId, text, stage.value, mode.value, (delta) => {
        bubble.text += delta;
      });
    } catch {
      result = null;
    }

    if (!result?.reply) {
      const fallback = await api.assistCoach(projectId, text, stage.value, mode.value);
      if (!fallback) {
        bubble.streaming = false;
        bubble.text = "AI 暂时没有响应，请稍后再试。";
        return;
      }
      bubble.text = fallback.reply;
      addCitations(bubble, fallback.citations);
      result = fallback;
    } else {
      addCitations(bubble, result.citations);
    }
    bubble.streaming = false;
    if (mode.value === "suggest" && currentPath.value && text && result) {
      bubble.suggestApply = true;
    }
    await loadMemoryStats();
  }

  async function runAgent(text: string) {
    if (!api) return;
    const bubble = addCoach("ai", "正在调用工具…");
    const result = await api.assistAgent(projectId, text, stage.value);
    bubble.text = "";
    if (!result) {
      bubble.text = "Agent 暂时没有响应，请稍后再试。";
      return;
    }
    bubble.tools = result.tools || [];
    bubble.answer = result.reply || "";
    addCitations(bubble, result.citations);
  }

  async function runVision(text: string) {
    if (!api) return;
    const label = imageName.value || "图片";
    appendUser((text ? text + "\n" : "") + "[图片] " + label);
    const data = image.value;
    clearImage();
    const bubble = addCoach("ai", "正在看图片…");
    const result = await api.assistVision(projectId, text, stage.value, data);
    if (!result) {
      bubble.text = "图片识别失败，请换一张更清晰的图片。";
      return;
    }
    bubble.text = result.reply || "模型没有识别出内容。";
    addCitations(bubble, result.citations);
  }

  async function sendCoach(text: string) {
    if (!api) return;
    const message = text.trim();
    if (image.value) {
      await runVision(message);
      return;
    }
    if (!message) return;
    appendUser(message);

    if (mode.value === "auto" && currentPath.value) {
      const result = await api.applyAssist(projectId, currentPath.value, message);
      if (result.ok && result.data) {
        lastPrevious = result.data.previous;
        lastPreviousPath = result.data.path;
        content.value = result.data.content;
        dirty.value = false;
        const msg = addCoach(
          "ai",
          "已修改 " +
            result.data.path +
            "。" +
            (result.data.note || "") +
            "\n可以点下面的“撤销这次修改”。",
        );
        msg.undo = true;
        await loadProject();
        await analyze();
        return;
      }
      const detail = result.data?.error?.message || "修改失败";
      addCoach("ai", "自动修改没有成功：" + detail + "。可以切回“协作”模式看建议。");
      return;
    }

    if (mode.value === "agent") {
      await runAgent(message);
      return;
    }

    await streamCoach(message, false);
  }

  async function applySuggestion(text: string) {
    if (!api || !currentPath.value) return;
    const result = await api.applyAssist(projectId, currentPath.value, text, true);
    if (!result.ok || !result.data) {
      addCoach("ai", "生成改动失败，可以换个说法再试。");
      return;
    }
    if (!confirm("AI 建议修改 " + result.data.path + "，是否应用？")) {
      addCoach("ai", "已保留建议，没有修改文件。");
      return;
    }
    await api.saveAssistFile(projectId, result.data.path, result.data.content);
    lastPrevious = result.data.previous;
    lastPreviousPath = result.data.path;
    content.value = result.data.content;
    dirty.value = false;
    const msg = addCoach("ai", "已应用对 " + result.data.path + " 的修改。");
    msg.undo = true;
    await loadProject();
    await analyze();
  }

  async function undoLast(message: CoachMessage) {
    if (!api) return;
    const previous = lastPrevious;
    const previousPath = lastPreviousPath;
    if (previous === null) return;
    await api.saveAssistFile(projectId, previousPath, previous);
    lastPrevious = null;
    message.undo = false;
    addCoach("ai", "已撤销 " + previousPath + " 的修改。");
    await loadProject();
  }

  let lastPrevious: string | null = null;
  let lastPreviousPath = "";

  async function askStage() {
    await streamCoach("帮我看这一步还缺什么");
  }

  function setImage(data: string, name: string) {
    image.value = data;
    imageName.value = name;
  }

  function clearImage() {
    image.value = "";
    imageName.value = "";
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendCoach((event.target as HTMLTextAreaElement).value);
      (event.target as HTMLTextAreaElement).value = "";
    }
  }

  onBeforeUnmount(() => {
    window.clearTimeout(stageTimer);
    if (modeSelect && modeHandler) modeSelect.removeEventListener("change", modeHandler);
  });

  return {
    api,
    project,
    stages,
    stage,
    stageIndex,
    stageLabel,
    stageHint,
    editorHint,
    isCodeStage,
    isLastStage,
    currentPath,
    content,
    dirty,
    findings,
    tests,
    testsLoaded,
    deliverable,
    deliverableLoaded,
    error,
    loading,
    saving,
    analyzing,
    mode,
    memoryStats,
    skills,
    messages,
    citeCount,
    image,
    imageName,
    boot,
    loadProject,
    loadFile,
    goStage,
    advance,
    selectFile,
    markDirty,
    saveFile,
    addFile,
    deleteFile,
    analyze,
    updateFinding,
    saveGoal,
    addTest,
    updateTest,
    deleteTest,
    setMode,
    sendCoach,
    applySuggestion,
    undoLast,
    askStage,
    setImage,
    clearImage,
    onKeydown,
    loadMemoryStats,
    langHint,
  };
}