<script setup lang="ts">
import { computed, ref, watch } from "vue";

interface Attachment {
  name: string;
  text: string;
}

const props = defineProps<{
  open: boolean;
  initialPrompt: string;
}>();

const emit = defineEmits<{ close: []; created: [runId: string] }>();

const prompt = ref("");
const attachments = ref<Attachment[]>([]);
const reading = ref(false);
const creating = ref(false);
const error = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

const canSubmit = computed(
  () => Boolean(prompt.value.trim() || attachments.value.length) && !creating.value && !reading.value,
);

const textExtensions = [
  "md", "markdown", "txt", "text", "csv", "json", "yaml", "yml", "xml",
  "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "java", "sql", "log",
];

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    prompt.value = props.initialPrompt || "";
    attachments.value = [];
    error.value = "";
    if (fileInput.value) fileInput.value.value = "";
  },
);

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() || "";
}

function chooseFiles() {
  fileInput.value?.click();
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (!files.length) return;
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
      const text = await file.text();
      if (!text.trim()) continue;
      if (attachments.value.some((item) => item.name === file.name)) continue;
      attachments.value.push({ name: file.name, text });
    }
  } finally {
    reading.value = false;
    input.value = "";
  }
}

function removeAttachment(index: number) {
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
          <h3 id="agent-title">主控 Agent · 开始一个新任务</h3>
          <p>描述要开发的软件；有现成开发文档就一起传上来。提交后会创建一条新的真实运行。</p>
        </div>
        <button type="button" class="tc-close" aria-label="关闭" @click="close">×</button>
      </header>

      <label class="agent-label" for="agent-prompt">想开发什么</label>
      <textarea
        id="agent-prompt"
        v-model="prompt"
        rows="6"
        placeholder="例如：做一个团队任务看板，支持拖拽换列，刷新后数据还在。"
      ></textarea>

      <div class="agent-attach">
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
        <span class="agent-hint">支持文本/代码文档，最多 512KB / 个</span>
      </div>

      <ul v-if="attachments.length" class="agent-files">
        <li v-for="(file, index) in attachments" :key="file.name">
          <span>{{ file.name }}</span>
          <small>{{ file.text.length }} 字符</small>
          <button type="button" @click="removeAttachment(index)">移除</button>
        </li>
      </ul>

      <p v-if="error" class="agent-error">{{ error }}</p>

      <footer>
        <button type="button" class="btn btn-sm btn-ghost" :disabled="creating" @click="close">取消</button>
        <button type="button" class="btn btn-sm btn-primary" :disabled="!canSubmit" @click="submit">
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
.agent-attach {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.agent-hint {
  font-size: 11.5px;
  color: var(--text-3);
}
.agent-files {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
}
.agent-files li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 12.5px;
  border-top: 1px solid var(--line);
}
.agent-files li:first-child {
  border-top: 0;
}
.agent-files small {
  color: var(--text-3);
}
.agent-files button {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #dc2626;
  font: inherit;
  cursor: pointer;
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