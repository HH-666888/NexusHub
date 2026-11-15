<script setup lang="ts">
import { computed, ref, watch } from "vue";

interface Attachment {
  name: string;
  text: string;
}

interface ParsedPrompt {
  requirement: string;
  docs: Attachment[];
}

const props = defineProps<{
  open: boolean;
  initialPrompt: string;
  readonly: boolean;
}>();

const emit = defineEmits<{ close: []; created: [runId: string] }>();

const prompt = ref("");
const attachments = ref<Attachment[]>([]);
const reading = ref(false);
const creating = ref(false);
const error = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const downloaded = ref(false);
const draftRestored = ref(false);

const DRAFT_KEY = "nexus-agent-draft-v1";

interface AgentDraft {
  prompt: string;
  attachments: Attachment[];
}

function readDraft(): AgentDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<AgentDraft>;
    if (typeof data.prompt !== "string" || !Array.isArray(data.attachments)) return null;
    const docs = data.attachments.filter(
      (item): item is Attachment =>
        Boolean(item) && typeof item.name === "string" && typeof item.text === "string",
    );
    return { prompt: data.prompt, attachments: docs };
  } catch {
    return null;
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 隐私模式不阻塞提交 */
  }
}

function saveDraft() {
  if (!props.open || props.readonly) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ prompt: prompt.value, attachments: attachments.value }));
  } catch {
    /* 空间不足或隐私模式时，至少保证当前页面可用 */
  }
}

const textExtensions = [
  "md", "markdown", "txt", "text", "csv", "json", "yaml", "yml", "xml",
  "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "java", "sql", "log",
];

const TEST_CASE_NAME = "NexusHub-全流程测试用例.md";
const TEST_CASE = `# NexusHub 全流程测试用例

## 背景
这是一个用于验证「主控 Agent → 六道工序 → 真实交付」的最小 Web 应用。
请实现一个可直接运行的「团队任务看板」，不要只写文档。

## 功能要求
1. 看板有三列：待办、进行中、已完成。
2. 可以新建任务，字段包含标题和负责人。
3. 任务可以在三列之间移动；刷新页面后数据还在。
4. 可以删除任务。
5. 页面顶部显示任务总数和已完成数量。

## 技术约束
- 后端使用 Python + FastAPI，数据存 SQLite。
- 前端使用原生 HTML/CSS/JavaScript，不引入前端框架。
- 提供 GET /api/tasks、POST /api/tasks、PATCH /api/tasks/{id}、DELETE /api/tasks/{id}。
- 同一目录提供 README.md，写清启动命令和端口。

## 验收标准
- 空数据库启动后，页面能打开，三列都显示空态。
- 新建任务后立即出现在「待办」，总数加一。
- 把任务移动到「已完成」，已完成数量加一；刷新后状态不变。
- 删除任务后列表和计数同步减少。
- 后端对不存在的任务返回 404，表单缺标题返回 400。

## 运行
- 安装依赖后执行：uvicorn main:app --host 127.0.0.1 --port 8010
- 打开 http://127.0.0.1:8010/ 验证。
`;

const totalChars = computed(() =>
  attachments.value.reduce((sum, item) => sum + item.text.length, 0),
);

const canSubmit = computed(
  () =>
    !props.readonly &&
    Boolean(prompt.value.trim() || attachments.value.length) &&
    !creating.value &&
    !reading.value,
);

function parsePrompt(value: string): ParsedPrompt {
  const first = value.indexOf("\n\n===== 文档：");
  if (first < 0) return { requirement: value, docs: [] };
  const docs: Attachment[] = [];
  const pattern = /===== 文档：(.+?) =====\n([\s\S]*?)(?=\n\n===== 文档：|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    docs.push({ name: match[1].trim(), text: match[2].replace(/\s+$/, "") });
  }
  return { requirement: value.slice(0, first), docs };
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = "";
    reading.value = false;
    creating.value = false;
    downloaded.value = false;
    if (fileInput.value) fileInput.value.value = "";
    if (props.readonly) {
      const parsed = parsePrompt(props.initialPrompt || "");
      prompt.value = parsed.requirement;
      attachments.value = parsed.docs;
    } else {
      const draft = readDraft();
      draftRestored.value = Boolean(draft && (draft.prompt.trim() || draft.attachments.length));
      prompt.value = draft?.prompt || props.initialPrompt || "";
      attachments.value = draft?.attachments || [];
    }
  },
);

