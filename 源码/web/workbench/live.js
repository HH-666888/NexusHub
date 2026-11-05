/* 工作台实时接入层。
   职责：把真实接口（run 快照 + 事件流）翻译成页面动作，页面本身不知道数据从哪来。
   没有 run id、或后端不可用时什么都不做，页面继续用它自带的演示时间线。 */
(function () {
  const params = new URLSearchParams(location.search);
  const id = params.get("run") || "";
  const prompt = params.get("prompt") || "";

  if (!window.api) return;

  // 新建：先落库，再把地址换成真实 id 重新进入
  if (id === "new" && prompt) {
    window.api.createRun(prompt, params.get("fast") === "1").then(function (result) {
      if (result && result.ok && result.data) {
        location.replace(
          "./?run=" +
            encodeURIComponent(result.data.id) +
            "&prompt=" +
            encodeURIComponent(prompt),
        );
      }
    });
    return;
  }

  if (!id || /^demo\d+$/.test(id)) return;

  const wb = window.__wb;
  if (!wb) return;

  wb.stopTimeline();
  if (wb.resetFiles) wb.resetFiles();

  const STAGE_OF = { plan: 0, design: 1, build: 2, assemble: 3, test: 4, deliver: 5 };
  const PHASE_OF = {
    spec: 0,
    arch: 1,
    ui: 1,
    building: 2,
    generating: 2,
    saving: 3,
    checking: 4,
    deliver: 5,
    done: 5,
    awaiting: 2,
    failed: 2,
  };

  const state = { events: [], verdict: null, cost: 0, run: null, timer: null };

  function timeOf(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function stageNote(kind, payload) {
    if (kind === "spec") {
      const n = (payload.spec && payload.spec.acceptance && payload.spec.acceptance.length) || 0;
      return n ? n + " 条验收标准" : "规格已定";
    }
    if (kind === "arch") {
      const n = (payload.arch && payload.arch.modules && payload.arch.modules.length) || 0;
      return n ? n + " 个模块" : "架构已定";
    }
    return "";
  }

  /** 一条事件 → 页面动作。回放与实时都走这里，所以刷新不会丢状态。 */
  function apply(kind, payload, at, record) {
    if (record !== false) state.events.push({ kind, payload, at });

    if (kind === "phase") {
      const index = PHASE_OF[payload.phase] ?? 2;
      if (payload.phase === "done") {
        wb.setStage(5);
        wb.setProgress(100);
      } else {
        wb.setStage(index);
        wb.setProgress(Math.min(96, 12 + index * 15));
      }
      wb.setEvent(timeOf(at) + " · " + (payload.label || payload.phase));
      return;
    }

    if (kind === "reasoning" || kind === "text") {
      const text = String(payload.delta || "").slice(0, 40);
      if (text) wb.setEvent(timeOf(at) + " · " + text);
      return;
    }

    if (kind === "spec" || kind === "arch") {
      wb.setEvent(timeOf(at) + " · " + (kind === "spec" ? "需求分析完成" : "架构设计完成"));
      return;
    }

    if (kind === "modules") {
      const items = (payload.batch && payload.batch.modules) || [];
      if (items.length) wb.setBranches(items);
      wb.setEvent(timeOf(at) + " · 拆出 " + items.length + " 条分支，并行开写");
      return;
    }

    if (kind === "file") {
      wb.feedFile(payload.path, payload.lang, payload.delta || "", Boolean(payload.done));
      if (payload.done) {
        wb.markBranchDone(payload.path);
        wb.setEvent(timeOf(at) + " · " + payload.path + " 写完");
      }
      return;
    }

    if (kind === "cost") {
      state.cost = payload.totalCny || state.cost;
      wb.setCost(state.cost);
      return;
    }

    if (kind === "usage") {
      wb.addCall();
      return;
    }

    if (kind === "check") {
      const s = payload.summary || {};
      wb.setEvent(timeOf(at) + " · 自测 " + (s.passed || 0) + " / " + (s.total || 0) + " 通过");
      return;
    }

    if (kind === "verdict") {
      state.verdict = payload;
      renderVerdict();
      wb.setEvent(timeOf(at) + " · 验收 " + (payload.passed || 0) + " / " + (payload.total || 0));
      return;
    }

    if (kind === "artifact") {
      wb.setEvent(timeOf(at) + " · 产物已生成：" + (payload.artifact ? payload.artifact.name : ""));
      return;
    }

    if (kind === "error") {
      wb.setStatus("failed");
      wb.setEvent("出错：" + (payload.message || "未知错误"));
      return;
    }
  }

  function applyRun(run) {
    state.run = run;
    state.cost = Number(run.totalCostCny || 0);
    wb.setCost(state.cost);
    const index = STAGE_OF[run.stage];
    if (typeof index === "number" && run.status !== "done") {
      wb.setStage(index);
      wb.setProgress(Math.min(96, 12 + index * 15));
    }
    if (run.status === "done") {
      wb.setStage(5);
      wb.setProgress(100);
    }
    wb.setStatus(run.status);

    const crumb = document.querySelector(".crumb b");
    if (crumb && run.prompt) {
      crumb.textContent = run.prompt.length > 18 ? run.prompt.slice(0, 18) + "…" : run.prompt;
    }
  }

  // ───────── 订阅 ─────────

  function subscribe() {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/v1/runs/" + encodeURIComponent(id) + "/stream");
    source.onmessage = function (message) {
      let payload;
      try {
        payload = JSON.parse(message.data);
      } catch (error) {
        return;
      }
      const kind = payload.kind;
      if (!kind) return;
      apply(kind, payload, Date.now());
      if (kind === "phase" && payload.phase === "done") {
        wb.setStatus("done");
        source.close();
      }
    };
    source.onerror = function () {
      // 浏览器会自己重连；这里只更新状态文案
      wb.setEvent("连接中断，正在重连…");
    };
  }

  // ───────── 控件 ─────────

  function pauseButton() {
    return document.querySelector('.appbar-right button[aria-label="暂停"]');
  }

  function wireControls() {
    const pause = pauseButton();
    if (pause) {
      pause.addEventListener("click", async function () {
        const paused = pause.getAttribute("aria-label") === "继续";
        const path = paused ? "/resume" : "/pause";
        const result = await fetch("/api/v1/runs/" + encodeURIComponent(id) + path, {
          method: "POST",
          credentials: "include",
        });
        if (!result.ok) return;
        pause.setAttribute("aria-label", paused ? "暂停" : "继续");
        pause.innerHTML = paused
          ? '<svg viewBox="0 0 24 24" aria-hidden><path d="M9 5v14M15 5v14" stroke-width="2" /></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden><path d="M8 5l11 7-11 7z" stroke-width="2" /></svg>';
        wb.setStatus(paused ? "running" : "paused");
      });
    }

    const right = document.querySelector(".appbar-right");
    if (right && !document.getElementById("cancel-run")) {
      const cancel = document.createElement("button");
      cancel.className = "btn btn-sm btn-ghost";
      cancel.type = "button";
      cancel.id = "cancel-run";
      cancel.textContent = "取消";
      cancel.addEventListener("click", async function () {
        cancel.disabled = true;
        await fetch("/api/v1/runs/" + encodeURIComponent(id) + "/cancel", {
          method: "POST",
          credentials: "include",
        });
        wb.setStatus("cancelled");
        cancel.textContent = "已取消";
      });
      right.insertBefore(cancel, pause || right.firstChild);
    }
  }

  // ───────── 三个 tab ─────────

  function ensurePane(name) {
    let pane = document.getElementById("pane-" + name);
    if (pane) return pane;
    pane = document.createElement("div");
    pane.id = "pane-" + name;
    pane.style.cssText = "display:none;flex:1;min-height:0;overflow:auto;padding:12px;";
    const body = document.getElementById("code-body");
    body.parentNode.insertBefore(pane, body.nextSibling);
    return pane;
  }

  function showTab(which) {
    const body = document.getElementById("code-body");
    const tabs = document.querySelector(".code-head .tabs");
    if (tabs) {
      Array.from(tabs.children).forEach(function (btn) {
        btn.classList.toggle("is-on", btn.textContent.trim() === which);
      });
    }
    ["preview", "verdict"].forEach(function (name) {
      const pane = document.getElementById("pane-" + name);
      if (pane) pane.style.display = "none";
    });
    const isCode = which === "代码";
    if (body) body.style.display = isCode ? "" : "none";
    const fileTabs = document.getElementById("file-tabs");
    if (fileTabs) fileTabs.style.display = isCode ? "" : "none";
    const fileRow = document.querySelector(".code-file");
    if (fileRow) fileRow.style.display = isCode ? "" : "none";
    const reviewBar = document.getElementById("review-bar");
    if (reviewBar) reviewBar.classList.toggle("is-hidden", !isCode);

    if (which === "预览") {
      const pane = ensurePane("preview");
      pane.style.display = "block";
      openPreview(pane);
    }

    if (which === "验收") {
      const pane = ensurePane("verdict");
      pane.style.display = "block";
      renderVerdict();
    }
  }

  /** 预览优先用真正跑起来的进程；起不来再退回产物 HTML */
  async function openPreview(pane) {
    if (pane.dataset.ready === "1") return;
    pane.dataset.ready = "1";
    pane.innerHTML = '<p style="color:var(--text-3);font-size:13px;">正在启动预览…</p>';

    let src = "/api/v1/runs/" + encodeURIComponent(id) + "/artifact";
    try {
      const response = await fetch("/api/v1/runs/" + encodeURIComponent(id) + "/runtime", {
        method: "POST",
        credentials: "include",
      });
      if (response.ok) {
        const info = await response.json();
        if (info.previewUrl) src = info.previewUrl;
      }
    } catch (error) {
      /* 起不来就用产物 HTML */
    }

    const frame = document.createElement("iframe");
    frame.style.cssText = "width:100%;height:100%;border:1px solid var(--line);border-radius:12px;background:#fff;";
    frame.src = src;
    pane.innerHTML = "";
    pane.appendChild(frame);
    pane.dataset.ready = "0";
  }

  function renderVerdict() {
    const pane = document.getElementById("pane-verdict");
    if (!pane) return;
    if (!state.verdict) {
      pane.innerHTML = '<p style="color:var(--text-3);font-size:13px;">还没有验收结果，等它跑完。</p>';
      return;
    }
    const v = state.verdict;
    const layers = (v.layers || [])
      .map(function (layer) {
        const checks = (layer.checks || [])
          .map(function (c) {
            return (
              '<div style="display:flex;gap:8px;font-size:12.5px;padding:3px 0;">' +
              '<span style="color:' + (c.pass ? "#10b981" : "#dc2626") + ';">' + (c.pass ? "✓" : "✗") + "</span>" +
              "<span>" + c.name + "</span></div>"
            );
          })
          .join("");
        return (
          '<div style="margin-bottom:12px;">' +
          '<div style="font-size:13px;font-weight:600;margin-bottom:4px;">' +
          layer.layer + " · " + layer.passed + "/" + layer.total + "</div>" +
          checks +
          "</div>"
        );
      })
      .join("");
    pane.innerHTML =
      '<div style="font-size:13px;margin-bottom:10px;">合计 <b>' + v.passed + "</b> / " + v.total + "</div>" + layers;
  }

  function wireTabs() {
    const head = document.querySelector(".code-head .tabs");
    if (head) {
      Array.from(head.children).forEach(function (btn) {
        btn.addEventListener("click", function () {
          showTab(btn.textContent.trim());
        });
      });
    }

    const bottom = document.querySelector(".statusbar .tabs");
    if (bottom) {
      Array.from(bottom.children).forEach(function (btn) {
        btn.addEventListener("click", async function () {
          Array.from(bottom.children).forEach((b) => b.classList.toggle("is-on", b === btn));
          const which = btn.textContent.trim();
          if (which === "终端") {
            wb.setEvent("容器未启动：产物已生成，但还没有跑运行时");
            return;
          }
          if (which === "验收") {
            const result = await fetch("/api/v1/runs/" + encodeURIComponent(id) + "/verdict", {
              credentials: "include",
            });
            if (!result.ok) {
              wb.setEvent("还没有验收结果");
              return;
            }
            const verdict = await result.json();
            state.verdict = verdict;
            wb.setEvent("验收：" + (verdict.passed || 0) + " / " + (verdict.total || 0) + " 通过");
            return;
          }
          wb.setEvent("事件 " + state.events.length + " 条");
        });
      });
    }
  }

  // ───────── 重播（本地，不请求后端） ─────────

  function rebind(id, handler) {
    const el = document.getElementById(id);
    if (!el) return;
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    clone.addEventListener("click", handler);
  }

  function stopReplay() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function replayAll() {
    stopReplay();
    wb.resetFiles();
    wb.setStage(0);
    wb.setProgress(0);
    wb.setStatus("running");

    let index = 0;
    state.timer = setInterval(function () {
      if (index >= state.events.length) {
        stopReplay();
        wb.setStatus("done");
        wb.setProgress(100);
        return;
      }
      const item = state.events[index++];
      apply(item.kind, item.payload, item.at, false);
    }, 150);
  }

  function replayFile() {
    stopReplay();
    const name = document.getElementById("file-name");
    const path = name ? name.textContent.trim() : "";
    if (!path) return;
    const items = state.events.filter(function (item) {
      return item.kind === "file" && item.payload && item.payload.path === path;
    });
    if (!items.length) return;

    wb.resetFile(path);
    let index = 0;
    state.timer = setInterval(function () {
      if (index >= items.length) {
        stopReplay();
        return;
      }
      const item = items[index++];
      wb.feedFile(item.payload.path, item.payload.lang, item.payload.delta || "", Boolean(item.payload.done));
    }, 120);
  }

  function backToLive() {
    stopReplay();
    wb.resetFiles();
    state.events.forEach(function (item) {
      apply(item.kind, item.payload, item.at, false);
    });
    if (state.run) applyRun(state.run);
  }

  // ───────── 启动 ─────────

  (async function boot() {
    document.body.classList.add("is-live");
    wb.setEvent("已连接，等待第一个事件…");

    // 顶栏预算用设置里的真实上限
    try {
      const settings = await window.api.settings();
      const limit = settings && typeof settings.budgetPerRun === "number" ? settings.budgetPerRun : null;
      const pill = document.querySelector(".appbar-right .pill-plain");
      if (pill && limit !== null) pill.textContent = "¥0.00 / ¥" + Number(limit).toFixed(2);
    } catch (error) {
      /* 读不到就保持原样 */
    }

    const run = await window.api.run(id);
    if (run) applyRun(run);

    const events = await window.api.events(id);
    if (Array.isArray(events)) {
      events.forEach(function (item) {
        apply(item.kind, item.payload, item.createdAt || Date.now());
      });
      if (run) applyRun(run); // 回放后再对齐一次状态
    }

    wireControls();
    wireTabs();
    rebind("replay", replayAll);
    rebind("replay-file", replayFile);
    rebind("back-live", backToLive);
    subscribe();
  })();
})();