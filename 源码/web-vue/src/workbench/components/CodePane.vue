<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { workbenchStore } from "../useWorkbenchStore";
import { highlight } from "../highlight";
import { showFile } from "../workbenchModel";

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

const store = workbenchStore;
const body = ref<HTMLElement | null>(null);
const activeTab = ref<"代码" | "预览" | "验收">("代码");
const previewUrl = ref("");
const previewLoading = ref(false);
const verdict = ref<Verdict | null>(null);
const verdictLoading = ref(false);

const activeFile = computed(() => store.files.find((file) => file.path === store.activePath) || null);
const streaming = computed(() => Boolean(activeFile.value && activeFile.value.state === "live"));

function activeLines() {
  return store.files.find((file) => file.path === store.activePath)?.lines || [];
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

async function selectTab(tab: "代码" | "预览" | "验收") {
  activeTab.value = tab;
  if (tab === "预览" && !previewUrl.value && !previewLoading.value) {
    previewLoading.value = true;
    try {
      const response = await fetch("/api/runs/" + runId() + "/runtime", { credentials: "include" });
      if (response.ok) {
        const info = await response.json();
        const runtime = info.runtime || info;
        previewUrl.value = runtime?.previewUrl || "";
      }
    } catch {
      previewUrl.value = "";
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

watch(
  () => activeFile.value?.lines.length,
  () => {
    void scrollToBottom();
  },
);
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
      <div v-for="(line, index) in activeLines()" :key="index" class="code-line">
        <span class="ln">{{ index + 1 }}</span>
        <pre v-html="highlight(line)"></pre>
      </div>
    </div>

    <div v-if="activeTab === '预览'" style="flex: 1; min-height: 0; overflow: auto; padding: 12px;">
      <p v-if="previewLoading" style="color: var(--text-3); font-size: 13px;">正在启动预览…</p>
      <iframe
        v-else-if="previewUrl"
        :src="previewUrl"
        style="width: 100%; height: 100%; border: 1px solid var(--line); border-radius: 12px; background: #fff;"
      ></iframe>
      <p v-else style="color: var(--text-3); font-size: 13px;">
        预览还没有启动：流程走到“验收交付”后会在这里打开真实产物。
      </p>
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