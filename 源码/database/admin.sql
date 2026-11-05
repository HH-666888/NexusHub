-- 默认管理员：admin / 123456
-- 可重复执行：已存在则不动密码，只保证账号在
--
-- 密码是 argon2id 的哈希，由 backend/scripts/seed_admin.py 生成；
-- 想改密码不要手改这里，重跑那个脚本（或重新算一份哈希替换下面这行）。
--
-- 与参考项目 admin.sql 的约定一致：一条 INSERT ... ON DUPLICATE KEY UPDATE 收尾。

INSERT INTO `users` (`username`, `display_name`, `password_hash`, `created_at`, `updated_at`)
VALUES (
  'admin',
  '管理员',
  '$argon2id$v=19$m=65536,t=3,p=4$jZAcNN/X4HhSHfsBj1/D9g$D5lYF80esCN+PmeEypK6s5EaMSrv4lSfXgxYAFnpieA',
  1793801873644,
  1793801873644
)
ON DUPLICATE KEY UPDATE
  `display_name` = VALUES(`display_name`),
  `updated_at`   = VALUES(`updated_at`);