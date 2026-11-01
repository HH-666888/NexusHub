# 后端镜像。
# 构建上下文是仓库根（要同时拿到 backend/ 与 database/）：
#   docker build -f backend/Dockerfile -t nexus-backend .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# 先装依赖，源码改动不会让这一层失效
COPY backend/pyproject.toml ./pyproject.toml
RUN pip install --upgrade pip && pip install .

COPY backend/ /app/
COPY database/ /database/

# 迁移脚本默认按仓库布局找 SQL；容器里目录不同，用环境变量指明
ENV NEXUS_SCHEMA_SQL=/database/schema/001_init.sql

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]