# NexusHub · 一个网页里的软件工厂

> 一句话进去，六道工序自己走完，最后交给你一个**能运行、被自动验收过的软件包**。
> 全过程可见、可暂停、可确认，花了多少钱也摊在界面上。

NexusHub 是 2026 第九届传智杯 · AI WEB 网页开发挑战赛（技术应用赛）参赛作品。

---

## 1. 项目定位

现在的 AI 编程工具大多还是「对话式」的：

- 用户得一直陪着走，一轮轮补上下文；
- 跑到一半不知道它在干什么、花了多少钱；
- 长任务一旦在中途失败，前面的投入很难复用。

NexusHub 把软件开发拆成六道**确定性工序**，每道工序内部由模型完成规划、生成和检查：

```text
需求分析 → 架构设计 → 自主开发 → 集成装配 → 自动测试 → 验收交付
                                      ↑            │
                                      └── 失败回环 ─┘
```

目标用户是**有明确需求、但缺少工程时间或工程能力的学生 / 独立开发者**。它不是「什么都能聊」的通用助手，而是一条可观察、可验收的软件交付流水线。

---

## 2. 现在能做什么

| 能力 | 状态 | 说明 |
|---|---|---|
| 登录 / 注册 / 会话 | ✅ | argon2id 密码哈希 + 7 天会话 |
| 项目列表 / 筛选 / 删除 | ✅ | 真实 MySQL 数据 |
| 一句话创建运行 | ✅ | 真实调用模型，创建六道工序运行 |
| 六道工序与任务树 | ✅ | 每道工序有任务、状态、耗时、失败原因 |
| SSE 实时事件 | ✅ | 任务、文件、推理、检索、费用、门禁、验收 |
| 代码流式写入 | ✅ | 按文件推送增量，前端逐行渲染 |
| 自动测试与失败回环 | ✅ | 真起进程、真发 HTTP 请求；失败带错误回第 3 道修，最多 2 轮 |
| 产物预览 | ✅ | 本机进程运行时，动态端口；`RUNTIME_RUNNER=process` |
| 人工门禁 | ✅ | 运行中可暂停并提问，用户回答后继续 |
| 费用台账 | ✅ | 按 token 记录，单次运行有成本上限 |
| RAG 检索 | ✅ | spec / design 阶段混合检索；发 `retrieval` 事件并展示依据 |
| AI 记忆 | ✅ | 只注入辅助开发，不注入主工作流 |
| 辅助开发工作台 | ✅ | 六阶段、CodeMirror、代码检查、AI 教练、记忆 |
| 主控 Agent 新建任务 | ✅ | 可输入需求、上传多份文本/代码文档、下载内置测试用例 |
| 刷新恢复 | ✅ | 草稿、树布局、聚焦、展开、当前文件、页签、滚动位置 |
| 多模态输入 | ❌ | 当前没有图片 / 语音 / 视频输入 |
| MCP 协议 | ❌ | 只有 Function Calling 工具；`mcp_server.py` 是明确的未实现占位 |
| 强隔离沙箱 | ⚠️ | 本机进程运行 + 语法/路径检查；没有容器级网络与资源隔离 |

> **不把未完成写成已完成。** 上表里 ❌ / ⚠️ 的能力不会在界面或文案里伪装成已支持。

---

## 3. 系统架构

```text
┌─────────────────────────────────────────────────────┐
│ 浏览器                                               │
│ Vue 3 + Vite + TypeScript                           │
│ 9 个页面；工作台通过 SSE 渲染事件                    │
└───────────────┬─────────────────────────────────────┘
                │ /api/*  HTTP + SSE
┌───────────────▼─────────────────────────────────────┐
│ FastAPI                                             │
│                                                     │
│  api/ auth · projects · runs · gate · memory        │
│       assist · rag · skills · settings              │
│                                                     │
│  pipeline/ 六道工序编排 + 事件记录 + 门禁            │
│  ai/       模型客户端 · 结构化输出 · RAG · 成本      │
│  runtime/  产物进程启动 / 健康检查 / 回收            │
│  db/       SQLAlchemy 模型 + Alembic 迁移            │
└───────────────┬─────────────────────────────────────┘
                │
        MySQL 8（nexus）
```

