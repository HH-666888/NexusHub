/* ─────────────────────────────────────────────────────────────
   首页长页的滚动叙事脚本
   - 只做三件事：跟手（进度、视差）、触发（进入视口演一次）、计数
   - 全部只改 transform / opacity / height(仅进度条)
   - 尊重 prefers-reduced-motion
   ───────────────────────────────────────────────────────────── */
(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ───────── 顶部阅读进度 ───────── */
  const bar = $("#scroll-progress");
  const hero = $(".hero");
  const nav = $("#flow-nav");
  const wrap = $("#flow-wrap");
  const rulerFill = $("#ruler-fill");
  const stages = $$(".stage");
  const navLinks = $$("[data-nav]");
  const dots = $$("[data-dot]");
  const navTrack = $("#nav-track");
  const compact = $("#nav-compact");

  let ticking = false;
  let activeIndex = -1;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = window.scrollY || document.documentElement.scrollTop;
      const docH = document.documentElement.scrollHeight - window.innerHeight;

      // 顶部进度
      if (bar) bar.style.transform = `scaleX(${docH > 0 ? Math.min(1, y / docH) : 0})`;

      // 导航：滚过首屏 80% 才出现
      if (nav && hero) {
        const heroBottom = hero.offsetTop + hero.offsetHeight * 0.8;
        nav.classList.toggle("is-on", y > heroBottom);
      }

      // 左侧标尺：按在六道区间里的进度填充
      if (wrap && rulerFill) {
        const top = wrap.offsetTop;
        const h = wrap.offsetHeight - window.innerHeight * 0.6;
        const p = Math.min(1, Math.max(0, (y - top + window.innerHeight * 0.5) / Math.max(1, h)));
        rulerFill.style.height = `${(p * 100).toFixed(2)}%`;
      }

      // 首屏视差：只改 transform，离开首屏就不再计算
      if (!reduce && hero && y < hero.offsetHeight * 1.2) {
        const title = $(".hero-copy h1", hero);
        const composer = $(".composer", hero);
        if (title) title.style.transform = `translateY(${(y * 0.12).toFixed(1)}px)`;
        if (composer) composer.style.transform = `translateY(${(y * 0.22).toFixed(1)}px) scale(${Math.max(0.98, 1 - y / 12000).toFixed(3)})`;
      }

      updateStages();

      // 幽灵序号视差
      if (!reduce) {
        stages.forEach((s) => {
          const ghost = $(".ghost", s);
          if (!ghost) return;
          const r = s.getBoundingClientRect();
          const offset = (r.top + r.height / 2 - window.innerHeight / 2) * -0.09;
          ghost.style.transform = `translateY(${offset.toFixed(1)}px)`;
        });
      }
    });
  }

  // 标尺上的六个点：按每段的真实中线摆，不写死百分比
  function positionDots() {
    if (!wrap) return;
    const h = wrap.offsetHeight;
    stages.forEach((s, i) => {
      const dot = dots[i];
      if (!dot) return;
      const center = s.offsetTop + s.offsetHeight / 2;
      dot.style.top = `${((center / h) * 100).toFixed(2)}%`;
    });
  }
  positionDots();

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", function () { onScroll(); positionDots(); });

  /* ───────── 滚动位置 → 上屏 / 演出 / 复位 ─────────
     上屏（is-visible）：元素进入视口就显示内容，保证看得见
     演出（is-in）：元素中心越过视口中线（且向下）时播一次，可重复
     复位：元素完全离开视口后清空，下一次向下经过再播 */

  function markActive(index) {
    if (index === activeIndex) return;
    activeIndex = index;
    navLinks.forEach((a, i) => a.classList.toggle("is-on", i === index));
    dots.forEach((d, i) => d.classList.toggle("is-on", i <= index));
    if (compact) compact.textContent = `${String(index + 1).padStart(2, "0")} / 06`;
    if (navTrack && navLinks[index]) {
      const a = navLinks[index];
      navTrack.style.width = `${a.offsetWidth}px`;
      navTrack.style.transform = `translateX(${a.offsetLeft - 40}px)`;
    }
  }

  const state = new Map();
  stages.forEach((s) => state.set(s, { played: false, visible: false }));
  let lastY = window.scrollY || 0;

  function playStage(s) {
    const st = state.get(s);
    if (!st || st.played) return;
    st.played = true;
    s.classList.remove("is-in");
    void s.offsetWidth;            // 强制重排，让过渡从 0 重新开始
    s.classList.add("is-in");
    runArt(s);
  }

  function resetStage(s) {
    const st = state.get(s);
    if (!st) return;
    st.played = false;
    st.visible = false;
    s.classList.remove("is-in");
    s.classList.remove("is-visible");
    cleanupArt(s);
  }

  function updateStages() {
    const y = window.scrollY || document.documentElement.scrollTop;
    const down = y > lastY;
    lastY = y;
    const vh = window.innerHeight;
    const mid = vh / 2;
    let nearest = null;

    stages.forEach((s, i) => {
      const st = state.get(s);
      const r = s.getBoundingClientRect();

      // 完全离开视口：复位，等待下一次向下经过
      if (r.bottom < -60 || r.top > vh + 60) {
        if (st.played || st.visible) resetStage(s);
        return;
      }

      // 进入视口：先让内容上屏
      if (!st.visible) {
        st.visible = true;
        s.classList.add("is-visible");
      }

      // 向下滚动、且这一段已经露出约四成：开始演出（不能等中心才演，否则卡片先空一会儿）
      const center = r.top + r.height / 2;
      if (down && r.top < vh * 0.62) playStage(s);

      // 当前工序 = 屏幕 45% 线落在哪一段里（比"离中线最近"稳，长短屏都不会跳）
      const line = vh * 0.45;
      if (r.top <= line && r.bottom > line) nearest = nearest || { index: i, dist: 0 };
      else if (r.top <= line) nearest = { index: i, dist: 0 };
    });

    if (nearest) markActive(nearest.index);
  }

  const bridge = $("#bridge");
  const stats = $("#stats");

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        if (entry.target.id === "bridge") entry.target.classList.add("is-in");
        if (entry.target.id === "stats") countAll(entry.target);
        io.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -18% 0px", threshold: 0.18 },
  );
  if (bridge) io.observe(bridge);
  if (stats) io.observe(stats);

  /* ───────── 每段的专属演出 ───────── */
  function runArt(stage) {
    if (stage.id === "s-build") typeBuild(stage);
    if (stage.id === "s-test") runChecks(stage);
    if (stage.id === "s-deliver") countAll(stage);
  }

  /** 复位：把 JS 驱动的那几段清干净，下一次才能重新演 */
  function cleanupArt(stage) {
    if (stage.id === "s-build") {
      $$(".build-col", stage).forEach((col) => {
        if (col._timer) {
          clearInterval(col._timer);
          col._timer = null;
        }
        const pre = $("pre", col);
        if (pre) pre.textContent = "";
      });
    }
    if (stage.id === "s-test") {
      const list = $("#checks", stage);
      if (list) {
        if (list._timers) {
          list._timers.forEach(clearTimeout);
          list._timers = [];
        }
        Array.from(list.children).forEach((li) => li.classList.remove("ok", "bad"));
      }
    }
    // 06 的数字只滚一次，复位时不做任何事
  }

  /* 03 并行开发：三列同时写入 */
  const BUILD = {
    "db/schema.sql": [
      "CREATE TABLE shifts (",
      "  id   BIGINT PRIMARY KEY,",
      "  day  DATE NOT NULL,",
      "  who  VARCHAR(32),",
      "  note VARCHAR(64)",
      ");",
      "CREATE INDEX idx_day",
      "  ON shifts(day);",
    ],
    "api/main.py": [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "",
      "@app.get('/api/shifts')",
      "def list_shifts():",
      "    rows = q('SELECT * FROM shifts')",
      "    return {'items': rows}",
      "",
      "@app.post('/api/shifts')",
      "def add_shift(d):",
      "    q('INSERT INTO shifts VALUES ...')",
      "    return {'ok': True}",
    ],
    "web/index.html": [
      "<div class=\"board\" id=\"board\">",
      "  <div class=\"col\">周一</div>",
      "  <div class=\"col\">周二</div>",
      "</div>",
      "<button id=\"add\">新增值班</button>",
      "<p class=\"hint\">拖拽调整班次</p>",
    ],
  };

  function typeBuild(stage) {
    $$(".build-col", stage).forEach((col) => {
      const pre = $("pre", col);
      const lines = BUILD[col.dataset.file] || [];
      if (!pre || !lines.length) return;
      if (reduce) {
        pre.textContent = lines.join("\n");
        return;
      }
      const speed = Number(col.dataset.speed || 60);
      if (col._timer) clearInterval(col._timer);
      pre.textContent = "";
      let i = 0;
      col._timer = setInterval(() => {
        if (i >= lines.length) {
          clearInterval(col._timer);
          col._timer = null;
          return;
        }
        pre.textContent += (i ? "\n" : "") + lines[i];
        i += 1;
      }, speed);
    });
  }

  /* 05 自动测试：逐条打勾，中间一条先失败再修复 */
  function runChecks(stage) {
    const list = $("#checks", stage);
    if (!list) return;
    const items = Array.from(list.children);
    if (reduce) {
      items.forEach((li) => li.classList.add("ok"));
      return;
    }
    if (!list._timers) list._timers = [];
    list._timers.push(
      ...items.map((li, i) =>
        setTimeout(() => {
          if (li.hasAttribute("data-fix")) {
            li.classList.add("bad");
            list._timers.push(
              setTimeout(() => {
                li.classList.remove("bad");
                li.classList.add("ok");
              }, 620),
            );
          } else {
            li.classList.add("ok");
          }
        }, 140 * i),
      ),
    );
  }

  /* 计数：¥0.025 / 138 秒 / 23 KB —— 只滚一次，复位不重来 */
  const counted = new WeakSet();
  function countAll(root) {
    if (counted.has(root)) return;
    counted.add(root);
    $$("[data-count]", root).forEach((el) => {
      const target = Number(el.dataset.count || 0);
      const decimals = Number(el.dataset.decimals || 0);
      const prefix = el.dataset.prefix || "";
      const suffix = el.dataset.suffix || "";
      const render = (v) =>
        (el.textContent = prefix + v.toFixed(decimals) + suffix);
      if (reduce) {
        render(target);
        return;
      }
      const start = performance.now();
      const dur = 800;
      function step(now) {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        render(target * eased);
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }
  // 首帧再跑一次：此时 state / observer 都已就绪
  onScroll();
})();