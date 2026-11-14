<script setup lang="ts"></script>

<template>
  <aside class="tasks">
    <div class="tasks-head">
      <h2>任务清单 <span class="pill pill-plain" style="font-weight: 500; font-size: 11px; padding: 1px 8px;">0 项</span></h2>
      <p>主控一边分析一边往下派活</p>
      <div class="stage-progress">
        <div class="label"><span>等待开始</span><span id="pct">0%</span></div>
        <div class="bar"><i id="bar" style="width: 0%"></i></div>
      </div>
    </div>

    <div class="task-list" id="task-list">
      <div class="t-group">
        <button type="button" class="t-item t-master" id="t-master">
          <span class="no">L1</span>
          <span class="name">主控 Agent</span>
          <span class="state">待命</span>
          <span class="chev">▾</span>
        </button>
      </div>
      <div class="t-group" id="stage-groups"></div>
    </div>

    <div class="evidence" id="evidence" hidden>
      <div class="evidence-head">参考依据 <span id="evidence-count">0</span></div>
      <div class="evidence-list" id="evidence-list"></div>
    </div>
  </aside>
</template>