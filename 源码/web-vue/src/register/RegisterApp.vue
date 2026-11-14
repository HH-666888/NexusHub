<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import "../theme";

type TipKey = "username" | "password" | "confirm";
type TipState = "" | "ok" | "error";

interface Tip {
  text: string;
  state: TipState;
}

const api = window.api;
const params = new URLSearchParams(location.search);
const next = params.get("next") || "";
const prompt = params.get("prompt") || "";

const username = ref("");
const password = ref("");
const confirm = ref("");
const showPassword = ref(false);
const loading = ref(false);
const tips = reactive<Record<TipKey, Tip>>({
  username: { text: "", state: "" },
  password: { text: "", state: "" },
  confirm: { text: "", state: "" },
});

const loginHref = computed(() => {
  const query = new URLSearchParams();
  if (next) query.set("next", next);
  if (prompt) query.set("prompt", prompt);
  const suffix = query.toString();
  return "../login/" + (suffix ? "?" + suffix : "");
});

function targetUrl() {
  if (prompt) return "../workbench/?run=new&prompt=" + encodeURIComponent(prompt);
  if (next === "workbench") return "../workbench/?run=new";
  if (next) return "../" + next + "/";
  return "../projects/";
}

function tip(name: TipKey, message = "", state: TipState = "") {
  tips[name].text = message;
  tips[name].state = state;
}

function clearTip(name: TipKey) {
  tip(name, "", "");
}

function fieldClass(name: TipKey) {
  return (
    "auth-field" +
    (tips[name].state === "error" ? " is-error" : "") +
    (tips[name].state === "ok" ? " is-ok" : "")
  );
}

function tipClass(name: TipKey) {
  return "field-tip" + (tips[name].state ? " " + tips[name].state : "");
}

function checkConfirm() {
  if (confirm.value && confirm.value !== password.value) {
    tip("confirm", "两次输入的密码不一致", "error");
  }
}

async function submit() {
  const name = username.value.trim();
  const pwd = password.value;
  const pwd2 = confirm.value;

  if (!name) {
    tip("username", "请填写用户名", "error");
    document.getElementById("username")?.focus();
    return;
  }
  if (name.length < 4 || name.length > 20) {
    tip("username", "用户名需 4–20 个字符", "error");
    document.getElementById("username")?.focus();
    return;
  }
  if (!pwd) {
    tip("password", "请填写密码", "error");
    document.getElementById("password")?.focus();
    return;
  }
  if (pwd.length < 6) {
    tip("password", "密码至少 6 位", "error");
    document.getElementById("password")?.focus();
    return;
  }
  if (pwd !== pwd2) {
    tip("confirm", "两次输入的密码不一致", "error");
    document.getElementById("confirm")?.focus();
    return;
  }

  loading.value = true;
  try {
    if (api) {
      const result = await api.register(name, pwd, pwd2);
      if (result.ok) {
        location.href = targetUrl();
        return;
      }
      if (!result.offline) {
        tip(
          "username",
          result.status === 409 ? "这个用户名已经被用了" : "注册失败，请检查用户名和密码",
          "error",
        );
        return;
      }
    }
    tip("username", "后端没启动，无法注册", "error");
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

    <h1>创建账号</h1>
    <p class="auth-sub">注册后就能开始构建你的第一个软件</p>

    <form id="auth-form" novalidate @submit.prevent="submit">
      <div :class="fieldClass('username')" data-field="username">
        <label for="username">用户名</label>
        <div class="input-wrap">
          <input
            id="username"
            v-model="username"
            name="username"
            type="text"
            placeholder="4–20 个字符"
            autocomplete="username"
            @input="clearTip('username')"
          />
        </div>
        <p :class="tipClass('username')" data-tip="username">{{ tips.username.text }}</p>
      </div>

      <div :class="fieldClass('password')" data-field="password">
        <label for="password">密码</label>
        <div class="input-wrap">
          <input
            id="password"
            v-model="password"
            name="password"
            :type="showPassword ? 'text' : 'password'"
            placeholder="至少 6 位"
            autocomplete="new-password"
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

      <div :class="fieldClass('confirm')" data-field="confirm">
        <label for="confirm">确认密码</label>
        <div class="input-wrap">
          <input
            id="confirm"
            v-model="confirm"
            name="confirm"
            :type="showPassword ? 'text' : 'password'"
            placeholder="再输一次"
            autocomplete="new-password"
            @input="clearTip('confirm')"
            @blur="checkConfirm"
          />
        </div>
        <p :class="tipClass('confirm')" data-tip="confirm">{{ tips.confirm.text }}</p>
      </div>

      <button class="btn btn-primary auth-submit" type="submit" id="submit-btn" :disabled="loading">
        {{ loading ? "注册中…" : "注册并开始" }}
      </button>
    </form>

    <p class="auth-foot">已经有账号了？<a :href="loginHref" id="to-login">去登录</a></p>
    <p class="auth-legal">继续即表示同意《服务条款》与《隐私政策》</p>

    <a class="back-home" href="../welcome/">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M15 6l-6 6 6 6" />
      </svg>
      返回欢迎页
    </a>
  </div>
</template>