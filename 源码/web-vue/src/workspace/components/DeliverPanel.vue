<script setup lang="ts">
import type { Deliverable } from "../../types/api";

defineProps<{
  data: Deliverable | null;
  loaded: boolean;
}>();
</script>

<template>
  <section v-if="loaded" class="stage-extra">
    <div class="extra-head">
      <b>交付检查</b>
      <span>{{ data ? data.passed + "/" + data.total + " 通过" : "—" }}</span>
    </div>
    <div class="extra-body">
      <div v-if="!data" class="extra-empty">检查结果暂时读不到。</div>
      <div v-else class="deliver-list">
        <div
          v-for="item in data.checks"
          :key="item.name"
          class="deliver-row"
          :class="item.pass ? 'pass' : 'fail'"
        >
          <b>{{ item.pass ? "✓" : "✗" }}</b>
          <span>{{ item.name }}</span>
          <small>{{ item.detail }}</small>
        </div>
      </div>
    </div>
  </section>
</template>