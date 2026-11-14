<script setup lang="ts">
import { ref } from "vue";
import type { AssistTest } from "../../types/api";

const props = defineProps<{
  tests: AssistTest[];
  loaded: boolean;
}>();

const emit = defineEmits<{
  add: [title: string, expected: string];
  update: [id: string, status: string];
  remove: [id: string];
}>();

const title = ref("");
const expected = ref("");

function statusText(status: string) {
  return status === "pass" ? "通过" : status === "fail" ? "失败" : "待测";
}

function add() {
  const value = title.value.trim();
  if (!value) return;
  emit("add", value, expected.value.trim());
  title.value = "";
  expected.value = "";
}
</script>

<template>
  <section v-if="loaded" class="stage-extra">
    <div class="extra-head"><b>测试用例</b><span>{{ tests.length }} 条</span></div>
    <div class="extra-body">
      <form class="test-form" id="test-form" @submit.prevent="add">
        <input
          id="test-title"
          v-model="title"
          placeholder="用例标题，例如：新增待办后出现在列表"
          maxlength="200"
        />
        <input id="test-expected" v-model="expected" placeholder="预期结果" maxlength="200" />
        <button class="btn btn-sm btn-primary" type="submit">添加</button>
      </form>
      <div class="test-list" id="test-list">
        <div v-if="!tests.length" class="extra-empty">还没有测试用例。先写一条，再标记通过或失败。</div>
        <div v-for="item in tests" :key="item.id" class="test-row">
          <div class="test-main">
            <b>{{ item.title }}</b>
            <small v-if="item.expected">预期：{{ item.expected }}</small>
          </div>
          <span class="test-status" :class="item.status">{{ statusText(item.status) }}</span>
          <div class="test-acts">
            <button type="button" data-status="pass" @click="emit('update', item.id, 'pass')">通过</button>
            <button type="button" data-status="fail" @click="emit('update', item.id, 'fail')">失败</button>
            <button type="button" data-del @click="emit('remove', item.id)">删除</button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>