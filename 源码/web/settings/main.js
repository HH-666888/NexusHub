// file:// 下有些浏览器禁用 localStorage：读写都兜底，别把整段脚本带崩
      function safeTheme() {
        try { return localStorage.getItem("nexus-theme"); } catch (e) { return null; }
      }
      function saveTheme(value) {
        try { localStorage.setItem("nexus-theme", value); } catch (e) { /* 忽略 */ }
      }
      (function () {
        const param = new URLSearchParams(location.search).get("theme");
        document.documentElement.dataset.theme = param || safeTheme() || "light";
        document.documentElement.dataset.style = new URLSearchParams(location.search).get("style") || "";
        document.addEventListener("click", function (event) {
          if (!event.target.closest("#theme-toggle")) return;
          const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
          document.documentElement.dataset.theme = next;
          saveTheme(next);
        });
      })();

// 设置页：所有控件都真的读写 /api/v1/settings
      (function () {
        const DEFAULT = {
          provider: "deepseek",
          modelDecide: "deepseek-chat",
          modelBuild: "deepseek-chat",
          budgetPerRun: 2,
          budgetPerDay: 20,
          theme: "light",
        };
        const PROVIDERS = ["deepseek", "openai", "local"];

        const providerCards = Array.from(document.querySelectorAll(".provider"));
        const keyInput = document.querySelector('.field-row input[type="password"]');
        const testBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "测试连接");
        const selects = Array.from(document.querySelectorAll(".field-row select"));
        const sliders = Array.from(document.querySelectorAll("input.slider"));
        const budgetInputs = Array.from(document.querySelectorAll(".budget-input"));
        const themeCards = Array.from(document.querySelectorAll(".swatch-card"));
        const saveBar = document.querySelector(".save-bar");
        const saveBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "保存更改");
        const resetBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "恢复默认");
        const savedAt = saveBar ? saveBar.querySelector("span") : null;

        const state = { provider: DEFAULT.provider, apiKeySet: false };

        function setProvider(value) {
          state.provider = value;
          providerCards.forEach((card, i) => card.classList.toggle("is-on", PROVIDERS[i] === value));
        }

        function setTheme(value) {
          document.documentElement.dataset.theme = value;
          try { localStorage.setItem("nexus-theme", value); } catch (e) {}
          themeCards.forEach((card, i) => card.classList.toggle("is-on", (i === 0 ? "light" : "dark") === value));
        }

        function paintBudget(slider) {
          const i = sliders.indexOf(slider);
          const box = budgetInputs[i];
          if (box) box.innerHTML = "<span>¥</span>" + Number(slider.value).toFixed(2);
          const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
          slider.style.background =
            "linear-gradient(to right, var(--primary) 0 " + pct + "%, var(--card-3) " + pct + "% 100%)";
        }

        function apply(saved) {
          const data = Object.assign({}, DEFAULT, saved || {});
          setProvider(data.provider);
          setTheme(data.theme === "dark" ? "dark" : "light");

          [selects[0], selects[1]].forEach(function (select, i) {
            if (!select) return;
            const want = i === 0 ? data.modelDecide : data.modelBuild;
            const exists = Array.from(select.options).some((o) => o.value === want);
            select.value = exists ? want : select.options[0].value;
          });

          if (sliders[0]) { sliders[0].value = data.budgetPerRun; paintBudget(sliders[0]); }
          if (sliders[1]) { sliders[1].value = data.budgetPerDay; paintBudget(sliders[1]); }

          state.apiKeySet = Boolean(saved && saved.apiKeySet);
          if (keyInput) {
            keyInput.value = "";
            keyInput.placeholder = state.apiKeySet ? "已配置（留空表示不修改）" : "sk-…";
          }
          if (savedAt) savedAt.textContent = "上次保存：" + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
        }

        // ── 交互 ──
        providerCards.forEach((card, i) => {
          card.addEventListener("click", function () { setProvider(PROVIDERS[i]); });
        });

        themeCards.forEach((card, i) => {
          card.addEventListener("click", function () { setTheme(i === 0 ? "light" : "dark"); });
        });

        sliders.forEach((slider) => {
          slider.addEventListener("input", function () { paintBudget(slider); });
        });

        if (testBtn) {
          testBtn.addEventListener("click", async function () {
            testBtn.disabled = true;
            const old = testBtn.textContent;
            testBtn.textContent = "测试中…";
            let message = { ok: false, message: "后端没启动" };
            if (window.api) {
              message = await window.api.testConnection({
                provider: state.provider,
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
            const payload = {
              provider: state.provider,
              modelDecide: selects[0] ? selects[0].value : DEFAULT.modelDecide,
              modelBuild: selects[1] ? selects[1].value : DEFAULT.modelBuild,
              budgetPerRun: sliders[0] ? Number(sliders[0].value) : DEFAULT.budgetPerRun,
              budgetPerDay: sliders[1] ? Number(sliders[1].value) : DEFAULT.budgetPerDay,
              theme: document.documentElement.dataset.theme,
            };
            const key = keyInput ? keyInput.value.trim() : "";
            if (key) payload.apiKey = key;

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
            setTimeout(function () { saveBtn.textContent = "保存更改"; saveBtn.disabled = false; }, 900);
          });
        }

        if (resetBtn) {
          resetBtn.addEventListener("click", function () {
            apply(DEFAULT);
            if (keyInput) { keyInput.value = ""; keyInput.placeholder = "sk-…"; }
            if (savedAt) savedAt.textContent = "已恢复默认（记得保存）";
          });
        }

        // ── 启动 ──
        (async function boot() {
          let saved = null;
          if (window.api) saved = await window.api.settings();
          apply(saved);
          sliders.forEach(paintBudget);
        })();
      })();
