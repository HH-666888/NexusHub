// 项目页真数据：列表、空状态、新建、退出登录
      (function () {
        const grid = document.querySelector(".grid");
        const count = document.querySelector(".count");
        const newBar = document.querySelector(".new-bar");
        const newInput = newBar ? newBar.querySelector("input") : null;
        const newBtn = newBar ? newBar.querySelector("button") : null;

        // 与后端 StageId 对应：plan / design / build / assemble / test / deliver
        const stageLabel = {
          plan: "需求分析", design: "架构设计", build: "自主开发",
          assemble: "集成装配", test: "自动测试", deliver: "验收交付",
        };
        const statusLabel = {
          running: "运行中", paused: "已暂停", done: "已完成",
          failed: "失败", cancelled: "已取消",
        };

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
          const pillClass =
            run.status === "running" ? "pill-live"
              : run.status === "failed" || run.status === "paused" || run.status === "cancelled" ? "pill-warn"
                : "pill";
          card.innerHTML =
            '<div class="thumb">' +
            '<span class="tl a"></span><span class="tl b"></span><span class="tb"></span>' +
            '<span class="pill ' + pillClass + '">' +
            (statusLabel[run.status] || run.status) + "</span></div>" +
            '<div class="body"><h3></h3>' +
            '<div class="meta"><span>' + (stageLabel[run.stage] || run.stage) + "</span><span>¥" +
            (run.totalCostCny || 0).toFixed(2) + "</span><span>" + fmtTime(run.createdAt) + "</span></div>" +
            '<div class="actions"><button class="btn btn-sm btn-ghost" type="button" data-open>看产线</button>' +
            '<button class="btn btn-sm btn-ghost card-del" type="button" data-del>删除</button></div></div>';
          card.querySelector("h3").textContent = run.prompt;

          const open = function (event) {
            if (event) event.stopPropagation();
            location.href = "../workbench/?run=" + encodeURIComponent(run.id);
          };
          card.addEventListener("click", open);
          card.querySelector("[data-open]").addEventListener("click", open);

          // 删除：二次确认，成功后从列表和统计里一起拿掉
          const delBtn = card.querySelector("[data-del]");
          delBtn.addEventListener("click", async function (event) {
            event.stopPropagation();
            const name = run.prompt || "这次运行";
            if (!window.confirm("删除「" + name + "」？删除后不能恢复。")) return;

            delBtn.disabled = true;
            delBtn.textContent = "删除中…";
            const result = window.api ? await window.api.deleteRun(run.id) : { ok: false };
            if (!result.ok) {
              delBtn.disabled = false;
              delBtn.textContent = "删除";
              alert(result.offline ? "后端没启动，删不了" : "删除失败，请重试");
              return;
            }

            allRuns = allRuns.filter((item) => item.id !== run.id);
            paintFilters();
            renderList();
            updateStats(allRuns);
          });

          return card;
        }

        function clearCards() {
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
          let usageToday = null;
        let filter = "all";
        const state = {};
        const segButtons = Array.from(document.querySelectorAll(".seg button"));

        function renderList() {
          clearCards();
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
          if (!Array.isArray(runs)) return; // 没有后端 / 未登录：保留空态

          allRuns = runs;
          clearCards();
          paintFilters();
          renderList();
            usageToday = await window.api.usageToday();
            updateStats(runs);
        }

        /** 顶栏预算与页脚统计：都按「今天」算，不写死 */
          function money(value) {
            const amount = Number(value || 0);
            return amount > 0 && amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
          }

          function updateStats(runs) {
            const start = new Date();
            start.setHours(0, 0, 0, 0);
            const todayCost = usageToday
              ? Number(usageToday.totalCny || 0)
              : runs
                  .filter((run) => new Date(run.createdAt) >= start)
                  .reduce((sum, run) => sum + Number(run.totalCostCny || 0), 0);

            const headPill = document.querySelector(".appbar-right .pill-plain");
            if (headPill) headPill.textContent = "今日估算 ¥" + money(todayCost);

            const footCount = document.getElementById("foot-count");
            if (footCount) footCount.textContent = "共 " + runs.length + " 个项目";

            const footBudget = document.getElementById("foot-budget");
            if (footBudget) footBudget.textContent = "今日估算 ¥" + money(todayCost);
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

        load();
      })();
