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

const textExtensions = [
  "md", "markdown", "txt", "text", "csv", "json", "yaml", "yml", "xml",
  "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "java", "sql", "log",
];

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
    if (fileInput.value) fileInput.value.value = "";
    if (props.readonly) {
      const parsed = parsePrompt(props.initialPrompt || "");
      prompt.value = parsed.requirement;
      attachments.value = parsed.docs;
    } else {
      prompt.value = props.initialPrompt || "";
      attachments.value = [];
    }
  },
);

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
        <div
          class="agent-attach"
          :class="{ dragging }"
          @dragenter.prevent="dragging = true"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <input
            ref="fileInput"
            type="file"
            multiple
            hidden
            accept=".md,.markdown,.txt,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.java,.sql,.log"
            @change="onFiles"
          />
          <button type="button" class="btn btn-sm btn-ghost" :disabled="reading" @click="chooseFiles">
            {{ reading ? "读取中…" : "＋ 上传开发文档" }}
          </button>
          <span class="agent-hint">可多选，也可以把文件拖到这里；最多 512KB / 个</span>
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