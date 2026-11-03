# Nexus 原型设计说明（Design Spec）

> 这份文档描述的是 `UI/` 目录下那套**纯静态原型**：它为什么看起来是这样、动效怎么做的、
> 每个数值是几、哪些坑必须避开。写它的目的是让这套东西能被复述、被复用、被改造成规范。
>
> 覆盖范围：`UI/pages/*.html`（欢迎、登录、项目、工作台、设置）、`UI/system/app.css`、
> `UI/system/glass.css`。所有数值都是代码里真实存在的值，不是估算。

---

## 0. 一句话概括

**白纸、蓝笔、克制的动效**：浅色底 + 单一强调蓝 + 细描边卡片 + 极轻的玻璃；
信息按"我在哪 → 它在干什么 → 它写了什么"的顺序排，动效只用来表达"正在发生"，不用来炫技。

原型里最"好看"的三个地方，原因都不在装饰：

1. **层次靠留白和描边**，不靠阴影堆叠。卡片阴影几乎不可见，只承担"浮起 1px"的心理暗示。
2. **只有一个强调色**。蓝色只出现在"会被点的地方"和"正在发生的地方"；状态色（绿/橙/红）只表达结果。
3. **动效有因果**。节点先出现、连线后画、代码后流——顺序本身就是信息（谁先谁后）。

---

## 1. 技术前提

| 项 | 说明 |
|---|---|
| 运行方式 | 纯 HTML + CSS + 原生 JS，**无构建、无依赖、无网络请求** |
| 打开方式 | 静态服务：`python -m http.server 5599 --directory UI`，访问 `/pages/xxx.html` |
| 截图工具 | `frontend/scripts/shot.mjs`（Edge CDP，可带 cookie、固定视口、等 2.5s 后截图） |
| 兼容目标 | Chromium 内核（用到了 `backdrop-filter`、`conic-gradient`、CSS 变量与 `data-*` 主题） |
| 字体 | 仅系统字体：`PingFang SC / Hiragino Sans GB / Microsoft YaHei / system-ui`；等宽 `JetBrains Mono → Cascadia Mono → Consolas` |

---

## 2. 设计语言

### 2.1 概念

原型讲的是**一间软件工厂**：左侧是任务清单（工单在往下派），中间是工作流树（工序在往下长），
右侧是代码流（文件在往下写），底部是事件条（机器在往下报）。

整套视觉都在服务这一件事：**让人相信"它真的在干活"**。

### 2.2 颜色

两套主题共用一套语义变量，只换值：

| 变量 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | `#f6f8fc` | `#0b0e14` | 页面底 |
| `--card` | `#ffffff` | `#12161e` | 卡片 / 面板 |
| `--card-2` | `#f7f9fd` | `#171c25` | 次级底色（输入框、hover） |
| `--card-3` | `#f1f5fb` | `#1b212b` | 三级底色（进度轨道、页签底） |
| `--line` | `#e7ebf3` | `#232936` | 主描边 |
| `--line-2` | `#dde4ef` | `#2c3441` | 次描边（更明显一点） |
| `--text` | `#0f172a` | `#e9edf5` | 正文主色 |
| `--text-2` | `#475569` | `#a9b3c4` | 次级文字 |
| `--text-3` | `#94a3b8` | `#6f7a8c` | 辅助 / 元信息 |
| `--primary` | `#2563eb` | `#3b82f6` | 唯一强调色 |
| `--primary-soft` | `#eef4ff` | `rgba(59,130,246,.14)` | 选中态底色 |
| `--primary-line` | `#c9d9ff` | `rgba(59,130,246,.42)` | 选中态描边 |
| `--ok` | `#16a34a` | `#4ade80` | 验收通过 |
| `--warn` | `#d97706` | `#fbbf24` | 待确认 / 写入中 |
| `--fail` | `#dc2626` | `#f87171` | 未通过 |

**用色规则（重要）**

- 蓝色 = "可交互" 或 "正在发生"。全页蓝色面积不超过 5%。
- 三个状态色**只**用于结果与状态，不做装饰：绿=通过、橙=等确认/写入中、红=失败。
- 正文与表格一律不用状态色，避免"看起来很吵"。

### 2.3 字体与字号

