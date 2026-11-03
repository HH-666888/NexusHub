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
  onScroll();

  /* ───────── 进入视口：每段演一次 ───────── */
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

  const seen = new Set();
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;

        if (el.classList.contains("stage")) {
          const index = Number(el.dataset.index || 0);
          markActive(index);
          if (seen.has(el)) return;
          seen.add(el);
          el.classList.add("is-in");
          runArt(el);
          io.unobserve(el);
        } else if (el.id === "bridge") {
          el.classList.add("is-in");
          io.unobserve(el);
        } else if (el.id === "stats") {
          countAll(el);
          io.unobserve(el);
        }
      });
    },
    { rootMargin: "0px 0px -18% 0px", threshold: 0.18 },
  );

  const bridge = $("#bridge");
  if (bridge) io.observe(bridge);
  stages.forEach((s) => io.observe(s));
  const stats = $("#stats");
  if (stats) io.observe(stats);

  // 导航高亮：用一个只占屏幕中间一条的观察器，谁在中间谁是当前
  const spy = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) markActive(Number(entry.target.dataset.index || 0));
      });
    },
    { rootMargin: "-46% 0px -46% 0px", threshold: 0 },
  );
  stages.forEach((s) => spy.observe(s));

  /* ───────── 每段的专属演出 ───────── */
  function runArt(stage) {
    if (stage.id === "s-build") typeBuild(stage);
    if (stage.id === "s-test") runChecks(stage);
    if (stage.id === "s-deliver") countAll(stage);
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
      let i = 0;
      const timer = setInterval(() => {
        if (i >= lines.length) {
          clearInterval(timer);
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
    items.forEach((li, i) => {
      setTimeout(() => {
        if (li.hasAttribute("data-fix")) {
          li.classList.add("bad");
          setTimeout(() => {
            li.classList.remove("bad");
            li.classList.add("ok");
          }, 620);
        } else {
          li.classList.add("ok");
        }
      }, 140 * i);
    });
  }

  /* 计数：¥0.025 / 138 秒 / 23 KB */
  function countAll(root) {
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
})();