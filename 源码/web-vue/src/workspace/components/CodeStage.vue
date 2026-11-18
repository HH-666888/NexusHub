<script setup lang="ts">
import { computed, ref } from "vue";
import type { AssistProjectFile } from "../../types/api";
import CodeEditor from "./CodeEditor.vue";

const props = defineProps<{
  files: AssistProjectFile[];
  currentPath: string;
  modelValue: string;
  hint: string;
  dirty: boolean;
  analyzing: boolean;
}>();

const emit = defineEmits<{
  select: [path: string];
  "update:modelValue": [value: string];
  add: [path: string];
  save: [];
  remove: [];
  analyze: [];
}>();

const newPath = ref("");

function add() {
  const path = newPath.value.trim();
  if (!path) return;
  emit("add", path);
  newPath.value = "";
}

function baseName(path: string) {
  return path.split("/").pop() || path;
}

function dirName(path: string) {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function langOf(path: string) {
  if (/\.py$/.test(path)) return "py";
  if (/\.ts$/.test(path)) return "ts";
  if (/\.js$/.test(path)) return "js";
  if (/\.html?$/.test(path)) return "html";
  if (/\.css$/.test(path)) return "css";
  if (/\.sql$/.test(path)) return "sql";
  if (/\.json$/.test(path)) return "json";
  return "txt";
}

function langLabel(path: string) {
  const map: Record<string, string> = {
    py: "Python",
    ts: "TypeScript",
    js: "JavaScript",
    html: "HTML",
    css: "CSS",
    sql: "SQL",
    json: "JSON",
    txt: "Text",
  };
  return map[langOf(path)] || "Text";
}

function langIcon(path: string) {
  const icons: Record<string, string> = {
    py: "Py",
    ts: "TS",
    js: "JS",
    html: "<>",
    css: "#",
    sql: "DB",
    json: "{}",
    txt: "·",
  };
  return icons[langOf(path)] || "·";
}

function sizeText(bytes?: number) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  return (bytes / 1024).toFixed(1) + " KB";
}

const fileGroups = computed(() => {
  const map = new Map<string, AssistProjectFile[]>();
  for (const file of props.files) {
    const dir = dirName(file.path);
    const list = map.get(dir);
    if (list) list.push(file);
    else map.set(dir, [file]);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] === "" ? -1 : b[0] === "" ? 1 : a[0].localeCompare(b[0])))
    .map(([name, files]) => ({ name, files: files.sort((a, b) => a.path.localeCompare(b.path)) }));
});

const lineCount = computed(() => (props.modelValue ? props.modelValue.split("\n").length : 0));
const charCount = computed(() => props.modelValue.length);

const symbols = computed(() => {
  const list: { kind: string; name: string; line: number }[] = [];
  const lines = props.modelValue.split("\n");
  for (let i = 0; i < lines.length && list.length < 9; i += 1) {
    const line = lines[i];
    let match = /^\s*(?:async\s+)?def\s+(\w+)/.exec(line);
    if (match) {
      list.push({ kind: "def", name: match[1], line: i + 1 });
      continue;
    }
    match = /^\s*class\s+(\w+)/.exec(line);
    if (match) {
      list.push({ kind: "class", name: match[1], line: i + 1 });
      continue;
    }
    match = /^\s*@app\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)/.exec(line);
    if (match) {
      list.push({ kind: "route", name: `${match[1].toUpperCase()} ${match[2]}`, line: i + 1 });
      continue;
    }
    match = /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/.exec(line);
    if (match) {
      list.push({ kind: "var", name: match[1], line: i + 1 });
    }
  }
  return list;
});

