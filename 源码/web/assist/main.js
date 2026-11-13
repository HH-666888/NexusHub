/* 辅助项目列表：只渲染真实项目，空态用占位。 */
(function () {
  const input = document.getElementById("goal");
  const createBtn = document.getElementById("create");
  const list = document.getElementById("list");
  const count = document.getElementById("count");

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  function card(project) {
    const el = document.createElement("article");
    el.className = "assist-card";
    el.dataset.id = project.id;
    const findings = project.findings || {};
    el.innerHTML =
      "<h3>" + escapeHtml(project.title) + "</h3>" +
      '<div class="meta">' +
        '<span class="pill-stage">' + escapeHtml(project.stageLabel) + "</span>" +
        "<span>" + project.files.length + " 个文件</span>" +
        "<span>" + (findings.open || 0) + " 个待处理</span>" +
      "</div>" +
      '<div class="foot">' +
        '<button class="btn btn-sm btn-ghost" type="button" data-act="open">继续</button>' +
        '<button class="btn btn-sm btn-ghost" type="button" data-act="del">删除</button>' +
      "</div>";
    el.addEventListener("click", function (event) {
      const act = event.target.dataset ? event.target.dataset.act : "";
      if (act === "del") {
        event.stopPropagation();
        if (confirm("删除这个辅助项目？")) {
          window.api.deleteAssist(project.id).then(load);
        }
        return;
      }
      location.href = "./workspace/?id=" + encodeURIComponent(project.id);
    });
    return el;
  }

  async function load() {
    const data = await window.api.assistProjects();
    if (!data) {
      list.innerHTML = '<div class="assist-empty">加载失败，请刷新重试。</div>';
      return;
    }
    count.textContent = String(data.projects.length);
    if (!data.projects.length) {
      list.innerHTML =
        '<div class="assist-empty">还没有辅助项目。<br />在上面写一句你要做的软件，创建后按六道工序一步一步做。</div>';
      return;
    }
    list.innerHTML = "";
    data.projects.forEach(function (project) {
      list.appendChild(card(project));
    });
  }

  async function create() {
    const goal = (input.value || "").trim();
    if (!goal) {
      input.focus();
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = "创建中…";
    const result = await window.api.createAssist(goal);
    createBtn.disabled = false;
    createBtn.textContent = "创建辅助项目";
    if (result.ok && result.data) {
      location.href = "./workspace/?id=" + encodeURIComponent(result.data.id);
      return;
    }
    alert(result.data && result.data.error ? result.data.error.message : "创建失败，请重试");
  }

  createBtn.addEventListener("click", create);
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter") create();
  });

  (async function boot() {
    load();
  })();
})();