| 层级 | 字号 / 字重 / 字距 | 用在哪 |
|---|---|---|
| H1（营销） | `clamp(38px, 4vw, 56px)` / 800 / `-0.03em` | 首页主张 |
| H1（页内） | 22px / 700 / `-0.02em` | 设置、项目页标题 |
| 卡片标题 | 14px / 600 / 0 | 项目卡、面板标题 |
| 正文 | 13.5–16.5px / 400 / 0 | 段落 |
| 小字 | 12.5–13px | 说明、元信息 |
| 标签 | 11.5–12px / 500–600 / `0.1–0.14em` | 工序名、状态 |
| 等宽数字 | 10.5–12px，`font-variant-numeric: tabular-nums` | 花费、时间、行号 |

规则：**标题用无衬线、字距收紧；标签字距拉开；数字等宽对齐。**

### 2.4 形状与阴影

| 令牌 | 值 | 用途 |
|---|---|---|
| `--r-sm` | 9px | 按钮、输入、小标签 |
| `--r-md` | 12px | 节点卡、面板 |
| `--r-lg` | 16px | 内容卡片 |
| `--r-xl` | 20px | 大卡（首页流程卡、登录卡） |
| 胶囊 | 999px | 状态 pill、预算 chip、文件页签 |

| 阴影 | 值（浅色） | 说明 |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(15,23,42,.05)` | 节点默认 |
| `--shadow-card` | `0 1px 2px rgba(15,23,42,.04), 0 14px 30px -20px rgba(15,23,42,.24)` | 卡片默认 |
| `--shadow-pop` | `0 22px 48px -24px rgba(15,23,42,.32)` | hover 抬起 |

**关键**：第二个阴影的 spread 是负的（-20 ~ -28），所以它只在下缘留一圈很淡的投影。
这就是"看起来高级"的主要来源——**阴影不灰、不糊、不包围整个卡片**。

### 2.5 间距与栅格

- 基准 8px；常用 6 / 8 / 10 / 12 / 14 / 16 / 18 / 22 / 26 / 40。
- 页面横向 padding：营销页 40px，应用页 20px，内容区 32–40px。
- 卡片间距 18px；卡片内边距 14–22px。
- "呼吸"的来源：**大块留白只给一处**（首页 hero 上方 84–92px），其余地方紧凑。

### 2.6 图标

- 24×24 网格，`stroke-width: 1.6`，`stroke-linecap/linejoin: round`，**无填充**。
- 只允许四档显示尺寸：17 / 19 / 23 / 25px。
- 图标一律 `currentColor`，跟着文字颜色走，不单独上色（状态除外）。

---

## 3. 布局系统

### 3.1 营销页（`welcome.html`）

```
topbar 76px（sticky，胶囊导航居中，右侧 登录/注册）
hero：grid  minmax(0,1fr) 600px  gap 52  padding 84/88
      ├ 左：eyebrow + H1 + 副标 + composer(680) + 样例 + 四格数字
      └ 右：flow-card（六道工序，padding 40/34，圆角 20）
features：grid 3 列 gap 18（图标 + 标题同行，描述占满下一行）
footer：细线 + 三列等宽小字
断点：1180 → hero 单列；820 → 导航隐藏、工序换行
```

### 3.2 应用页（工作台）

```
appbar 60px（sticky）
work：grid
  columns: 300px  minmax(0,1fr)  420px
  rows:    minmax(0,1fr)  46px
  height:  calc(100vh - 60px)
  ├ 左：任务清单（可滚动）
  ├ 中：树画布（可滚动，点阵底）
  ├ 右：代码面板（可折叠 → 列宽变 0，中间自动占满）
  └ 底：statusbar（跨三列）
```

两栏都可收起，用 **grid 命名区域** 而不是自动流向：

```css
.work {
  grid-template-columns: 300px minmax(0,1fr) 420px;
  grid-template-areas: "tasks canvas code" "status status status";
}
.tasks { grid-area: tasks; } .canvas { grid-area: canvas; }
.code-pane { grid-area: code; } .statusbar { grid-area: status; }