const miniLines = computed(() => {
  return props.modelValue
    .split("\n")
    .slice(0, 140)
    .map((line) => {
      const text = line.trim();
      const indent = line.length - line.trimStart().length;
      const width = text ? Math.max(8, Math.min(100, text.length * 2.1 - indent * 1.2)) : 3;
      let tone = "plain";
      if (/^(def|class|async def|function)\b/.test(text)) tone = "hot";
      else if (/^@app\./.test(text)) tone = "route";
      else if (/^#|^\/\//.test(text)) tone = "dim";
      return { width, tone, key: line.slice(0, 12) + text.length };
    });
});
</script>

<template>
  <div class="code-ide">
    <aside class="ide-tree">
      <div class="ide-tree-head">
        <span>项目文件</span>
        <small>{{ files.length }}</small>
      </div>
      <div class="ide-tree-scroll" id="file-tabs">
        <div v-for="group in fileGroups" :key="group.name || '__root'" class="ide-group">
          <div class="ide-group-label">{{ group.name || "根目录" }}</div>
          <button
            v-for="file in group.files"
            :key="file.path"
            type="button"
            class="ide-file"
            :class="{ 'is-on': file.path === currentPath }"
            :data-path="file.path"
            @click="emit('select', file.path)"
          >
            <span class="ficon" :data-lang="langOf(file.path)">{{ langIcon(file.path) }}</span>
            <span class="fname">{{ baseName(file.path) }}</span>
            <span class="fmeta">{{ sizeText(file.bytes) }}</span>
          </button>
        </div>
        <div v-if="!files.length" class="ide-tree-empty">还没有文件，新建第一个。</div>
        <div v-if="symbols.length" class="ide-symbols">
          <div class="ide-group-label">结构</div>
          <div v-for="item in symbols" :key="item.line + item.name" class="ide-symbol">
            <span class="sk" :data-kind="item.kind">{{ item.kind }}</span>
            <span class="sn">{{ item.name }}</span>
            <span class="sl">{{ item.line }}</span>
          </div>
        </div>
      </div>
      <div class="ide-new">
        <input
          v-model="newPath"
          type="text"
          id="new-path"
          placeholder="新文件，如 api/main.py"
          @keydown.enter.prevent="add"
        />
        <button class="btn btn-sm btn-ghost" type="button" id="add-file" @click="add">新建</button>
      </div>
    </aside>

    <section class="ide-main">
      <div class="ide-top">
        <div class="ide-crumb">
          <span class="crumb-dir">{{ dirName(currentPath) || "项目" }}</span>
          <span class="crumb-sep">/</span>
          <b>{{ currentPath ? baseName(currentPath) : "未选择文件" }}</b>
        </div>
        <div class="ide-meta">
          <span class="lang-pill">{{ langLabel(currentPath) }}</span>
          <span>{{ lineCount }} 行</span>
          <span class="save-dot" :class="{ dirty }">{{ dirty ? "未保存" : "已保存" }}</span>
        </div>
        <div class="ide-actions">
          <button class="btn btn-sm btn-ghost" type="button" id="del-file" @click="emit('remove')">删除</button>
          <button class="btn btn-sm btn-ghost" type="button" id="save-file" @click="emit('save')">保存</button>
          <button
            class="btn btn-sm btn-primary ide-ai-btn"
            :class="{ 'is-running': analyzing }"
            type="button"
            id="analyze"
            @click="emit('analyze')"
          >
            <span class="ai-spark"></span>
            {{ analyzing ? "审查中" : "AI 审查" }}
          </button>
        </div>
      </div>

      <div class="ide-editor">
        <CodeEditor
          :model-value="modelValue"
          :path="currentPath"
          @update:model-value="emit('update:modelValue', $event)"
        />
        <div v-if="analyzing" class="ai-scan">
          <div class="scan-beam"></div>
          <div class="scan-pill">AI 正在审查 · 命名 / 异常 / 边界</div>
        </div>
        <div class="ide-minimap" aria-hidden>
          <i v-for="line in miniLines" :key="line.key" :class="line.tone" :style="{ width: line.width + '%' }"></i>
        </div>
        <div class="ide-ai-dock" :class="{ running: analyzing }">
          <span class="dock-orb"></span>
          <div class="dock-txt">
            <b>{{ analyzing ? "AI 正在扫描代码" : "AI 已索引项目上下文" }}</b>
            <small>{{ files.length }} 个文件 · {{ lineCount }} 行 · {{ symbols.length }} 个结构</small>
          </div>
          <span class="dock-state">{{ analyzing ? "SCANNING" : "READY" }}</span>
        </div>
      </div>

      <div class="ide-status">
        <span class="status-live" :class="{ dirty }"></span>
        <span>{{ currentPath ? "工作区已连接" : "等待选择文件" }}</span>
        <span class="status-hint" id="editor-hint">{{ hint }}</span>
        <span class="grow"></span>
        <span>{{ lineCount }} 行 · {{ charCount }} 字符</span>
      </div>
    </section>
  </div>
</template>
