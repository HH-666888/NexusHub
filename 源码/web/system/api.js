/* 前端唯一的接口出口。
   规则：
   - 页面永远先问后端；后端不在（用 python http.server 单开静态站时）就返回 null，
     由调用方回退到演示数据，保证原型不白屏。
   - 会话靠 cookie，所以每个请求都带 credentials。 */
(function () {
  const BASE = "/api/v1";

  async function request(path, options) {
    const opts = Object.assign(
      { credentials: "include", headers: { "Content-Type": "application/json" } },
      options || {},
    );
    let response;
    try {
      response = await fetch(BASE + path, opts);
    } catch (error) {
      return { ok: false, offline: true, status: 0, data: null };
    }

    if (response.status === 204) return { ok: true, offline: false, status: 204, data: null };

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }

    // 纯静态托管（python http.server / 双击打开）时，/api/v1 不存在，
    // 服务器会回一个 HTML 404。这种情况按"没有后端"处理，让调用方回退演示数据。
    if (!response.ok && data === null) {
      return { ok: false, offline: true, status: response.status, data: null };
    }

    return { ok: response.ok, offline: false, status: response.status, data };
  }

  window.api = {
    base: BASE,

    /** 当前登录用户；未登录返回 null。 */
    async me() {
      const result = await request("/auth/me");
      return result.ok && result.data ? result.data.user : null;
    },

    async login(username, password) {
      return request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
    },

    async register(username, password, confirmPassword) {
      return request("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          confirm_password: confirmPassword || password,
        }),
      });
    },

    async logout() {
      return request("/auth/logout", { method: "POST" });
    },

    /** 运行列表；offline 时返回 null。 */
    async runs(limit) {
      const result = await request("/runs?limit=" + (limit || 50));
      return result.ok ? result.data : null;
    },

    async createRun(prompt) {
      return request("/runs", { method: "POST", body: JSON.stringify({ prompt }) });
    },

    async run(runId) {
      const result = await request("/runs/" + encodeURIComponent(runId));
      return result.ok ? result.data : null;
    },

    async events(runId) {
      const result = await request("/runs/" + encodeURIComponent(runId) + "/events");
      return result.ok ? result.data : null;
    },

    async settings() {
      const result = await request("/settings");
      return result.ok ? result.data : null;
    },

    async saveSettings(patch) {
      return request("/settings", { method: "PUT", body: JSON.stringify(patch) });
    },
  };
})();