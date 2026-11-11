/* AI 记忆页：按天展示，可置顶/删除/导出/清空。 */
(function () {
  const statsBox = document.getElementById("stats");
  const groupsBox = document.getElementById("groups");

  function esc(text) {
    return String(text).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  function fmtTime(ms) {
    if (!ms) return "—";
    const date = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return date.getMonth() + 1 + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function renderStats(stats) {
    statsBox.innerHTML =
      "共 <b>" + stats.total + "</b> 条 · 今日 <b>" + stats.today + "/" + stats.dailyLimit + "</b> · 近 7 天 <b>" + stats.week + "</b> 条 · 最近一次 " + (stats.lastAt ? fmtTime(stats.lastAt) : "—");
  }

  function entryEl(entry) {
    const el = document.createElement("article");
    el.className = "memory-card";
    el.innerHTML =
      "<h4>" + (entry.pinned ? "📌 " : "") + esc(entry.title) + "</h4>" +
      "<p>" + esc(entry.body) + "</p>" +
      '<div class="why">因为：' + esc(entry.reason || "AI 自己判断") + " · 来源：" + esc(entry.sourceType) + " · 置信度：" + esc(entry.confidence) + " · " + fmtTime(entry.createdAt) + "</div>" +
      '<div class="acts">' +
        '<button type="button" data-act="pin">' + (entry.pinned ? "取消置顶" : "置顶") + "</button>" +
        '<button type="button" data-act="del">删除</button>' +
      "</div>";
    el.querySelector('[data-act="pin"]').addEventListener("click", function () {
      window.api.updateMemory(entry.id, !entry.pinned).then(load);
    });
    el.querySelector('[data-act="del"]').addEventListener("click", function () {
      if (confirm("删除这条记忆？")) window.api.deleteMemory(entry.id).then(load);
    });
    return el;
  }

  let cache = null;

  async function load() {
    const data = await window.api.memory(60);
    if (!data) {
      statsBox.textContent = "加载失败，请刷新重试。";
      return;
    }
    cache = data;
    renderStats(data.stats);
    groupsBox.innerHTML = "";
    if (!data.groups.length) {
      groupsBox.innerHTML =
        '<div class="memory-empty">还没有记忆。<br />在辅助开发里推进阶段，AI 会自己判断记什么。</div>';
      return;
    }
    data.groups.forEach(function (group) {
      const wrap = document.createElement("div");
      wrap.className = "memory-group";
      const title = document.createElement("h3");
      title.className = "memory-day";
      title.textContent = group.day + " · " + group.entries.length + " 条";
      wrap.appendChild(title);
      group.entries.forEach(function (entry) {
        wrap.appendChild(entryEl(entry));
      });
      groupsBox.appendChild(wrap);
    });
  }

  document.getElementById("export").addEventListener("click", function () {
    if (!cache) return;
    const blob = new Blob([JSON.stringify(cache, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "nexushub-memory.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  document.getElementById("clear").addEventListener("click", function () {
    if (confirm("清空全部 AI 记忆？此操作不可恢复。")) {
      window.api.clearMemory().then(load);
    }
  });

  (async function boot() {
    if (window.api) {
      const me = await window.api.me();
      const avatar = document.querySelector(".avatar");
      if (avatar && me) avatar.textContent = me.displayName || me.username || "—";
    }
    load();
  })();
})();