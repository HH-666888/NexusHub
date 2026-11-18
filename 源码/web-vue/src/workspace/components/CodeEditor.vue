<script setup lang="ts">
import { onMounted, ref, watch } from "vue";

const props = defineProps<{
  modelValue: string;
  path: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const area = ref<HTMLTextAreaElement | null>(null);
let editor: CodeMirrorEditor | null = null;
let applying = false;

function modeFor(path: string) {
  if (/\.py$/.test(path)) return "python";
  if (/\.java$/.test(path)) return "text/x-java";
  if (/\.js$/.test(path)) return "javascript";
  if (/\.html?$/.test(path)) return "xml";
  if (/\.css$/.test(path)) return "css";
  if (/\.sql$/.test(path)) return "text/x-sql";
  return null;
}

onMounted(() => {
  if (!area.value || !window.CodeMirror) return;
  editor = window.CodeMirror.fromTextArea(area.value, {
    mode: modeFor(props.path),
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    lineWrapping: false,
  });
  editor.setSize(null, "100%");
  editor.on("change", () => {
    if (!editor || applying) return;
    emit("update:modelValue", editor.getValue());
  });
});

watch(
  () => props.modelValue,
  (value) => {
    if (!editor || editor.getValue() === value) return;
    applying = true;
    editor.setValue(value);
    applying = false;
  },
);

watch(
  () => props.path,
  (path) => {
    editor?.setOption("mode", modeFor(path));
  },
);
</script>

<template>
  <textarea
    id="code"
    ref="area"
    class="code-editor"
    spellcheck="false"
    placeholder="在这里写代码；保存后可以点“检查”。"
    :value="modelValue"
  ></textarea>
</template>