# web

纯静态前端：**HTML + CSS + 原生 JS，无构建、无依赖、无框架**。
页面由 FastAPI 同源托管，接口走 `/api/v1/*`。

## 目录

```
web/
├─ index.html          入口：按登录态分流到 /welcome/ 或 /projects/
├─ dev.html            开发索引（各页面快捷入口，内部用）
├─ common/             全站共享
│  ├─ app.css          设计令牌 + 通用组件
│  ├─ glass.css        玻璃态外观（?style=glass）
│  ├─ auth.css         登录/注册页样式
│  ├─ api.js           唯一的 fetch 出口（me / login / runs / events / settings…）
│  └─ demo.js          没有后端时的本地演示态
├─ welcome/            index.html + welcome.css + welcome-long.css + welcome-long.js
├─ login/              index.html + main.js
├─ register/           index.html + main.js
├─ projects/           index.html + style.css + main.js
├─ workbench/          index.html + style.css + main.js（演示）+ live.js（真实数据）
├─ settings/           index.html + style.css + main.js
├─ shots/              截图留档
├─ README.md
└─ DESIGN-SPEC.md      设计说明（数值、动效、坑）
```

## 约定

1. **一个页面一个目录**，目录里是 `index.html` + `style.css` + `main.js`；
   页面私有的样式和脚本不要内联，也不要塞进 `common/`。
2. **共享资源只在 `common/`**，页面用相对路径 `../common/xxx.css` 引用。
3. **引用带版本号**：`app.css?v=20261108b`。改样式/脚本后如果不换版本号，
   浏览器会用旧的（服务器已对文本资源发 `no-cache`，换版本号是双保险）。
4. **URL 是目录**：`/login/`、`/projects/`、`/workbench/?run=xxx`，不再有 `.html` 后缀。
5. **脚本顺序**：依赖在前、`main.js` 最后。`main.js` 里会直接调用 `window.api`。

## 怎么打开

前端**不能**用 `python -m http.server` 单跑——接口会 404、登录无法工作。必须由后端托管：

```powershell
cd 源码\backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

然后打开 <http://127.0.0.1:8000/>。

改了前端**不用重启**（每次请求都从磁盘读，文本资源带 `no-cache`）。
改了后端 Python 才需要重启。

## 截图

```powershell
cd 源码
node tools/shot.mjs "http://127.0.0.1:8000/welcome/?theme=light" `
  "web/shots/xx.png" "nexus_session=dummy" 960 1440
```

参数：URL、输出路径、cookie、宽、高。截图工具走 Edge CDP，会等 2.5 秒再拍。

## 主题与外观

| 参数 | 效果 |
|---|---|
| `?theme=dark` | 深色 |
| `?style=glass` | 玻璃态（半透卡片、背景光晕） |
| 设置页 | 主题会写进 `localStorage["nexus-theme"]`，全站生效 |