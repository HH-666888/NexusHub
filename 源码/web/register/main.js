function safeTheme() {
        try { return localStorage.getItem("nexus-theme"); } catch (e) { return null; }
      }
      (function () {
        const query = new URLSearchParams(location.search);
        document.documentElement.dataset.theme = query.get("theme") || safeTheme() || "light";
      })();

(function () {
        const params = new URLSearchParams(location.search);
        const next = params.get("next") || "";
        const prompt = params.get("prompt") || "";

        const form = document.getElementById("auth-form");
        const username = document.getElementById("username");
        const password = document.getElementById("password");
        const confirm = document.getElementById("confirm");
        const submitBtn = document.getElementById("submit-btn");
        const eyeBtn = document.getElementById("eye-btn");

        function tip(name, message, state) {
          const box = document.querySelector('[data-tip="' + name + '"]');
          const field = document.querySelector('[data-field="' + name + '"]');
          if (box) {
            box.textContent = message || "";
            box.className = "field-tip" + (state ? " " + state : "");
          }
          if (field) {
            field.classList.toggle("is-error", state === "error");
            field.classList.toggle("is-ok", state === "ok");
          }
        }

        function targetUrl() {
          if (prompt) return "../workbench/?run=new&prompt=" + encodeURIComponent(prompt);
          if (next === "workbench") return "../workbench/?run=new";
          if (next) return "../" + next + "/";
          return "../projects/";
        }

        [username, password, confirm].forEach(function (input) {
          input.addEventListener("input", function () { tip(input.name, ""); });
        });

        eyeBtn.addEventListener("click", function () {
          const show = password.type === "password";
          password.type = show ? "text" : "password";
          confirm.type = show ? "text" : "password";
          eyeBtn.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
          eyeBtn.style.color = show ? "var(--primary)" : "";
        });

        confirm.addEventListener("blur", function () {
          if (confirm.value && confirm.value !== password.value) {
            tip("confirm", "两次输入的密码不一致", "error");
          }
        });

        form.addEventListener("submit", async function (event) {
          event.preventDefault();
          const name = username.value.trim();
          const pwd = password.value;
          const pwd2 = confirm.value;

          if (!name) { tip("username", "请填写用户名", "error"); username.focus(); return; }
          if (name.length < 4 || name.length > 20) {
            tip("username", "用户名需 4–20 个字符", "error");
            username.focus();
            return;
          }
          if (!pwd) { tip("password", "请填写密码", "error"); password.focus(); return; }
          if (pwd.length < 6) {
            tip("password", "密码至少 6 位", "error");
            password.focus();
            return;
          }
          if (pwd !== pwd2) { tip("confirm", "两次输入的密码不一致", "error"); confirm.focus(); return; }

          submitBtn.disabled = true;
          submitBtn.textContent = "注册中…";

          try {
            if (window.api) {
              const result = await window.api.register(name, pwd, pwd2);
              if (result.ok) {
                              location.href = targetUrl();
                return;
              }
              if (!result.offline) {
                const message =
                  result.status === 409 ? "这个用户名已经被用了" : "注册失败，请检查用户名和密码";
                tip("username", message, "error");
                return;
              }
            }

            // 没有后端时退回演示登录
                      location.href = targetUrl();
          } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "注册并开始";
          }
        });

        // 带上 next / prompt，注册完能接着走原来那条路
        const toLogin = document.getElementById("to-login");
        if (toLogin && (next || prompt)) {
          const q = new URLSearchParams();
          if (next) q.set("next", next);
          if (prompt) q.set("prompt", prompt);
          toLogin.href = "../login/?" + q.toString();
        }
      })();
