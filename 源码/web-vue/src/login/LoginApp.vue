<script setup>
import { computed, nextTick, reactive, ref } from "vue";
import "../theme.js";

const api = window.api;
const params = new URLSearchParams(location.search);
const next = params.get("next") || "";
const prompt = params.get("prompt") || "";

const account = ref("");
const password = ref("");
const showPassword = ref(false);
const loading = ref(false);
const tips = reactive({
  account: { text: "", state: "" },
  password: { text: "", state: "" },
});

const registerHref = computed(() => {
  const query = new URLSearchParams();
  if (next) query.set("next", next);
  if (prompt) query.set("prompt", prompt);
  const suffix = query.toString();
  return "../register/" + (suffix ? "?" + suffix : "");
});

function targetUrl() {
  if (prompt) return "../workbench/?run=new&prompt=" + encodeURIComponent(prompt);
  if (next === "workbench") return "../workbench/?run=new";
  if (next) return "../" + next + "/";
  return "../projects/";
}

function tip(name, message, state) {
  tips[name].text = message || "";
  tips[name].state = state || "";
}

function clearTip(name) {
  tip(name, "", "");
}

function fieldClass(name) {
  return (
    "auth-field" +
    (tips[name].state === "error" ? " is-error" : "") +
    (tips[name].state === "ok" ? " is-ok" : "")
  );
}

function tipClass(name) {
  return "field-tip" + (tips[name].state ? " " + tips[name].state : "");
}

async function fillTest() {
  account.value = "admin";
  password.value = "123456";
  clearTip("account");
  clearTip("password");
  await nextTick();
  document.getElementById("password")?.focus();
}

async function submit() {
  const name = account.value.trim();
  const pwd = password.value;

  if (!name) {
    tip("account", "请输入账号", "error");
    document.getElementById("account")?.focus();
    return;
  }
  if (!pwd) {
    tip("password", "请输入密码", "error");
    document.getElementById("password")?.focus();
    return;
  }

  loading.value = true;
  try {
    if (api && api.login) {
      const result = await api.login(name, pwd);
      if (result.ok) {
        location.href = targetUrl();
        return;
      }
      if (!result.offline) {
        tip("password", "账号或密码不对", "error");
        return;
      }
    }
    tip("password", "后端没启动，无法登录", "error");
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth-card">
    <div class="auth-brand">
      <svg viewBox="0 0 24 24" aria-hidden>
        <path class="brand-mark" d="M4 20V4h3.4l9.2 12V4H20v16h-3.4L7.4 8v12H4z" />
      </svg>
      NexusHub
    </div>

    <h1>欢迎回来</h1>
    <p class="auth-sub">登录后继续构建你的软件</p>

    <div class="test-hint">
      <span>测试账号 <b>admin</b> / <b>123456</b></span>
      <button type="button" id="fill-test" @click="fillTest">填入</button>
    </div>

    <form id="auth-form" novalidate @submit.prevent="submit">
      <div :class="fieldClass('account')" data-field="account">
        <label for="account">账号</label>
        <div class="input-wrap">
          <input
            id="account"
            v-model="account"
            name="account"
            type="text"
            placeholder="请输入用户名"
            autocomplete="username"
            @input="clearTip('account')"
          />
        </div>
        <p :class="tipClass('account')" data-tip="account">{{ tips.account.text }}</p>
      </div>

      <div :class="fieldClass('password')" data-field="password">
        <label for="password">密码</label>
        <div class="input-wrap">
          <input
            id="password"
            v-model="password"
            name="password"
            :type="showPassword ? 'text' : 'password'"
            placeholder="请输入密码"
            autocomplete="current-password"
            @input="clearTip('password')"
          />
          <button
            class="eye-btn"
            type="button"
            id="eye-btn"
            :aria-label="showPassword ? '隐藏密码' : '显示密码'"
            :style="{ color: showPassword ? 'var(--primary)' : '' }"
            @click="showPassword = !showPassword"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden>
              <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
              <circle cx="12" cy="12" r="2.6" />
            </svg>
          </button>
        </div>
        <p :class="tipClass('password')" data-tip="password">{{ tips.password.text }}</p>
      </div>

      <button class="btn btn-primary auth-submit" type="submit" id="submit-btn" :disabled="loading">
        {{ loading ? "登录中…" : "登录" }}
      </button>
    </form>

    <p class="auth-foot">还没有账号？<a :href="registerHref" id="to-register">立即注册</a></p>
    <p class="auth-legal">继续即表示同意《服务条款》与《隐私政策》</p>

    <a class="back-home" href="../welcome/">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M15 6l-6 6 6 6" />
      </svg>
      返回欢迎页
    </a>
  </div>
</template>