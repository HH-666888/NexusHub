<script setup lang="ts">
import { computed, ref } from "vue";
import type { ApiResult, Run, TodayUsage } from "../types/api";

type FilterKey = "all" | "running" | "done" | "failed";

const api = window.api;
const runs = ref<Run[]>([]);
const filter = ref<FilterKey>("all");
const usageToday = ref<TodayUsage | null>(null);
const prompt = ref("");
const creating = ref(false);
const deletingId = ref("");
const loaded = ref(false);
const selecting = ref(false);
const selected = ref<string[]>([]);
const busy = ref(false);

const selectedSet = computed(() => new Set(selected.value));
const allSelected = computed(
  () => filteredRuns.value.length > 0 && filteredRuns.value.every((run) => selectedSet.value.has(run.id)),
);

const stageLabel: Record<string, string> = {
  plan: "需求分析",
  design: "架构设计",
  build: "自主开发",
  assemble: "集成装配",
  test: "自动测试",
  deliver: "验收交付",
};
const statusLabel: Record<string, string> = {
  running: "运行中",
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const filterKeys: FilterKey[] = ["all", "running", "done", "failed"];
const filterNames: Record<FilterKey, string> = {
  all: "全部",
  running: "进行中",
  done: "已完成",
  failed: "未通过",
};

const counts = computed<Record<string, number>>(() => {
  const byStatus: Record<string, number> = { running: 0, done: 0, failed: 0 };
  runs.value.forEach((run) => {
    byStatus[run.status] = (byStatus[run.status] || 0) + 1;
  });
  return byStatus;
});

const filters = computed(() =>
  filterKeys.map((key) => ({
    key,
    label: filterNames[key] + (key === "all" ? "" : " " + (counts.value[key] || 0)),
  })),
);

const filteredRuns = computed(() =>
  filter.value === "all" ? runs.value : runs.value.filter((run) => run.status === filter.value),
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
  loaded.value ? "共 " + runs.value.length + " 个项目" : "共 0 个项目",
);
const footBudgetText = computed(() =>
  loaded.value ? "今日估算 ¥" + money(todayCost.value) : "今日估算 ¥—",
);

function money(value?: number | null) {
  const amount = Number(value || 0);
  return amount > 0 && amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
}

function fmtTime(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
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

function statusText(status: string) {
  return statusLabel[status] || status;
}

function stageText(stage: string) {
  return stageLabel[stage] || stage;
}

function pillClass(status: string) {
  if (status === "running") return "pill-live";
  if (status === "failed" || status === "paused" || status === "cancelled") return "pill-warn";
  return "pill";
}

function openRun(run: Run) {
  location.href = "../workbench/?run=" + encodeURIComponent(run.id);
}

async function removeRun(run: Run) {
  const name = run.prompt || "这次运行";
  if (!window.confirm("删除「" + name + "」？删除后不能恢复。")) return;

  deletingId.value = run.id;
  let result: ApiResult<null> = { ok: false, offline: true, status: 0, data: null };
  if (api) {
    result = await api.deleteRun(run.id);
  }
  if (!result.ok) {
    deletingId.value = "";
    alert(result.offline ? "后端没启动，删不了" : "删除失败，请重试");
    return;
  }

  runs.value = runs.value.filter((item) => item.id !== run.id);
  deletingId.value = "";
  updateChrome();
}

function toggleSelectMode() {
  selecting.value = !selecting.value;
  selected.value = [];
}

function toggleSelected(run: Run) {
  if (selectedSet.value.has(run.id)) {
    selected.value = selected.value.filter((id) => id !== run.id);
  } else {
    selected.value = [...selected.value, run.id];
  }
}

function toggleAll() {
  selected.value = allSelected.value ? [] : filteredRuns.value.map((run) => run.id);
}

function onCardClick(run: Run) {
  if (selecting.value) {
    toggleSelected(run);
    return;
  }
  openRun(run);
}

async function deleteMany(ids: string[]) {
  if (!api || !ids.length) return 0;
  busy.value = true;
  let removed = 0;
  try {
    for (const id of ids) {
      const result = await api.deleteRun(id);
      if (result.ok) {
        runs.value = runs.value.filter((item) => item.id !== id);
        selected.value = selected.value.filter((sid) => sid !== id);
        removed += 1;
      }
    }
  } finally {
    busy.value = false;
    updateChrome();
  }
  return removed;
}

async function removeSelected() {
  if (!selected.value.length) return;
  if (!window.confirm("删除选中的 " + selected.value.length + " 个项目？删除后不能恢复。")) return;
  const total = selected.value.length;
  const removed = await deleteMany([...selected.value]);
  if (removed < total) alert("有 " + (total - removed) + " 个项目没删掉，请重试");
  if (removed) selecting.value = false;
}

async function clearAll() {
  if (!api) {
    alert("后端没启动，删不了");
    return;
  }
  if (!window.confirm("清空全部项目？所有产物和记录都会删除，不能恢复。")) return;
  busy.value = true;
  try {
    // 浏览器可能缓存着旧版 api.js，没有 clearRuns 时退回逐个删除（列表现取，避免用旧数据）
    const withClear = api as unknown as { clearRuns?: () => Promise<ApiResult<{ deleted: number }>> };
    if (typeof withClear.clearRuns === "function") {
      const result = await withClear.clearRuns();
      if (!result.ok) {
        alert(result.offline ? "后端没启动，删不了" : "清除失败，请重试");
        return;
      }
    } else {
      const fresh = (await api.runs(100)) || [];
      const removed = await deleteMany(fresh.map((run) => run.id));
      if (removed < fresh.length) {
        alert("有 " + (fresh.length - removed) + " 个项目没删掉，请重试");
        return;
      }
    }
    runs.value = [];
    selected.value = [];
    selecting.value = false;
  } finally {
    busy.value = false;
    updateChrome();
  }
  await load();
  updateChrome();
}

function updateChrome() {
  const pill = document.querySelector(".appbar-right .pill-plain");
  if (pill) pill.textContent = "今日估算 ¥" + money(todayCost.value);
}

async function load() {
  if (!api) return;

  const data = await api.runs(100);
  if (!Array.isArray(data)) return;

  runs.value = data;
  loaded.value = true;
  updateChrome();

  usageToday.value = await api.usageToday();
  updateChrome();
}

async function create() {
  const text = prompt.value.trim();
  if (!text) {
    const input = document.querySelector(".new-bar input") as HTMLInputElement | null;
    input?.focus();
    return;
  }

  creating.value = true;
  try {
    if (api) {
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

void load();
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

  <div class="tools">
    <button class="btn btn-sm btn-ghost" type="button" @click="toggleSelectMode">
      {{ selecting ? "退出多选" : "多选" }}
    </button>
    <template v-if="selecting">
      <button class="btn btn-sm btn-ghost" type="button" @click="toggleAll">
        {{ allSelected ? "取消全选" : "全选" }}
      </button>
      <button
        class="btn btn-sm btn-ghost tools-danger"
        type="button"
        :disabled="busy || !selected.length"
        @click="removeSelected"
      >
        删除所选 {{ selected.length ? "(" + selected.length + ")" : "" }}
      </button>
    </template>
    <button
      class="btn btn-sm btn-ghost tools-danger"
      type="button"
      :disabled="busy || !runs.length"
      @click="clearAll"
    >
      一键清除全部
    </button>
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
      :class="{ 'is-selected': selecting && selectedSet.has(run.id), 'is-selecting': selecting }"
      :data-run="run.id"
      style="cursor: pointer;"
      @click="onCardClick(run)"
    >
      <div class="thumb">
        <span class="tl a"></span>
        <span class="tl b"></span>
        <span class="tb"></span>
        <span v-if="selecting" class="card-check" :class="{ 'is-on': selectedSet.has(run.id) }">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
        <span class="pill" :class="pillClass(run.status)">{{ statusText(run.status) }}</span>
      </div>
      <div class="body">
        <h3 :title="run.prompt">{{ run.prompt }}</h3>
        <div class="meta">
          <span>{{ stageText(run.stage) }}</span>
          <span>¥{{ (run.totalCostCny || 0).toFixed(2) }}</span>
          <span>{{ fmtTime(run.createdAt) }}</span>
        </div>
        <div v-if="!selecting" class="actions">
          <button class="btn btn-sm btn-ghost" type="button" data-open @click.stop="openRun(run)">
            看产线
          </button>
          <button
            class="btn btn-sm btn-ghost card-del"
            type="button"
            data-del
            :disabled="deletingId === run.id || busy"
            @click.stop="removeRun(run)"
          >
            {{ deletingId === run.id ? "删除中…" : "删除" }}
          </button>
        </div>
        <div v-else class="actions actions-select">
          <span>点击{{ selectedSet.has(run.id) ? "取消选择" : "选中" }}</span>
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