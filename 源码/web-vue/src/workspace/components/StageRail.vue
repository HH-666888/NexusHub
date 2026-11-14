<script setup lang="ts">
import type { AssistStage } from "../../types/api";

const props = defineProps<{
  stages: AssistStage[];
  current: string;
}>();

const emit = defineEmits<{ select: [id: string] }>();

function stageClass(stage: AssistStage, index: number) {
  const currentIndex = props.stages.findIndex((item) => item.id === props.current);
  return (
    "stage-item" +
    (stage.id === props.current ? " is-on" : "") +
    (index < currentIndex ? " is-done" : "") +
    (index > currentIndex ? " is-wait" : "")
  );
}
</script>

<template>
  <aside class="stage-rail" id="rail">
    <div class="rail-title">六道工序</div>
    <button
      v-for="(stage, index) in stages"
      :key="stage.id"
      type="button"
      :class="stageClass(stage, index)"
      @click="emit('select', stage.id)"
    ><span class="no">0{{ index + 1 }}</span><span>{{ stage.label }}</span></button>
  </aside>
</template>