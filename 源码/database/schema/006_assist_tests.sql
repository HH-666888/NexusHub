-- 005：辅助开发的测试用例
CREATE TABLE IF NOT EXISTS assist_test_cases (
    id          BIGINT NOT NULL AUTO_INCREMENT,
    project_id  VARCHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title       VARCHAR(200) NOT NULL,
    steps       TEXT NULL,
    expected    TEXT NULL,
    status      VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY idx_assist_tests_project (project_id),
    CONSTRAINT fk_assist_tests_project FOREIGN KEY (project_id) REFERENCES assist_projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;