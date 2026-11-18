<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { workbenchStore } from "../useWorkbenchStore";
import { highlight } from "../highlight";
import { followLatest, showFile } from "../workbenchModel";

interface VerdictCheck {
  name: string;
  pass: boolean;
}

interface VerdictLayer {
  layer: string;
  passed: number;
  total: number;
  checks?: VerdictCheck[];
}

interface Verdict {
  passed: number;
  total: number;
  layers?: VerdictLayer[];
}

type CodeTab = "代码" | "预览" | "验收";

const store = workbenchStore;
const body = ref<HTMLElement | null>(null);
const codeKey = "nexus-wb-code:" + (new URLSearchParams(location.search).get("run") || "new");

function readTab(): CodeTab {
  try {
    const saved = localStorage.getItem(codeKey + ":tab");
    if (saved === "预览" || saved === "验收") return saved;
  } catch {
    /* 忽略隐私模式 */
  }
  return "代码";
}

const activeTab = ref<CodeTab>(readTab());
const previewUrl = ref("");
const previewLoading = ref(false);
const previewWrap = ref<HTMLElement | null>(null);
const previewFull = ref(false);
const verdict = ref<Verdict | null>(null);
const verdictLoading = ref(false);

function onFullscreenChange() {
  previewFull.value = document.fullscreenElement === previewWrap.value;
}

async function toggleFullscreen() {
  const element = previewWrap.value;
  if (!element) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await element.requestFullscreen();
  } catch {
    /* 浏览器拒绝时保持原样，不弹窗打扰 */
  }
}

function openInNewWindow() {
  if (previewUrl.value) window.open(previewUrl.value, "_blank", "noopener");
}

const activeFile = computed(() => store.files.find((file) => file.path === store.activePath) || null);
const streaming = computed(() => Boolean(activeFile.value && activeFile.value.state === "live"));

/** 完整行 + 正在逐字写入的半行；半行让「流式输出」真的看得见 */
const displayLines = computed(() => {
  const file = activeFile.value;
  if (!file) return [] as string[];
  const lines = file.lines.slice();
  if (file.state === "live") lines.push(file.partial || "");
  return lines;
});

function activeLines() {
  return displayLines.value;
}

function lineHtml(index: number) {
  const line = displayLines.value[index] ?? "";
  const body = highlight(line);
  if (streaming.value && index === displayLines.value.length - 1) {
    return body + '<span class="caret"></span>';
  }
  return body;
}

function baseName(path: string) {
  return path.split("/").pop() || path;
}

function tabMark(path: string) {
  const file = store.files.find((item) => item.path === path);
  if (store.livePath === path) return "写入中";
  return file?.state === "done" ? "✓" : "待生成";
}

function hideCode() {
  document.getElementById("work")?.classList.add("no-code");
}

function openFile(path: string) {
  activeTab.value = "代码";
  showFile(path);
}

async function selectTab(tab: CodeTab) {
  activeTab.value = tab;
  if (tab === "预览" && !previewLoading.value) {
    // 每次都重新取一次：预览进程重启后端口可能变了，缓存旧地址只会显示白页
    previewLoading.value = true;
    try {
      const response = await fetch("/api/runs/" + runId() + "/runtime", { credentials: "include" });
      if (response.ok) {
        const info = await response.json();
        const runtime = info.runtime || info;
        previewUrl.value = runtime?.previewUrl || "";
      }
    } catch {
      // 网络抖动时保留上一次的地址，不把还能用的预览清成白页
    } finally {
      previewLoading.value = false;
    }
  }
  if (tab === "验收" && !verdict.value && !verdictLoading.value) {
    verdictLoading.value = true;
    try {
      const response = await fetch("/api/runs/" + runId() + "/verdict", { credentials: "include" });
      if (response.ok) {
        const data = await response.json();
        verdict.value = (data.verdict || data) as Verdict;
      }
    } catch {
      verdict.value = null;
    } finally {
      verdictLoading.value = false;
    }
  }
}

function runId() {
  return new URLSearchParams(location.search).get("run") || "";
}

async function scrollToBottom() {
  await nextTick();
  if (body.value) body.value.scrollTop = body.value.scrollHeight;
}

function saveCodeScroll() {
  if (!body.value || !store.activePath) return;
  try {
    localStorage.setItem(codeKey + ":scroll:" + store.activePath, String(body.value.scrollTop));
  } catch {
    /* 忽略隐私模式 */
  }
}

function restoreCodeScroll(path = store.activePath) {
  if (!body.value || !path) return;
  try {
    const saved = Number(localStorage.getItem(codeKey + ":scroll:" + path));
    if (Number.isFinite(saved)) body.value.scrollTop = saved;
  } catch {
    /* 忽略 */
  }
}

function follow() {
  followLatest();
  void scrollToBottom();
}

watch(activeTab, (tab) => {
  try {
    localStorage.setItem(codeKey + ":tab", tab);
  } catch {
    /* 忽略 */
  }
});

watch(
  () => [activeFile.value?.lines.length, activeFile.value?.partial?.length],
  () => {
    if (store.follow) void scrollToBottom();
  },
);

watch(
  () => store.activePath,
  async () => {
    await nextTick();
    if (store.follow && activeFile.value?.state === "live") await scrollToBottom();
    else restoreCodeScroll(store.activePath);
  },
);