### 六道工序

| 工序 | 产物 | 关键动作 |
|---|---|---|
| 01 需求分析 | `SpecV2` | 澄清边界、生成验收标准、检索开发规范 |
| 02 架构设计 | `ArchV2` | 模块拆分、依赖关系、文件清单、检索架构规范 |
| 03 自主开发 | 真实文件 | 按依赖顺序逐文件生成；语法 / SQL / HTML 结构校验；失败重试 |
| 04 集成装配 | 可启动工程 | 装配入口、依赖、端口和运行环境 |
| 05 自动测试 | 测试用例与结果 | 启动产物、读 OpenAPI、生成 HTTP / 页面用例并执行 |
| 06 验收交付 | 交付摘要 + 预览 | 汇总验收结果、产物说明、运行地址 |

测试失败时进入回环：把真实错误带回第 3 道工序修复，再重新测试；最多 2 轮，避免无限烧钱。

### AI 技术点

- **结构化阶段契约**：每道工序输出 Pydantic 模型，下游按契约读取，不靠自然语言猜。
- **混合 RAG**：本地向量余弦 + 字符 n-gram 词面匹配；语料在 `源码/RAG-knowledge/`，当前 8 篇开发规范。
- **检索可追溯**：命中结果写入 `retrieval` 事件，工作台显示来源、摘要和条数。
- **工具调用**：辅助 Agent 通过 Function Calling 调用 `list_files` / `read_file` / `check_syntax` / `search_knowledge`，工具轨迹回传前端。
- **人工门禁**：运行中暂停，前端收集问题答案，后端继续执行。
- **成本台账**：按模型、token、运行记录费用；`RUN_COST_LIMIT_CNY` 控制上限。
- **录制回放**：模型客户端支持 `off / record / replay`，回放读取 `backend/data/cassettes`。
- **模型配置**：默认 DeepSeek `deepseek-chat`；`MODEL_DECIDE` / `MODEL_EXECUTE` 可按阶段配置，但**当前默认仍是同一模型**，没有包装成「双模型路由」。

---

## 4. 前端工程

### 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Vue 3.5 |
| 构建 | Vite 8（多页面入口） |
| 语言 | TypeScript 5.9，`strict: true` |
| 样式 | 原生 CSS + 设计令牌 |
| 代码编辑 | CodeMirror |
| 通信 | `fetch` + `EventSource` |

### 页面

| 页面 | 路径 |
|---|---|
| 登录 / 注册 | `/login/`、`/register/` |
| 项目列表 | `/projects/` |
| 设置 | `/settings/` |
| AI 记忆 | `/memory/` |
| 辅助项目列表 | `/assist/` |
| 辅助工作台 | `/assist/workspace/` |
| 欢迎页 | `/welcome/` |
| 主工作台 | `/workbench/` |

### 工程做法

- `src` 下没有 `.js` 文件；`vue-tsc --noEmit` 是构建闸门。
- 辅助工作台拆成 `StageRail`、`PlanStage`、`CodeStage`、`CodeEditor`、`TestsPanel`、`DeliverPanel`、`FindingsPanel`、`CoachPanel`，状态集中在 `useWorkspace`。
- 主工作台拆成 `TaskPanel`、`TaskDetail`、`CanvasPanel`、`CodePane`、`StatusBar`、`GateModal`、`MainAgentDialog`；状态在 `useWorkbenchStore`，SSE 在 `useWorkbenchRun`，树布局是 `useWorkbenchTree` 的纯函数。
- 多页面入口 + 动态加载欢迎页 / 工作台脚本，避免首屏加载所有页面。
- 刷新恢复：草稿、树布局、聚焦、展开、当前文件、代码页签、滚动位置写入 `localStorage`，运行内容从 MySQL 读回。
- 视觉回归：9 页 × 1440 / 1920 / 390 共 27 张截图；迁移期 26 张字节级一致，欢迎页 1920 为动画帧差异；工作台树垂直居中是后续有意调整。

