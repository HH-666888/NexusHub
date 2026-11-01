/**
 * SSE 帧解析（契约 §6.1、§7）。
 *
 * 关键行为：未知 kind 必须被忽略而不是抛错 —— 后端加事件类型时前端可能还没发版。
 */

import { describe, expect, it } from "vitest";

import { parseEvent } from "@/api/sse";

describe("parseEvent", () => {
  it("解析出已知事件", () => {
    const event = parseEvent('{"kind":"text","delta":"<div"}');

    expect(event).toEqual({ kind: "text", delta: "<div" });
  });

  it("契约里已登记但还没实现的 kind 也认得（tool / retrieval / cost）", () => {
    expect(
      parseEvent('{"kind":"tool","name":"fs.read","args":{},"ok":true}'),
    ).not.toBeNull();
    expect(
      parseEvent('{"kind":"retrieval","query":"模块划分","hits":[]}'),
    ).not.toBeNull();
    expect(
      parseEvent('{"kind":"cost","stage":"spec","deltaCny":0.001}'),
    ).not.toBeNull();
  });

  it("未知 kind 返回 null（不抛错、不误消费）", () => {
    expect(parseEvent('{"kind":"brand_new_event","x":1}')).toBeNull();
  });

  it("坏 JSON / 空帧 / 非对象都返回 null", () => {
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent("")).toBeNull();
    expect(parseEvent("null")).toBeNull();
    expect(parseEvent('"just a string"')).toBeNull();
  });

  it("缺少 kind 的帧被丢弃", () => {
    expect(parseEvent('{"delta":"x"}')).toBeNull();
  });
});