.work.no-tasks { grid-template-columns: 0 minmax(0,1fr) 420px; }
.work.no-tasks .tasks { display: none; }
.work.no-code  { grid-template-columns: 300px minmax(0,1fr) 0; }
.work.no-code  .code-pane { display: none; }
.work.no-tasks.no-code { grid-template-columns: 0 minmax(0,1fr) 0; }
```

**为什么必须命名区域**：用自动流向时，`.tasks` 一旦 `display:none`，后面的 `.canvas` 会顶到第一列（0 宽），
`.code-pane` 顶到第二列（1fr）——结果代码面板占满整屏、树消失。这是实际踩到的坑。

**不用动画折叠列宽**——列宽动画会触发整页重排抖动，视觉上反而廉价。

### 3.3 断点

| 断点 | 页面 | 变化 |
|---|---|---|
| ≤1180 | 首页 | hero 改单列，H1 48px，能力三块改单列 |
| ≤1080 | 项目页 | 卡片 3 → 2 列 |
| ≤900 | 设置页 | 左侧分区栏隐藏，字段改成上下排 |
| ≤820 | 首页 | 顶栏导航隐藏，六道工序换行（每行 3 个） |
| ≤720 | 项目页 | 卡片单列 |

> 工作台（`workbench.html`）**没有做窄屏适配**：三栏 + 树 + 代码面板在 1024 以下需要另想布局，
> 这是刻意留的未完成项，不要当成遗漏。

---

## 4. 组件清单与状态

| 组件 | 尺寸 | 状态 | 交互 |
|---|---|---|---|
| `.btn-primary` | h40 / padding 0 18 | 默认渐变蓝、hover 加深 | 点击有 0.16s 颜色过渡 |
| `.btn`（ghost） | 同上 | 透明底 + 描边 | hover 变浅蓝底 |
| `.btn-sm` | h32 / 12px 字 | — | 用于工具条 |
| `.pill` | 4/11 padding，999 圆角 | plain / live / ok / warn / fail | 静态，不点（点的是里面的按钮） |
| `.composer` | h46，内嵌按钮 | focus 时外圈 4px 蓝晕 | 输入框无边框，容器负责框 |
| `.file-tabs button` | 11px 等宽 | 默认 / 当前（蓝底）/ done（绿 ✓）/ live（蓝底"写入中"） | 点击切文件 |
| `.review-bar` | 高约 30 | 仅回看时显示（橙底） | 两个文字按钮 |
| `.node-root` | LR 200×58 / TD 240×60 | 单态 | 无 |
| `.node-stage` | LR 200×56 / TD 104×64 | done / live / wait / focus | 点击进/出聚焦 |
| `.node-task` | LR 150×52 / TD 132×52 | done / live / ghost / parallel | 无（未来点开文件） |
| 顶栏「清单 / 代码」 | h32 | 打开 / 收起 | 收起对应侧栏，树自动占满 |

**一个必须记住的样式陷阱**：基类写了 `.node-stage { opacity: 0 }`（等动画放行），
如果状态类直接写 `.node-stage.wait { opacity: .55 }`，它会**盖过基类**，
导致"还没轮到"的工序在开场就露出来。正确写法是 `.node-stage.in.wait { opacity: .55 }`——
把状态挂在"已入场"之后，入场顺序才不会被状态样式破坏。
| `.t-item`（任务清单） | 行高 30 | 普通 / is-live / 三级缩进 | 静态 |
| `.statusbar` | h46 | 三个页签 | 切换（示意） |
| `.swatch`（设置） | 92×62 | 选中 / 未选 | 选主题 |

---

## 5. 树型工作流：这是原型的主角

### 5.1 数据结构

```js
// 二级：固定六道
STAGES = [{ no, name, short, note, state: "done|live|wait", icon }, ...]

// 三级：主控按需分析出来的活，同一道下可以并行
TASKS = [{ title, file, state: "done|live", progress: 0-100, parallel: true }, ...]

