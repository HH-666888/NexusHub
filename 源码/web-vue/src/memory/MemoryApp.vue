<script setup>
import { onMounted, ref } from "vue";

const api = window.api;
const stats = ref(null);
const statsError = ref("");
const groups = ref([]);
const cache = ref(null);

function fmtTime(ms) {
  if (!ms) return "—";
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getMonth() +
    1 +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

async function load() {
  if (!api || !api.memory) {
    statsError.value = "加载失败，请刷新重试。";
    return;
  }
  const data = await api.memory(60);
  if (!data) {
    statsError.value = "加载失败，请刷新重试。";
    return;
  }
  cache.value = data;
  stats.value = data.stats;
  statsError.value = "";
  groups.value = data.groups || [];
}

async function togglePin(entry) {
  await api.updateMemory(entry.id, !entry.pinned);
  await load();
}

async function remove(entry) {
  if (!confirm("删除这条记忆？")) return;
  await api.deleteMemory(entry.id);
  await load();
}

function exportMemory() {
  if (!cache.value) return;
  const blob = new Blob([JSON.stringify(cache.value, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "nexushub-memory.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

async function clearAll() {
  if (!confirm("清空全部 AI 记忆？此操作不可恢复。")) return;
  await api.clearMemory();
  await load();
}

onMounted(load);
</script>

<template>
  <div class="head" style="display: flex; align-items: center; gap: 10px; margin: 0 0 16px;">
    <h1 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">AI 记忆</h1>
    <span class="grow" style="flex: 1;"></span>
    <button class="btn btn-sm btn-ghost" type="button" id="export" @click="exportMemory">导出</button>
    <button class="btn btn-sm btn-ghost" type="button" id="clear" @click="clearAll">清空</button>
  </div>

  <div class="memory-stats" id="stats">
    <template v-if="stats">
      共 <b>{{ stats.total }}</b> 条 · 今日 <b>{{ stats.today }}/{{ stats.dailyLimit }}</b> · 近 7 天
      <b>{{ stats.week }}</b> 条 · 最近一次 {{ stats.lastAt ? fmtTime(stats.lastAt) : "—" }}
    </template>
    <template v-else>{{ statsError || "正在读取…" }}</template>
  </div>

  <section id="groups">
    <div v-if="!groups.length" class="memory-empty">
      还没有记忆。<br />在辅助开发里推进阶段，AI 会自己判断记什么。
    </div>

    <template v-else>
      <div v-for="group in groups" :key="group.day" class="memory-group">
        <h3 class="memory-day">{{ group.day }} · {{ group.entries.length }} 条</h3>
        <article v-for="entry in group.entries" :key="entry.id" class="memory-card">
          <h4>{{ entry.pinned ? "📌 " : "" }}{{ entry.title }}</h4>
          <p>{{ entry.body }}</p>
          <div class="why">
            因为：{{ entry.reason || "AI 自己判断" }} · 来源：{{ entry.sourceType }} · 置信度：{{
              entry.confidence
            }} · {{ fmtTime(entry.createdAt) }}
          </div>
          <div class="acts">
            <button type="button" data-act="pin" @click="togglePin(entry)">
              {{ entry.pinned ? "取消置顶" : "置顶" }}
            </button>
            <button type="button" data-act="del" @click="remove(entry)">删除</button>
          </div>
        </article>
      </div>
    </template>
  </section>
</template>