// file:// 下有些浏览器禁用 localStorage：读写都兜底，别把整段脚本带崩
      function safeTheme() {
        try { return localStorage.getItem("nexus-theme"); } catch (e) { return null; }
      }
      function saveTheme(value) {
        try { localStorage.setItem("nexus-theme", value); } catch (e) { /* 忽略 */ }
      }
      (function () {
        const query = new URLSearchParams(location.search);
        document.documentElement.dataset.theme = query.get("theme") || safeTheme() || "light";
        document.addEventListener("click", function (event) {
          if (!event.target.closest("#theme-toggle")) return;
          const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
          document.documentElement.dataset.theme = next;
          saveTheme(next);
        });
      })();

/* ───────────────── 树的布局与动画 ─────────────────
         核心：行距不固定，按"这一道工序的子树有多大"单独算。
         谁的分支多，它和下一道之间的空隙就自动变长；别的间距不受影响。
         - lr：根在左，六道竖排，子树在右边向下铺
         - td：根在上，六道横排，子树在下面向右铺
         分支过多时先折叠，点"还有 N 个"再展开（展开后行距继续撑开）。 */

      const STAGES = [
        { no: "01", name: "需求分析", short: "需求", note: "5 条验收标准", state: "done", icon: "M6 4h9l3 3v13H6z M9 11h6 M9 15h4" },
        { no: "02", name: "架构设计", short: "架构", note: "4 个模块", state: "done", icon: "M4 5h16v5H4z M4 14h9v5H4z M17 14h3v5h-3z" },
        { no: "03", name: "并行开发", short: "并行", note: "2 个分支并行", state: "live", icon: "M4 18V6l6 3 4-3 6 3v9 M4 18h16" },
        { no: "04", name: "集成装配", short: "装配", note: "等待上游", state: "wait", icon: "M7 3h10v7H7z M3 14h8v7H3z M13 14h8v7h-8z" },
        { no: "05", name: "自动测试", short: "测试", note: "等待上游", state: "wait", icon: "M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12 M15.5 15.5L20 20" },
        { no: "06", name: "验收交付", short: "验收", note: "等待上游", state: "wait", icon: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M9 12l2 2 4-4" },
      ];

      /* 三级：同一道工序下可以有很多分支（几个到几十个都算正常）。
         这里用 TASKS 作为"第 3 道"的子节点；?branches=N 可模拟几十个分支。 */
      const TASKS = [
        { title: "数据库", file: "db/schema.sql", state: "done", progress: 100 },
        { title: "后端接口", file: "api/main.py", state: "live", progress: 72, parallel: true },
        { title: "前端页面", file: "web/index.html", state: "live", progress: 38, parallel: true },
      ];

      // 演示用：按 ?branches=N 造出 N 个同级分支，看行距怎么被撑开
      function seedBranches(count) {
        if (!count || count <= TASKS.length) return;
        const names = ["数据库", "后端接口", "前端页面", "静态资源", "接口测试", "数据迁移", "权限校验", "部署脚本"];
        for (let i = TASKS.length; i < count; i += 1) {
          const title = names[i % names.length] + " " + (i + 1);
          TASKS.push({
            title,
            file: `modules/${String(i + 1).padStart(2, "0")}/index.js`,
            state: i % 3 === 0 ? "done" : "live",
            progress: 20 + ((i * 17) % 70),
            parallel: i % 3 !== 0,
          });
        }
      }

      const inner = document.getElementById("canvas-inner");
      const svg = document.getElementById("tree-svg");
      const work = document.getElementById("work");

      /** 视图状态：排布 + 聚焦哪一道 + 哪些分支被折叠（展开过的记在 expanded 里） */
      const view = { layout: "lr", edges: "curve", focus: null, expanded: new Set() };

      /* 折叠规则：超过 5 个就先折叠，只画 5 个 + 一枚"还有 N 个" */
      const COLLAPSE_AT = 5;

      /* 真实任务仓库：每道工序下面都可以有任务，不再只有第 3 道 */
      const STAGE_ORDER = ["plan", "design", "build", "assemble", "test", "deliver"];
      const TASK_STORE = { tasks: [] };
      const PLAY = { speed: 1, maxPct: 0 };

      /** 把后端任务转成树上的卡片刻度 */
      function toCard(task) {
        const state =
          task.state === "done" ? "done"
            : task.state === "running" ? "live"
              : task.state === "failed" ? "fail" : "wait";
        return {
          id: task.id,
          title: task.title,
          file: task.file || task.note || "",
          note: task.note || "",
          state,
          progress: state === "done" ? 100 : state === "live" ? 45 : 0,
          parallel: state === "live",
        };
      }

      function tasksOf(stageIndex, limit) {
        const stage = STAGE_ORDER[stageIndex];
        const mine = TASK_STORE.tasks.filter((task) => task.stage === stage).map(toCard);
        if (!mine.length && stageIndex === 2) {
          // 演示态：没有真实任务时，继续用写死的三个分支
          const expanded = view.expanded.has(stageIndex);
          const list = expanded || TASKS.length <= limit ? TASKS.slice() : TASKS.slice(0, limit);
          return limit ? list.slice(0, limit) : list;
        }
        return limit ? mine.slice(0, limit) : mine;
      }

      function taskCountOf(stageIndex) {
        const stage = STAGE_ORDER[stageIndex];
        const mine = TASK_STORE.tasks.filter((task) => task.stage === stage);
        if (!mine.length && stageIndex === 2 && TASK_STORE.tasks.length === 0) return TASKS.length;
        return mine.length;
      }

      function childrenOf(stageIndex, limit = COLLAPSE_AT) {
        return tasksOf(stageIndex, limit);
      }

      /** 子树占多高：分支多、卡多，占用就大；这是"行距自动拉长"的依据 */
      function childMetrics(list) {
        const n = list.length;
        const dense = n > 6;                       // 分支多时把卡片压矮，别让树长得没边
        const h = dense ? 40 : 52;
        const gap = dense ? 8 : 10;
        return { n, h, gap, stackH: n * h + Math.max(0, n - 1) * gap, dense };
      }

      let timers = [];
      // 实时模式下节点是随时增删的，别做错峰入场动画（清除定时器会把它们永远藏住）
      const later = (fn, ms) =>
        document.body.classList.contains("is-live") ? fn() : timers.push(setTimeout(fn, ms));
      const clearTimers = () => {
        timers.forEach(clearTimeout);
        timers = [];
      };

      /** 把折线点序列转成带圆角的路径：拐角用二次贝塞尔，半径按相邻段长度自动收敛 */
      function roundedPath(points, radius = 10) {
        const pts = points.filter((p, i) => {
          if (i === 0) return true;
          const prev = points[i - 1];
          return Math.abs(p[0] - prev[0]) > 0.01 || Math.abs(p[1] - prev[1]) > 0.01;
        });
        if (pts.length < 2) return "";
        let d = `M ${pts[0][0]} ${pts[0][1]}`;
        for (let i = 1; i < pts.length - 1; i += 1) {
          const [x0, y0] = pts[i - 1];
          const [x1, y1] = pts[i];
          const [x2, y2] = pts[i + 1];
          const inLen = Math.hypot(x1 - x0, y1 - y0);
          const outLen = Math.hypot(x2 - x1, y2 - y1);
          const r = Math.min(radius, inLen / 2, outLen / 2);
          if (r < 0.6) { d += ` L ${x1} ${y1}`; continue; }
          const ux = (x1 - x0) / inLen;
          const uy = (y1 - y0) / inLen;
          const vx = (x2 - x1) / outLen;
          const vy = (y2 - y1) / outLen;
          d += ` L ${x1 - ux * r} ${y1 - uy * r}`;
          d += ` Q ${x1} ${y1} ${x1 + vx * r} ${y1 + vy * r}`;
        }
        const last = pts[pts.length - 1];
        d += ` L ${last[0]} ${last[1]}`;
        return d;
      }

      /** 横向流动的贝塞尔：控制点按水平距离给，出入角度都接近水平，看起来才"顺" */
      function curveH(x0, y0, x1, y1) {
        const dx = Math.max(56, Math.abs(x1 - x0) * 0.8);
        return `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x1 - dx} ${y1}, ${x1} ${y1}`;
      }
      /** 纵向流动的贝塞尔（上下树用） */
      function curveV(x0, y0, x1, y1) {
        const dy = Math.max(44, Math.abs(y1 - y0) * 0.55);
        return `M ${x0} ${y0} C ${x0} ${y0 + dy}, ${x1} ${y1 - dy}, ${x1} ${y1}`;
      }

      /**
       * 【布局铁律】父节点永远居中于它的子节点整体范围。
       * 之后再加层级（L4）、再加分支，都只调这一个函数，不要各写各的。
       */
      function centeredOn(childMin, childMax, selfSize) {
        return (childMin + childMax) / 2 - selfSize / 2;
      }

      function addPath(d, delay) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        path.setAttribute("pathLength", "1");   // 归一化：dash 长度恒为 1，收尾不会差半像素
        svg.appendChild(path);
        path.style.opacity = "0";
        later(function () {
          path.style.opacity = "1";
          path.classList.add("draw");
        }, delay);
      }

      /* ───────── 左右树：行距按子树高度单独算 ───────── */

      function layoutLR(width) {
        const nodes = [];
        const paths = [];
        const curved = view.edges === "curve";
        const ROOT = { x: 20, y: 14, w: curved ? 168 : 200, h: 58 };
        const STAGE_X = curved ? 316 : 268;
        const STAGE_W = curved ? 180 : 200;
        const STAGE_H = 56;
        const GAP = 18;            // 行与行之间的最小缝隙
        const TASK_X = STAGE_X + STAGE_W + (curved ? 54 : 44);
        const TASK_W = 150;
        const BUS_X = STAGE_X - 26;
        const TASK_BUS_X = STAGE_X + STAGE_W + 20;

        const stages = view.focus === null ? STAGES : [STAGES[view.focus]];

        // 先算出每一道"自己那一行要占多高"：max(最小行高, 子树高度 + 上下留白)
        const rows = stages.map((stage, i) => {
          const index = view.focus === null ? i : view.focus;
          const kids = childrenOf(index);
          const m = childMetrics(kids);
          return { stage, index, kids, m, rowH: Math.max(STAGE_H + GAP, m.stackH + 32) };
        });

        // 每一道占一条"带"：带高 = max(卡高, 子树高)，父卡与子树共用带中心
        // 于是子树永远以父卡为中心上下铺开，相邻两道按各自带高留缝，互不影响
        let cursor = 30;
        rows.forEach((row) => {
          row.bandH = Math.max(STAGE_H, row.m.stackH);
          row.center = cursor + row.bandH / 2;      // ← 这一道的中心线
          row.y = row.center - STAGE_H / 2;
          cursor += row.bandH + GAP;
        });

        // 【铁律】父节点永远居中于它的子节点：
        // 根卡的中心 = 六道（含各自子树）整体的中心，跟 03 对它的三个分支用的是同一条规则
        const blockTop = rows[0].center - rows[0].bandH / 2;
        const blockBottom = rows[rows.length - 1].center + rows[rows.length - 1].bandH / 2;
        ROOT.y = Math.max(14, centeredOn(blockTop, blockBottom, ROOT.h));

        nodes.push({ kind: "root", ...ROOT, title: "主控 Agent", note: "拆需求 · 派活 · 收口" });

        // 主干不再单独画：每条分支从根的右边缘出发，一条连续路径走到卡片
        const rootCy = ROOT.y + ROOT.h / 2;

        rows.forEach((row) => {
          nodes.push({
            kind: "stage",
            x: STAGE_X,
            y: row.y,
            w: STAGE_W,
            h: STAGE_H,
            stageIndex: row.index,
            data: row.stage,
          });
          paths.push(view.edges === "curve"
            ? curveH(ROOT.x + ROOT.w - 4, rootCy, STAGE_X + 6, row.center)
            : roundedPath([[ROOT.x + ROOT.w - 8, rootCy], [BUS_X, rootCy], [BUS_X, row.center], [STAGE_X + 10, row.center]], 12));

          // 子树：小堆以父卡为轴居中，大堆从父卡上沿往下排（不许越到上一道的地盘里）
          const firstTop = row.center - row.m.stackH / 2;
          row.kids.forEach((task, k) => {
            const top = firstTop + k * (row.m.h + row.m.gap);
            nodes.push({
              kind: "task",
              x: TASK_X,
              y: top,
              w: TASK_W,
              h: row.m.h,
              dense: row.m.dense,
              data: task,
            });
            paths.push(view.edges === "curve"
              ? curveH(STAGE_X + STAGE_W - 4, row.center, TASK_X + 6, top + row.m.h / 2)
              : roundedPath([[STAGE_X + STAGE_W, row.center], [TASK_BUS_X, row.center], [TASK_BUS_X, top + row.m.h / 2], [TASK_X + 10, top + row.m.h / 2]], 10));
          });

          // 折叠时在末尾补一枚"还有 N 个"
          const hidden = taskCountOf(row.index) - row.kids.length;
          if (hidden > 0) {
            const top = firstTop + row.kids.length * (row.m.h + row.m.gap);
            nodes.push({
              kind: "chip",
              x: TASK_X,
              y: top,
              w: TASK_W,
              h: row.m.h,
              stageIndex: row.index,
              title: `还有 ${hidden} 个分支`,
              note: "点开展开",
            });
            paths.push(view.edges === "curve"
              ? curveH(STAGE_X + STAGE_W - 4, row.center, TASK_X + 6, top + row.m.h / 2)
              : roundedPath([[STAGE_X + STAGE_W, row.center], [TASK_BUS_X, row.center], [TASK_BUS_X, top + row.m.h / 2], [TASK_X + 10, top + row.m.h / 2]], 10));
          }
        });

        if (view.focus !== null && rows.length) {
          nodes.push({
            kind: "other",
            x: STAGE_X,
            y: rows[0].y + STAGE_H + 18,
            w: STAGE_W,
            h: 44,
            title: `其余 ${STAGES.length - 1} 道工序在后台继续`,
            note: "聚焦不打断执行",
          });
        }

        const height = Math.max(cursor + 40, ROOT.y + ROOT.h + 40);
        return { nodes, paths, width, height };
      }

      /* ───────── 上下树：列宽按子树宽度单独算 ───────── */

      function layoutTD(width) {
        const nodes = [];
        const paths = [];
        const ROOT_W = 240;
        const ROOT_H = 60;
        const ROOT_X = Math.max(12, (width - ROOT_W) / 2);
        const STAGE_H = 64;
        const GAP = 16;

        const stages = view.focus === null ? STAGES : [STAGES[view.focus]];
        const wide = width >= 900;
        const stageW = wide ? 138 : 104;
        const taskW = wide ? 132 : 118;
        const taskH = 52;
        const taskGap = 12;

        // 每一列的宽度 = max(自己的卡宽, 它的子树总宽) ← 列与列之间由此被撑开
        // 横向空间比纵向紧张：先按 4 个排，放不下就 3 个、2 个 —— 保证六道都留在屏内
        // 上下树的宽度是硬约束：依次尝试"多放几个 / 少放几个 / 卡片更窄"，
        // 取第一个能装进画布的方案，装不下才允许横向滚动
        const measure = (limit, sw, tw, gap) => stages.map((stage, i) => {
          const index = view.focus === null ? i : view.focus;
          const kids = childrenOf(index, limit);
          const hidden = taskCountOf(index) - kids.length;
          const slots = kids.length + (hidden > 0 ? 1 : 0);
          const kidsW = slots ? slots * tw + (slots - 1) * taskGap : 0;
          return { stage, index, kids, hidden, kidsW, colW: Math.max(sw, kidsW), sw, tw };
        });
        const fits = (list, gap) =>
          list.reduce((sum, c) => sum + c.colW, 0) + (list.length - 1) * gap <= width - 16;

        const attempts = [ [4, stageW, taskW, GAP], [3, stageW, taskW, GAP], [2, stageW, taskW, GAP], [1, 96, 104, 10], [1, 86, 96, 8] ];
        let cols = null;
        let usedGap = GAP;
        for (const [limit, sw, tw, gap] of attempts) {
          const list = measure(limit, sw, tw, gap);
          if (!cols) { cols = list; usedGap = gap; }
          if (fits(list, gap)) { cols = list; usedGap = gap; break; }
        }
        const stageWUsed = cols[0].sw;
        const taskWUsed = cols[0].tw;

        const totalW = cols.reduce((sum, c) => sum + c.colW, 0) + (cols.length - 1) * usedGap;
        let x = Math.max(10, (width - totalW) / 2);
        cols.forEach((col) => {
          col.x = x;
          col.center = x + col.colW / 2;   // 卡片与子树共用这条中心线
          x += col.colW + usedGap;
        });

        const stageY = 138;
        const busY = stageY - 28;
        // 【铁律】同上：根卡的水平中心 = 六列整体的中心
        const blockLeft = cols[0].center - cols[0].colW / 2;
        const blockRight = cols[cols.length - 1].center + cols[cols.length - 1].colW / 2;
        const rootX = centeredOn(blockLeft, blockRight, ROOT_W);
        const rootCx = rootX + ROOT_W / 2;
        nodes.push({ kind: "root", x: rootX, y: 14, w: ROOT_W, h: ROOT_H, title: "主控 Agent", note: "拆需求 · 派活 · 收口" });

        cols.forEach((col) => {
          nodes.push({
            kind: "stage",
            compact: true,
            x: col.center - stageW / 2,
            y: stageY,
            w: stageW,
            h: STAGE_H,
            stageIndex: col.index,
            data: col.stage,
          });
          paths.push(view.edges === "curve"
            ? curveV(rootCx, 14 + ROOT_H - 4, col.center, stageY + 6)
            : roundedPath([[rootCx, 14 + ROOT_H - 8], [rootCx, busY], [col.center, busY], [col.center, stageY + 10]], 12));
        });

        const taskY = stageY + STAGE_H + 52;
        const taskBusY = taskY - 24;
        cols.forEach((col) => {
          if (!col.kids.length) return;
          const kidsW = col.kids.length * taskWUsed + (col.kids.length - 1) * taskGap;
          const kx0 = col.center - kidsW / 2;
          paths.push(`M ${col.center} ${stageY + STAGE_H} V ${taskBusY}`);
          paths.push(`M ${kx0 + taskWUsed / 2} ${taskBusY} H ${kx0 + kidsW - taskWUsed / 2}`);
          col.kids.forEach((task, k) => {
            const kx = kx0 + k * (taskWUsed + taskGap);
            nodes.push({ kind: "task", x: kx, y: taskY, w: taskWUsed, h: taskH, data: task });
            paths.push(view.edges === "curve"
              ? curveV(col.center, stageY + STAGE_H - 4, kx + taskWUsed / 2, taskY + 6)
              : roundedPath([[col.center, taskBusY], [kx + taskWUsed / 2, taskBusY], [kx + taskWUsed / 2, taskY + 10]], 10));
          });
          if (col.hidden > 0) {
            const kx = kx0 + col.kids.length * (taskWUsed + taskGap);
            nodes.push({
              kind: "chip",
              x: kx,
              y: taskY,
              w: taskWUsed,
              h: taskH,
              stageIndex: col.index,
              title: `还有 ${col.hidden} 个分支`,
              note: "点开展开",
            });
            paths.push(view.edges === "curve"
              ? curveV(col.center, stageY + STAGE_H - 4, kx + taskWUsed / 2, taskY + 6)
              : roundedPath([[col.center, taskBusY], [kx + taskWUsed / 2, taskBusY], [kx + taskWUsed / 2, taskY + 10]], 10));
          }
        });

        if (view.focus !== null) {
          nodes.push({
            kind: "other",
            x: Math.max(12, cols[0].center - 100),
            y: taskY + taskH + 26,
            w: 200,
            h: 40,
            title: `其余 ${STAGES.length - 1} 道工序在后台继续`,
            note: "聚焦不打断执行",
          });
        }

        const height = taskY + taskH + 200;
        return { nodes, paths, width, height };
      }

      /* ───────── 渲染：按布局建节点，再按顺序点亮 ───────── */

      function render() {
        clearTimers();
        inner.querySelectorAll(".node-root, .node-stage, .node-task, .node-other").forEach((n) => n.remove());
        svg.innerHTML = "";

        const width = inner.clientWidth || 720;
        const plan = view.layout === "lr" ? layoutLR(width) : layoutTD(width);

        inner.style.minHeight = plan.height + "px";
        svg.setAttribute("viewBox", `0 0 ${width} ${plan.height}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.style.height = plan.height + "px";   // 与 viewBox 1:1，避免 y 被拉伸

        const stageItems = plan.nodes.filter((n) => n.kind === "stage");
        const taskItems = plan.nodes.filter((n) => n.kind === "task");

        plan.nodes.forEach((item) => {
          const el = document.createElement("div");

          if (item.kind === "root") {
            el.className = "node-root";
            el.style.cssText = `left:${item.x}px;top:${item.y}px;width:${item.w}px`;
            el.innerHTML = `<b>${item.title}</b><small>${item.note}</small>`;
            later(() => el.classList.add("in"), 100);
          }

          if (item.kind === "stage") {
            el.className = `node-stage ${item.data.state}${view.focus !== null ? " focus" : ""}`;
            el.style.cssText = `left:${item.x}px;top:${item.y}px;width:${item.w}px${item.compact ? ";min-height:" + item.h + "px" : ""}`;
            el.dataset.stage = String(item.stageIndex);
            const compactName = item.compact && width < 900;
            el.innerHTML = item.compact
              ? `<span class="no">${item.data.no}</span><span class="txt"><b>${compactName ? item.data.short : item.data.name}</b><small>${item.data.note}</small></span>`
              : `<span class="no">${item.data.no}</span>
                 <svg viewBox="0 0 24 24"><path d="${item.data.icon}"/></svg>
                 <span class="txt"><b>${item.data.name}</b><small>${item.data.note}</small></span>`;
            if (item.compact) el.style.gridTemplateColumns = "18px minmax(0,1fr)";
            const appearAt = 380 + stageItems.indexOf(item) * 170;
            later(() => el.classList.add("in"), appearAt);
          }

          if (item.kind === "task") {
            const t = item.data;
            el.className = `node-task ${t.state}${t.parallel ? " parallel" : ""}${item.dense ? " dense" : ""}`;
            el.style.cssText = `left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px`;
            if (t.id) el.dataset.task = t.id;
            el.innerHTML = `<b>${t.title}</b>${item.dense ? "" : `<code>${t.file}</code>`}
              <span class="mini"><i style="width:${t.progress}%"></i></span>`;
            const appearAt = 1480 + taskItems.indexOf(item) * 90;
            later(() => el.classList.add("in"), appearAt);
          }

          if (item.kind === "chip") {
            el.className = "node-task ghost chip";
            el.style.cssText = `left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px`;
            el.dataset.expand = String(item.stageIndex);
            el.innerHTML = `<b>${item.title}</b><code>${item.note}</code>`;
            later(() => el.classList.add("in"), 1480 + taskItems.length * 90 + 120);
          }

          if (item.kind === "other") {
            el.className = "node-task ghost other";
            el.style.cssText = `left:${item.x}px;top:${item.y}px;width:${item.w}px`;
            el.innerHTML = `<b>${item.title}</b><code>${item.note}</code>`;
            later(() => el.classList.add("in"), 1480 + TASKS.length * 90 + 120);
          }

          inner.appendChild(el);
        });

        plan.paths.forEach((d, i) => addPath(d, 260 + Math.min(i * 30, 900)));
        updateHeader();
      }

      /* ───────── 顶部状态与聚焦条 ───────── */

      function updateHeader() {
        const parallel = TASKS.filter((t) => t.parallel).length;
        const pill = document.querySelector(".appbar-center .pill");
        if (pill && !pill.dataset.lock) {
          const liveIndex = STAGES.findIndex((s) => s.state === "live");
          const doneCount = STAGES.filter((s) => s.state === "done").length;
          const current = liveIndex >= 0 ? liveIndex + 1 : Math.max(doneCount, 1);
          const total = TASK_STORE.tasks.length || TASKS.length;
          pill.innerHTML = `<i class="pulse-dot"></i>运行中 · 第 ${current} / 6 道 · ${total} 个任务（${parallel} 个并行）`;
        }
        const name = document.getElementById("focus-name");
        if (view.focus !== null) {
          name.textContent = `${STAGES[view.focus].no} ${STAGES[view.focus].name}`;
          work.classList.add("is-focus");
        } else {
          work.classList.remove("is-focus");
        }
      }

      /* ───────── 交互：排布 / 聚焦 / 展开分支 / 重播 ───────── */

      document.querySelectorAll(".layout-switch button").forEach((btn) => {
        btn.addEventListener("click", function () {
          if (view.layout === btn.dataset.layout) return;
          view.layout = btn.dataset.layout;
          document.querySelectorAll(".layout-switch button").forEach((b) => {
            b.classList.toggle("is-on", b.dataset.layout === view.layout);
          });
          render();
        });
      });

      document.querySelectorAll("[data-edges]").forEach((btn) => {
        btn.addEventListener("click", function () {
          if (view.edges === btn.dataset.edges) return;
          view.edges = btn.dataset.edges;
          document.querySelectorAll("[data-edges]").forEach((b) => {
            b.classList.toggle("is-on", b.dataset.edges === view.edges);
          });
          render();
        });
      });

      inner.addEventListener("click", function (event) {
        const chip = event.target.closest("[data-expand]");
        if (chip) {
          view.expanded.add(Number(chip.dataset.expand));
          render();                       // 展开后行距会重新计算、继续撑开
          return;
        }
        const stage = event.target.closest(".node-stage");
        if (!stage) return;
        const index = Number(stage.dataset.stage);
        view.focus = view.focus === index ? null : index;
        render();
      });

      document.getElementById("exit-focus").addEventListener("click", function () {
        view.focus = null;
        render();
      });
      /* ───────────────── 右侧：多文件流式代码 + 回看 ─────────────────
         面板只有一个：换文件时只换内容与标题，框不消失；
         生成过的文件留在页签里，随时点回去看，也能重播它那一次的生成过程。 */

      // v2：不预置任何演示文件，全部由事件流注入
      const FILES = [];

      function fileOf(path) {
        return FILES.find((f) => f.path === path);
      }

      function renderTabs() {
        fileTabs.innerHTML = FILES.map((f) => {
          const live = codeView.live === f.path;
          const on = codeView.current === f.path;
          const cls = [on ? "is-on" : "", f.state === "done" ? "done" : "", live ? "live" : ""].join(" ").trim();
          const mark = live ? "写入中" : f.state === "done" ? "✓" : "待生成";
          return `<button type="button" class="${cls}" data-path="${f.path}">${f.path.split("/").pop()}<i>${mark}</i></button>`;
        }).join("");
      }

      function addLine(index, text) {
        const line = document.createElement("div");
        line.className = "code-line";
        line.innerHTML = `<span class="ln">${index + 1}</span><pre>${hl(text)}</pre>`;
        codeBody.appendChild(line);
        codeBody.scrollTop = codeBody.scrollHeight;
        lineCount.textContent = String(index + 1);
      }

      /** 切到某个文件：面板不消失，只换内容；生成过的进回看态，正在写的接着写 */
      function showFile(path, options = {}) {
        const file = fileOf(path);
        if (!file) return;
        codeView.current = path;

        if (streamTimer) {
          clearInterval(streamTimer);
          streamTimer = null;
        }

        const streaming = codeView.live === path && !options.review;
        fileName.textContent = path;
        fileDot.style.background = streaming ? "var(--warn)" : "var(--ok)";
        // 两种状态都要保留 #line-count 节点：addLine 每次都要写它，缺了会在第 2 行抛错
        streamState.innerHTML = streaming
          ? `流式写入 · <b id="line-count">0</b> 行`
          : `已生成 · <b id="line-count">${file.lines.length}</b> 行`;
        lineCount = document.getElementById("line-count");

        codeBody.innerHTML = "";
        codeBody.classList.remove("swap");
        void codeBody.offsetWidth;
        codeBody.classList.add("swap");

        reviewBar.classList.toggle("is-on", !streaming);
        reviewText.textContent = streaming ? "正在写这个文件" : `回看 · ${path} 已生成完毕`;

        codePane.classList.remove("flash");
        void codePane.offsetWidth;
        codePane.classList.add("flash");

        renderTabs();

        if (streaming) {
          // 已经写过的行先补齐，再接着往后写 —— 切走再切回不会丢进度
          for (let i = 0; i < file.written; i += 1) addLine(i, file.lines[i]);
          // 实时模式下代码由事件驱动，不能再开本地打字机，否则会写两遍
          if (!(window.__wb && window.__wb.isLive)) streamLines(path);
        } else {
          file.lines.forEach((text, i) => addLine(i, text));
        }
      }

      /** 流式写入：进度记在 file.written 上，切到别的文件也不会中断 */
      function streamLines(path) {
        const file = fileOf(path);
        if (streamTimer) clearInterval(streamTimer);
        streamTimer = setInterval(function () {
          if (file.written >= file.lines.length) {
            clearInterval(streamTimer);
            streamTimer = null;
            file.state = "done";
            if (codeView.live === path) codeView.live = null;
            renderTabs();
            if (codeView.current === path) {
              streamState.innerHTML = `已生成 · <b id="line-count">${file.lines.length}</b> 行`;
              lineCount = document.getElementById("line-count");
              reviewBar.classList.add("is-on");
              reviewText.textContent = `回看 · ${path} 已生成完毕`;
              codeBody.insertAdjacentHTML(
                "beforeend",
                '<div class="code-line"><span class="ln"></span><pre><span class="caret"></span></pre></div>',
              );
            }
            return;
          }
          if (codeView.current === path) addLine(file.written, file.lines[file.written]);
          file.written += 1;
        }, 45);
      }

      /** 开始生成一个新文件：标成 live、清零进度、切过去 */
      function startFile(path) {
        const file = fileOf(path);
        if (!file) return;
        file.state = "live";
        file.written = 0;
        codeView.live = path;
        showFile(path);
      }
      fileTabs.addEventListener("click", function (event) {
        const btn = event.target.closest("button[data-path]");
        if (!btn) return;
        showFile(btn.dataset.path);
      });

      document.getElementById("replay-file").addEventListener("click", function () {
        const path = codeView.current;
        const file = fileOf(path);
        if (!file) return;
        codeView.live = null;
        showFile(path, { review: true });
        // 用回看的方式再放一遍（不改变文件状态）
        let i = 0;
        codeBody.innerHTML = "";
        streamedLines = 0;
        if (streamTimer) clearInterval(streamTimer);
        streamTimer = setInterval(function () {
          if (codeView.current !== path) return;
          if (i >= file.lines.length) {
            clearInterval(streamTimer);
            streamTimer = null;
            return;
          }
          addLine(i, file.lines[i]);
          i += 1;
        }, 45);
      });

      document.getElementById("back-live").addEventListener("click", function () {
        const live = codeView.live;
        if (live) showFile(live);
        else {
          const last = FILES[FILES.length - 1];
          showFile(last.path);
        }
      });

      /* ───────────────── 交互 ───────────────── */

      document.getElementById("toggle-tasks").addEventListener("click", function () {
        work.classList.toggle("no-tasks");
        setTimeout(render, 60);
      });
      document.getElementById("show-tasks").addEventListener("click", function () {
        work.classList.remove("no-tasks");
        setTimeout(render, 60);
      });

      document.getElementById("toggle-code").addEventListener("click", function () {
        work.classList.toggle("no-code");
        if (!work.classList.contains("no-code") && !codeView.current && !document.documentElement.dataset.live) showFile("db/schema.sql");
        setTimeout(render, 60);
      });
      document.getElementById("hide-code").addEventListener("click", function () {
        work.classList.add("no-code");
        setTimeout(render, 60);
      });
      document.getElementById("show-code").addEventListener("click", function () {
        work.classList.remove("no-code");
        if (!codeView.current && !document.documentElement.dataset.live) showFile("db/schema.sql");
        setTimeout(render, 60);
      });

      document.getElementById("replay").addEventListener("click", function () {
        render();
        runTimeline();
      });

      window.addEventListener("resize", function () {
        clearTimeout(window.__treeResize);
        window.__treeResize = setTimeout(render, 150);
      });

      // 事件条：轮流滚几条真实感的事件
      const EVENTS = [];
      let ev = 0;
      const eventLine = document.getElementById("event-line");
      // v2：没有演示事件；只在真实事件到来时由 live.js 更新
      EVENTS.length = 0;

      /* ── 演示时间线：先给一个"已经写完的"看回看，再依次流式写两个新文件 ── */
      let timelineTimers = [];

      function runTimeline() {
        timelineTimers.forEach(clearTimeout);
        timelineTimers = [];
        const q = new URLSearchParams(location.search);
        FILES.forEach((f, i) => {
          f.state = i === FILES.length - 1 ? "live" : "done";
          f.written = 0;
        });
        codeView.live = null;

        // ?review=1：直接停在"回看已写完的文件"，不自动往下演
        if (q.get("review") === "1") {
          FILES.forEach((f) => (f.state = "done"));
          showFile(q.get("file") || "db/schema.sql");
          return;
        }

        const fast = q.get("fast") === "1";
        showFile("db/schema.sql"); // 一开始就能看到回看条
        timelineTimers.push(setTimeout(() => startFile("api/main.py"), fast ? 260 : 1600));
        timelineTimers.push(setTimeout(() => startFile("web/index.html"), fast ? 2200 : 5400));
      }
      // ?branches=12 模拟"分支很多"，用来看行距 / 列宽怎么被自动撑开
      seedBranches(0);

      // ?focus=3 直接进"聚焦第 3 道"（1 起算），方便演示与截图
      const focusParam = Number(new URLSearchParams(location.search).get("focus"));
      if (focusParam >= 1 && focusParam <= STAGES.length) {
        view.focus = focusParam - 1;
      }

      // ?edges=elbow 用折线（默认曲线）
      const edgesParam = new URLSearchParams(location.search).get("edges");
      if (edgesParam === "elbow" || edgesParam === "curve") {
        view.edges = edgesParam;
        document.querySelectorAll("[data-edges]").forEach((b) => {
          b.classList.toggle("is-on", b.dataset.edges === view.edges);
        });
      }

      // ?layout=td 直接进上下树
      const initialLayout = new URLSearchParams(location.search).get("layout");
      if (initialLayout === "td" || initialLayout === "lr") {
        view.layout = initialLayout;
        document.querySelectorAll(".layout-switch button").forEach((b) => {
          b.classList.toggle("is-on", b.dataset.layout === view.layout);
        });
      }

      // ?tasks=off 直接收起左侧清单
      if (new URLSearchParams(location.search).get("tasks") === "off") {
        work.classList.add("no-tasks");
      }

      // ?code=off 直接进"隐藏代码"态，方便演示与截图
      if (new URLSearchParams(location.search).get("code") === "off") {
        work.classList.add("no-code");
      }

      /* ───────── 真实数据桥：live.js 通过它驱动这一页 ───────── */
      const LIVE = { buf: new Map(), calls: 0 };

      function liveEnsureFile(path, lang) {
        let file = fileOf(path);
        if (!file) {
          file = { path, lang: lang || "text", state: "live", lines: [], written: 0 };
          FILES.push(file);
          renderTabs();
        }
        return file;
      }

      function liveRenderCurrent() {
        const file = fileOf(codeView.current);
        if (!file) return;
        codeBody.innerHTML = "";
        file.lines.forEach((text, i) => addLine(i, text));
        streamState.innerHTML =
          file.state === "done"
            ? `已生成 · <b id="line-count">${file.lines.length}</b> 行`
            : `流式写入 · <b id="line-count">${file.lines.length}</b> 行`;
        lineCount = document.getElementById("line-count");
      }

      function renderTaskList() {
        const list = document.querySelector(".t-child");
        if (!list || !TASK_STORE.tasks.length) return;
        const order = STAGE_ORDER;
        const sorted = TASK_STORE.tasks.slice().sort(function (a, b) {
          return order.indexOf(a.stage) - order.indexOf(b.stage);
        });
        list.innerHTML = sorted
          .map(function (task) {
            const stateText =
              task.state === "done" ? "完成"
                : task.state === "running" ? "进行中"
                  : task.state === "failed" ? "失败" : "等待";
            const cls = task.state === "running" ? " is-live" : task.state === "failed" ? " is-fail" : "";
            const short = String(task.file || "").split("/").pop();
            const label = task.title + (short ? " · " + short : task.note ? " · " + task.note : "");
            return '<div class="t-item' + cls + '" data-task="' + task.id + '">' +
              '<span class="name">' + label + "</span>" +
              '<span class="state">' + stateText + "</span></div>";
          })
          .join("");

        const count = document.querySelector(".tasks-head h2 .pill");
        if (count) count.textContent = TASK_STORE.tasks.length + " 项";
      }

      function refreshTaskViews() {
        renderTaskList();
        if (tcCurrent) showTaskDetail(tcCurrent);

        if (TASK_STORE.tasks.length) {
          // 进度 = (当前道 + 本道完成比) / 6。刚进一道时任务还没派完，
          // 若只按"已出现的任务"算，会出现 2 个任务全做完就 100% 的假象。
          const stageIndex = Math.max(0, STAGES.findIndex(function (item) { return item.state === "live"; }));
          const stageId = STAGE_ORDER[stageIndex];
          const inStage = TASK_STORE.tasks.filter(function (task) { return task.stage === stageId; });
          const doneInStage = inStage.filter(function (task) { return task.state === "done"; }).length;
          const ratio = inStage.length ? doneInStage / inStage.length : 0;
          const raw = Math.min(99, Math.round(((stageIndex + ratio) / 6) * 100));
          // 回环修复会真的回到前一道，但进度条不要把用户吓得以为白干了
          PLAY.maxPct = Math.max(PLAY.maxPct, raw);
          const pct = PLAY.maxPct;
          const pctEl = document.getElementById("pct");
          const barEl = document.getElementById("bar");
          if (pctEl) pctEl.textContent = pct + "%";
          if (barEl) barEl.style.width = pct + "%";
        }

        render();
      }

      /* ───────── 播放速度：0.1–1，1 是真实速度 ───────── */
      try {
        const saved = Number(localStorage.getItem("nexus-speed"));
        if (saved >= 0.1 && saved <= 1) PLAY.speed = saved;
      } catch (error) {
        /* 隐私模式读不到就按 1 处理 */
      }

      const speedInput = document.getElementById("speed");
      const speedBtn = document.getElementById("speed-btn");
      const speedPop = document.getElementById("speed-pop");

      function applySpeed(value) {
        const speed = Math.min(1, Math.max(0.1, Number(value) || 1));
        PLAY.speed = speed;
        if (speedBtn) speedBtn.textContent = (speed === 1 ? "1" : speed.toFixed(1)) + "×";
        if (speedInput && speedInput.value !== String(speed)) speedInput.value = String(speed);
        document.documentElement.style.setProperty("--node-dur", (0.28 / speed).toFixed(2) + "s");
        try {
          localStorage.setItem("nexus-speed", String(speed));
        } catch (error) {
          /* 存不了就算了 */
        }
      }

      if (speedInput) {
        applySpeed(PLAY.speed);
        speedInput.addEventListener("input", function () {
          applySpeed(speedInput.value);
        });
      }
      if (speedBtn && speedPop) {
        speedBtn.addEventListener("click", function (event) {
          event.stopPropagation();
          speedPop.classList.toggle("open");
        });
        document.addEventListener("click", function (event) {
          if (!speedPop.contains(event.target)) speedPop.classList.remove("open");
        });
      }

      /* ───────── 任务详情卡：点一下就知道它干了什么 ───────── */

      const tc = {
        box: document.getElementById("task-card"),
        stage: document.getElementById("tc-stage"),
        title: document.getElementById("tc-title"),
        state: document.getElementById("tc-state"),
        ms: document.getElementById("tc-ms"),
        file: document.getElementById("tc-file"),
        note: document.getElementById("tc-note"),
        open: document.getElementById("tc-open"),
      };
      let tcCurrent = null;

      const STATE_TEXT = { pending: "等待", running: "进行中", done: "完成", failed: "失败" };

      function fmtMs(ms) {
        if (!ms && ms !== 0) return "—";
        return ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s";
      }

      function showTaskDetail(id) {
        const task = TASK_STORE.tasks.find((item) => item.id === id);
        if (!task || !tc.box) return;
        tcCurrent = id;

        const index = STAGE_ORDER.indexOf(task.stage);
        if (tc.stage) tc.stage.textContent = index >= 0 ? "第 " + (index + 1) + " 道 · " + STAGES[index].name : task.stage;
        if (tc.title) tc.title.textContent = task.title || "任务";
        if (tc.state) {
          tc.state.textContent = STATE_TEXT[task.state] || task.state;
          tc.state.className = task.state === "failed" ? "is-fail" : "";
        }
        if (tc.ms) tc.ms.textContent = fmtMs(task.ms);
        if (tc.file) tc.file.textContent = task.file || "—";
        if (tc.note) {
          tc.note.textContent = task.reason
            ? "原因：" + task.reason
            : task.note ? "说明：" + task.note : "";
        }

        if (tc.open) {
          const target = task.file && fileOf(task.file) ? task.file : "";
          // 用 style.display，别用 hidden：.btn 的 display 会盖掉 [hidden]
          tc.open.style.display = target ? "" : "none";
          tc.open.onclick = function () {
            if (target) showFile(target);
          };
        }
        tc.box.hidden = false;
      }

      function hideTaskDetail() {
        tcCurrent = null;
        if (tc.box) tc.box.hidden = true;
      }

      if (tc.box) {
        const close = document.getElementById("tc-close");
        if (close) close.addEventListener("click", hideTaskDetail);
        document.addEventListener("keydown", function (event) {
          if (event.key === "Escape") hideTaskDetail();
        });
        // 事件委托：树上的任务卡和侧栏的任务项都能点
        document.addEventListener("click", function (event) {
          const hit = event.target.closest("[data-task]");
          if (!hit) return;
          const id = hit.dataset.task;
          if (!id || !TASK_STORE.tasks.some((item) => item.id === id)) return;
          showTaskDetail(id);
        });
      }

      window.__wb = {
        isLive: true,

        getSpeed() {
          return PLAY.speed;
        },

        setSpeed(value) {
          applySpeed(value);
          if (speedInput) speedInput.value = String(PLAY.speed);
        },

        stopTimeline() {
          timelineTimers.forEach(clearTimeout);
          timelineTimers = [];
        },

        /** 当前是第几道（0..5）：前面的算完成，当前进行中，后面等待 */
        setStage(index) {
          STAGES.forEach((s, i) => {
            s.state = i < index ? "done" : i === index ? "live" : "wait";
            // 带数字的说明（5 条验收标准 / 3 个分支并行）保留，其它换成完成
            if (i < index && !/^\d/.test(s.note)) s.note = "完成";
          });
          const groups = document.querySelectorAll("#task-list .t-group");
          const rows = groups[1];
          if (rows) {
            rows.querySelectorAll(".t-item").forEach((row, i) => {
              row.classList.toggle("is-live", i === index);
              const state = row.querySelector(".state");
              if (state) state.textContent = i < index ? "完成" : i === index ? "进行中" : "等待";
            });
          }
          const label = document.querySelector(".stage-progress .label span:first-child");
          if (label && STAGES[index]) label.textContent = "第 " + (index + 1) + " 道 · " + STAGES[index].name;
          render();
        },

        setProgress(pct) {
          const pctEl = document.getElementById("pct");
          const barEl = document.getElementById("bar");
          if (pctEl) pctEl.textContent = pct + "%";
          if (barEl) barEl.style.width = pct + "%";
        },

        /** 用真实任务替换第 3 道下面的分支卡与侧栏子项 */
        setBranches(items) {
          if (TASK_STORE.tasks.length) {
            // 已经有真实任务了，这里只更新道次说明，别把侧栏/树覆盖回演示数据
            if (STAGES[2]) STAGES[2].note = items.length + " 个任务并行";
            return;
          }
          TASKS.length = 0;
          items.forEach((it) => {
            TASKS.push({
              title: it.title || it.name || it.moduleId || "任务",
              file: it.file || "",
              state: it.state === "done" ? "done" : "live",
              progress: it.progress || 0,
              parallel: it.parallel !== false,
            });
          });

          const list = document.querySelector(".t-child");
          if (list) {
            list.innerHTML = items
              .map((it) => {
                const state = it.state === "done" ? "完成" : it.state === "live" ? "写入中" : "等待";
                const label = it.title || it.name || it.moduleId || "任务";
                const short = String(it.file || "").split("/").pop();
                return `<div class="t-item${it.state === "live" ? " is-live" : ""}"><span class="name">${label} · ${short}</span><span class="state">${state}</span></div>`;
              })
              .join("");
          }

          const count = document.querySelector(".tasks-head h2 .pill");
          if (count) count.textContent = items.length + " 项";
          if (STAGES[2]) STAGES[2].note = items.length + " 个任务并行";
          render();
        },

        /** 任务：created / started / done / failed 都走这里 */
        addTask(task) {
          if (!task || !task.id) return;
          const index = TASK_STORE.tasks.findIndex((item) => item.id === task.id);
          if (index >= 0) TASK_STORE.tasks[index] = Object.assign({}, TASK_STORE.tasks[index], task);
          else TASK_STORE.tasks.push(Object.assign({}, task));
          refreshTaskViews();
        },

        updateTask(id, patch) {
          const task = TASK_STORE.tasks.find((item) => item.id === id);
          if (!task) return;
          Object.assign(task, patch || {});
          refreshTaskViews();
        },

        clearTasks() {
          TASK_STORE.tasks.length = 0;
          PLAY.maxPct = 0;
          renderTaskList();
          render();
        },

        /** 流式代码：delta 累加到文件，done 时收尾 */
        feedFile(path, lang, delta, done, replace) {
          const file = liveEnsureFile(path, lang);
          if (replace) {
            // 修复时整文件重写，不是追加
            file.lines = [];
            LIVE.buf.set(path, "");
            file.state = "live";
          }
          const merged = (LIVE.buf.get(path) || "") + (delta || "");
          const parts = merged.split("\n");
          const rest = parts.pop();
          parts.forEach((line) => file.lines.push(line));
          LIVE.buf.set(path, rest);

          if (done) {
            if (rest) file.lines.push(rest);
            LIVE.buf.set(path, "");
            file.state = "done";
            if (codeView.live === path) codeView.live = null;
            renderTabs();
          }

          if (!codeView.current) {
            codeView.live = done ? null : path;
            showFile(path);
            return;
          }
          if (codeView.current === path) liveRenderCurrent();
        },

        /** 事件到达时切换焦点文件（可选） */
        focusFile(path) {
          if (codeView.current === path) return;
          if (fileOf(path)) showFile(path);
        },

        setCost(cny) {
          const budget = document.querySelector(".appbar-right .pill-plain");
          if (budget) {
            const limit = (budget.textContent.split("/")[1] || " ¥2.00").trim();
            budget.textContent = "¥" + Number(cny).toFixed(2) + " / " + limit;
          }
          const bottom = document.querySelector(".statusbar .cost");
          if (bottom) bottom.textContent = "本轮 ¥" + Number(cny).toFixed(2) + " · " + LIVE.calls + " 次模型调用";
        },

        addCall() {
          LIVE.calls += 1;
          const bottom = document.querySelector(".statusbar .cost");
          if (bottom) {
            const cny = (bottom.textContent.match(/¥([\d.]+)/) || [])[1] || "0.00";
            bottom.textContent = "本轮 ¥" + cny + " · " + LIVE.calls + " 次模型调用";
          }
        },

        setEvent(text) {
          const line = document.getElementById("event-line");
          if (line) line.textContent = text;
        },

        setStatus(status) {
          const pill = document.querySelector(".appbar-center .pill");
          if (!pill) return;
          const map = { running: "运行中", paused: "已暂停", done: "已完成", failed: "已失败", cancelled: "已取消" };
          const label = map[status] || status;
          let done = STAGES.filter((s) => s.state === "done").length;
          if (status === "done") {
            STAGES.forEach((s) => {
              s.state = "done";
              if (!/^\d/.test(s.note) && s.note !== "完成") s.note = "完成";
            });
            done = 6;
            const rows = document.querySelectorAll("#task-list .t-group")[1];
            if (rows) {
              rows.querySelectorAll(".t-item").forEach((row) => {
                row.classList.remove("is-live");
                const st = row.querySelector(".state");
                if (st) st.textContent = "完成";
              });
            }
          }
          pill.dataset.lock = "1"; // 别让 updateHeader 把它覆盖回「运行中」
          if (status === "running") delete pill.dataset.lock;
          pill.className = "pill " + (status === "running" ? "pill-live" : status === "done" ? "pill-ok" : "pill-warn");
          pill.innerHTML =
            (status === "running" ? '<i class="pulse-dot"></i>' : "") +
            label +
            " · 第 " + done + " / 6 道";
          if (status === "done") render();
        },

        /** 重播单个文件前，把它清空 */
        resetFile(path) {
          const file = fileOf(path);
          if (!file) return;
          file.lines = [];
          file.state = "live";
          LIVE.buf.set(path, "");
          if (codeView.current === path) liveRenderCurrent();
          renderTabs();
        },

        /** 文件写完：把对应分支从「写入中」改成「完成」 */
        markBranchDone(path) {
          const task = TASKS.find((item) => item.file === path);
          if (task) {
            task.state = "done";
            task.progress = 100;
          }
          const rows = Array.from(document.querySelectorAll(".t-child .t-item"));
          rows.forEach((row) => {
            const name = row.querySelector(".name");
            if (name && String(name.textContent).includes(String(path).split("/").pop())) {
              row.classList.remove("is-live");
              const state = row.querySelector(".state");
              if (state) state.textContent = "完成";
            }
          });
          render();
        },

        /** 实时模式开始时清掉页面自带的演示文件，避免和真内容叠在一起 */
        resetFiles() {
          FILES.length = 0;
          codeView.current = null;
          codeView.live = null;
          codeBody.innerHTML = "";
          renderTabs();
        },
      };

      // 带真实 run id 时由 live.js 驱动，不跑演示时间线
      const bootRunId = new URLSearchParams(location.search).get("run") || "";
      // v2：工作台必须带真实 run；没有就回项目页，不展示任何演示时间线
      if (!bootRunId) {
        location.replace("../projects/");
      }
      const liveMode = Boolean(bootRunId) && bootRunId !== "new";
      window.__wb.isLive = liveMode;

      // 首屏：先树，再代码流（实时模式不演）
      render();
      if (!liveMode && !bootRunId && FILES.length) runTimeline();
      window.__treeDone = true;

// 从首页带过来的需求：显示在面包屑上，演示时能看出"刚才输入的那句话"
      (function () {
        const prompt = new URLSearchParams(location.search).get("prompt");
        if (!prompt) return;
        const crumb = document.querySelector(".crumb b");
        if (crumb) crumb.textContent = prompt.length > 18 ? prompt.slice(0, 18) + "…" : prompt;
        document.title = "NexusHub · " + prompt.slice(0, 16);
      })();
