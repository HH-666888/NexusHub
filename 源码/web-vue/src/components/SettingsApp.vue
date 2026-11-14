<script setup>
import { computed, onMounted, ref } from "vue";

const api = window.api;

const apiKey = ref("");
const apiKeySet = ref(false);
const testing = ref(false);
const saving = ref(false);
const hintText = ref("保存后不回显；留空表示不修改。填了会用于之后的工作流和辅助开发。");
const hintColor = ref("");
const theme = ref(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const memory = ref(null);
const memoryState = ref("loading");
const saveHint = ref("尚未保存");
const saveLabel = ref("保存 API Key");

const themes = [
  { value: "light", label: "浅色", preview: "浅色预览" },
  { value: "dark", label: "深色", preview: "深色预览" },
];

const keyPlaceholder = computed(() =>
  apiKeySet.value ? "已配置（留空表示不修改）" : "sk-…"
);

function setTheme(value) {
  theme.value = value;
  document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem("nexus-theme", value);
  } catch (error) {
    /* 无痕模式忽略 */
  }
}

async function testConnection() {
  if (testing.value) return;
  testing.value = true;
  let message = { ok: false, message: "后端没启动" };
  if (api && api.testConnection) {
    try {
      message = await api.testConnection({
        provider: "deepseek",
        apiKey: apiKey.value.trim(),
      });
    } catch (error) {
      message = { ok: false, message: "测试失败" };
    }
  }
  testing.value = false;
  hintText.value = message.message;
  hintColor.value = message.ok ? "var(--ok)" : "#dc2626";
}

function formatSavedAt() {
  return new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function save() {
  if (saving.value) return;
  const key = apiKey.value.trim();
  if (!key) {
    saveHint.value = "留空不修改；要保存请先填 Key";
    return;
  }

  saving.value = true;
  saveLabel.value = "保存中…";
  let result = { ok: false };
  if (api && api.saveSettings) {
    try {
      result = await api.saveSettings({ apiKey: key });
    } catch (error) {
      result = { ok: false };
    }
  }

  saveHint.value = result.ok ? "上次保存：" + formatSavedAt() : "保存失败，请检查后端";
  if (result.ok) {
    apiKey.value = "";
    apiKeySet.value = true;
  }
  saveLabel.value = "已保存";
  setTimeout(() => {
    saveLabel.value = "保存 API Key";
    saving.value = false;
  }, 900);
}

onMounted(async () => {
  if (!api) {
    memoryState.value = "error";
    return;
  }

  try {
    const tasks = [];
    if (api.settings) tasks.push(api.settings());
    if (api.memoryStats) tasks.push(api.memoryStats());
    const [saved, stats] = await Promise.all(tasks);

    if (saved) {
      apiKeySet.value = Boolean(saved.apiKeySet);
    }
    if (stats) {
      memory.value = stats;
      memoryState.value = "ready";
    } else {
      memoryState.value = "error";
    }
  } catch (error) {
    memoryState.value = "error";
  }
});
</script>

<template>
  <nav class="settings-side" aria-label="设置分区">
    <a class="is-here" href="#s-model">
      <svg viewBox="0 0 24 24" aria-hidden>
        <rect x="4" y="4" width="16" height="7" rx="2" />
        <rect x="4" y="14" width="16" height="6" rx="2" />
      </svg>
      模型接入
    </a>
    <a href="#s-theme">
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
      </svg>
      外观主题
    </a>
    <a href="#s-memory">
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 3a7 7 0 0 0-7 7c0 3 2 4 2 6h10c0-2 2-3 2-6a7 7 0 0 0-7-7z" />
        <path d="M9 20h6" />
      </svg>
      AI 记忆
    </a>
  </nav>

  <main class="settings-main">
    <h1>设置</h1>
    <p>这里改的东西只影响你这台机器上的运行，不会同步到别人的账号。</p>

    <section class="panel section" id="s-model">
      <h2>模型接入</h2>
      <p class="desc">固定使用 DeepSeek。只需填自己的 API Key；不填则用服务端环境变量里的 Key。</p>

      <div class="field-row">
        <label>API Key</label>
        <div>
          <div style="display: flex; gap: 8px;">
            <input
              v-model="apiKey"
              class="input"
              type="password"
              value=""
              :placeholder="keyPlaceholder"
            />
            <button class="btn btn-ghost" type="button" :disabled="testing" @click="testConnection">
              {{ testing ? "测试中…" : "测试连接" }}
            </button>
          </div>
          <p class="hintline" :style="hintColor ? { color: hintColor } : null">{{ hintText }}</p>
        </div>
      </div>
    </section>

    <section class="panel section" id="s-theme">
      <h2>外观主题</h2>
      <p class="desc">浅色适合白天与投屏，深色适合夜里盯着看。</p>

      <div class="theme-grid">
        <div
          v-for="item in themes"
          :key="item.value"
          class="swatch-card"
          :class="{ 'is-on': theme === item.value }"
          @click="setTheme(item.value)"
        >
          <div class="swatch" :class="{ 'is-on': theme === item.value }">
            <div class="swatch-preview" :class="item.value">{{ item.preview }}</div>
          </div>
          {{ item.label }}
        </div>
      </div>
    </section>

    <section class="panel section" id="s-memory">
      <h2>AI 记忆</h2>
      <p style="margin: 0 0 10px; font-size: 12.5px; color: var(--text-3);">
        记忆只在“辅助开发”里生效；工作流使用模型的纯粹能力，不读取记忆。
      </p>
      <div id="memory-summary" style="font-size: 13px; color: var(--text-2);">
        <template v-if="memoryState === 'ready' && memory">
          共 <b>{{ memory.total }}</b> 条 · 今日 <b>{{ memory.today }}/{{ memory.dailyLimit }}</b> · 近 7 天
          <b>{{ memory.week }}</b> 条
        </template>
        <template v-else-if="memoryState === 'error'">暂时读不到记忆统计。</template>
        <template v-else>正在读取…</template>
      </div>
      <div style="margin-top: 12px;">
        <a class="btn btn-sm btn-ghost" href="../memory/">打开记忆页</a>
      </div>
    </section>

    <div class="save-bar">
      <span>{{ saveHint }}</span>
      <div style="display: flex; gap: 10px;">
        <button class="btn btn-primary" type="button" :disabled="saving" @click="save">
          {{ saveLabel }}
        </button>
      </div>
    </div>
  </main>
</template>