---

## 5. 目录结构

```text
NexusHub/
├─ 源码/                     # 所有代码、数据与运行配置
│  ├─ backend/
│  │  ├─ app/api/           路由与业务接口
│  │  ├─ app/api/pipeline/  六道工序编排
│  │  ├─ app/api/ai/        模型、RAG、成本
│  │  ├─ app/api/runtime/   产物进程运行时
│  │  ├─ app/domain/        纯数据契约（Pydantic）
│  │  ├─ app/features/      auth / settings
│  │  ├─ app/shared/        错误、SSE、时间
│  │  ├─ app/db/            SQLAlchemy 模型
│  │  ├─ migrations/        Alembic 迁移
│  │  ├─ data/cassettes/    模型录制回放
│  │  ├─ mcp_server.py      MCP 占位（未实现）
│  │  └─ .env.example
│  ├─ web/                  静态页面与构建产物
│  │  ├─ vue-dist/          Vite 构建输出，由 FastAPI 托管
│  │  └─ ...                原始静态资源 / 兼容页面
│  ├─ web-vue/              Vue 3 + TypeScript 源码
│  │  ├─ src/
│  │  │  ├─ workbench/      主工作台
│  │  │  ├─ workspace/      辅助工作台
│  │  │  ├─ components/     六个业务组件
│  │  │  └─ types/          API / 工作台类型
│  │  └─ vite.config.js
│  ├─ database/             MySQL 建表与管理员种子
│  ├─ RAG-knowledge/        RAG 语料
│  ├─ skills/               阶段技能说明
│  ├─ docs/                 设计与契约文档
│  └─ tools/                本地截图工具
├─ 技术文档/                 # 文档与配图资源
│  ├─ NexusHub-技术文档-提交版.pdf # 参赛技术文档（28 页）
│  ├─ 项目定位.txt
│  └─ tech_doc_assets/      文档配图
└─ 原型动画/                 # 早期原型，保留，不参与构建
```

---

## 6. 本地运行

### 前置与依赖清单

| 组件 | 版本 | 用途 |
|---|---|---|
| Python | 3.12+ | 后端运行时 |
| MySQL | 8.0 | 业务数据，以及每次运行独立的产物库 |
| Node.js | 20+ | 仅重新构建前端时需要 |
| pnpm | 10.x | 前端依赖，`pnpm-lock.yaml` 锁定版本 |

后端依赖清单在 [`源码/backend/pyproject.toml`](源码/backend/pyproject.toml)：FastAPI、Uvicorn、SQLAlchemy 2、PyMySQL、Alembic、Pydantic 2、httpx、numpy，另有 esprima / javalang / tinycss2 / sqlparse 四个语法校验库；`[dev]` 组是 pytest、ruff、import-linter。

前端依赖清单在 [`源码/web-vue/package.json`](源码/web-vue/package.json) 与 `pnpm-lock.yaml`：Vue 3.5、Vite 8、TypeScript 5.9、vue-tsc。

### 环境变量

模板在 [`源码/backend/.env.example`](源码/backend/.env.example)，复制成 `.env` 后填写。**最小可跑集合只有两项**：`DATABASE_URL` 与 `DEEPSEEK_API_KEY`。

