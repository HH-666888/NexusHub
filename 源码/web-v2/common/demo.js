/* 原型用的"假登录"：只写一个标记，不做任何校验。
   以后接真实后端时，把这两个函数换成 fetch 即可，页面不用改。 */
(function () {
  const KEY = "nexus-demo-user";

  window.NexusDemo = {
    getUser() {
      try {
        return localStorage.getItem(KEY);
      } catch (e) {
        return null;
      }
    },
    login(name) {
      try {
        localStorage.setItem(KEY, name || "评委");
      } catch (e) {
        /* file:// 下可能禁用，忽略 */
      }
    },
    logout() {
      try {
        localStorage.removeItem(KEY);
      } catch (e) {
        /* 忽略 */
      }
    },
  };
})();