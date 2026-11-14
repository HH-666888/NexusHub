<script setup lang="ts"></script>

<template>
  <aside class="task-card" id="task-card" hidden>
    <header>
      <span class="tc-stage" id="tc-stage">第 — 道</span>
      <button type="button" class="tc-close" id="tc-close" aria-label="关闭">×</button>
    </header>
    <h4 id="tc-title">任务</h4>
    <dl>
      <div><dt>状态</dt><dd id="tc-state">—</dd></div>
      <div><dt>耗时</dt><dd id="tc-ms">—</dd></div>
      <div><dt>产物</dt><dd id="tc-file">—</dd></div>
    </dl>
    <p class="tc-note" id="tc-note"></p>
    <button type="button" class="btn btn-sm btn-ghost" id="tc-open" hidden>看这个文件</button>
  </aside>
</template>