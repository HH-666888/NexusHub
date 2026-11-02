-- 全栈运行时的 MySQL 账号（一次性，用 root 执行）。
--
-- 两个账号，各管一件事：
--   nexus_provisioner  只负责 CREATE / DROP DATABASE，读不了任何业务表
--   nexus_product      产物代码用的账号，只在 `nexus_run_%` 这些库上有权限
--
-- 为什么不给每个 run 建一个 MySQL 用户（试过，做不到干净）：
--   MySQL 要求"授出者自己必须先持有该权限"。供给账号在运行期新建的库，
--   它自己还没有那个库的授权，所以 GRANT 一定报 1044。
--   能绕过的两个办法都很糟：给供给账号全局授权（等于让它能读主库），
--   或者写 root 权限的存储过程（一次性脚本里塞 DELIMITER，维护成本更高）。
--   于是改成"共享产物账号 + 通配库授权"：简单、够用，
--   代价是隔离强度从"每 run 一个账号"降到"库名不可猜"。
--   要升级到强隔离，正确做法是给每个 run 起独立 MySQL 实例（或独立 schema 的 PG），
--   那不是这台 2C4G 该干的事。
--
-- 执行：
--   1. 把 __PROVISIONER_PASSWORD__ / __PRODUCT_PASSWORD__ 换成随机密码
--   2. mysql -u root -p < database/schema/002_provisioner.sql
--   3. 两个密码分别写进 backend/.env 的 MYSQL_PROVISIONER_URL 与 MYSQL_PRODUCT_URL

CREATE USER IF NOT EXISTS 'nexus_provisioner'@'127.0.0.1' IDENTIFIED BY '__PROVISIONER_PASSWORD__';
ALTER USER 'nexus_provisioner'@'127.0.0.1' IDENTIFIED BY '__PROVISIONER_PASSWORD__';
GRANT CREATE, DROP ON *.* TO 'nexus_provisioner'@'127.0.0.1';

CREATE USER IF NOT EXISTS 'nexus_product'@'%' IDENTIFIED BY '__PRODUCT_PASSWORD__';
ALTER USER 'nexus_product'@'%' IDENTIFIED BY '__PRODUCT_PASSWORD__';
GRANT ALL PRIVILEGES ON `nexus\_run\_%`.* TO 'nexus_product'@'%';

FLUSH PRIVILEGES;