<script setup lang="ts"></script>

<template>
  <main class="canvas" id="canvas">
    <div class="canvas-head">
      <h3>工作流树</h3>
      <span class="hint">一级主控 → 六道工序 → 按需分析出的任务</span>
      <span class="spacer"></span>
      <div class="layout-switch" role="group" aria-label="连线样式">
        <button type="button" data-edges="curve" class="is-on">曲线</button>
        <button type="button" data-edges="elbow">折线</button>
      </div>
      <div class="layout-switch" role="group" aria-label="树的排布">
        <button type="button" data-layout="lr" class="is-on">左右树</button>
        <button type="button" data-layout="td">上下树</button>
      </div>
      <button class="btn btn-sm btn-ghost show-tasks" type="button" id="show-tasks">
        <svg viewBox="0 0 24 24" aria-hidden style="width: 14px; height: 14px;"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
        显示清单
      </button>
      <button class="btn btn-sm btn-ghost show-code" type="button" id="show-code">显示代码</button>
      <div class="speed-pop" id="speed-pop">
        <button type="button" class="speed-btn" id="speed-btn" title="播放速度（1 是真实速度）">1×</button>
        <div class="speed-menu" id="speed-menu">
          <div class="speed-row">
            <span>0.1×</span>
            <input type="range" id="speed" min="0.1" max="1" step="0.1" value="1" />
            <span>1×</span>
          </div>
          <p>只影响呈现，不影响后端与花费</p>
        </div>
      </div>
      <button class="btn btn-sm btn-ghost" type="button" id="replay">
        <svg viewBox="0 0 24 24" aria-hidden style="width: 14px; height: 14px;"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
        重播生成
      </button>
    </div>

    <div class="focus-bar" id="focus-bar">
      聚焦：<b id="focus-name">—</b>
      <span id="focus-note">其余工序在后台继续</span>
      <button type="button" id="exit-focus">退出聚焦</button>
    </div>

    <div class="canvas-inner" id="canvas-inner">
      <svg class="tree-svg" id="tree-svg" aria-hidden></svg>
      <!-- 节点由脚本插入，便于做逐个出现 -->
    </div>
  </main>
</template>