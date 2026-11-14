<script setup lang="ts">
import type { AssistFinding } from "../../types/api";

defineProps<{ findings: AssistFinding[] }>();
const emit = defineEmits<{ update: [id: string, status: string] }>();
</script>

<template>
  <section class="side-block">
    <div class="side-head">检查结果 <span class="count" id="finding-count">{{ findings.length }}</span></div>
    <div class="findings-list" id="findings">
      <div v-if="!findings.length" class="findings-empty">
        还没有检查结果。<br />写好文件后点“检查”。
      </div>
      <div v-for="item in findings" :key="item.id" class="finding">
        <div><span class="badge" :class="item.severity"></span>{{ item.message }}</div>
        <div class="where">{{ item.path }}:{{ item.line }} · {{ item.stageLabel }}</div>
        <div class="acts">
          <button type="button" data-act="fixed" @click="emit('update', item.id, 'fixed')">已修</button>
          <button type="button" data-act="ignored" @click="emit('update', item.id, 'ignored')">忽略</button>
        </div>
      </div>
    </div>
  </section>
</template>