<script setup lang="ts">
import { computed } from "vue";
import { workbenchStore } from "../useWorkbenchStore";

const store = workbenchStore;
const costText = computed(() => "本轮 ¥" + Number(store.cost || 0).toFixed(2) + " · " + store.calls + " 次模型调用");
</script>

<template>
  <div class="statusbar">
    <div class="tabs">
      <button class="is-on" type="button">事件</button>
      <button type="button">终端</button>
      <button type="button">验收</button>
    </div>
    <span class="line-text" id="event-line">{{ store.eventLine }}</span>
    <span class="cost">{{ costText }}</span>
  </div>
</template>