-- =============================================================================
-- Nexus · MySQL 8 初始表结构
-- 来源：docs/05-数据库契约.md（改这里必须先改那份契约）
-- 适用：MySQL 8.0.30+
--
-- 建库（DBA 或首次部署时执行一次，字符集必须 utf8mb4）：
--   CREATE DATABASE IF NOT EXISTS nexus
--     DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--
-- 时间一律存 epoch 毫秒 BIGINT，不用 DATETIME —— 时区问题从根上排除。
-- =============================================================================

SET NAMES utf8mb4;

-- -----------------------------------------------------------------------------
-- users：账号
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(32)  NOT NULL COMMENT '登录名，唯一',
  display_name  VARCHAR(64)  NOT NULL COMMENT '界面显示名',
  password_hash VARCHAR(255) NOT NULL COMMENT 'argon2id 编码串，禁止明文/MD5',
  created_at    BIGINT       NOT NULL COMMENT 'epoch 毫秒',
  updated_at    BIGINT       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- sessions：会话
-- 只存 sha256(token)：cookie 原文不落库，库被读走也拿不到可用会话。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id         CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
             COMMENT 'sha256(token) 十六进制',
  user_id    BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT NOT NULL COMMENT 'epoch 毫秒',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- runs：一次构建
-- usage 三个平铺列；对外是嵌套对象，转换只发生在 features/runs/repo.py
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id               VARCHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  prompt           TEXT NOT NULL COMMENT '用户原话，一字不改',
  stage            VARCHAR(16) NOT NULL COMMENT 'spec|arch|ui|build|assemble|verify',
  status           VARCHAR(16) NOT NULL COMMENT 'running|paused|done|failed|cancelled',
  workflow_version VARCHAR(8)  NOT NULL DEFAULT 'v1',
  total_cost_cny   DECIMAL(12,6) NOT NULL DEFAULT 0.000000,
  input_tokens     INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens    INT UNSIGNED NOT NULL DEFAULT 0,
  thinking_tokens  INT UNSIGNED NOT NULL DEFAULT 0,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_runs_user_time (user_id, created_at DESC, id DESC) COMMENT '游标分页专用',
  KEY idx_runs_status (status),
  CONSTRAINT fk_runs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- run_events：事件流（回放的唯一依据）
-- 只追加，不更新不删除。payload 与 SSE 帧是同一份 JSON。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id     VARCHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  seq        INT UNSIGNED NOT NULL COMMENT '同一次运行内从 1 递增',
  kind       VARCHAR(16) NOT NULL,
  payload    JSON NOT NULL COMMENT '契约书 §7 的整条事件',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_events_run_seq (run_id, seq),
  CONSTRAINT fk_events_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- cost_records：一次模型调用一行（"每一分钱花在哪"的原始凭证）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cost_records (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id           VARCHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stage            VARCHAR(16) NOT NULL,
  model            VARCHAR(48) NOT NULL,
  price_tier       VARCHAR(8)  NOT NULL COMMENT 'peak|offPeak',
  input_tokens     INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens    INT UNSIGNED NOT NULL DEFAULT 0,
  thinking_tokens  INT UNSIGNED NOT NULL DEFAULT 0,
  cache_hit_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  cost_cny         DECIMAL(12,6) NOT NULL,
  latency_ms       INT UNSIGNED NOT NULL,
  created_at       BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_cost_run_time (run_id, created_at),
  CONSTRAINT fk_cost_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- artifacts：产物内容（存库不落磁盘，备份因此只是一个 dump）
-- 同一 run 同名只留最新一份：回放靠事件，不靠产物历史。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifacts (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id     VARCHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind       VARCHAR(8)  NOT NULL COMMENT 'html|json',
  name       VARCHAR(64) NOT NULL COMMENT 'spec.json|arch.json|ui-spec.json|plan.html|…',
  content    LONGTEXT NOT NULL COMMENT '产物正文',
  bytes      INT UNSIGNED NOT NULL,
  sha256     CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_artifacts_run_name (run_id, name),
  CONSTRAINT fk_artifacts_run FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- settings：每用户配置 KV（不含任何密钥）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  user_id    BIGINT UNSIGNED NOT NULL,
  `key`      VARCHAR(32) NOT NULL COMMENT 'appearance|modelConfig',
  value      JSON NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, `key`),
  CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- rag_documents / rag_chunks：RAG 语料与向量
-- 中文关键词召回必须用 ngram 解析器，默认分词器对中文无效。
-- embedding 存 FLOAT32 小端序 BLOB，长度 = dim * 4。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag_documents (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  path       VARCHAR(255) NOT NULL COMMENT '相对 content/playbook 的路径',
  title      VARCHAR(128) NOT NULL,
  sha256     CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bytes      INT UNSIGNED NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_rag_doc_path (path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS rag_chunks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id BIGINT UNSIGNED NOT NULL,
  chunk_index INT UNSIGNED NOT NULL,
  heading     VARCHAR(255) NULL COMMENT '章节标题，用于显示“依据：xxx §2”',
  text        TEXT NOT NULL,
  embedding   BLOB NOT NULL COMMENT 'FLOAT32 小端序，长度 = dim * 4',
  dim         SMALLINT UNSIGNED NOT NULL,
  model       VARCHAR(48) NOT NULL COMMENT 'embedding 模型名，换模型必须重建',
  PRIMARY KEY (id),
  UNIQUE KEY uk_chunk_doc_idx (document_id, chunk_index),
  FULLTEXT KEY ft_chunk_text (text) WITH PARSER ngram,
  CONSTRAINT fk_chunk_doc FOREIGN KEY (document_id) REFERENCES rag_documents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- idempotency_keys：建运行防连点（30 秒内复用同一结果）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id    BIGINT UNSIGNED NOT NULL,
  `key`      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id     VARCHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, `key`),
  KEY idx_idem_expires (expires_at),
  CONSTRAINT fk_idem_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;