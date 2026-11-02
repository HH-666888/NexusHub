-- 全栈运行的供给账号。
--
-- 为什么单独一个账号：产物的数据库要能"建库建表"，但绝不能顺手动到
-- nexus 主库（用户、运行、事件全在里面）。所以给它只够干活的权限。
--
-- 执行方式（只需一次，用 root）：
--   mysql -u root -p -e "SET @pw='<换成随机密码>'; source database/schema/002_provisioner.sql"
-- 执行前先把下面的 __PASSWORD__ 换成同一个密码。
--
-- 权限清单解释：
--   CREATE/DROP DATABASE  每个 run 一个库
--   CREATE USER / DROP USER 每个 run 一个只登录自己库的账号
--   库级 GRANT           把那个库授权给那个账号
-- 不给：全局 SELECT/UPDATE/DELETE、SUPER、FILE、PROCESS —— 它不需要，给了就是风险。

CREATE USER IF NOT EXISTS 'nexus_provisioner'@'127.0.0.1' IDENTIFIED BY '__PASSWORD__';

GRANT CREATE, DROP ON *.* TO 'nexus_provisioner'@'127.0.0.1';
GRANT CREATE USER ON *.* TO 'nexus_provisioner'@'127.0.0.1';
GRANT GRANT OPTION ON *.* TO 'nexus_provisioner'@'127.0.0.1';

FLUSH PRIVILEGES;