// 视图状态
view = { layout: "lr" | "td", focus: null | stageIndex }
```

### 5.2 两种排布（坐标公式）

**左右树（lr）**：根在左，六道竖排，三级往右

行距**不是固定的 74**，而是每一道单独算（见 5.2.1）：

```
root   = (20, 14, 200×58)
rowH_i = max(56+18, subtreeH_i + 32)      // 56=卡高，18=最小缝
y_0 = 18;  y_{i+1} = y_i + rowH_i        // ← 谁的分支多，谁和下一道之间就变长
stage  = (268, y_i, 200×56)
bus    = x 242（根右侧 26px），从首道中心竖到末道中心
task   = (512, firstTop + k*(h+gap), 150×52)，firstTop = max(center_i - stackH/2, y_i)
```

**上下树（td）**：根在上，六道横排，三级往下

```
root  = ((W-240)/2, 14, 240×60)
stage = (x0 + i*(104+12), 138, 104×64)    // x0 居中
busY  = 110（根的底部 → 横总线 → 各道顶部）
task  = (tx0 + i*(132+12), 138+64+52, 132×52)
```

**为什么两套尺寸不同**：上下树一行要塞六张卡，中间栏只有约 720px，
所以卡宽压到 104（宽屏 ≥900 时 138 并用全名）、只放"编号 + 名字 + 一句状态"；左右树宽度富余，才用完整卡（200 宽，图标+全名+说明）。

### 5.2.1 动态伸缩：行距/列宽按子树大小单独算

固定行距在分支一多时必然挤在一起（第一版就是这样：三个分支只隔 10px）。规则改成三条：

1. **每一行的高度独立**：`rowH_i = max(最小行高, 子树高度 + 上下留白)`。
   谁的分支多，`rowH_i` 就大，**它和下一道之间的空隙自动变长，别的间距一个像素都不动**。
2. **父卡与子树共用一条中心线**（这条是后来改的，第一版把子树夹到父卡上沿，看着"全往下掉"）：

   ```
   bandH_i   = max(卡高, 子树高)          // 每一道占一条"带"
   center_i  = 带的顶部 + bandH_i / 2      // 父卡与子树都用这条线
   y_i       = center_i - 卡高/2
   firstTop  = center_i - 子树高/2         // 子树以父卡为中心上下铺开
   ```
   相邻两道按各自带高留缝，所以"哪个分支多，哪个和下一道之间就长"依然成立，但左右是对称的。
3. **分支多时先压矮再折叠**：≥6 个时卡片从 52 降到 40、间距 10→8（`dense` 模式，只留标题与进度）；
   超过 5 个先折叠成"还有 N 个分支 / 点开展开"，展开后重新走第 1 条——行距继续撑开。

上下树的对应物是**列宽**：`colW_i = max(卡宽, 子树宽度)`，谁的子节点多，它那一列就更宽，
其余列不变。放不下时自动减少可见分支（4 → 3 → 2），保证六道工序都留在屏内。

```js
// 左右树
const rows = stages.map((stage) => {
  const kids = childrenOf(index, 5);
  const stackH = kids.length * h + (kids.length - 1) * gap;
  return { kids, stackH, rowH: Math.max(56 + 18, stackH + 32) };
});
let cursor = 18;
rows.forEach((r) => { r.y = cursor; r.center = cursor + 28; cursor += r.rowH; });
```

### 5.3 连线：一条连续路径 + 圆角 + 归一化描边

第一版连线"看着有缺口"，其实是四个问题叠在一起，缺一个都修不干净：

| 现象 | 原因 | 解法 |
|---|---|---|
| 拐角缺一块 | 主干和支线是**两条独立 `<path>`**，各自圆头收笔，接头处两个端帽对不上 | 每条分支从根出发**一条连续路径**走到卡片 |
| 拐角生硬 | 硬 90°，1–2px 线宽下拐点像被"切"了一刀 | 拐角用二次贝塞尔过渡（`Q`），半径 10–12px，按相邻段长度自动收敛 |
| 线尾差半像素 | `stroke-dasharray: getTotalLength()` 取整后比实际短一点，末尾留缝 | `pathLength="1"` + `stroke-dasharray: 1`，全部用归一化长度 |
| 线头与卡片之间有一道白 | 线停在卡片左边缘，卡片的圆角与描边让接头露白 | 线**钻进卡片下方 10px**（卡片不透明且层级更高） |

还有一个隐蔽的错位源：SVG 用 `inset: 0; height: 100%` 撑满的是 **padding box**，而 `viewBox` 用的是内容高度，
`preserveAspectRatio="none"` 会把 y 坐标整体拉伸几个像素——线看着"偏下"就是这么来的。
现在直接把 `svg.style.height` 钉成 `plan.height`，与 viewBox 严格 1:1。

```js
/** 折线转圆角路径：拐角用二次贝塞尔，半径按相邻段长度自动收敛 */
function roundedPath(points, radius = 10) {
  const pts = points.filter((p, i) => i === 0 ||
    Math.abs(p[0] - points[i-1][0]) > 0.01 || Math.abs(p[1] - points[i-1][1]) > 0.01);
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const [x0, y0] = pts[i-1], [x1, y1] = pts[i], [x2, y2] = pts[i+1];
    const inLen = Math.hypot(x1-x0, y1-y0), outLen = Math.hypot(x2-x1, y2-y1);
    const r = Math.min(radius, inLen/2, outLen/2);      // ← 关键：半径不能超过相邻段一半
    if (r < 0.6) { d += ` L ${x1} ${y1}`; continue; }
    const ux = (x1-x0)/inLen, uy = (y1-y0)/inLen;
    const vx = (x2-x1)/outLen, vy = (y2-y1)/outLen;
    d += ` L ${x1-ux*r} ${y1-uy*r} Q ${x1} ${y1} ${x1+vx*r} ${y1+vy*r}`;
  }
  d += ` L ${pts[pts.length-1][0]} ${pts[pts.length-1][1]}`;
  return d;
}

