<script setup lang="ts">
import { reactive, watch } from "vue";
import { workbenchStore } from "../useWorkbenchStore";
import type { GateQuestion } from "../useWorkbenchStore";

const store = workbenchStore;
const answers = reactive<Record<string, string | string[]>>({});

function resetAnswers() {
  for (const question of store.gate.questions) {
    answers[question.id] = question.type === "multi" ? [] : question.default || "";
  }
}

watch(
  () => store.gate.visible,
  (visible) => {
    if (visible) resetAnswers();
  },
  { immediate: true },
);

async function submit(auto: boolean) {
  const runId = new URLSearchParams(location.search).get("run") || "";
  const payload = store.gate.questions.map((question: GateQuestion) => {
    if (question.type === "multi") {
      const selected = answers[question.id];
      const value = Array.isArray(selected) ? selected.join(",") : "";
      return { id: question.id, value: value || question.default || "" };
    }
    const value = answers[question.id];
    return {
      id: question.id,
      value: (Array.isArray(value) ? value[0] : value) || question.default || "",
    };
  });
  await window.api?.answerGate(runId, {
    round: store.gate.round,
    answers: payload,
    auto,
  });
  store.hideGate();
}
</script>

<template>
  <div class="gate-modal" id="gate-modal" :hidden="!store.gate.visible">
    <div class="gate-card">
      <h4 class="gate-title">{{ store.gate.title }}</h4>
      <div class="gate-body">
        <div v-for="(question, index) in store.gate.questions" :key="question.id" class="gate-q">
          <p>{{ index + 1 }}. {{ question.text }}</p>
          <div class="gate-opts">
            <input
              v-if="question.type === 'text'"
              class="gate-text"
              :name="question.id"
              :placeholder="question.default || ''"
              v-model="answers[question.id]"
            />
            <template v-else-if="question.type === 'multi'">
              <label v-for="option in question.options || []" :key="option">
                <input
                  type="checkbox"
                  :name="question.id"
                  :value="option"
                  v-model="answers[question.id]"
                />
                {{ option }}
              </label>
            </template>
            <template v-else>
              <label v-for="option in question.options || []" :key="option">
                <input
                  type="radio"
                  :name="question.id"
                  :value="option"
                  v-model="answers[question.id]"
                />
                {{ option }}
              </label>
            </template>
          </div>
        </div>
      </div>
      <div class="gate-actions">
        <button type="button" class="btn btn-sm btn-ghost" id="gate-skip" @click="submit(true)">
          按默认继续
        </button>
        <button type="button" class="btn btn-sm btn-primary" id="gate-submit" @click="submit(false)">
          提交
        </button>
      </div>
    </div>
  </div>
</template>