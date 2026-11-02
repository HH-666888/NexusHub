"""产物容器的基础镜像。

为什么固定一个镜像而不是每次 pip install：
一次生成等 30–120 秒装依赖，体验和成本都不划算。把 fastapi/uvicorn/sqlalchemy/pymysql
预置进镜像，每 run 只挂代码，冷启动 2–3 秒。

约定（与流水线一致，改之前先改契约 §5.9）：
- 产物入口是 /app/api/main.py（挂载进来是只读的）
- 应用必须监听 $PORT，并提供 GET /health 返回 200
- 数据库连接串从 $DATABASE_URL 读，不许写死

构建：
  docker build -t nexus-runtime-py312 backend/docker/runtime-python
"""

FROM python:3.12-slim

# 只装产物真的会用到的：web 框架 + 数据库驱动
RUN pip install --no-cache-dir \
    "fastapi==0.115.6" \
    "uvicorn[standard]==0.34.0" \
    "sqlalchemy==2.0.36" \
    "pymysql==1.1.1" \
    "cryptography==44.0.0"

# 非 root：即使产物代码想写宿主也写不动（叠加上 --read-only 与 :ro 挂载）
RUN useradd --create-home --uid 10001 runner
WORKDIR /app
USER runner

ENV PORT=8000
EXPOSE 8000

# 产物目录里可能还没有 api/main.py（生成中途），这时给出明确错误而不是静默退出
CMD ["sh", "-c", "test -f /app/_runtime_app.py || { echo 'missing /app/_runtime_app.py'; exit 1; }; exec uvicorn _runtime_app:app --host 0.0.0.0 --port ${PORT}"]