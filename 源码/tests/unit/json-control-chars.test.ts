import { describe, expect, it } from "vitest";
import { escapeRawControlChars, extractJsonText } from "@/core/domain/spec";

/**
 * JSON 字符串里的裸控制字符（真实故障的修复）
 * ============================================================
 * 实测一条真运行里，一个模块栽在这里：
 *   "产出无法使用：JSON 解析失败：Bad control character in string literal
 *    in JSON at position 3122 (line 1 column 3123)"
 * 模块产出是 {html, css, js} 三段代码，模型很容易在字符串里**直接换行**，
 * 而不是写 \n —— 那不是合法 JSON，于是整个模块被丢弃：
 * 钱花了、产物里少一整块功能，而它本可以救回来。
 *
 * 这一组钉两件事：救得回来，以及**不许救错**。
 */

/** 走一遍真实链路：extractJsonText → JSON.parse */
const parse = (raw: string): unknown => {
  const text = extractJsonText(raw);
  if (text === null) throw new Error("抠不出 JSON");
  return JSON.parse(text);
};

describe("裸控制字符 · 救得回来", () => {
  it("【关键】字符串里的**裸换行**能解析，而且值里就是那个换行", () => {
    // 这就是当初那个故障的形状：代码字符串里直接换了行
    const raw = '{"js":"const a = 1;\nconst b = 2;"}';
    expect(() => JSON.parse(raw)).toThrow(); // 严格解析确实会失败
    const obj = parse(raw) as { js: string };
    expect(obj.js).toBe("const a = 1;\nconst b = 2;");
  });

  it("裸制表符、裸回车、以及别的控制字符都能救", () => {
    const obj = parse('{"a":"x\ty","b":"p\rq","c":"\u0001z"}') as Record<string, string>;
    expect(obj.a).toBe("x\ty");
    expect(obj.b).toBe("p\rq");
    expect(obj.c).toBe("\u0001z");
  });

  it("一段真实的模块产出（html/css/js）能整份解析", () => {
    const raw = [
      "{",
      '  "html": "<div class=\\"timer\\">',
      '  <span>25:00</span></div>",',
      '  "css": ".timer {\\n  color: red;\\n}",',
      '  "js": "let left = 1500;',
      'function tick() { left -= 1; }"',
      "}",
    ].join("\n");
    const obj = parse(raw) as { html: string; css: string; js: string };
    expect(obj.html).toContain("<span>25:00</span>");
    expect(obj.js).toContain("function tick()");
    expect(obj.js.split("\n")).toHaveLength(2);
  });
});

describe("裸控制字符 · ★ 不许救错", () => {
  it("★ 反例：字符串**外面**的换行一个都不许动（缩进就是换行）", () => {
    const pretty = '{\n  "a": 1,\n  "b": 2\n}';
    // 逐字不变 —— 动了它反而会把好数据弄坏
    expect(escapeRawControlChars(pretty)).toBe(pretty);
    expect(parse(pretty)).toEqual({ a: 1, b: 2 });
  });

  it("★ 反例：已经转义过的 \\n 不许被二次转义", () => {
    const raw = '{"js":"a\\nb"}';
    expect(escapeRawControlChars(raw)).toBe(raw);
    const obj = parse(raw) as { js: string };
    expect(obj.js).toBe("a\nb"); // 一个换行，不是字面的 \n 两个字
  });

  it("★ 反例：字符串里的转义引号不许把「在不在字符串里」判错", () => {
    // `"a\":\"b{"` —— 中间那个 { 在字符串**里面**，不许被当成结构
    const raw = '{"a":"x\\":\\"y{\\nz"}';
    const obj = parse(raw) as { a: string };
    expect(obj.a).toBe('x":"y{\nz');
  });

  it("★ 反例：反斜杠结尾的字符串也不许把状态带歪", () => {
    // "路径 C:\\" 后面紧跟结构 —— \\ 是转义过的反斜杠，不能把结束引号吃掉
    const raw = '{"p":"C:\\\\","q":"ok"}';
    const obj = parse(raw) as { p: string; q: string };
    expect(obj.p).toBe("C:\\");
    expect(obj.q).toBe("ok");
  });

  it("★ 反例：完全合法的 JSON 走一遍修复必须逐字不变", () => {
    const samples = [
      "{}",
      '{"a":null}',
      '{"n":-1.5e10}',
      '{"arr":[1,2,{"deep":"值"}]}',
      '{"s":"没有控制字符的中文"}',
    ];
    for (const s of samples) {
      expect(escapeRawControlChars(s)).toBe(s);
    }
  });

  it("★ 反例：结构真的坏了（少括号）不许被「修好」成另一份数据", () => {
    // 修复只管控制字符，不管括号 —— 坏了就要报错，不能假装成功
    expect(() => parse('{"a":"x"')).toThrow();
  });
});

describe("裸控制字符 · 与抠取的关系", () => {
  it("围栏里、以及「第一个 { 到最后一个 }」这两条路也走修复", () => {
    const fenced = '这是说明\n```json\n{"js":"a\nb"}\n```\n后面还有话';
    expect((parse(fenced) as { js: string }).js).toBe("a\nb");

    const noisy = '前置废话 {"js":"a\nb"} 后置废话';
    expect((parse(noisy) as { js: string }).js).toBe("a\nb");
  });

  it("裸控制字符救不了**截断**（那是另一回事，各有各的报错）", () => {
    /*
      这一条是划分边界：控制字符修复之后，截断仍然是截断 ——
      上层据此报"JSON 写坏了"并给出位置，而不是被这里悄悄糊过去。
    */
    const truncated = '{"js":"let a = 1;';
    const text = extractJsonText(truncated);
    expect(text).not.toBeNull();
    expect(() => JSON.parse(text!)).toThrow();
  });
});