// 每条分支一条路径：根 → 主干 → 拐角 → 卡片（终点多钻 10px 进卡片）
paths.push(roundedPath([[rootRight-8, rootCy], [busX, rootCy], [busX, row.center], [stageX+10, row.center]], 12));
```

```css
.tree-svg path {
  fill: none;
  stroke: #b7cbf3;          /* 比 primary-line 深一档，2px 下才"站得住" */
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  shape-rendering: geometricPrecision;
}
/* 归一化后 dash 长度恒为 1：动画收尾不会差半像素 */
.tree-svg path.draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw .5s ease forwards; }
@keyframes draw { to { stroke-dashoffset: 0; } }
```

```js
path.setAttribute("pathLength", "1");       // 归一化 dash
svg.style.height = plan.height + "px";      // 与 viewBox 1:1，杜绝 y 拉伸
```

参考实现：React Flow 的 `getSmoothStepPath`（圆角直角边）、
`pathLength` 归一化 dash（避免 `getTotalLength` 取整误差）都是业界常见做法。

#### 曲线 or 折线：这是"丝滑"的真正来源

视频画布类产品（React Flow、ComfyUI 这类）看着顺，不是因为技术栈不同——它们也是 SVG / canvas 画的。
差别在**边的几何**：

| | 折线（elbow） | 曲线（cubic Bézier） |
|---|---|---|
| 形态 | 正交直角 + 圆角 | 从源点切线方向出发，平滑汇入目标点 |
| 交叉 | 必须绕开，否则像"电路板乱线" | 允许交叉，交叉本身不脏，反而像神经网络 |
| 适用 | 层级 / 流水线（谁接谁一目了然） | 多对多、大量分支的图 |

```js
// 横向：控制点按水平距离给，出入角度都接近水平，才"顺"
function curveH(x0, y0, x1, y1) {
  const dx = Math.max(56, Math.abs(x1 - x0) * 0.8);
  return `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x1 - dx} ${y1}, ${x1} ${y1}`;
}
```

曲线要好看，**必须给它横向余量**：同样的树，根到工序只留 48px 时曲线会挤成 S 形；
留到 100px 以上才舒展。所以曲线模式下根卡变窄、列间距加大（`ROOT.w 168 / STAGE_X 316`），
折线模式仍用原来的紧凑尺寸。

工作台右上角可以实时切换「曲线 / 折线」（`?edges=elbow`）。
### 5.4 生成时序（单位 ms）

| 时刻 | 动作 |
|---|---|
| 100 | 根节点落入（`opacity 0→1` + `translateY(-8px)→0` + `scale(.98)→1`，0.28s） |
| 260 | 主干线开始画 |
| 380 + i×170 | 第 i 道工序卡落入 |
| 上一步 + 40 | 该道工序的连接线开始画（0.5s） |
| 1480 + i×200 | 三级任务卡依次落入，连线同步 |
| 1480 + n×200 + 120 | "继续分析…"虚线占位落入 |

代码流另有一条时间线（与树并行）：`0` 显示已完成的 `db/schema.sql`（回看态）→ `1600` 开始流式写 `api/main.py` → `5400` 切到 `web/index.html`。
`?fast=1` 会把后两个时刻压到 `260 / 2200`，方便演示与截图。

### 5.5 状态视觉映射

| 状态 | 视觉 | 理由 |
|---|---|---|
| `done` | 图标变绿，卡面正常 | 完成是"不再吸引注意"的状态，不该高亮 |
| `live` | 蓝色描边 + 4px 淡蓝外圈 | 全场只有 1–3 个，必须一眼看到 |
| `wait` | 整体 `opacity: .55` | "还没轮到"，压下去；**必须写成 `.node-stage.in.wait`** |
| `focus` | 蓝边 + 更强外圈 | 被聚焦的那一道 |

### 5.6 并行：同一道工序下的多分支

三件事缺一不可：

1. 顶部 pill 改复数：`运行中 · 第 3/6 道 · 2 个分支并行`
2. 每个分支卡自己带 **迷你进度条**（3px 高，卡内）+ **"并行"徽标**（卡内右上，浅蓝底）
3. 底部成本按分支聚合（原型里是静态文字，但结构上留了位置）

> 背景知识：这套产品当初定的并行粒度是**模块**，不是文件——文件级并行会产生大量合并冲突，收益为负。
> 所以并行在界面上表现为"几个模块同时在写"，而不是"几十个文件同时在闪"。

### 5.7 单体聚焦

- 触发：点任意工序卡；再点一次或点"退出聚焦"返回。
- 渲染：只画 `根 → 被聚焦的那一道 → 它的三级`，其余折叠成一枚虚线占位：
  `其余 5 道工序在后台继续 / 聚焦不打断执行`。
- 顶部出现聚焦条：`聚焦：03 三方向生成 · 其余工序在后台继续 · 退出聚焦`。
- **代价必须写出来**：不写"后台继续"，用户会以为停了。

---

## 6. 代码流面板

### 6.1 数据模型

```js
FILES = [{
  path: "web/index.html",
  lang: "html",
  state: "done" | "live",
  written: 0,          // 已写入行数（进度就存在这里）
  lines: ["<!doctype html>", ...]
}]

