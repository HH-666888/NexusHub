-- 全栈运行时的两张表。
--
-- run_databases：一个 run 一个库 + 一个只登录该库的账号。
--   password 要存下来：容器启动时得把它注入环境变量，服务重启后也要能重建连接。
-- run_runtimes：一个 run 一个容器。host_port 是宿主上对外映射的端口。
--
-- 两表都以 run_id 为主键：一个 run 只该有一个库、一个容器（契约 §5.9 的幂等要求）。

CREATE TABLE IF NOT EXISTS run_databases (
  run_id      VARCHAR(64) NOT NULL,
  db_name     VARCHAR(64) NOT NULL,
  db_user     VARCHAR(64) NOT NULL,
  db_password VARCHAR(128) NOT NULL,
  created_at  BIGINT NOT NULL,
  dropped_at  BIGINT NULL,
  PRIMARY KEY (run_id),
  UNIQUE KEY uk_run_databases_name (db_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='每个 run 的产物数据库与专属账号';

CREATE TABLE IF NOT EXISTS run_runtimes (
  run_id       VARCHAR(64) NOT NULL,
  container_id VARCHAR(64) NOT NULL,
  host_port    INT NOT NULL,
  preview_url  VARCHAR(255) NOT NULL,
  status       VARCHAR(16) NOT NULL,
  started_at   BIGINT NOT NULL,
  stopped_at   BIGINT NULL,
  error        VARCHAR(500) NULL,
  PRIMARY KEY (run_id),
  KEY idx_run_runtimes_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='每个 run 的产物容器';