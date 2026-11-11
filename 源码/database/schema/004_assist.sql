-- 004：辅助开发与 AI 记忆
-- 只增不删；可重复执行（IF NOT EXISTS）。
-- 字段与 app/db/models.py 保持一致。

CREATE TABLE IF NOT EXISTS assist_projects (
    id          VARCHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id     BIGINT UNSIGNED NOT NULL,
    title       VARCHAR(120) NOT NULL,
    goal        TEXT NULL,
    stage       VARCHAR(16) NOT NULL DEFAULT 'plan',
    status      VARCHAR(16) NOT NULL DEFAULT 'active',
    mode        VARCHAR(16) NOT NULL DEFAULT 'suggest',
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY idx_assist_projects_user (user_id, updated_at),
    CONSTRAINT fk_assist_projects_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS assist_files (
    id          BIGINT NOT NULL AUTO_INCREMENT,
    project_id  VARCHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    path        VARCHAR(255) NOT NULL,
    lang        VARCHAR(16) NOT NULL DEFAULT 'text',
    content     LONGTEXT NOT NULL,
    updated_at  BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_assist_files_path (project_id, path),
    CONSTRAINT fk_assist_files_project FOREIGN KEY (project_id) REFERENCES assist_projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS assist_findings (
    id          BIGINT NOT NULL AUTO_INCREMENT,
    project_id  VARCHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    file_path   VARCHAR(255) NOT NULL,
    line        INT NOT NULL DEFAULT 0,
    severity    VARCHAR(8) NOT NULL DEFAULT 'warn',
    rule        VARCHAR(64) NOT NULL,
    message     VARCHAR(500) NOT NULL,
    stage       VARCHAR(16) NOT NULL DEFAULT 'build',
    status      VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY idx_assist_findings_project (project_id, status),
    CONSTRAINT fk_assist_findings_project FOREIGN KEY (project_id) REFERENCES assist_projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS memory_entries (
    id           BIGINT NOT NULL AUTO_INCREMENT,
    user_id      BIGINT UNSIGNED NOT NULL,
    day          CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title        VARCHAR(120) NOT NULL,
    body         VARCHAR(500) NOT NULL,
    reason       VARCHAR(255) NOT NULL DEFAULT '',
    source_type  VARCHAR(16) NOT NULL DEFAULT 'assist',
    source_id    VARCHAR(64) NOT NULL DEFAULT '',
    confidence   VARCHAR(16) NOT NULL DEFAULT 'single',
    pinned       TINYINT(1) NOT NULL DEFAULT 0,
    created_at   BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY idx_memory_user_day (user_id, day),
    CONSTRAINT fk_memory_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;