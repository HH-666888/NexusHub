/* 顶部两个入口 + 头像菜单。
   工作流 / 辅助开发 是同一产品的两个功能；AI 记忆在头像菜单里。 */
(function () {
  const path = location.pathname;
  const inAssist = path.indexOf("/assist") === 0;
  const inMemory = path.indexOf("/memory") === 0;

  function injectTabs() {
    const header = document.querySelector("header.appbar");
    if (!header || header.querySelector(".top-tabs")) return;
    const brand = header.querySelector(".brand");
    const tabs = document.createElement("nav");
    tabs.className = "top-tabs";
    tabs.innerHTML =
      '<a href="/projects/" class="' + (!inAssist && !inMemory ? "is-on" : "") + '">工作流</a>' +
      '<a href="/assist/" class="' + (inAssist ? "is-on" : "") + '">辅助开发</a>';
    if (brand && brand.parentNode === header) {
      header.insertBefore(tabs, brand.nextSibling);
    } else {
      header.insertBefore(tabs, header.firstChild);
    }
  }

  function injectMenu() {
    const avatar = document.querySelector(".appbar-right .avatar");
    if (!avatar || avatar.dataset.menuReady === "1") return;
    avatar.dataset.menuReady = "1";
    avatar.style.cursor = "pointer";

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
      const action = event.target.dataset ? event.target.dataset.action : "";
      if (action === "logout") {
        try {
          if (window.api) await window.api.logout();
        } catch (error) {
          /* 忽略 */
        }
        location.href = "/login/";
      }
    });
    document.addEventListener("click", function () {
      menu.hidden = true;
    });
  }

  async function fillAvatar() {
    const avatar = document.querySelector(".appbar-right .avatar");
    if (!avatar || !window.api || !window.api.me) return;
    if (avatar.textContent.trim() !== "—") return;
    try {
      const me = await window.api.me();
      if (me) avatar.textContent = me.displayName || me.username || "—";
    } catch (error) {
      /* 保持占位 */
    }
  }

  function boot() {
    injectTabs();
    injectMenu();
    fillAvatar();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();