codeView = { current: "web/index.html", live: "web/index.html" | null }
```

### 6.2 流式写入

```js
streamTimer = setInterval(() => {
  const file = fileOf(path);
  if (file.written >= file.lines.length) { /* 收尾：标 done、去掉光标、显示回看条 */ }
  if (codeView.current === path) addLine(file.written, file.lines[file.written]);
  file.written += 1;
}, 45);   // 45ms/行：既看得出在动，又不至于让人等
```

**关键设计**：进度存在 `file.written`，不在计时器里。这样用户可以随时切走去看别的文件，
后台继续写；切回来时先补齐 `0..written` 再继续流。

### 6.3 换文件时"框不消失"

- 面板**始终存在**，只换 `#file-name`、页签、内容；
- 换的瞬间给面板加 `.flash`（0.6s 内描边闪一下蓝），给内容加 `.swap`（0.28s 淡入 + 上移 4px）；
- 目的：让用户感知到"同一个框刷新了"，而不是"页面跳走了"。

```css
.code-pane.flash { animation: pane-flash .6s ease; }
@keyframes pane-flash {
  0% { box-shadow: inset 0 0 0 2px rgba(37,99,235,.5); }
  100% { box-shadow: inset 0 0 0 2px rgba(37,99,235,0); }
}
.code-body.swap { animation: body-swap .28s ease; }
@keyframes body-swap { from { opacity:0; transform: translateY(4px);} to { opacity:1; transform:none; } }
```

### 6.4 回看

- 页签保留所有生成过的文件：`✓` 已完成、蓝色 `写入中` 正在进行、灰色 `待生成`。
- 切到已完成文件 → 显示回看条：`回看 · <path> 已生成完毕` + `重播这次生成` + `回到实时`。
- 重播：按 45ms/行 重新放一遍，**不动文件状态、不影响正在写的文件**。

### 6.5 语法高亮（无依赖，40 行）

一次正则分组，按顺序处理：注释 → 字符串 → HTML 标签 → 关键字 → 数字。

```js
const re = /(#[^\n]*|--[^\n]*|\/\/[^\n]*)|('[^']*'|"[^"]*")|(<\/?[a-zA-Z][^>]*>)|(\b(?:import|def|return|...)\b)|(\b\d+\.?\d*\b)/g;
```

要点：
- **先把每段转义再拼 HTML**（`esc()`），否则代码里的 `<` 会把 DOM 弄坏；
- 数字放最后一组，避免把 `1500` 里的 `1` 单独包起来；
- 字符串组在标签组之前，保证 `"<div>"` 被当字符串而不是标签。

### 6.6 三个必须记住的坑

