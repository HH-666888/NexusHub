<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { workbenchStore } from "../useWorkbenchStore";
import { highlight } from "../highlight";

const store = workbenchStore;
const body = ref<HTMLElement | null>(null);

const activeFile = computed(() => store.files.find((file) => file.path === store.activePath) || null);
const streaming = computed(() => Boolean(activeFile.value && activeFile.value.state === "live"));

function activeLines() {
  return store.files.find((file) => file.path === store.activePath)?.lines || [];
}

function baseName(path: string) {
  return path.split("/").pop() || path;
}

function tabMark(path: string) {
  const file = store.files.find((item) => item.path === path);
  if (store.livePath === path) return "写入中";
  return file?.state === "done" ? "✓" : "待生成";
}

function openFile(path: string) {
  window.__wb?.showFile(path);
}

async function scrollToBottom() {
  await nextTick();
  if (body.value) body.value.scrollTop = body.value.scrollHeight;
}

watch(
  () => activeFile.value?.lines.length,
  () => {
    void scrollToBottom();
  },
);
</script>

<template>
  <aside class="code-pane" id="code-pane">
    <div class="code-head">
      <div class="tabs">
        <button class="is-on" type="button">代码</button>
        <button type="button">预览</button>
        <button type="button">验收</button>
      </div>
      <span class="spacer"></span>
      <button class="icon-btn" type="button" id="hide-code" aria-label="隐藏代码面板">
        <svg viewBox="0 0 24 24" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
      </button>
    </div>

    <div class="file-tabs" id="file-tabs" role="tablist" aria-label="已生成的文件">
      <button
        v-for="file in store.files"
        :key="file.path"
        type="button"
        :class="{
          'is-on': store.activePath === file.path,
          done: file.state === 'done',
          live: store.livePath === file.path,
        }"
        :data-path="file.path"
        @click="openFile(file.path)"
      >
        {{ baseName(file.path) }}<i>{{ tabMark(file.path) }}</i>
      </button>
    </div>

    <div class="code-file">
      <span class="dot" id="file-dot" :style="{ background: store.dotWarn ? 'var(--warn)' : 'var(--ok)' }"></span>
      <span id="file-name">{{ store.activePath || "—" }}</span>
      <span class="grow"></span>
      <span class="stream" id="stream-state">
        <template v-if="activeFile">
          {{ streaming ? "流式写入" : "已生成" }} · <b id="line-count">{{ activeFile.lines.length }}</b> 行
        </template>
        <template v-else>等待文件事件<b id="line-count" hidden>0</b></template>
      </span>
    </div>

    <div class="review-bar" id="review-bar" :class="{ 'is-on': store.reviewMode }">
      <span id="review-text">{{ store.reviewText }}</span>
      <button type="button" id="replay-file">重播这次生成</button>
      <button type="button" id="back-live">回到实时</button>
    </div>

    <div class="code-body" id="code-body" ref="body">
      <div v-for="(line, index) in activeLines()" :key="index" class="code-line">
        <span class="ln">{{ index + 1 }}</span>
        <pre v-html="highlight(line)"></pre>
      </div>
    </div>
  </aside>
</template>