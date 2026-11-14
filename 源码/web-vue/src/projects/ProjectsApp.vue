<script setup>
import { computed, ref } from "vue";

const api = window.api;
const runs = ref([]);
const filter = ref("all");
const usageToday = ref(null);
const prompt = ref("");
const creating = ref(false);
const deletingId = ref("");
const loaded = ref(false);

const stageLabel = {
  plan: "需求分析",
  design: "架构设计",
  build: "自主开发",
  assemble: "集成装配",
  test: "自动测试",
  deliver: "验收交付",
};
const statusLabel = {
  running: "运行中",
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const filterKeys = ["all", "running", "done", "failed"];
const filterNames = { all: "全部", running: "进行中", done: "已完成", failed: "未通过" };

const counts = computed(() => {
  const byStatus = { running: 0, done: 0, failed: 0 };
  runs.value.forEach((run) => {
    if (byStatus[run.status] === undefined) byStatus[run.status] = 0;
    byStatus[run.status] += 1;
  });
  return byStatus;
});

const filters = computed(() =>
  filterKeys.map((key) => ({
    key,
    label: filterNames[key] + (key === "all" ? "" : " " + (counts.value[key] || 0)),
  }))
);

const filteredRuns = computed(() =>
  filter.value === "all" ? runs.value : runs.value.filter((run) => run.status === filter.value)
);

const todayCost = computed(() => {
  if (usageToday.value) return Number(usageToday.value.totalCny || 0);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return runs.value
    .filter((run) => new Date(run.createdAt) >= start)
    .reduce((sum, run) => sum + Number(run.totalCostCny || 0), 0);
});

const footCountText = computed(() =>
  loaded.value ? "共 " + runs.value.length + " 个项目" : "共 0 个项目"
);
const footBudgetText = computed(() =>
  loaded.value ? "今日估算 ¥" + money(todayCost.value) : "今日估算 ¥—"
);

function money(value) {
  const amount = Number(value || 0);
  return amount > 0 && amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
}

function fmtTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

function statusText(status) {
  return statusLabel[status] || status;
}

function stageText(stage) {
  return stageLabel[stage] || stage;
}

function pillClass(status) {
  if (status === "running") return "pill-live";
  if (status === "failed" || status === "paused" || status === "cancelled") return "pill-warn";
  return "pill";
}

function openRun(run) {
  location.href = "../workbench/?run=" + encodeURIComponent(run.id);
}

async function removeRun(run) {
  const name = run.prompt || "这次运行";
  if (!window.confirm("删除「" + name + "」？删除后不能恢复。")) return;

  deletingId.value = run.id;
  const result = api && api.deleteRun ? await api.deleteRun(run.id) : { ok: false, offline: true };
  if (!result.ok) {
    deletingId.value = "";
    alert(result.offline ? "后端没启动，删不了" : "删除失败，请重试");
    return;
  }

  runs.value = runs.value.filter((item) => item.id !== run.id);
  deletingId.value = "";
  updateChrome();
}

function updateChrome() {
  const pill = document.querySelector(".appbar-right .pill-plain");
  if (pill) pill.textContent = "今日估算 ¥" + money(todayCost.value);
}

async function load() {
  if (!api || !api.runs) return;

  const data = await api.runs(24);
  if (!Array.isArray(data)) return;

  runs.value = data;
  loaded.value = true;
  updateChrome();

  if (api.usageToday) {
    usageToday.value = await api.usageToday();
    updateChrome();
  }
}

async function create() {
  const text = prompt.value.trim();
  if (!text) {
    document.querySelector(".new-bar input")?.focus();
    return;
  }

  creating.value = true;
  try {
    if (api && api.createRun) {
      const result = await api.createRun(text);
      if (result.ok && result.data) {
        location.href = "../workbench/?run=" + encodeURIComponent(result.data.id);
        return;
      }
      alert(result.offline ? "后端没启动，创建不了" : "创建失败，请稍后重试");
      return;
    }
    alert("后端没启动，创建不了");
  } finally {
    creating.value = false;
  }
}

load();
</script>

<template>
  <div class="new-bar">
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      style="width: 18px; height: 18px; color: var(--text-3); flex: none;"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
    <input
      v-model="prompt"
      type="text"
      placeholder="用一句话描述你要做的软件，例如：一个能拖拽的团队任务看板"
      aria-label="新需求"
      @keydown.enter="create"
    />
    <button class="btn btn-primary" type="button" :disabled="creating" @click="create">
      {{ creating ? "创建中…" : "生成" }}
    </button>
  </div>

  <div class="head">
    <h1>我的项目 <span class="count">{{ filteredRuns.length }}</span></h1>
    <div class="seg" role="tablist">
      <button
        v-for="item in filters"
        :key="item.key"
        :class="{ 'is-on': filter === item.key }"
        type="button"
        @click="filter = item.key"
      >
        {{ item.label }}
      </button>
    </div>
  </div>

  <div class="grid">
    <a class="card-new" href="../workbench/?run=new">
      <span class="plus">
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
      <b>新建项目</b>
      <small>从一句话开始</small>
    </a>

    <article
      v-for="run in filteredRuns"
      :key="run.id"
      class="card"
      :data-run="run.id"
      style="cursor: pointer;"
      @click="openRun(run)"
    >
      <div class="thumb">
        <span class="tl a"></span>
        <span class="tl b"></span>
        <span class="tb"></span>
        <span class="pill" :class="pillClass(run.status)">{{ statusText(run.status) }}</span>
      </div>
      <div class="body">
        <h3>{{ run.prompt }}</h3>
        <div class="meta">
          <span>{{ stageText(run.stage) }}</span>
          <span>¥{{ (run.totalCostCny || 0).toFixed(2) }}</span>
          <span>{{ fmtTime(run.createdAt) }}</span>
        </div>
        <div class="actions">
          <button class="btn btn-sm btn-ghost" type="button" data-open @click.stop="openRun(run)">
            看产线
          </button>
          <button
            class="btn btn-sm btn-ghost card-del"
            type="button"
            data-del
            :disabled="deletingId === run.id"
            @click.stop="removeRun(run)"
          >
            {{ deletingId === run.id ? "删除中…" : "删除" }}
          </button>
        </div>
      </div>
    </article>

    <div
      v-if="loaded && filteredRuns.length === 0"
      class="empty-state"
      style="grid-column: 1 / -1; padding: 36px 20px; border: 1px dashed var(--line-2); border-radius: 16px; text-align: center; color: var(--text-2); font-size: 13.5px;"
    >
      还没有项目。<br />在上面输入一句话，就能开始第一个构建。
    </div>
  </div>

  <footer class="foot">
    <span>NexusHub 0.9.4</span>
    <span id="foot-count">{{ footCountText }}</span>
    <span id="foot-budget">{{ footBudgetText }}</span>
  </footer>
</template>