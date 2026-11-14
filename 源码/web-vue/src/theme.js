// 登录/注册没有公共顶栏，主题需要在挂载前自己补上。
function storedTheme() {
  try {
    return localStorage.getItem("nexus-theme");
  } catch (error) {
    return null;
  }
}

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get("theme") || storedTheme() || "light";