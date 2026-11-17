/**
 * 停下正在跑的一轮（抓取 → 编版面 → 推送）。
 *
 * 一轮由 run() 包起来：里面（包括它顺手丢到后台的版面、写完再推、自动分析）都拿到同一个「这一代」的中止信号。
 * stop() 把这一代的信号中止、换上新的一代：引擎子进程被终止，正在跑和排队的模型调用退出，各个检查点不再往下走。
 * 读者自己点的（详细报道、影响分析、问答）不在任何一轮里，不受影响。停下之后新开的一轮用新的一代，照常跑。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export class StoppedError extends Error {
  constructor(reason) { super("stopped" + (reason ? "：" + reason : "")); this.name = "StoppedError"; this.stopped = true; }
}

export const isStopped = (e) => Boolean(e && (e.stopped || e.name === "StoppedError" || (e.cause && e.cause.stopped)));

export function createStopper() {
  const als = new AsyncLocalStorage();
  let ctl = new AbortController();
  let last = null;
  const api = {
    /** 在一轮里执行 fn；已经在某一轮里就沿用那一轮。 */
    run(fn) { return als.getStore() ? fn() : als.run(ctl, fn); },
    /** 当前这一轮的中止信号（不在任何一轮里返回 null）。 */
    signal() { const c = als.getStore(); return c ? c.signal : null; },
    stopped() { const s = api.signal(); return Boolean(s && s.aborted); },
    /** 检查点：这一轮已被停下就抛 StoppedError。 */
    check() { const s = api.signal(); if (s && s.aborted) throw s.reason instanceof StoppedError ? s.reason : new StoppedError(); },
    /** 停下现在所有在跑的轮次。返回这次停止的记录。 */
    stop(reason) {
      const old = ctl;
      ctl = new AbortController();
      last = { at: new Date().toISOString(), reason: reason || "" };
      old.abort(new StoppedError(reason));
      return last;
    },
    last: () => last,
  };
  return api;
}

/** 整个插件共用一个（引擎子进程、模型调用都从这里取信号）。 */
export const stopper = createStopper();
