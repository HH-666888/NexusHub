<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{ goal: string }>();
const emit = defineEmits<{ save: [goal: string] }>();

const goalText = ref(props.goal);

watch(
  () => props.goal,
  (value) => {
    goalText.value = value;
  },
);

function save() {
  emit("save", goalText.value);
}
</script>

<template>
  <div class="plan-box">
    <label style="font-size: 12.5px; color: var(--text-2);">这个软件要解决什么？写给谁？做到什么算完成？</label>
    <textarea
      id="goal-text"
      v-model="goalText"
      placeholder="例如：做一个团队任务看板，支持拖拽换列，刷新后数据还在。"
    ></textarea>
    <div style="display: flex; gap: 8px;">
      <button class="btn btn-primary btn-sm" type="button" id="save-goal" @click="save">保存需求</button>
      <span class="code-hint">保存后，右侧可以问 AI「需求还缺什么」。</span>
    </div>
  </div>
</template>