import { describe, expect, it } from "vitest";
import { byteLength, hashContent, isSafePathSegment } from "@/core/domain/artifact";
import { summarizeChecks, type CheckResult } from "@/core/domain/check";
import { extractHtml, inspectArtifact } from "@/core/generate/prompt";

/**
 * 保护从模型输出里提取 HTML 的三层兜底、产物七项检查、检查结果汇总、
 * 产物体积与哈希、以及路径片段校验。
 */
describe("提取 HTML", () => {
  it("标准的 ```html 代码块", () => {
    const text =
      "好的，这是代码：\n```html\n<!DOCTYPE html>\n<html><body>hi</body></html>\n```\n希望有用！";
    const html = extractHtml(text);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.endsWith("</html>")).toBe(true);
    expect(html).not.toContain("```");
    expect(html).not.toContain("希望有用");
  });

  it("没有语言标注的代码块也能提取", () => {
    const text = "```\n<html><body>x</body></html>\n```";
    expect(extractHtml(text)).toBe("<html><body>x</body></html>");
  });

  it("没有代码围栏时，从 DOCTYPE 开始截取", () => {
    const text = "这是你要的页面：<!DOCTYPE html><html><body>x</body></html>以上。";
    const html = extractHtml(text);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.endsWith("</html>")).toBe(true);
  });

  it("没有 </html> 结尾（被截断）时，原样返回剩余部分", () => {
    const text = "<!DOCTYPE html><html><body>还没写完";
    const html = extractHtml(text);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("还没写完");
  });

  it("什么都没有时返回原文本，交给后续检查去报错", () => {
    expect(extractHtml("模型今天不想干活")).toBe("模型今天不想干活");
  });

  it("代码块里的内容不以 <html 开头时，回退到第二种方式", () => {
    const text = "```html\n<!-- 备注 -->\n<!DOCTYPE html><html></html>\n```";
    const html = extractHtml(text);
    expect(html).toContain("<!DOCTYPE html>");
  });
});

const GOOD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>body{color:red}</style></head>
<body>
  <h1>团队任务看板</h1>
  <p>拖拽卡片可以改变状态，点击左侧方框可以标记完成。</p>
  <div id="board"><button>新建任务</button><button>清空已完成</button></div>
  <script>
    const data = JSON.parse(localStorage.getItem('tasks') || '[]');
    document.querySelector('#board').addEventListener('click', () => {
      localStorage.setItem('tasks', JSON.stringify(data));
    });
  </script>
</body></html>`;

describe("产物检查", () => {
  it("一份合格的自包含页面应该全部通过", () => {
    const results = inspectArtifact(GOOD_HTML);
    const failed = results.filter((r) => !r.pass);
    expect(failed).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(7);
  });

  it("缺少 </html>（被截断）会被判为结构不完整", () => {
    const truncated = GOOD_HTML.replace("</html>", "");
    const r = inspectArtifact(truncated).find((x) => x.name.includes("完整"));
    expect(r?.pass).toBe(false);
  });

  it("引用外部 CDN 会被判为不自包含", () => {
    const withCdn = GOOD_HTML.replace(
      "<style>",
      '<script src="https://cdn.example.com/lib.js"></script><style>',
    );
    const r = inspectArtifact(withCdn).find((x) => x.name.includes("自包含"));
    expect(r?.pass).toBe(false);
    expect(r?.detail).toContain("外部引用");
  });

  it("协议相对地址（//cdn...）也算外部引用", () => {
    const withCdn = GOOD_HTML.replace(
      "<style>",
      '<link rel="stylesheet" href="//cdn.example.com/a.css"><style>',
    );
    const r = inspectArtifact(withCdn).find((x) => x.name.includes("自包含"));
    expect(r?.pass).toBe(false);
  });

  it("没有事件绑定会被判为不可交互", () => {
    const inert = `<html><head><style></style></head><body>静态页面没有任何交互</body></html>`;
    const r = inspectArtifact(inert).find((x) => x.name.includes("事件"));
    expect(r?.pass).toBe(false);
  });

  it("没有 localStorage 会被判为数据不能持久化", () => {
    const noStore = GOOD_HTML.replace(/localStorage/g, "window.__x");
    const r = inspectArtifact(noStore).find((x) => x.name.includes("持久化"));
    expect(r?.pass).toBe(false);
  });

  it("中文字符太少会被判为非中文界面", () => {
    const english = `<html><head><style></style></head><body>Hello <script>a.addEventListener('x',()=>{})</script></body></html>`;
    const r = inspectArtifact(english).find((x) => x.name.includes("中文"));
    expect(r?.pass).toBe(false);
  });

  it("每一项都带有可读的说明，便于直接显示给用户", () => {
    for (const r of inspectArtifact(GOOD_HTML)) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("检查结果汇总", () => {
  const mk = (pass: boolean): CheckResult => ({
    name: pass ? "通过项" : "失败项",
    pass,
    detail: "说明",
  });

  it("全部通过时失败数为零", () => {
    const s = summarizeChecks([mk(true), mk(true), mk(true)]);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(3);
    expect(s.failed).toBe(0);
    expect(s.failures).toEqual([]);
  });

  it("部分失败时只把失败项列进 failures", () => {
    const s = summarizeChecks([mk(true), mk(false), mk(true), mk(false)]);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(2);
    expect(s.failures).toHaveLength(2);
    expect(s.failures.every((f) => !f.pass)).toBe(true);
  });

  it("空数组不会出错", () => {
    const s = summarizeChecks([]);
    expect(s).toEqual({ total: 0, passed: 0, failed: 0, failures: [] });
  });
});

describe("产物哈希与体积", () => {
  it("同样的内容哈希相同，不同内容哈希不同", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
    expect(hashContent("abc")).toHaveLength(64);
  });

  it("按字节算体积，而不是按字符数 —— 中文一个字占 3 字节", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("中文")).toBe(6);
    expect(byteLength("中文")).toBeGreaterThan("中文".length);
  });
});

describe("路径片段校验", () => {
  it("UUID 形式的运行 id 合法", () => {
    expect(isSafePathSegment("9f997d31-b719-4d8d-b9fd-bd7a73d17ab2")).toBe(true);
  });

  it("带扩展名的文件名合法", () => {
    expect(isSafePathSegment("index.html")).toBe(true);
    expect(isSafePathSegment("spec.json")).toBe(true);
  });

  it("路径穿越企图一律拒绝", () => {
    for (const bad of [
      "..",
      "../etc",
      "a/../b",
      "..\\windows",
      "/absolute",
      "a/b",
      "a\\b",
      "",
    ]) {
      expect(isSafePathSegment(bad), bad).toBe(false);
    }
  });

  it("隐藏文件与超长名称拒绝", () => {
    expect(isSafePathSegment(".env")).toBe(false);
    expect(isSafePathSegment("a".repeat(65))).toBe(false);
  });

  it("含空格、中文、特殊字符的名称拒绝", () => {
    for (const bad of ["我的文件", "a b", "a;rm", "a|b", "a*b"]) {
      expect(isSafePathSegment(bad), bad).toBe(false);
    }
  });
});
