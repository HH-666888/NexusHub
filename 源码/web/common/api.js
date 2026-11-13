/* 前端唯一的接口出口。
   规则：
   - 所有请求（登录、设置、运行、事件）一律走 /api。
   - 会话靠 cookie，每个请求都带 credentials。
   - 后端不可用时返回 offline，由调用方显示错误态；不回退任何演示数据。 */
(function () {
  const BASE = "/api";

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


    // ── 辅助开发 ──
    async assistProjects() {
      const result = await request("/assist/projects");
      return result.ok ? result.data : null;
    },

    async createAssist(goal) {
      return request("/assist/projects", { method: "POST", body: JSON.stringify({ goal }) });
    },

    async assistProject(id) {
      const result = await request("/assist/projects/" + encodeURIComponent(id));
      return result.ok ? result.data : null;
    },

    async updateAssist(id, patch) {
      return request("/assist/projects/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(patch || {}),
      });
    },

    async deleteAssist(id) {
      return request("/assist/projects/" + encodeURIComponent(id), { method: "DELETE" });
    },

    async saveAssistFile(id, path, content) {
      return request("/assist/projects/" + encodeURIComponent(id) + "/files", {
        method: "POST",
        body: JSON.stringify({ path, content }),
      });
    },

    async assistFile(id, path) {
      const result = await request(
        "/assist/projects/" + encodeURIComponent(id) + "/file?path=" + encodeURIComponent(path),
      );
      return result.ok ? result.data : null;
    },

    async analyzeAssist(id) {
      return request("/assist/projects/" + encodeURIComponent(id) + "/analyze", { method: "POST" });
    },

    async assistFindings(id, status) {
      const result = await request(
        "/assist/projects/" + encodeURIComponent(id) + "/findings?status=" + (status || "open"),
      );
      return result.ok ? result.data.findings : null;
    },

    async updateFinding(id, status) {
      return request("/assist/findings/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
    },

    async applyAssist(id, path, instruction) {
      return request("/assist/projects/" + encodeURIComponent(id) + "/apply", {
        method: "POST",
        body: JSON.stringify({ path, instruction }),
      });
    },

    async assistCoach(id, message, stage) {
      const result = await request("/assist/projects/" + encodeURIComponent(id) + "/stage/ai", {
        method: "POST",
        body: JSON.stringify({ message, stage }),
      });
      return result.ok ? result.data : null;
    },

    // ── AI 记忆 ──
    async memory(days) {
      const result = await request("/memory?days=" + (days || 30));
      return result.ok ? result.data : null;
    },

    async memoryStats() {
      const result = await request("/memory/stats");
      return result.ok ? result.data : null;
    },

    async updateMemory(id, pinned) {
      return request("/memory/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      });
    },

    async deleteMemory(id) {
      return request("/memory/" + encodeURIComponent(id), { method: "DELETE" });
    },

    async clearMemory() {
      return request("/memory", { method: "DELETE" });
    },

    async settings() {
      const result = await request("/settings");
      return result.ok ? result.data : null;
    },

    async saveSettings(patch) {
      return request("/settings", { method: "PUT", body: JSON.stringify(patch) });
    },

    /** 真的去探一下提供商；返回 { ok, message } */
    async testConnection(payload) {
      const result = await request("/settings/test", {
        method: "POST",
        body: JSON.stringify(payload || {}),
      });
      if (result.ok && result.data) return result.data;
      return { ok: false, message: result.offline ? "后端没启动，测不了" : "测试失败" };
    },
  };
})();