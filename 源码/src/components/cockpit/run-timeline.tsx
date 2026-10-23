"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  frameAt,
  replayDurationMs,
  type ReplayFrame,
  type RunEvent,
} from "@/core/domain/run-event";

/**
 * 时间轴回放
 * ============================================================
 * 拖动滑块，看到「那一刻的画面」：已经写了多少字、
 * 花了多少钱、检查过了几项。
 *
 * ── 为什么这个功能值得做 ──
 *   演示时不用现场等一次生成。评委可以反复看、停在任意一刻。
 *   而且它把「过程」从一个转瞬即逝的东西变成了可复查的对象 ——
 *   这正是这个项目想说的事。
 *
 * ── 一个刻意的设计：时间轴按「事件」走，不按毫秒 ──
 *   模型吐字的速度不是均匀的。按毫秒拖，会在某些段落上
 *   怎么拖都不动、在另一些段落上一拖就跳过一大段。
 *   所以滑块的值是**事件序号**，毫秒只是显示出来的结果。
 */

const SPEEDS = [0.5, 1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

interface EventsPayload {
  count: number;
  durationMs: number;
  events: RunEvent[];
}

export interface RunTimelineProps {
  runId: string;
  /** 生成刚跑完时递增，用来触发重新拉取 */
  refreshKey?: number;
}

export function RunTimeline({ runId, refreshKey }: RunTimelineProps) {
  const [data, setData] = useState<EventsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 当前停在第几条事件（0 表示还没开始） */
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);

  /* ---------- 拉取事件 ---------- */
  useEffect(() => {
    let alive = true;

    /*
      注意这里**没有**同步调用 setLoading(true)。
      lint 会拦（在 effect 里同步 setState 会级联渲染），而且拦得对：
      重新拉取时把界面切回「加载中…」再切回来，用户看到的是一次闪烁，
      而旧内容本来就可以继续显示到新内容到达为止。
      loading 初值就是 true，只有「拉完了」这一个方向需要改它。
    */
    fetch(`/api/runs/${runId}/events`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<EventsPayload>;
      })
      .then((payload) => {
        if (!alive) return;
        setData(payload);
        // 默认停在末尾：用户多半是刚跑完想看看结果，
        // 而不是想从零开始重播一遍。想重播就自己拖回去。
        setCursor(Math.max(0, payload.count - 1));
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [runId, refreshKey]);

  const events = useMemo(() => data?.events ?? [], [data]);
  const duration = useMemo(() => replayDurationMs(events), [events]);

  /* ---------- 播放循环 ---------- */
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    setPlaying(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  useEffect(() => {
    if (!playing || events.length === 0) return;

    // 用真实时间推进：每条事件之间的间隔按它在原始录制里的真实间隔走，
    // 再除以倍速。这样回放出来的节奏和当时是一致的。
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      setCursor((c) => {
        if (c + 1 >= events.length) {
          setPlaying(false);
          return events.length - 1;
        }
        const gap = events[c + 1].at - events[c].at;
        // 两个事件之间可能隔了很久（模型在思考），把单次等待封顶，
        // 否则回放会在那里干等，看起来像卡死了
        const wait = Math.min(Math.max(gap, 40), 900) / speed;
        timerRef.current = setTimeout(tick, wait);
        return c + 1;
      });
    };

    timerRef.current = setTimeout(tick, 60);

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [playing, events, speed]);

  useEffect(() => stop, [stop]);

  /* ---------- 当前画面 ---------- */
  const frame: ReplayFrame = useMemo(() => {
    if (events.length === 0) return frameAt([], 0);
    const offset = events[Math.min(cursor, events.length - 1)].at - events[0].at;
    return frameAt(events, offset);
  }, [events, cursor]);

  if (loading) {
    return (
      <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)]/40 px-3 py-2 text-[11px] text-slate-500">
        正在读取过程记录…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)]/40 px-3 py-2 text-[11px] text-slate-500">
        过程记录读取失败：{error}
      </div>
    );
  }

  /*
    还没有过程记录时的说明。
    注意措辞：不是「没有数据」这种打发人的话，而是说清楚
    **为什么还没有**、以及**什么时候会有**。
  */
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--color-border-soft)] bg-[var(--color-surface)]/40 px-3 py-2.5 text-[11px] leading-relaxed text-slate-500">
        <span className="text-slate-400">这条记录还没有过程录像。</span>
        <br />
        过程记录是在**真正调用模型的那一次生成**里写下来的；
        已有成品时刷新页面走的是回放路径，不会重复记录。
        点「重新生成」跑一次，这里就会出现可拖动的时间轴。
      </div>
    );
  }

  const pct = events.length > 1 ? (cursor / (events.length - 1)) * 100 : 100;
  const atEnd = cursor >= events.length - 1;

  return (
    <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)]/60 p-3">
      {/* ---------- 控制条 ---------- */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            if (playing) {
              stop();
            } else {
              // 已经停在末尾时再按播放，从头开始 ——
              // 否则按下去什么都不动，看起来像坏了
              if (atEnd) setCursor(0);
              setPlaying(true);
            }
          }}
          className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-[rgb(var(--app-accent-glow)/0.9)] text-[11px] text-white transition-opacity duration-150 hover:opacity-90"
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? "❙❙" : "▶"}
        </button>

        <input
          type="range"
          min={0}
          max={Math.max(0, events.length - 1)}
          value={cursor}
          onChange={(e) => {
            stop();
            setCursor(Number(e.target.value));
          }}
          className="nexus-scrubber h-1 flex-1 cursor-pointer appearance-none rounded-full"
          style={{
            background: `linear-gradient(90deg, rgb(var(--tint-4)) ${pct}%, var(--color-border-soft) ${pct}%)`,
          }}
          aria-label="时间轴"
        />

        <span className="w-24 flex-none text-right font-mono text-[10.5px] tabular-nums text-slate-500">
          {(frame.offsetMs / 1000).toFixed(1)}s / {(duration / 1000).toFixed(1)}s
        </span>

        <div className="flex flex-none gap-0.5">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              className={`rounded px-1.5 py-0.5 text-[10px] tabular-nums transition-colors duration-150 ${
                speed === s
                  ? "bg-slate-700/70 text-slate-100"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      {/* ---------- 这一刻的画面 ---------- */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--color-border-soft)] pt-2 text-[10.5px] tabular-nums">
        <span className="text-slate-500">
          第 <span className="text-slate-300">{frame.consumed}</span> / {events.length} 步
        </span>
        {frame.phaseLabel && (
          <span className="text-slate-400">{frame.phaseLabel}</span>
        )}
        <span className="text-slate-500">
          已写 <span className="text-slate-300">{frame.text.length}</span> 字
        </span>
        {/*
          花费只在真的收到过用量事件之后才显示。
          没收到时显示「—」而不是 ¥0.0000 ——
          「还不知道」和「花了零元」不是一回事。
        */}
        <span className="text-slate-500">
          {frame.costCny === null ? (
            <>花费 <span className="text-slate-600">—</span></>
          ) : (
            <>
              花费 <span className="text-slate-300">¥{frame.costCny.toFixed(4)}</span>
            </>
          )}
        </span>
        {frame.checks && (
          <span className="text-slate-500">
            自检{" "}
            <span
              className={
                frame.checks.passed === frame.checks.total
                  ? "text-emerald-400"
                  : "text-amber-400"
              }
            >
              {frame.checks.passed}/{frame.checks.total}
            </span>
          </span>
        )}
        {frame.artifactBytes !== null && (
          <span className="text-slate-500">
            产物 <span className="text-slate-300">{(frame.artifactBytes / 1024).toFixed(1)} KB</span>
          </span>
        )}
        {frame.error && <span className="text-red-400">出错：{frame.error}</span>}
      </div>
    </div>
  );
}