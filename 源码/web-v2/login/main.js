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
        const account = document.getElementById("account");
        const password = document.getElementById("password");
        const submitBtn = document.getElementById("submit-btn");
        const eyeBtn = document.getElementById("eye-btn");

        function targetUrl() {
          if (prompt) return "../workbench/?run=new&prompt=" + encodeURIComponent(prompt);
          if (next === "workbench") return "../workbench/?run=new";
          if (next) return "../" + next + "/";
          return "../projects/";
        }

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

        [account, password].forEach(function (input) {
          input.addEventListener("input", function () { tip(input.name, ""); });
        });

        eyeBtn.addEventListener("click", function () {
          const show = password.type === "password";
          password.type = show ? "text" : "password";
          eyeBtn.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
          eyeBtn.style.color = show ? "var(--primary)" : "";
        });

        document.getElementById("fill-demo").addEventListener("click", function () {
          account.value = "admin";
          password.value = "123456";
          tip("account", "");
          tip("password", "");
          password.focus();
        });

        form.addEventListener("submit", async function (event) {
          event.preventDefault();
          const name = account.value.trim();
          const pwd = password.value;

          if (!name) { tip("account", "请输入账号", "error"); account.focus(); return; }
          if (!pwd) { tip("password", "请输入密码", "error"); password.focus(); return; }

          submitBtn.disabled = true;
          submitBtn.textContent = "登录中…";

          try {
            if (window.api) {
              const result = await window.api.login(name, pwd);
              if (result.ok) {
                if (window.NexusDemo) window.NexusDemo.login(name);
                location.href = targetUrl();
                return;
              }
              if (!result.offline) {
                tip("password", "账号或密码不对", "error");
                return;
              }
            }

            // 没有后端时（双击打开 / 纯静态托管）退回演示登录
            if (window.NexusDemo) window.NexusDemo.login(name);
            location.href = targetUrl();
          } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "登录";
          }
        });
        // 把 next / prompt 带进注册页，注册完能接着走
        if (next || prompt) {
          const q = new URLSearchParams();
          if (next) q.set("next", next);
          if (prompt) q.set("prompt", prompt);
          document.querySelectorAll('a[href="../register/"]').forEach(function (link) {
            link.href = "../register/?" + q.toString();
          });
        }
      })();