watch([prompt, attachments], saveDraft, { deep: true });

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() || "";
}

function chooseFiles() {
  if (props.readonly) return;
  fileInput.value?.click();
}

function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  void addFiles(files);
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  if (props.readonly) return;
  void addFiles(Array.from(event.dataTransfer?.files || []));
}

async function addFiles(files: File[]) {
  if (!files.length || props.readonly) return;
  reading.value = true;
  error.value = "";
  try {
    for (const file of files) {
      const ext = extensionOf(file.name);
      if (!textExtensions.includes(ext)) {
        error.value = `${file.name} 不是纯文本文档；目前支持 ${textExtensions.slice(0, 10).join(" / ")} 等文本或代码格式。`;
        continue;
      }
      if (file.size > 512 * 1024) {
        error.value = `${file.name} 超过 512KB，请拆分或精简后再上传。`;
        continue;
      }
      if (attachments.value.some((item) => item.name === file.name)) {
        error.value = `${file.name} 已经在列表里了。`;
        continue;
      }
      const text = await file.text();
      if (!text.trim()) continue;
      if (totalChars.value + text.length > 120000) {
        error.value = "文档正文合计超过 12 万字符，请删掉一些或精简后再上传。";
        break;
      }
      attachments.value.push({ name: file.name, text });
    }
  } finally {
    reading.value = false;
  }
}

function removeAttachment(index: number) {
  if (props.readonly) return;
  attachments.value.splice(index, 1);
}

function downloadTestCase() {
  if (props.readonly) return;
  const blob = new Blob([TEST_CASE], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = TEST_CASE_NAME;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);

  if (attachments.value.some((item) => item.name === TEST_CASE_NAME)) {
    downloaded.value = true;
    return;
  }
  if (totalChars.value + TEST_CASE.length > 120000) {
    error.value = "文档正文合计超过 12 万字符，请先删掉一些再试。";
    return;
  }
  attachments.value.push({ name: TEST_CASE_NAME, text: TEST_CASE });
  downloaded.value = true;
}

function close() {
  if (creating.value) return;
  emit("close");
}

