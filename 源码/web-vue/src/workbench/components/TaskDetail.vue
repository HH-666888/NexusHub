<script setup lang="ts">
import { workbenchStore } from "../useWorkbenchStore";
import { showFile } from "../workbenchModel";

const store = workbenchStore;

function close() {
  store.hideTaskDetail();
}

function openFile() {
  if (store.taskDetail.openFile) showFile(store.taskDetail.openFile);
}
</script>

<template>
  <aside class="task-card" id="task-card" :hidden="!store.taskDetail.visible">
    <header>
      <span class="tc-stage" id="tc-stage">{{ store.taskDetail.stage }}</span>
      <button type="button" class="tc-close" id="tc-close" aria-label="关闭" @click="close">×</button>
    </header>
    <h4 id="tc-title">{{ store.taskDetail.title }}</h4>
    <dl>
      <div><dt>状态</dt><dd id="tc-state" :class="store.taskDetail.stateClass">{{ store.taskDetail.state }}</dd></div>
      <div><dt>耗时</dt><dd id="tc-ms">{{ store.taskDetail.ms }}</dd></div>
      <div><dt>产物</dt><dd id="tc-file">{{ store.taskDetail.file }}</dd></div>
    </dl>
    <p class="tc-note" id="tc-note">{{ store.taskDetail.note }}</p>
    <button
      v-if="store.taskDetail.openFile"
      type="button"
      class="btn btn-sm btn-ghost"
      id="tc-open"
      @click="openFile"
    >
      看这个文件
    </button>
  </aside>
</template>