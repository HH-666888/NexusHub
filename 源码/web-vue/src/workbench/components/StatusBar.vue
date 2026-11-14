<script setup lang="ts"></script>

<template>
  <div class="statusbar">
    <div class="tabs">
      <button class="is-on" type="button">事件</button>
      <button type="button">终端</button>
      <button type="button">验收</button>
    </div>
    <span class="line-text" id="event-line">等待事件…</span>
    <span class="cost">本轮 ¥0.00 · 0 次模型调用</span>
  </div>
</template>