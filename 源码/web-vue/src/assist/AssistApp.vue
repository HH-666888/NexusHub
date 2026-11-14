<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { AssistProject, AssistProjectList } from "../types/api";

const api = window.api;
const goal = ref("");
const projects = ref<AssistProject[]>([]);
const error = ref("");
const creating = ref(false);

function open(project: AssistProject) {
  location.href = "./workspace/?id=" + encodeURIComponent(project.id);
}

async function remove(project: AssistProject) {
  if (!confirm("删除这个辅助项目？")) return;
  if (!api) {
    alert("后端没启动，删不了");
    return;
  }
  await api.deleteAssist(project.id);
  await load();
}

async function load() {
  if (!api) {
    error.value = "加载失败，请刷新重试。";
    return;
  }
  const data: AssistProjectList | null = await api.assistProjects();
  if (!data) {
    error.value = "加载失败，请刷新重试。";
    return;
  }
  error.value = "";
  projects.value = data.projects || [];
}

async function create() {
  const text = goal.value.trim();
  if (!text) {
    document.getElementById("goal")?.focus();
    return;
  }
  if (!api) {
    alert("后端没启动，创建不了");
    return;
  }

  creating.value = true;
  try {
    const result = await api.createAssist(text);
    if (result.ok && result.data) {
      location.href = "./workspace/?id=" + encodeURIComponent(result.data.id);
      return;
    }
    alert(result.data?.error?.message || "创建失败，请重试");
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="assist-new">
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      style="width: 18px; height: 18px; color: var(--text-3); flex: none; align-self: center;"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
    <input
      id="goal"
      v-model="goal"
      type="text"
      placeholder="描述你要做的软件，例如：一个团队任务看板（AI 会陪你一步步做）"
      aria-label="辅助开发目标"
      @keydown.enter="create"
    />
    <button class="btn btn-primary" type="button" id="create" :disabled="creating" @click="create">
      {{ creating ? "创建中…" : "创建辅助项目" }}
    </button>
  </div>

  <div class="head" style="display: flex; align-items: center; gap: 10px; margin: 0 0 16px;">
    <h1 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">
      辅助项目 <span id="count" class="count">{{ projects.length }}</span>
    </h1>
  </div>

  <section class="assist-grid" id="list">
    <div v-if="error" class="assist-empty">{{ error }}</div>
    <div v-else-if="!projects.length" class="assist-empty">
      还没有辅助项目。<br />
      在上面写一句你要做的软件，创建后按六道工序一步一步做。
    </div>
    <template v-else>
      <article
        v-for="project in projects"
        :key="project.id"
        class="assist-card"
        :data-id="project.id"
        @click="open(project)"
      >
        <h3>{{ project.title }}</h3>
        <div class="meta">
          <span class="pill-stage">{{ project.stageLabel }}</span>
          <span>{{ (project.files || []).length }} 个文件</span>
          <span>{{ (project.findings && project.findings.open) || 0 }} 个待处理</span>
        </div>
        <div class="foot">
          <button class="btn btn-sm btn-ghost" type="button" data-act="open" @click.stop="open(project)">
            继续
          </button>
          <button class="btn btn-sm btn-ghost" type="button" data-act="del" @click.stop="remove(project)">
            删除
          </button>
        </div>
      </article>
    </template>
  </section>
</template>