| 变量 | 必填 | 说明 | 默认 |
|---|---|---|---|
| `DATABASE_URL` | 是 | MySQL 连接串，要求 utf8mb4 | 本机 nexus / nexus |
| `DEEPSEEK_API_KEY` | 是 | 模型密钥，只放本地 `.env` | 空 |
| `DEEPSEEK_BASE_URL` | 否 | 供应商地址 | api.deepseek.com |
| `MODEL_DECIDE` / `MODEL_EXECUTE` | 否 | 决策、执行阶段的模型名 | deepseek-chat |
| `RUN_COST_LIMIT_CNY` | 否 | 单次运行费用上限（元） | 5 |
| `PLAYBOOK_DIR` / `SKILL_DIR` | 否 | RAG 语料、阶段技能目录 | ../RAG-knowledge |
| `COOKIE_SECURE` | 否 | http 调试必须为 false | false |
| `ALLOWED_ORIGIN` | 否 | 同源部署留空 | 空 |
| `RECORD_MODE` | 否 | off / record / replay | off |
| `MAX_LOOPBACK` | 否 | 测试失败回环轮数 | 2 |
| `ASK_MAX_QUESTIONS` / `ASK_MAX_ROUNDS` | 否 | 门禁提问上限，0 表示不限 | 0 |
| `MEMORY_DAILY_LIMIT` | 否 | 记忆每日写入上限 | 3 |
| `MYSQL_PROVISIONER_URL` | 否 | 建库供给账号 | 空，留空则供给接口 503 |
| `MYSQL_PRODUCT_URL` | 否 | 产物库账号 | 空 |
| `INTERNAL_TOKEN` | 否 | 运行时内部口令 | 空 |
| `RUNTIME_WORKSPACE_DIR` | 否 | 产物工作区目录 | ./data/workspace |
| `RUNTIME_RUNNER` | 否 | docker / process | docker |

### 1）建库

```bash
mysql -u root -p
```

```sql
CREATE DATABASE IF NOT EXISTS nexus
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'nexus'@'127.0.0.1' IDENTIFIED BY 'nexus';
GRANT ALL PRIVILEGES ON nexus.* TO 'nexus'@'127.0.0.1';
```

### 2）后端

```powershell
cd 源码\backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
Copy-Item .env.example .env
# 编辑 .env：填 DATABASE_URL 与 DEEPSEEK_API_KEY
alembic upgrade head
```

可选：导入管理员种子。

```powershell
cmd /c "mysql -u nexus -p nexus < ..\database\admin.sql"
```

启动：

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

打开：

- 应用：<http://127.0.0.1:8000/>
- 健康检查：<http://127.0.0.1:8000/api/health>
- 接口文档：<http://127.0.0.1:8000/api/docs>
- 演示账号（导入种子后）：`admin / 123456`

### 3）前端

仓库已包含构建产物 `源码/web/vue-dist`，直接启动后端即可访问，不需要先跑 Node。

修改前端后：

```powershell
cd 源码\web-vue
pnpm install
pnpm typecheck
pnpm build
```

`pnpm build` 会把产物写回 `源码/web/vue-dist`。完整联调请由 FastAPI 托管页面，避免开发服务器与接口不同源。

---

## 7. 验证记录

已实际执行：

```text
cd 源码/web-vue
pnpm typecheck     # 0 errors
pnpm build         # success

# 没有 pnpm 的环境用等价命令：
npm run typecheck
npm run build

cd ../backend
python -m compileall -q app   # 语法编译通过
```

- 本次交付前用 npm 等价命令复跑：`typecheck` 0 错误，`build` 成功（397ms），产物写回 `web/vue-dist`。

- 9 个页面控制台零异常、无 404/500（本地 headless Edge 检查）。
- 迁移期 27 张截图同尺寸；26/27 字节级一致；唯一差异为欢迎页 1920 的卡片动画帧。
- 工作台树在画布内垂直居中后，工作台 3 张截图为有意差异，不再按旧基线逐字节比较。
- 后端 API 冒烟验证覆盖登录、运行创建、事件读取；门禁与预览做过页面层手工检查；**完整 pytest 套件尚未补齐**，不写成「测试全部通过」。

---

## 8. 已知边界

这些是当前版本真实存在的边界，不作为「已完成」宣传：

