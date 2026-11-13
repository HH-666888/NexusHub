/* 全站共用的顶栏：品牌、两个入口、面包屑、预算、主题、设置、退出、头像。
   页面只写 <header class="appbar" id="appbar" data-crumb="...">，
   需要额外控件时用 <template data-slot="center|right"> 传进来。 */
(function () {
  const path = location.pathname;
  const isAssist = path.indexOf("/assist") === 0 || path.indexOf("/memory") === 0;
  const isWorkflow = path.indexOf("/projects") === 0 || path.indexOf("/workbench") === 0;
  const host = document.getElementById("appbar");
  const activeTab = (host && host.dataset.tab) || (isAssist ? "assist" : isWorkflow ? "workflow" : "");

  const ICON = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  };

  function safeGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      /* 无痕模式下忽略 */
    }
  }

  function migrateLegacyTheme() {
    // 旧设置页曾把服务端 theme 写进 localStorage，导致点一次设置全站变黑。
    // 只修一次；之后用户自己选的主题不再被覆盖。
    if (safeGet("nexus-theme-repaired") === "1") return;
    if (safeGet("nexus-theme") === "dark") safeSet("nexus-theme", "light");
    safeSet("nexus-theme-repaired", "1");
  }

  function initTheme() {
    const query = new URLSearchParams(location.search);
    document.documentElement.dataset.theme = query.get("theme") || safeGet("nexus-theme") || "light";
    document.documentElement.dataset.style = query.get("style") || "";
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    safeSet("nexus-theme", next);
  }

  function avatarMenu() {
    const avatar = document.querySelector("#appbar .avatar");
    if (!avatar) return;
    const menu = document.createElement("div");
    menu.className = "avatar-menu";
    menu.hidden = true;
    menu.innerHTML =
      '<a href="/settings/">设置</a>' +
      '<a href="/memory/">AI 记忆</a>' +
      '<button type="button" data-action="logout">退出</button>';
    document.body.appendChild(menu);

    avatar.addEventListener("click", function (event) {
      event.stopPropagation();
      const rect = avatar.getBoundingClientRect();
      menu.style.top = rect.bottom + 6 + "px";
      menu.style.right = Math.max(12, window.innerWidth - rect.right) + "px";
      menu.hidden = !menu.hidden;
    });
    menu.addEventListener("click", async function (event) {
      if (event.target.dataset && event.target.dataset.action === "logout") {
        await logout();
      }
    });
    document.addEventListener("click", function () {
      menu.hidden = true;
    });
  }

  async function logout() {
    try {
      if (window.api) await window.api.logout();
    } catch (error) {
      /* 忽略 */
    }
    location.href = "/login/";
  }

  async function fillUser() {
    const avatar = document.querySelector("#appbar .avatar");
    if (!avatar || !window.api || !window.api.me) return;
    try {
      const me = await window.api.me();
      if (me) avatar.textContent = me.username || "—";
    } catch (error) {
      /* 保持占位 */
    }
  }

  async function refreshBudget() {
    const pill = document.getElementById("appbar-budget");
    if (!pill || !window.api) return;
    try {
      const [settings, runs] = await Promise.all([window.api.settings(), window.api.runs(50)]);
      const budget = settings && typeof settings.budgetPerDay === "number" ? settings.budgetPerDay : null;
      if (budget === null || !Array.isArray(runs)) return;
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const cost = runs
        .filter(function (run) {
          return new Date(run.createdAt) >= start;
        })
        .reduce(function (sum, run) {
          return sum + Number(run.totalCostCny || 0);
        }, 0);
      pill.textContent = "¥" + cost.toFixed(2) + " / ¥" + budget.toFixed(2);
    } catch (error) {
      /* 保持占位 */
    }
  }

  function render() {
    if (!host) return;

    const crumb = host.dataset.crumb || "";
    const parent = host.dataset.parent || "";
    const parentHref = host.dataset.parentHref || "/projects/";
    const centerTpl = host.querySelector('template[data-slot="center"]');
    const rightTpl = host.querySelector('template[data-slot="right"]');
    const center = centerTpl ? centerTpl.innerHTML : "";
    const extra = rightTpl ? rightTpl.innerHTML : "";

    host.innerHTML =
      '<a class="brand" href="/welcome/" aria-label="NexusHub">' +
        '<svg viewBox="0 0 24 24" aria-hidden><path class="brand-mark" d="M4 20V4h3.4l9.2 12V4H20v16h-3.4L7.4 8v12H4z"/></svg>' +
        "<b>NexusHub</b>" +
      "</a>" +
      '<nav class="top-tabs">' +
        '<a href="/projects/" class="' + (activeTab === "workflow" ? "is-on" : "") + '">工作流</a>' +
        '<a href="/assist/" class="' + (activeTab === "assist" ? "is-on" : "") + '">辅助开发</a>' +
      "</nav>" +
      '<nav class="crumb">' +
        ('<span>/</span>' + (parent ? '<a href="' + parentHref + '">' + parent + "</a><span>/</span>" : "")) +
        '<b id="crumb-title">' + crumb + "</b>" +
      "</nav>" +
      (center ? '<div class="appbar-center">' + center + "</div>" : "") +
      '<div class="appbar-right">' +
        extra +
        '<span class="pill pill-plain" id="appbar-budget">¥— / ¥—</span>' +
        '<button class="icon-btn" type="button" id="appbar-theme" aria-label="切换主题">' +
          '<svg viewBox="0 0 24 24" aria-hidden>' + ICON.sun + "</svg>" +
        "</button>" +
        '<a class="icon-btn" href="/settings/" aria-label="设置">' +
          '<svg viewBox="0 0 24 24" aria-hidden>' + ICON.gear + "</svg>" +
        "</a>" +
        '<button class="btn btn-sm btn-ghost" type="button" id="appbar-logout">退出</button>' +
        '<button class="avatar" type="button">—</button>' +
      "</div>";

    document.getElementById("appbar-theme").addEventListener("click", toggleTheme);
    document.getElementById("appbar-logout").addEventListener("click", logout);
    avatarMenu();
    fillUser();
    refreshBudget();
  }

  migrateLegacyTheme();
  initTheme();
  render();
})();