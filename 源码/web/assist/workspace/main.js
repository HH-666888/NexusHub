/* 辅助工作台：六阶段、文件、检查、AI 助手。 */
(function () {
  const params = new URLSearchParams(location.search);
  const projectId = params.get("id") || "";
  const STAGE_HINTS = {
    design: "先把模块和文件定下来，再写代码；右边可以问 AI「还缺哪个模块」。",
    build: "你自己写代码，AI 只审查不代写；保存后点“检查”。",
    assemble: "把入口、依赖、启动方式补齐；检查会看静态资源与外部引用。",
    test: "从验收标准出发写用例；失败原因贴到右边问 AI。",
    deliver: "过一遍上线前清单：依赖、密钥、错误处理、README。",
  };

  const state = {
    project: null,
    currentPath: "",
    content: "",
    findings: [],
    dirty: false,
    previous: null,
    previousPath: "",
  };

  const rail = document.getElementById("rail");
  const stageTitle = document.getElementById("stage-title");
  const stagePill = document.getElementById("stage-pill");
  const body = document.getElementById("stage-body");
  const findingsBox = document.getElementById("findings");
  const findingCount = document.getElementById("finding-count");
  const coachLog = document.getElementById("coach-log");
  const coachInput = document.getElementById("coach-input");
  const modeSelect = document.getElementById("mode");
  const advanceBtn = document.getElementById("advance");
  const crumbTitle = document.getElementById("crumb-title");
  const memoryPill = document.getElementById("memory-pill");

  async function loadMemoryStats() {
    if (!window.api || !window.api.memoryStats) return;
    const stats = await window.api.memoryStats();
    if (!stats || !memoryPill) return;
    memoryPill.textContent = "记忆 " + stats.total + " 条 · 今日 " + stats.today + "/" + stats.dailyLimit;
  }

  function esc(text) {
    return String(text).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  function stageIndex() {
    return (state.project.stages || []).findIndex(function (s) {
      return s.id === state.stage;
    });
  }

  function stageLabel(id) {
    const found = (state.project.stages || []).find(function (s) {
      return s.id === id;
    });
    return found ? found.label : id;
  }

  function renderRail() {
    rail.innerHTML = '<div class="rail-title">六道工序</div>';
    (state.project.stages || []).forEach(function (stage, index) {
      const current = (state.project.stages || []).findIndex(function (s) {
        return s.id === state.stage;
      });
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "stage-item" +
        (stage.id === state.stage ? " is-on" : "") +
        (index < current ? " is-done" : "") +
        (index > current ? " is-wait" : "");
      btn.innerHTML = '<span class="no">0' + (index + 1) + "</span><span>" + esc(stage.label) + "</span>";
      btn.addEventListener("click", function () {
        if (stage.id === state.stage) return;
        goStage(stage.id, false);
      });
      rail.appendChild(btn);
    });
  }

  function saveGoal() {
    const area = document.getElementById("goal-text");
    if (!area) return Promise.resolve();
    return window.api.updateAssist(projectId, { goal: area.value }).then(loadProject);
  }

  function renderPlan() {
    body.innerHTML =
      '<div class="plan-box">' +
        "<label style=\"font-size:12.5px;color:var(--text-2);\">这个软件要解决什么？写给谁？做到什么算完成？</label>" +
        '<textarea id="goal-text" placeholder="例如：做一个团队任务看板，支持拖拽换列，刷新后数据还在。">' +
        esc(state.project.goal || "") +
        "</textarea>" +
        '<div style="display:flex;gap:8px;">' +
          '<button class="btn btn-primary btn-sm" type="button" id="save-goal">保存需求</button>' +
          '<span class="code-hint">保存后，右侧可以问 AI「需求还缺什么」。</span>' +
        "</div>" +
      "</div>";
    document.getElementById("save-goal").addEventListener("click", saveGoal);
  }

  function langHint(path) {
    if (/\.py$/.test(path)) return "Python";
    if (/\.java$/.test(path)) return "Java";
    if (/\.js$/.test(path)) return "JavaScript";
    if (/\.html?$/.test(path)) return "HTML";
    if (/\.css$/.test(path)) return "CSS";
    if (/\.sql$/.test(path)) return "SQL";
    return "文本";
  }

  function renderCodeStage() {
    const files = state.project.files || [];
    body.innerHTML =
      '<div class="file-bar">' +
        '<div class="file-tabs" id="file-tabs"></div>' +
        '<span class="grow" style="flex:1;"></span>' +
        '<input type="text" id="new-path" placeholder="新文件，如 app.py" />' +
        '<button class="btn btn-sm btn-ghost" type="button" id="add-file">新建</button>' +
        '<button class="btn btn-sm btn-primary" type="button" id="save-file">保存</button>' +
        '<button class="btn btn-sm btn-ghost" type="button" id="del-file">删除</button>' +
        '<button class="btn btn-sm btn-ghost" type="button" id="analyze">检查</button>' +
      "</div>" +
      '<textarea class="code-editor" id="code" spellcheck="false" placeholder="在这里写代码；保存后可以点“检查”。"></textarea>' +
      '<p class="code-hint" id="editor-hint">还没有选择文件。</p>';

    const tabs = document.getElementById("file-tabs");
    files.forEach(function (file) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.path = file.path;
      btn.className = file.path === state.currentPath ? "is-on" : "";
      btn.textContent = file.path;
      btn.addEventListener("click", function () {
        selectFile(file.path);
      });
      tabs.appendChild(btn);
    });

    const editor = document.getElementById("code");
    editor.value = state.content || "";
    editor.addEventListener("input", function () {
      state.content = editor.value;
      state.dirty = true;
      updateHint();
    });

    enhanceEditor();

    document.getElementById("save-file").addEventListener("click", saveFile);
    document.getElementById("add-file").addEventListener("click", addFile);
    document.getElementById("del-file").addEventListener("click", deleteFile);
    document.getElementById("analyze").addEventListener("click", analyze);
    updateHint();
  }

  function cmMode(path) {
    if (/\.py$/.test(path)) return "python";
    if (/\.java$/.test(path)) return "text/x-java";
    if (/\.js$/.test(path)) return "javascript";
    if (/\.html?$/.test(path)) return "xml";
    if (/\.css$/.test(path)) return "css";
    if (/\.sql$/.test(path)) return "text/x-sql";
    return null;
  }

  function enhanceEditor() {
    const area = document.getElementById("code");
    if (!area || !window.CodeMirror) return;
    const editor = window.CodeMirror.fromTextArea(area, {
      mode: cmMode(state.currentPath),
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      lineWrapping: false,
    });
    editor.setSize(null, 420);
    editor.on("change", function () {
      state.content = editor.getValue();
      state.dirty = true;
      updateHint();
    });
  }

  function updateHint() {
    const hint = document.getElementById("editor-hint");
    if (!hint) return;
    if (!state.currentPath) {
      hint.textContent = "还没有选择文件。先新建一个，比如 app.py。";
      return;
    }
    hint.textContent =
      state.currentPath + " · " + langHint(state.currentPath) + (state.dirty ? " · 有未保存修改" : " · 已保存");
  }

  function renderStage() {
    const stage = state.stage;
    const label = stageLabel(stage);
    stageTitle.textContent = label;
    stagePill.textContent = "第 " + (stageIndex() + 1) + " 道 · " + label;
    if (stage === "plan") {
      renderPlan();
    } else {
      renderCodeStage();
      const hint = document.createElement("p");
      hint.className = "code-hint";
      hint.style.margin = "0 0 10px";
      hint.textContent = STAGE_HINTS[stage] || "";
      body.insertBefore(hint, body.firstChild);
    }
  if (stage === "test") renderTestPanel();
  if (stage === "deliver") renderDeliverPanel();
    advanceBtn.style.display = stage === "deliver" ? "none" : "";
  }

  function addStagePanel(title, meta) {
    const section = document.createElement("section");
    section.className = "stage-extra";
    section.innerHTML = '<div class="extra-head"><b>' + title + '</b><span>' + (meta || "") + '</span></div><div class="extra-body"></div>';
    body.insertBefore(section, body.firstChild);
    return section;
  }

  async function renderTestPanel() {
    const tests = (await window.api.assistTests(projectId)) || [];
    const section = addStagePanel("测试用例", tests.length + " 条");
    const box = section.querySelector(".extra-body");
    box.innerHTML = '<form class="test-form" id="test-form"><input id="test-title" placeholder="用例标题，例如：新增待办后出现在列表" maxlength="200" /><input id="test-expected" placeholder="预期结果" maxlength="200" /><button class="btn btn-sm btn-primary" type="submit">添加</button></form><div class="test-list" id="test-list"></div>';
    const list = box.querySelector("#test-list");
    function paint(items) {
      if (!items.length) { list.innerHTML = '<div class="extra-empty">还没有测试用例。先写一条，再标记通过或失败。</div>'; return; }
      list.innerHTML = "";
      items.forEach(function (item) {
        const row = document.createElement("div");
        row.className = "test-row";
        const statusText = item.status === "pass" ? "通过" : item.status === "fail" ? "失败" : "待测";
        row.innerHTML = '<div class="test-main"><b>' + esc(item.title) + '</b>' + (item.expected ? '<small>预期：' + esc(item.expected) + '</small>' : '') + '</div><span class="test-status ' + item.status + '">' + statusText + '</span><div class="test-acts"><button type="button" data-status="pass">通过</button><button type="button" data-status="fail">失败</button><button type="button" data-del>删除</button></div>';
        row.querySelector('[data-status="pass"]').addEventListener("click", async function () { await window.api.updateAssistTest(item.id, { status: "pass" }); paint((await window.api.assistTests(projectId)) || []); });
        row.querySelector('[data-status="fail"]').addEventListener("click", async function () { await window.api.updateAssistTest(item.id, { status: "fail" }); paint((await window.api.assistTests(projectId)) || []); });
        row.querySelector("[data-del]").addEventListener("click", async function () { if (!confirm("删除这条测试用例？")) return; await window.api.deleteAssistTest(item.id); paint((await window.api.assistTests(projectId)) || []); });
        list.appendChild(row);
      });
    }
    paint(tests);
    box.querySelector("#test-form").addEventListener("submit", async function (event) {
      event.preventDefault();
      const title = box.querySelector("#test-title").value.trim();
      const expected = box.querySelector("#test-expected").value.trim();
      if (!title) return;
      await window.api.createAssistTest(projectId, { title, expected });
      paint((await window.api.assistTests(projectId)) || []);
      box.querySelector("#test-title").value = "";
      box.querySelector("#test-expected").value = "";
    });
  }

  async function renderDeliverPanel() {
    const data = await window.api.assistDeliverable(projectId);
    const section = addStagePanel("交付检查", data ? data.passed + "/" + data.total + " 通过" : "—");
    const box = section.querySelector(".extra-body");
    if (!data) { box.innerHTML = '<div class="extra-empty">检查结果暂时读不到。</div>'; return; }
    box.innerHTML = '<div class="deliver-list">' + data.checks.map(function (item) {
      return '<div class="deliver-row ' + (item.pass ? "pass" : "fail") + '"><b>' + (item.pass ? "✓" : "✗") + '</b><span>' + esc(item.name) + '</span><small>' + esc(item.detail) + '</small></div>';
    }).join("") + "</div>";
  }

  async function loadProject() {
    const project = await window.api.assistProject(projectId);
    if (!project) {
      document.body.innerHTML = '<main class="assist-page"><div class="assist-empty">项目不存在或已被删除。<br /><a href="../">回到辅助开发</a></div></main>';
      return;
    }
    state.project = project;
    if (!state.stage) state.stage = project.stage;
    if (project.mode) modeSelect.value = project.mode;
    crumbTitle.textContent = project.title;
    document.title = project.title + " · 辅助开发";
    renderRail();
    if (!state.currentPath && project.files.length) {
      state.currentPath = project.files[0].path;
      const file = await window.api.assistFile(projectId, state.currentPath);
      state.content = file ? file.content : "";
    }
    renderStage();
    loadFindings();
  }

  let stageTimer = null;

  function goStage(stage, persist) {
    state.stage = stage;
    renderRail();
    renderStage();
    if (!persist) return;

    clearTimeout(stageTimer);
    stageTimer = setTimeout(function () {
      window.api.updateAssist(projectId, { stage }).then(function () {
        loadMemoryStats();
      });
    }, 250);
  }

  async function selectFile(path) {
    if (state.dirty && !confirm("当前文件还没保存，切换会丢掉修改，继续？")) return;
    state.currentPath = path;
    const file = await window.api.assistFile(projectId, path);
    state.content = file ? file.content : "";
    state.dirty = false;
    renderStage();
  }

  async function saveFile() {
    if (!state.currentPath) return;
    const result = await window.api.saveAssistFile(projectId, state.currentPath, state.content);
    if (result.ok) {
      state.dirty = false;
      await loadProject();
    }
  }

  async function addFile() {
    const path = (document.getElementById("new-path").value || "").trim();
    if (!path) return;
    const result = await window.api.saveAssistFile(projectId, path, "");
    if (result.ok) {
      state.currentPath = path;
      state.content = "";
      state.dirty = false;
      await loadProject();
    }
  }

  async function deleteFile() {
    if (!state.currentPath) return;
    if (!confirm("删除文件 " + state.currentPath + "？")) return;
    const response = await fetch(
      "/api/assist/projects/" + encodeURIComponent(projectId) + "/file?path=" + encodeURIComponent(state.currentPath),
      { method: "DELETE", credentials: "include" },
    );
    if (response.ok) {
      state.currentPath = "";
      state.content = "";
      await loadProject();
    }
  }

  async function analyze() {
    if (!state.currentPath) return;
    if (state.dirty) await saveFile();
    const result = await window.api.analyzeAssist(projectId);
    if (!result.ok) {
      alert("检查失败，请重试");
      return;
    }
    await loadFindings();
    const project = await window.api.assistProject(projectId);
    if (project) {
      state.project = project;
      renderRail();
    }
  }

  function findingEl(item) {
    const el = document.createElement("div");
    el.className = "finding";
    el.innerHTML =
      '<div><span class="badge ' + esc(item.severity) + '"></span>' + esc(item.message) + "</div>" +
      '<div class="where">' + esc(item.path) + ":" + item.line + " · " + esc(item.stageLabel) + "</div>" +
      '<div class="acts">' +
        '<button type="button" data-act="fixed">已修</button>' +
        '<button type="button" data-act="ignored">忽略</button>' +
      "</div>";
    el.querySelector('[data-act="fixed"]').addEventListener("click", function () {
      window.api.updateFinding(item.id, "fixed").then(loadFindings);
    });
    el.querySelector('[data-act="ignored"]').addEventListener("click", function () {
      window.api.updateFinding(item.id, "ignored").then(loadFindings);
    });
    return el;
  }

  async function loadFindings() {
    const items = await window.api.assistFindings(projectId, "open");
    state.findings = items || [];
    findingsBox.innerHTML = "";
    findingCount.textContent = String(state.findings.length);
    if (!state.findings.length) {
      findingsBox.innerHTML =
        '<div class="findings-empty">还没有检查结果。<br />写好文件后点“检查”。</div>';
      return;
    }
    state.findings.forEach(function (item) {
      findingsBox.appendChild(findingEl(item));
    });
  }

  function addCitations(el, citations) {
    if (!citations || !citations.length) return;
    const cite = document.createElement("span");
    cite.className = "cite";
    cite.textContent = "参考了 " + citations.length + " 条记忆：" + citations.map(function (c) { return c.title; }).join("、");
    el.appendChild(cite);
    document.getElementById("cite-count").textContent = "记忆 " + citations.length + " 条";
  }

  function appendCoach(kind, text, citations) {
    const el = document.createElement("div");
    el.className = "coach-msg " + kind;
    el.textContent = text;
    addCitations(el, citations);
    coachLog.appendChild(el);
    coachLog.scrollTop = coachLog.scrollHeight;
    return el;
  }

  function appendStreamBubble() {
    const el = document.createElement("div");
    el.className = "coach-msg ai streaming";
    coachLog.appendChild(el);
    coachLog.scrollTop = coachLog.scrollHeight;
    return el;
  }

  async function streamCoach(message) {
    if (message) appendCoach("user", message);
    const el = appendStreamBubble();
    let result = null;
    try {
      result = await window.api.assistCoachStream(
        projectId,
        message,
        state.stage,
        modeSelect.value,
        function (delta) {
          el.textContent += delta;
          coachLog.scrollTop = coachLog.scrollHeight;
        },
      );
    } catch (error) {
      result = null;
    }

    if (!result || !result.reply) {
      const fallback = await window.api.assistCoach(projectId, message, state.stage, modeSelect.value);
      if (!fallback) {
        el.classList.remove("streaming");
        el.textContent = "AI 暂时没有响应，请稍后再试。";
        return;
      }
      el.textContent = fallback.reply;
      addCitations(el, fallback.citations);
      result = fallback;
    } else {
      addCitations(el, result.citations);
    }
    el.classList.remove("streaming");
    if (modeSelect.value === "suggest" && state.currentPath && message && result !== null) {
      addSuggestApply(el, message);
    }
    loadMemoryStats();
    return el;
  }

  async function sendCoach() {
    const message = (coachInput.value || "").trim();
    if (message) appendCoach("user", message);
    coachInput.value = "";

    if (modeSelect.value === "auto" && state.currentPath && message) {
      const result = await window.api.applyAssist(projectId, state.currentPath, message);
      if (result.ok && result.data) {
        state.previous = result.data.previous;
        state.previousPath = result.data.path;
        state.content = result.data.content;
        state.dirty = false;
        appendCoach("ai", "已修改 " + result.data.path + "。" + (result.data.note || "") + "\n可以点下面的“撤销这次修改”。");
        addUndo();
        await loadProject();
        await analyze();
        return;
      }
      const detail = result.data && result.data.error ? result.data.error.message : "修改失败";
      appendCoach("ai", "自动修改没有成功：" + detail + "。可以切回“协作”模式看建议。");
      return;
    }

    if (modeSelect.value === "agent") {
      await runAgent(message);
      return;
    }

    await streamCoach(message);
  }

  async function runAgent(message) {
    const bubble = appendCoach("ai", "正在调用工具…");
    const result = await window.api.assistAgent(projectId, message, state.stage);
    bubble.textContent = "";
    if (!result) {
      bubble.textContent = "Agent 暂时没有响应，请稍后再试。";
      return;
    }
    const tools = result.tools || [];
    if (tools.length) {
      const wrap = document.createElement("div");
      wrap.className = "tool-traces";
      tools.forEach(function (item) {
        const row = document.createElement("div");
        row.className = "tool-call";
        const title = document.createElement("b");
        title.textContent = "🔧 " + item.name;
        const meta = document.createElement("small");
        const args = JSON.stringify(item.arguments || {});
        meta.textContent = args + " · " + item.ms + "ms";
        const body = document.createElement("div");
        body.className = "tool-result";
        body.textContent = item.result || "";
        row.appendChild(title);
        row.appendChild(meta);
        row.appendChild(body);
        wrap.appendChild(row);
      });
      bubble.appendChild(wrap);
    }
    const answer = document.createElement("div");
    answer.className = "agent-answer";
    answer.textContent = result.reply || "";
    bubble.appendChild(answer);
    addCitations(bubble, result.citations);
    coachLog.scrollTop = coachLog.scrollHeight;
  }

  function addSuggestApply(el, message) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm btn-ghost";
    btn.style.marginTop = "6px";
    btn.textContent = "按这条建议改代码";
    btn.addEventListener("click", async function () {
      btn.disabled = true;
      btn.textContent = "生成改动中…";
      const result = await window.api.applyAssist(projectId, state.currentPath, message, true);
      btn.disabled = false;
      btn.textContent = "按这条建议改代码";
      if (!result.ok || !result.data) {
        appendCoach("ai", "生成改动失败，可以换个说法再试。");
        return;
      }
      if (!confirm("AI 建议修改 " + result.data.path + "，是否应用？")) {
        appendCoach("ai", "已保留建议，没有修改文件。");
        return;
      }
      await window.api.saveAssistFile(projectId, result.data.path, result.data.content);
      state.previous = result.data.previous;
      state.previousPath = result.data.path;
      state.content = result.data.content;
      state.dirty = false;
      appendCoach("ai", "已应用对 " + result.data.path + " 的修改。");
      addUndo();
      await loadProject();
      await analyze();
    });
    el.appendChild(btn);
  }

  function addUndo() {
    const last = coachLog.lastElementChild;
    if (!last) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm btn-ghost";
    btn.style.marginTop = "6px";
    btn.textContent = "撤销这次修改";
    btn.addEventListener("click", async function () {
      if (state.previous === null) return;
      await window.api.saveAssistFile(projectId, state.previousPath, state.previous);
      state.previous = null;
      appendCoach("ai", "已撤销 " + state.previousPath + " 的修改。");
      await loadProject();
    });
    last.appendChild(btn);
  }

  document.getElementById("coach-send").addEventListener("click", sendCoach);
  document.getElementById("ask-stage").addEventListener("click", async function () {
    await streamCoach("帮我看这一步还缺什么");
  });
  coachInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendCoach();
    }
  });
  modeSelect.addEventListener("change", function () {
    window.api.updateAssist(projectId, { mode: modeSelect.value });
    if (modeSelect.value === "auto") {
      appendCoach("ai", "自动模式：会直接修改当前文件，改完可以撤销。");
    }
  });
  advanceBtn.addEventListener("click", function () {
    const stages = state.project.stages || [];
    const index = stageIndex();
    if (index >= 0 && index < stages.length - 1) {
      goStage(stages[index + 1].id, true);
    }
  });

  (async function boot() {
    if (!projectId) {
      location.replace("../");
      return;
    }
    await loadProject();
    loadMemoryStats();
    window.api.skills().then(function (items) {
      const pill = document.getElementById("skill-pill");
      if (pill && items && items.length) {
        pill.textContent = "Skill " + items[0].version;
        pill.title = items[0].name + " · " + (items[0].stages || []).length + " 道工序";
      }
    });
  })();
})();