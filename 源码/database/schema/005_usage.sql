-- 004：辅助开发的模型用量与估算费用
-- 工作流的费用记在 cost_records；辅助开发没有 run，单独记这里。

CREATE TABLE IF NOT EXISTS usage_records (
    id           BIGINT NOT NULL AUTO_INCREMENT,
    user_id      BIGINT UNSIGNED NOT NULL,
    project_id   VARCHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
    kind         VARCHAR(16) NOT NULL DEFAULT 'coach',
    model        VARCHAR(64) NOT NULL,
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    cost_cny     DECIMAL(12, 6) NOT NULL DEFAULT 0,
    created_at   BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY idx_usage_user_time (user_id, created_at),
    CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;