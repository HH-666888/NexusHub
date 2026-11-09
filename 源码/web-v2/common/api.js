/* v2 前端唯一的接口出口。
   规则：
   - 运行与事件走 /api/v2；登录与设置复用 /api/v1。
   - 会话靠 cookie，每个请求都带 credentials。
   - 后端不可用时返回 offline，由调用方显示错误态；不回退任何演示数据。 */
(function () {
  const BASE = "/api/v2";
  const CORE = "/api/v1";

  async function request(path, options, base) {
    const opts = Object.assign(
      { credentials: "include", headers: { "Content-Type": "application/json" } },
      options || {},
    );
    let response;
    try {
      response = await fetch((base || BASE) + path, opts);
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

    // 后端不在时返回 offline，由页面显示错误态。
    if (!response.ok && data === null) {
      return { ok: false, offline: true, status: response.status, data: null };
    }

    return { ok: response.ok, offline: false, status: response.status, data };
  }

  window.api = {
    base: BASE,

    /** 当前登录用户；未登录返回 null。 */
    async me() {
      const result = await request("/auth/me", null, CORE);
      return result.ok && result.data ? result.data.user : null;
    },

    async login(username, password) {
      return request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }, CORE);
    },

    async register(username, password, confirmPassword) {
      return request("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          confirm_password: confirmPassword || password,
        }),
      }, CORE);
    },

    async logout() {
      return request("/auth/logout", { method: "POST" }, CORE);
    },

    /** 运行列表；offline 时返回 null。 */
    async runs(limit) {
      const result = await request("/runs?limit=" + (limit || 50));
      return result.ok ? result.data : null;
    },

    async deleteRun(id) {
      return request("/runs/" + encodeURIComponent(id), { method: "DELETE" });
    },

    async createRun(prompt, fast) {
      const path = fast ? "/runs?fast=1" : "/runs";
      return request(path, { method: "POST", body: JSON.stringify({ prompt }) });
    },

    async run(runId) {
      const result = await request("/runs/" + encodeURIComponent(runId));
      return result.ok ? result.data : null;
    },

    async gate(runId) {
      const result = await request("/runs/" + encodeURIComponent(runId) + "/gate");
      return result.ok ? result.data : null;
    },

    async answerGate(runId, payload) {
      return request("/runs/" + encodeURIComponent(runId) + "/answers", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    async events(runId) {
      const result = await request("/runs/" + encodeURIComponent(runId) + "/events");
      return result.ok ? result.data : null;
    },

    async settings() {
      const result = await request("/settings", null, CORE);
      return result.ok ? result.data : null;
    },

    async saveSettings(patch) {
      return request("/settings", { method: "PUT", body: JSON.stringify(patch) }, CORE);
    },

    /** 真的去探一下提供商；返回 { ok, message } */
    async testConnection(payload) {
      const result = await request("/settings/test", {
        method: "POST",
        body: JSON.stringify(payload || {}),
      }, CORE);
      if (result.ok && result.data) return result.data;
      return { ok: false, message: result.offline ? "后端没启动，测不了" : "测试失败" };
    },
  };
})();