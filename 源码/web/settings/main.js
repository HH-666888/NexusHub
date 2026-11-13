// 设置页：只保留能真正生效的配置——API Key 与外观主题。
(function () {
  const keyInput = document.querySelector('.field-row input[type="password"]');
  const testBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "测试连接");
  const themeCards = Array.from(document.querySelectorAll(".swatch-card"));
  const saveBar = document.querySelector(".save-bar");
  const saveBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "保存更改");
  const savedAt = saveBar ? saveBar.querySelector("span") : null;

  const state = { apiKeySet: false };

  function setTheme(value) {
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem("nexus-theme", value);
    } catch (error) {
      /* 无痕模式忽略 */
    }
    themeCards.forEach(function (card, i) {
      card.classList.toggle("is-on", (i === 0 ? "light" : "dark") === value);
    });
  }

  function apply(saved) {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    state.apiKeySet = Boolean(saved && saved.apiKeySet);
    if (keyInput) {
      keyInput.value = "";
      keyInput.placeholder = state.apiKeySet ? "已配置（留空表示不修改）" : "sk-…";
    }
  }

  themeCards.forEach(function (card, i) {
    card.addEventListener("click", function () {
      setTheme(i === 0 ? "light" : "dark");
    });
  });

  if (testBtn) {
    testBtn.addEventListener("click", async function () {
      testBtn.disabled = true;
      const old = testBtn.textContent;
      testBtn.textContent = "测试中…";
      let message = { ok: false, message: "后端没启动" };
      if (window.api) {
        message = await window.api.testConnection({
          provider: "deepseek",
          apiKey: keyInput ? keyInput.value.trim() : "",
        });
      }
      testBtn.textContent = old;
      testBtn.disabled = false;
      const hint = document.querySelector(".hintline");
      if (hint) {
        hint.textContent = message.message;
        hint.style.color = message.ok ? "var(--ok)" : "#dc2626";
      }
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", async function () {
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      const key = keyInput ? keyInput.value.trim() : "";
      const payload = key ? { apiKey: key } : {};

      if (window.api) {
        const result = await window.api.saveSettings(payload);
        if (savedAt) {
          savedAt.textContent = result.ok
            ? "上次保存：" + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
            : "保存失败，请检查后端";
        }
        if (result.ok && key && keyInput) {
          keyInput.value = "";
          keyInput.placeholder = "已配置（留空表示不修改）";
          state.apiKeySet = true;
        }
      }
      saveBtn.textContent = "已保存";
      setTimeout(function () {
        saveBtn.textContent = "保存更改";
        saveBtn.disabled = false;
      }, 900);
    });
  }

  (async function boot() {
    let saved = null;
    if (window.api) saved = await window.api.settings();
    apply(saved);
  })();
})();