onMounted(async () => {
  document.addEventListener("fullscreenchange", onFullscreenChange);
  body.value?.addEventListener("scroll", saveCodeScroll, { passive: true });
  if (activeTab.value !== "代码") await selectTab(activeTab.value);
  await nextTick();
  if (store.follow && activeFile.value?.state === "live") await scrollToBottom();
  else restoreCodeScroll();
});

onUnmounted(() => {
  document.removeEventListener("fullscreenchange", onFullscreenChange);
});
</script>

<template>
  <aside class="code-pane" id="code-pane">
    <div class="code-head">
      <div class="tabs">
        <button type="button" :class="{ 'is-on': activeTab === '代码' }" @click="selectTab('代码')">代码</button>
        <button type="button" :class="{ 'is-on': activeTab === '预览' }" @click="selectTab('预览')">预览</button>
        <button type="button" :class="{ 'is-on': activeTab === '验收' }" @click="selectTab('验收')">验收</button>
      </div>
      <span class="spacer"></span>
      <button class="icon-btn" type="button" id="hide-code" aria-label="隐藏代码面板" @click="hideCode">
        <svg viewBox="0 0 24 24" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
      </button>
    </div>

    <div v-show="activeTab === '代码'" class="file-tabs" id="file-tabs" role="tablist" aria-label="已生成的文件">
      <button
        v-for="file in store.files"
        :key="file.path"
        type="button"
        :class="{
          'is-on': store.activePath === file.path,
          done: file.state === 'done',
          live: store.livePath === file.path,
        }"
        :data-path="file.path"
        @click="openFile(file.path)"
      >
        {{ baseName(file.path) }}<i>{{ tabMark(file.path) }}</i>
      </button>
    </div>

    <div v-show="activeTab === '代码'" class="code-file">
      <span class="dot" id="file-dot" :style="{ background: store.dotWarn ? 'var(--warn)' : 'var(--ok)' }"></span>
      <span id="file-name">{{ store.activePath || "—" }}</span>
      <button v-if="!store.follow" type="button" class="follow-btn" @click="follow">跟随最新</button>
      <span class="grow"></span>
      <span class="stream" id="stream-state">
        <template v-if="activeFile">
          {{ streaming ? "流式写入" : "已生成" }} · <b id="line-count">{{ activeFile.lines.length }}</b> 行
        </template>
        <template v-else>等待文件事件<b id="line-count" hidden>0</b></template>
      </span>
    </div>

    <div v-show="activeTab === '代码'" class="review-bar" id="review-bar" :class="{ 'is-on': store.reviewMode }">
      <span id="review-text">{{ store.reviewText }}</span>
      <button type="button" id="replay-file">重播这次生成</button>
      <button type="button" id="back-live">回到实时</button>
    </div>

    <div v-show="activeTab === '代码'" class="code-body" id="code-body" ref="body">
      <div v-for="(line, index) in activeLines()" :key="store.activePath + ':' + index" class="code-line">
        <span class="ln">{{ index + 1 }}</span>
        <pre v-html="lineHtml(index)"></pre>
      </div>
    </div>

    <div v-if="activeTab === '预览'" ref="previewWrap" class="preview-wrap">
      <div class="preview-bar">
        <span class="preview-state">
          {{ previewUrl ? "真实运行中" : previewLoading ? "启动中…" : "未启动" }}
        </span>
        <span class="spacer"></span>
        <button v-if="previewUrl" type="button" class="preview-btn" @click="openInNewWindow">新窗口</button>
        <button v-if="previewUrl" type="button" class="preview-btn is-main" @click="toggleFullscreen">
          {{ previewFull ? "退出全屏" : "全屏" }}
        </button>
      </div>
      <div class="preview-body">
        <p v-if="previewLoading" class="preview-empty">正在启动预览…</p>
        <iframe v-else-if="previewUrl" :src="previewUrl" class="preview-frame"></iframe>
        <p v-else class="preview-empty">
          预览还没有启动：流程走到“验收交付”后会在这里打开真实产物。
        </p>
      </div>
    </div>

    <div v-if="activeTab === '验收'" style="flex: 1; min-height: 0; overflow: auto; padding: 12px;">
      <p v-if="verdictLoading" style="color: var(--text-3); font-size: 13px;">正在读取验收结果…</p>
      <p v-else-if="!verdict" style="color: var(--text-3); font-size: 13px;">还没有验收结果，等它跑完。</p>
      <template v-else>
        <div style="font-size: 13px; margin-bottom: 10px;">
          合计 <b>{{ verdict.passed }}</b> / {{ verdict.total }}
        </div>
        <div v-for="(layer, index) in verdict.layers || []" :key="index" style="margin-bottom: 12px;">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px;">
            {{ layer.layer }} · {{ layer.passed }}/{{ layer.total }}
          </div>
          <div
            v-for="(check, checkIndex) in layer.checks || []"
            :key="checkIndex"
            style="display: flex; gap: 8px; font-size: 12.5px; padding: 3px 0;"
          >
            <span :style="{ color: check.pass ? '#10b981' : '#dc2626' }">{{ check.pass ? "✓" : "✗" }}</span>
            <span>{{ check.name }}</span>
          </div>
        </div>
      </template>
    </div>
  </aside>
</template>