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

// 项目卡 → 工作台（原型串联：没有真实数据，统一进同一页）
      (function () {
        const cards = Array.from(document.querySelectorAll(".card"));
        const open = (i) => { location.href = "../workbench/?run=demo" + (i + 1); };

        cards.forEach(function (card, i) {
          card.style.cursor = "pointer";
          card.addEventListener("click", function (event) {
            if (event.target.closest("button, a")) return;
            open(i);
          });
          const btn = card.querySelector(".actions button");
          if (btn) btn.addEventListener("click", function (event) { event.stopPropagation(); open(i); });
        });
      })();

(function () {
        const user = window.NexusDemo && window.NexusDemo.getUser();
        if (!user) return;
        const host = document.querySelector(".appbar-right") || document.querySelector(".topbar-actions") || document.querySelector("header");
        if (!host) return;
        const chip = document.createElement("span");
        chip.id = "demo-who";
        chip.className = "pill";
        chip.style.marginRight = "8px";
        chip.textContent = user;
        host.insertBefore(chip, host.firstChild);
      })();

// 项目页真数据：列表、空状态、新建、退出登录
      (function () {
        const grid = document.querySelector(".grid");
        const count = document.querySelector(".count");
        const newBar = document.querySelector(".new-bar");
        const newInput = newBar ? newBar.querySelector("input") : null;
        const newBtn = newBar ? newBar.querySelector("button") : null;

        const stageLabel = {
          spec: "需求分析", arch: "架构设计", build: "并行开发",
          assemble: "集成装配", test: "自动测试", deliver: "验收交付",
        };
        const statusLabel = { running: "运行中", done: "已完成", failed: "失败" };

        function fmtTime(ms) {
          const d = new Date(ms);
          const pad = (n) => String(n).padStart(2, "0");
          return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
        }

        function cardFor(run) {
          const card = document.createElement("article");
          card.className = "card";
          card.dataset.run = run.id;
          card.style.cursor = "pointer";
          const pillClass = run.status === "running" ? "pill-live" : run.status === "failed" ? "pill-warn" : "pill";
          card.innerHTML =
            '<div class="thumb"><span class="pill ' + pillClass + '">' +
            (statusLabel[run.status] || run.status) + "</span></div>" +
            '<div class="body"><h3></h3>' +
            '<div class="meta"><span>' + (stageLabel[run.stage] || run.stage) + "</span><span>¥" +
            (run.totalCostCny || 0).toFixed(2) + "</span><span>" + fmtTime(run.createdAt) + "</span></div>" +
            '<div class="actions"><button class="btn btn-sm btn-ghost" type="button">看产线</button></div></div>';
          card.querySelector("h3").textContent = run.prompt;

          const open = function (event) {
            if (event) event.stopPropagation();
            location.href = "../workbench/?run=" + encodeURIComponent(run.id);
          };
          card.addEventListener("click", open);
          card.querySelector("button").addEventListener("click", open);
          return card;
        }

        function clearDemoCards() {
          if (!grid) return;
          Array.from(grid.querySelectorAll(".card")).forEach((el) => el.remove());
          const empty = grid.querySelector(".empty-state");
          if (empty) empty.remove();
        }

        function showEmpty() {
          if (!grid) return;
          const box = document.createElement("div");
          box.className = "empty-state";
          box.style.cssText =
            "grid-column:1/-1;padding:36px 20px;border:1px dashed var(--line-2);border-radius:16px;text-align:center;color:var(--text-2);font-size:13.5px;";
          box.innerHTML = "还没有项目。<br />在上面输入一句话，就能开始第一个构建。";
          grid.appendChild(box);
        }

        let allRuns = [];
        let filter = "all";
        const segButtons = Array.from(document.querySelectorAll(".seg button"));

        function renderList() {
          clearDemoCards();
          const list = filter === "all" ? allRuns : allRuns.filter((run) => run.status === filter);
          if (count) count.textContent = String(list.length);
          if (list.length === 0) {
            showEmpty();
            return;
          }
          list.forEach((run) => grid.appendChild(cardFor(run)));
        }

        function paintFilters() {
          const byStatus = { running: 0, done: 0, failed: 0 };
          allRuns.forEach((run) => { byStatus[run.status] = (byStatus[run.status] || 0) + 1; });
          const labels = { all: "全部", running: "进行中", done: "已完成", failed: "未通过" };
          segButtons.forEach((btn) => {
            const key = btn.dataset.filter || "all";
            btn.textContent = labels[key] + (key === "all" ? "" : " " + (byStatus[key] || 0));
            btn.classList.toggle("is-on", key === filter);
          });
        }

        segButtons.forEach((btn, i) => {
          btn.dataset.filter = ["all", "running", "done", "failed"][i] || "all";
          btn.addEventListener("click", function () {
            filter = btn.dataset.filter;
            paintFilters();
            renderList();
          });
        });

        async function load() {
          if (!window.api) return;
          const runs = await window.api.runs(24);
          if (!Array.isArray(runs)) return; // 没有后端 / 未登录：保留演示卡片

          allRuns = runs;
          clearDemoCards();
          paintFilters();
          renderList();
        }

        async function create() {
          const prompt = (newInput && newInput.value ? newInput.value : "").trim();
          if (!prompt) {
            if (newInput) newInput.focus();
            return;
          }
          if (newBtn) {
            newBtn.disabled = true;
            newBtn.textContent = "创建中…";
          }
          try {
            if (window.api) {
              const result = await window.api.createRun(prompt);
              if (result.ok && result.data) {
                location.href = "../workbench/?run=" + encodeURIComponent(result.data.id);
                return;
              }
              if (!result.offline) {
                alert("创建失败，请稍后重试");
                return;
              }
            }
            location.href = "../workbench/?run=new&prompt=" + encodeURIComponent(prompt);
          } finally {
            if (newBtn) {
              newBtn.disabled = false;
              newBtn.textContent = "生成";
            }
          }
        }

        if (newBtn) newBtn.addEventListener("click", create);
        if (newInput) {
          newInput.addEventListener("keydown", function (event) {
            if (event.key === "Enter") create();
          });
        }

        // 退出登录
        const right = document.querySelector(".appbar-right");
        if (right) {
          const out = document.createElement("button");
          out.className = "btn btn-ghost";
          out.type = "button";
          out.textContent = "退出";
          out.style.height = "36px";
          out.style.fontSize = "13px";
          out.addEventListener("click", async function () {
            if (window.api) await window.api.logout();
            if (window.NexusDemo) window.NexusDemo.logout();
            location.href = "../login/";
          });
          right.insertBefore(out, right.querySelector(".avatar"));
        }

        load();
      })();
