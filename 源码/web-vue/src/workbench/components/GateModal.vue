<script setup lang="ts"></script>

<template>
  <div class="gate-modal" id="gate-modal" hidden>
    <div class="gate-card">
      <h4 class="gate-title">需要你确认</h4>
      <div class="gate-body"></div>
      <div class="gate-actions">
        <button type="button" class="btn btn-sm btn-ghost" id="gate-skip">按默认继续</button>
        <button type="button" class="btn btn-sm btn-primary" id="gate-submit">提交</button>
      </div>
    </div>
  </div>
</template>