1. **没有多模态**：不能上传截图、语音或视频让模型直接理解。
2. **没有 MCP 协议**：只有模型 Function Calling 工具，`backend/mcp_server.py` 是未实现占位。
3. **不是强隔离沙箱**：产物用本机进程运行，已有路径校验、语法/SQL 检查、超时与回收，但没有容器级网络/资源隔离。
4. **RAG 没有量化评测**：检索链路真实存在，但还没有 hit@3 / 召回率对比表。
5. **主链路是顺序流水线**：按依赖逐个模块生成，不是并行 Multi-Agent；文案不把「阶段角色」说成「并行智能体」。
6. **模型是单供应商**：默认 DeepSeek；`MODEL_DECIDE` / `MODEL_EXECUTE` 可配置，但没有真实双模型对比数据。
7. **在线演示与演示视频**：公网部署与 5–8 分钟演示视频仍待补；技术文档已完成并导出 PDF（28 页），见 `技术文档/NexusHub-技术文档-提交版.pdf`。
8. **后端测试**：`backend/tests` 还没有完整用例，当前以前端类型检查、构建、页面自动化检查和 API 冒烟为主。

---

## 9. 评分点对应

| 评分维度 | 本项目的对应证据 |
|---|---|
| 大模型集成 | 真实 DeepSeek 调用、结构化输出、成本台账、录制回放、用户自带 Key |
| Agent / 工作流 | 六道工序、任务事件、门禁、测试失败回环、辅助 Agent 工具循环 |
| RAG | 混合检索、开发规范语料、`retrieval` 事件、工作台参考依据 |
| AI 安全 | 人工门禁、路径校验、语法/SQL/HTML 检查、回环上限；沙箱仍需加强 |
| 工具集成 | Function Calling 工具与轨迹；MCP 尚未实现 |
| 创新性 | 把「生成 → 运行 → 读错误 → 修复 → 复测」做成可观察的交付流水线 |
| 前端工程 | Vue 3 + TypeScript 全量、组件/composable 分层、多页构建、代码分割 |
| 实用性 | 一句话到可运行产物；真实测试、预览、项目历史 |
| 用户体验 | 树形任务、流式代码、参考依据、成本、门禁、草稿与刷新恢复 |
| 社会价值 | 降低独立开发者/学生的软件交付门槛；商业路径仍在验证 |

---

## 10. 团队信息

| 项目 | 内容 |
|---|---|
| 团队名称 | 都不白来 |

---

## 11. 文档

| 文档 | 内容 |
|---|---|
| [`技术文档/NexusHub-技术文档-提交版.pdf`](技术文档/NexusHub-技术文档-提交版.pdf) | 参赛技术文档（28 页） |
| [`docs/01-赛题分析与评分对照.md`](源码/docs/01-赛题分析与评分对照.md) | 赛题事实、评分表、风险 |
| [`docs/03-前后端分离契约书.md`](源码/docs/03-前后端分离契约书.md) | 接口、SSE、事件格式 |
| [`docs/04-目录结构.md`](源码/docs/04-目录结构.md) | 目录与依赖方向 |
| [`docs/05-数据库契约.md`](源码/docs/05-数据库契约.md) | 表结构与数据边界 |
| [`web-vue/README.md`](源码/web-vue/README.md) | 前端迁移、组件边界、验证记录 |

---

## 12. 说明

- 项目保留完整 Git 提交历史，按阶段提交。
- 未完成能力在代码和本文档中都显式标注，不用演示数据伪装真实结果。
- API Key 只通过 `.env` 或用户设置注入，不进入仓库。

---

## 13. 提交材料对照

| 材料 | 官方要求 | 本仓库对应 |
|---|---|---|
| 代码仓库 | GitHub / Gitee，须为 Public | 本仓库 |
| 代码规范 | 结构清晰、有效注释、主流规范 | 分层目录 + 模块级说明；ruff 规则见 `pyproject.toml` |
| README | 项目介绍、技术架构、安装运行、团队信息 | 本文第 1–6 节与第 10 节 |
| Git 记录 | 完整历史，体现真实开发过程 | 自 2026-10-21 立项提交起按阶段提交 |
| 环境配置 | 环境变量模板 + 依赖清单 | `源码/backend/.env.example`、`pyproject.toml`、`pnpm-lock.yaml` |
| 演示视频 | 5–8 分钟、MP4、1080p | 待录制 |
| 技术文档 | PDF，不超过 30 页 | `技术文档/NexusHub-技术文档-提交版.pdf`（28 页） |
| 在线演示 | 公网可访问，可选加分项 | 待部署 |