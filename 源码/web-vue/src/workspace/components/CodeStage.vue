<script setup lang="ts">
import { ref } from "vue";
import type { AssistProjectFile } from "../../types/api";
import CodeEditor from "./CodeEditor.vue";

defineProps<{
  files: AssistProjectFile[];
  currentPath: string;
  modelValue: string;
  hint: string;
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
</script>

<template>
  <div class="file-bar">
    <div class="file-tabs" id="file-tabs">
      <button
        v-for="file in files"
        :key="file.path"
        type="button"
        :data-path="file.path"
        :class="{ 'is-on': file.path === currentPath }"
        @click="emit('select', file.path)"
      >{{ file.path }}</button>
    </div>
    <span class="grow" style="flex: 1;"></span>
    <input
      v-model="newPath"
      type="text"
      id="new-path"
      placeholder="新文件，如 app.py"
      @keydown.enter.prevent="add"
    />
    <button class="btn btn-sm btn-ghost" type="button" id="add-file" @click="add">新建</button>
    <button class="btn btn-sm btn-primary" type="button" id="save-file" @click="emit('save')">保存</button>
    <button class="btn btn-sm btn-ghost" type="button" id="del-file" @click="emit('remove')">删除</button>
    <button class="btn btn-sm btn-ghost" type="button" id="analyze" @click="emit('analyze')">检查</button>
  </div>
  <CodeEditor
    :model-value="modelValue"
    :path="currentPath"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <p class="code-hint" id="editor-hint">{{ hint }}</p>
</template>