async function submit() {
  if (!canSubmit.value) return;
  const base = prompt.value.trim();
  const docs = attachments.value
    .map((item) => `\n\n===== 文档：${item.name} =====\n${item.text}`)
    .join("");
  const request = (base || "请根据下面的开发文档实现软件。") + docs;
  if (request.length > 120000) {
    error.value = "需求和文档合计超过 12 万字符，请精简后再提交。";
    return;
  }

  creating.value = true;
  error.value = "";
  try {
    const result = await window.api?.createRun(request);
    if (!result || !result.ok || !result.data) {
      error.value = result?.offline ? "后端没启动，创建不了。" : "创建失败，请稍后重试。";
      return;
    }
    clearDraft();
    emit("created", result.data.id);
  } catch {
    error.value = "创建失败，请稍后重试。";
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="agent-modal" @click.self="close">
    <section class="agent-card" role="dialog" aria-modal="true" aria-labelledby="agent-title">
      <header>
        <div>
          <h3 id="agent-title">
            {{ readonly ? "主控 Agent · 当前任务" : "主控 Agent · 开始一个新任务" }}
          </h3>
          <p>
            {{
              readonly
                ? "这次任务已经开始，需求和文档只能查看，不能再修改。"
                : "描述要开发的软件；有现成开发文档就一起传上来。提交后会创建一条新的真实运行。"
            }}
          </p>
        </div>
        <button type="button" class="tc-close" aria-label="关闭" @click="close">×</button>
      </header>

      <label class="agent-label" for="agent-prompt">
        {{ readonly ? "已提交的需求" : "想开发什么" }}
      </label>
      <textarea
        id="agent-prompt"
        v-model="prompt"
        rows="6"
        :readonly="readonly"
        :class="{ readonly }"
        placeholder="例如：做一个团队任务看板，支持拖拽换列，刷新后数据还在。"
      ></textarea>

      <template v-if="!readonly">
        <div class="agent-testcase">
          <div class="agent-testcase-copy">
            <b>没有现成文档？</b>
            <span>下载一份可直接跑通全流程的测试用例，下载后会自动加入下方文档列表。</span>
          </div>
          <button type="button" class="agent-testcase-btn" @click="downloadTestCase">
            {{ downloaded ? "重新下载" : "下载测试用例" }}
          </button>
        </div>

        <div
          class="agent-attach"
          :class="{ dragging, reading }"
          @dragenter.prevent="dragging = true"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
          @click="chooseFiles"
        >
          <input
            ref="fileInput"
            type="file"
            multiple
            hidden
            accept=".md,.markdown,.txt,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.java,.sql,.log"
            @change="onFiles"
          />
          <span class="agent-upload-mark">＋</span>
          <span class="agent-upload-copy">
            <b>{{ reading ? "读取中…" : "上传开发文档" }}</b>
            <small>可多选，也可以把文件拖到这里；最多 512KB / 个</small>
          </span>
        </div>
      </template>

      <div v-if="attachments.length" class="agent-docs">
        <div class="agent-docs-head">
          <span>{{ readonly ? "已提交文档" : "开发文档" }}</span>
          <small>{{ attachments.length }} 个 · {{ totalChars }} 字符</small>
        </div>
        <details v-for="(file, index) in attachments" :key="file.name" class="agent-doc">
          <summary>
            <span>{{ file.name }}</span>
            <small>{{ file.text.length }} 字符</small>
            <button v-if="!readonly" type="button" @click.prevent="removeAttachment(index)">移除</button>
          </summary>
          <pre>{{ file.text }}</pre>
        </details>
      </div>

      <p v-if="error" class="agent-error">{{ error }}</p>

      <footer>
        <span class="agent-save-hint">
          {{
            readonly
              ? "内容已写入这次运行的记录"
              : draftRestored
                ? "已恢复本机草稿；编辑会自动保存"
                : "草稿自动保存在本机，提交后写入运行记录"
          }}
        </span>
        <button type="button" class="btn btn-sm btn-ghost" :disabled="creating" @click="close">
          {{ readonly ? "关闭" : "取消" }}
        </button>
        <button
          v-if="!readonly"
          type="button"
          class="btn btn-sm btn-primary"
          :disabled="!canSubmit"
          @click="submit"
        >
          {{ creating ? "创建运行中…" : "开始开发" }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.agent-modal {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.35);
  padding: 20px;
}
.agent-card {
  width: min(680px, 100%);
  max-height: min(760px, 90vh);
  overflow: auto;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: var(--card, #fff);
  box-shadow: 0 30px 80px -30px rgba(15, 23, 42, 0.45);
}
.agent-card header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.agent-card h3 {
  margin: 0 0 6px;
  font-size: 17px;
}
.agent-card p {
  margin: 0;
  color: var(--text-3);
  font-size: 12.5px;
  line-height: 1.7;
}
.agent-label {
  display: block;
  margin-bottom: 8px;
  font-size: 12.5px;
  color: var(--text-2);
}
.agent-card textarea {
  width: 100%;
  min-height: 140px;
  resize: vertical;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  font: inherit;
  line-height: 1.7;
  color: var(--text);
  background: var(--card-2, #fff);
}
.agent-card textarea.readonly {
  color: var(--text-2);
  background: var(--card-3, #f8fafc);
  resize: none;
}
.agent-attach {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px dashed var(--line-2);
  border-radius: 12px;
  transition: border-color 0.2s ease, background 0.2s ease;
}
.agent-attach.dragging {
  border-color: var(--primary);
  background: rgba(37, 99, 235, 0.06);
}
.agent-hint {
  font-size: 11.5px;
  color: var(--text-3);
}
.agent-docs {
  margin-top: 12px;
}
.agent-docs-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12.5px;
  color: var(--text-2);
}
.agent-docs-head small {
  color: var(--text-3);
}
.agent-doc {
  border: 1px solid var(--line);
  border-radius: 10px;
  margin-bottom: 6px;
  overflow: hidden;
}
.agent-doc summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 12.5px;
}
.agent-doc summary small {
  color: var(--text-3);
}
.agent-doc summary button {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #dc2626;
  font: inherit;
  cursor: pointer;
}
.agent-doc pre {
  max-height: 220px;
  overflow: auto;
  margin: 0;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  background: var(--card-3, #f8fafc);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.agent-error {
  margin-top: 10px;
  color: #dc2626;
  font-size: 12.5px;
}
.agent-card footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
</style>
<style scoped>
.agent-card {
  border-radius: 20px;
  padding: 24px;
  border-color: #e3eaf3;
  box-shadow: 0 24px 70px -28px rgba(15, 23, 42, 0.38);
}
.agent-card h3 {
  font-size: 18px;
  letter-spacing: -0.01em;
}
.agent-card p {
  max-width: 560px;
  line-height: 1.65;
}
.agent-label {
  margin-top: 2px;
  font-weight: 600;
  color: var(--text-2);
}
.agent-card textarea {
  min-height: 150px;
  padding: 14px 16px;
  border-color: #dbe4f0;
  border-radius: 14px;
  background: #fbfdff;
  font-size: 13.5px;
  line-height: 1.75;
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.025);
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}
.agent-card textarea::placeholder {
  color: #9aa8ba;
}
.agent-card textarea:focus {
  outline: none;
  border-color: #9cc2fb;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
.agent-card textarea.readonly {
  background: #f7fafd;
  border-color: #e5ebf4;
  box-shadow: none;
}
.agent-testcase {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid #e3ebf5;
  border-radius: 14px;
  background: linear-gradient(180deg, #f8fbff, #f4f8fe);
}
.agent-testcase-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.agent-testcase-copy b {
  font-size: 12.5px;
  color: var(--text-2);
}
.agent-testcase-copy span {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
}
.agent-testcase-btn {
  flex: 0 0 auto;
  padding: 7px 11px;
  border: 1px solid #cfe0f6;
  border-radius: 9px;
  background: #fff;
  color: var(--primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease;
}
.agent-testcase-btn:hover {
  border-color: #9cc2fb;
  background: #f4f9ff;
}
.agent-attach {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  padding: 12px 14px;
  border: 1px solid #e3ebf5;
  border-radius: 14px;
  background: #fbfdff;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease;
}
.agent-attach:hover,
.agent-attach.dragging {
  border-color: #9cc2fb;
  background: #f6faff;
}
.agent-attach.reading {
  cursor: progress;
  opacity: 0.7;
}
.agent-upload-mark {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: #eaf3ff;
  color: var(--primary);
  font-size: 17px;
  line-height: 1;
}
.agent-upload-copy {
  display: grid;
  gap: 2px;
}
.agent-upload-copy b {
  font-size: 12.5px;
  color: var(--text-2);
  font-weight: 600;
}
.agent-upload-copy small {
  font-size: 11.5px;
  color: var(--text-3);
}
.agent-docs {
  margin-top: 14px;
}
.agent-doc {
  border-color: #e5ebf4;
  border-radius: 12px;
}
.agent-doc summary {
  padding: 9px 12px;
  background: #fbfdff;
}
.agent-doc summary:hover {
  background: #f6faff;
}
.agent-doc pre {
  background: #f8fbfe;
}
.agent-card footer {
  margin-top: 20px;
}
</style>

<style scoped>
.agent-save-hint {
  margin-right: auto;
  align-self: center;
  color: var(--text-3);
  font-size: 11.5px;
}
</style>
