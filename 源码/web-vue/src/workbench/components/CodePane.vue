<script setup lang="ts"></script>

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

    <div class="file-tabs" id="file-tabs" role="tablist" aria-label="已生成的文件"></div>

    <div class="code-file">
      <span class="dot" id="file-dot"></span>
      <span id="file-name">—</span>
      <span class="grow"></span>
      <span class="stream" id="stream-state">等待文件事件<b id="line-count" hidden>0</b></span>
    </div>

    <div class="review-bar" id="review-bar">
      <span id="review-text">回看 · 这个文件已经写完了</span>
      <button type="button" id="replay-file">重播这次生成</button>
      <button type="button" id="back-live">回到实时</button>
    </div>

    <div class="code-body" id="code-body"></div>
  </aside>
</template>