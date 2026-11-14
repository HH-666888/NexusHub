<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { CoachMessage } from "../useWorkspace";

const props = defineProps<{
  messages: CoachMessage[];
  image: string;
  imageName: string;
  citeCount: string;
}>();

const emit = defineEmits<{
  send: [text: string];
  "image-change": [data: string, name: string];
  "image-clear": [];
  apply: [text: string];
  undo: [message: CoachMessage];
}>();

const draft = ref("");
const log = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function send() {
  const text = draft.value.trim();
  draft.value = "";
  emit("send", text);
}

function pickImage() {
  fileInput.value?.click();
}

function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
    alert("只支持 png / jpeg / webp / gif 图片");
    input.value = "";
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    alert("图片请压缩到 4MB 以内");
    input.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    emit("image-change", String(reader.result || ""), file.name);
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  if (fileInput.value) fileInput.value.value = "";
  emit("image-clear");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

async function scrollToBottom() {
  await nextTick();
  if (log.value) log.value.scrollTop = log.value.scrollHeight;
}

watch(
  () => props.messages,
  () => {
    void scrollToBottom();
  },
  { deep: true },
);
</script>

<template>
  <section class="side-block coach">
    <div class="side-head">AI 助手 <span class="count" id="cite-count">{{ citeCount }}</span></div>
    <div class="coach-log" id="coach-log" ref="log">
      <div class="coach-msg ai">我会按当前阶段帮你：需求阶段问清楚，写代码时只看不改。</div>
      <div
        v-for="message in messages"
        :key="message.id"
        class="coach-msg"
        :class="[message.kind, { streaming: message.streaming }]"
      >
        <template v-if="message.text">{{ message.text }}</template>
        <div v-if="message.tools && message.tools.length" class="tool-traces">
          <div v-for="tool in message.tools" :key="tool.name + tool.ms" class="tool-call">
            <b>🔧 {{ tool.name }}</b>
            <small>{{ JSON.stringify(tool.arguments || {}) }} · {{ tool.ms }}ms</small>
            <div class="tool-result">{{ tool.result || "" }}</div>
          </div>
        </div>
        <div v-if="message.answer" class="agent-answer">{{ message.answer }}</div>
        <span v-if="message.citations && message.citations.length" class="cite">
          参考了 {{ message.citations.length }} 条记忆：{{
            message.citations.map((item) => item.title).join("、")
          }}
        </span>
        <button
          v-if="message.suggestApply"
          class="btn btn-sm btn-ghost"
          type="button"
          style="margin-top: 6px;"
          @click="emit('apply', message.text)"
        >
          按这条建议改代码
        </button>
        <button
          v-if="message.undo"
          class="btn btn-sm btn-ghost"
          type="button"
          style="margin-top: 6px;"
          @click="emit('undo', message)"
        >
          撤销这次修改
        </button>
      </div>
    </div>
    <div class="coach-form">
      <div class="coach-attach">
        <input
          id="coach-image-input"
          ref="fileInput"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          @change="onFile"
        />
        <button class="btn btn-sm btn-ghost" type="button" id="coach-image-btn" @click="pickImage">＋ 图片</button>
        <span id="coach-image-name">{{ imageName }}</span>
        <button
          v-if="image"
          class="coach-image-clear"
          type="button"
          id="coach-image-clear"
          @click="clearImage"
        >
          ×
        </button>
      </div>
      <img v-if="image" id="coach-image-preview" :src="image" alt="" />
      <textarea
        id="coach-input"
        v-model="draft"
        placeholder="问点什么，或直接说“下一步做什么”"
        @keydown="onKeydown"
      ></textarea>
      <button class="btn btn-primary btn-sm" type="button" id="coach-send" @click="send">发送</button>
    </div>
  </section>
</template>