| 坑 | 现象 | 解法 |
|---|---|---|
| 代码数据里含 `</script>` | 外层 `<script>` 被提前闭合，整段 JS 变成页面文字 | 数据里写 `<\/script>` |
| 回看态没保留 `#line-count` 节点 | 只渲染第 1 行，第 2 行抛错 | 两种状态的 HTML 都带 `<b id="line-count">` |
| grid 子项 `min-width: auto` | 长代码行把列撑宽、不折行，被面板裁掉 | `pre { min-width: 0; width: 100% }` |

---

## 7. 动效清单

| 名称 | 时长 / 缓动 | 触发 | 作用 |
|---|---|---|---|
| `draw` | 0.5s ease | 连线出现 | 把"这条线接上了"演出来 |
| 节点落入 | 0.28s ease | 卡片出现 | `opacity` + `translateY(-8px)` + `scale(.98)` |
| `item-in` | 0.32s ease | 任务清单逐项 | 依次出现，暗示"派活顺序" |
| `pane-flash` | 0.6s ease | 换文件 | 同一个框刷新了内容 |
| `body-swap` | 0.28s ease | 换文件内容 | 淡入 + 上移 4px |
| `breathe` | 1.4s ease-in-out 无限 | 运行中的圆点 | 呼吸，不闪 |
| `blink` | 1s steps(1) 无限 | 代码末尾光标 | 打字机既视感 |
| hover 抬起 | 0.16s ease | 卡片 | `translateY(-2px)` + `--shadow-pop` |
| 颜色过渡 | 0.16–0.2s ease | 按钮/导航/主题切换 | 避免"啪"地变色 |

**动效原则**

1. 只动 `opacity` / `transform`（合成层），不动 `width/height/top/left`。
2. 时长控制在 0.16–0.5s；唯一超过 1s 的是呼吸点（它是"持续状态"，不是"过渡"）。
3. 动画**表达因果**：先节点、后连线、再代码；顺序本身是信息。
4. 不做入场浮夸动画（无整页 fade-in、无视差），页面一打开就该可读。

---

## 8. 背景与玻璃

### 8.1 素面（默认）

```css
html, body { background: var(--bg); }          /* #f6f8fc */
body::before {                                  /* 极淡的光晕 */
  content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(900px 460px at 80% -10%, #ffffff 0%, rgba(255,255,255,0) 68%),
    radial-gradient(700px 340px at 6% 0%, #f1f6ff 0%, rgba(241,246,255,0) 72%);
}
```

工作台画布另有**点阵底**：

```css
.canvas {
  background-color: rgba(255,255,255,.55);                                  /* 一层白纱 */
  background-image: radial-gradient(rgba(37,99,235,.14) 1px, transparent 1px); /* 点阵 */
  background-size: 22px 22px;
}
```

点阵只做"尺度感"，透明度 0.14，近看才有——**远看是纯色，近看有细节**，这是它显得"专业"的原因之一。

### 8.2 玻璃态（`?style=glass`）

玻璃要成立，必须先有"可透的东西"：

```css
body::after {                       /* 四团模糊色块 */
  inset: -20%; filter: blur(48px) saturate(1.2);
  background:
    radial-gradient(38% 42% at 22% 12%, rgba(59,130,246,.55), transparent 70%),
    radial-gradient(34% 38% at 82%  8%, rgba(56,189,248,.50), transparent 72%),
    radial-gradient(40% 44% at 72% 92%, rgba(125,211,252,.40), transparent 74%),
    radial-gradient(30% 34% at  8% 82%, rgba(129,140,248,.28), transparent 72%);
}

.card {
  background: linear-gradient(155deg, rgba(255,255,255,.88) 0%, rgba(255,255,255,.60) 38%, rgba(255,255,255,.46) 100%);
  backdrop-filter: blur(20px) saturate(1.25);
  border: 1px solid rgba(255,255,255,.85);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.95), 0 18px 44px -26px rgba(17,58,128,.45);
}
```

四条原则：

1. **背景先有颜色**，否则玻璃等于白板；
2. **半透 + 内高光**（`inset 0 1px 0 white` 就是玻璃的"上边缘"）；
3. **光只落在会被点的东西上**（主按钮、当前工序、进度条），正文一律不发光；
4. **工作区要安静**：画布区再压一层 `rgba(255,255,255,.34)` 白纱，否则色块透上来干扰读节点。

> 用户的反馈是"玻璃态太明显了"。当前工作台只用**轻玻璃**：`rgba(255,255,255,.72–.86)` + `blur(8–12px)`，**零外发光**。
> 结论：玻璃用在"浮起来的面板"上，不要用在"整页背景"上。

### 8.3 主题切换

```js
// 两个维度，互不干扰
document.documentElement.dataset.theme = "light" | "dark";
document.documentElement.dataset.style = "" | "glass";
```

- 状态存 `localStorage["nexus-theme"]`；
- URL 可覆盖：`?theme=dark&style=glass`；
- 切换按钮就是顶栏那个太阳/月亮图标（工作台放在右侧工具区）。

---

## 9. 交互清单（原型里真实可用的）

| 位置 | 操作 | 结果 |
|---|---|---|
| 顶栏 | 点太阳/月亮 | 整页切主题 |
| 画布标题栏 | 点「左右树 / 上下树」 | 重排 + 重播动画 |
| 画布标题栏 | 点「重播生成」 | 树与代码流从头演一遍 |
| 画布 | 点任意工序卡 | 进入聚焦；再点或点「退出聚焦」返回 |
| 代码面板 | 点文件页签 | 切换文件（回看/实时） |
| 代码面板 | 点「重播这次生成」 | 重放该文件的生成过程 |
| 代码面板 | 点「回到实时」 | 跳回正在写的文件 |
| 顶栏 | 点「代码」 | 收起/展开代码面板（树自动占满） |
| 顶栏 | 点「›」 | 同上 |

---

## 10. 为什么它看起来"好"（可复用的判断标准）

1. **一个页面只有一个视觉焦点**。工作台里是"当前工序"；首页里是那句 H1 + 输入条。
2. **层级靠尺寸与留白，不靠颜色**。标题 22–56px、正文 13.5px，中间没有模糊地带。
3. **描边比阴影可靠**。1px `#e7ebf3` 的描边，在任何缩放下都清晰；阴影会糊。
4. **动效只解释因果**。用户看懂"先有节点再有线"就理解了流水线，不需要额外的图例。
5. **状态可对账**。"验收 6/6"、"工序 03 · 3 个分支并行"、"流式写入 · 8 行"——全是可验证的事实，不是形容词。
6. **信息按"我在哪 → 它在干什么 → 它写了什么"排**。左中右三栏正好对应这三问。
7. **克制**：全页没有渐变标题、没有发光边框、没有玻璃拟态滥用、没有图标外发光。

---

## 11. 复用到真实产品时需要补的

| 需要 | 说明 |
|---|---|
| 组件化 | 现在是一个 HTML 内联样式；落地要拆成 React 组件 + Tailwind token |
| 真实数据 | 树来自 `planning/from-run.ts` 的投影；代码流来自 SSE 的 `text` 片段 |
| 虚拟滚动 | 树节点超过 200 个时，DOM 会卡；代码行超过 2000 行需要窗口化 |
| 键盘可达 | 目前只有鼠标：需要 `.node-stage` 可 Tab、Enter 聚焦、Esc 退出 |
| `prefers-reduced-motion` | 尊重系统设置，关闭 `draw`/`breathe`/`blink` |
| 真正的折叠动画 | 现在是瞬间折叠；如果要动画，只动 `opacity` 与 `translateY` |

---

## 12. 附：文件与参数索引

```
UI/
  system/app.css      设计令牌 + 通用组件（按钮/胶囊/面板/表单/图标容器）
  system/glass.css    玻璃态外观（只覆盖表面）
  pages/welcome.html  营销页（含 welcome.css）
  pages/login.html    登录
  pages/projects.html 我的项目
  pages/workbench.html 树 + 三栏 + 代码流（本文件第 5、6 节的主体）
  pages/settings.html 设置
  shots/              迭代截图
```

工作台 URL 参数：

| 参数 | 作用 |
|---|---|
| `?layout=lr` / `?layout=td` | 左右树 / 上下树 |
| `?focus=3` | 直接进"聚焦第 3 道" |
| `?code=off` | 收起代码面板 |
| `?fast=1` | 压缩演示时间线 |
| `?review=1&file=api/main.py` | 停在回看态 |
| `?tasks=off` | 收起左侧任务清单 |
| `?theme=dark&style=glass` | 深色 + 玻璃 |