/**
 * 模型任务的排队。本地模型一次只跑得动一两个请求，而要用它的事很多：读者点的（详细报道、影响分析、问答）、
 * 到点推送的版面、版面出来后顺手做的（自动分析、追踪综述、修解析规则）。以前各管各的忙闲，读者点的会和
 * 后台的抢模型，或者干等一整份版面。
 *
 * 这里按「一次模型调用」排队，不按整件事排：每次调用先领一个名额（名额数 = 实测的并发数），名额不够时按
 * 优先级等，同级先到先得。读者点的排最前，所以最多等正在跑的那一次调用（一两分钟），不用等整份版面写完。
 * 一件事（job）用 run() 包起来，里面的调用自动带上它的优先级（AsyncLocalStorage），面板上能看到谁在跑、谁在等。
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** 数字小的先跑。 */
export const PRIORITY = { reader: 0, push: 1, background: 2, idle: 3 };
const NAMES = ["reader", "push", "background", "idle"];

/**
 * @param o { slots?(): number  同时跑几个调用（默认 1）, graceMs?: 一件事两次调用之间为它留位的时间（默认 1500） }
 */
export function createQueue(o) {
  const als = new AsyncLocalStorage();
  const jobs = new Map(); // id → { id, kind, label, priority, since, calls, state }
  const waiting = []; // { job, step, priority, seq, at, grant }
  const active = new Set(); // { job, step, at }
  let seq = 0;
  const slots = () => Math.max(1, Math.floor(Number(o && typeof o.slots === "function" ? o.slots() : 1)) || 1);

  // 一件事的两次调用之间有一小段空当（核对、存库）：别让低优先级的趁这个空当插进来占住模型一两分钟
  const grace = o && Number.isFinite(o.graceMs) ? o.graceMs : 1500;
  let timer = null;
  function pump() {
    while (waiting.length && active.size < slots()) {
      let k = 0;
      for (let i = 1; i < waiting.length; i++) if (waiting[i].priority < waiting[k].priority || (waiting[i].priority === waiting[k].priority && waiting[i].seq < waiting[k].seq)) k = i;
      const now = Date.now();
      let hold = 0;
      for (const j of jobs.values()) if (j.priority < waiting[k].priority && j.state === "working" && j.released && now - j.released < grace) hold = Math.max(hold, grace - (now - j.released));
      if (hold > 0) { if (!timer) timer = setTimeout(() => { timer = null; pump(); }, hold + 5); return; }
      const w = waiting.splice(k, 1)[0];
      const a = { job: w.job, step: w.step, at: Date.now() };
      active.add(a);
      if (w.job) { w.job.state = "running"; w.job.calls++; }
      let released = false;
      w.grant(() => {
        if (released) return;
        released = true;
        active.delete(a);
        if (w.job && jobs.has(w.job.id) && ![...active].some((x) => x.job === w.job) && !waiting.some((x) => x.job === w.job)) { w.job.state = "working"; w.job.released = Date.now(); }
        pump();
      });
    }
  }

  return {
    /**
     * 把一件事登记进来并执行；里面的模型调用按它的优先级排队。
     * @param meta { kind: "detail"|"analysis"|"edition"|..., label: 给读者看的名字, priority: PRIORITY.* }
     */
    run(meta, fn) {
      const job = { id: ++seq, kind: meta.kind || "other", label: meta.label || meta.kind || "", priority: Number.isInteger(meta.priority) ? meta.priority : PRIORITY.background, since: Date.now(), calls: 0, state: "working" };
      jobs.set(job.id, job);
      return als.run(job, async () => { try { return await fn(); } finally { jobs.delete(job.id); pump(); } });
    },
    /** 领一个调用名额（模型调用前）；返回用完后归还的函数。不在任何 job 里的调用按后台算。 */
    acquire(step) {
      const job = als.getStore() || null;
      return new Promise((grant) => {
        waiting.push({ job, step: step || "other", priority: job ? job.priority : PRIORITY.background, seq: ++seq, at: Date.now(), grant });
        if (job) job.state = "waiting";
        pump();
      });
    },
    /** 现在这次调用所属的事（没有就是 null）。 */
    current: () => als.getStore() || null,
    /** 给面板看：正在跑的调用、排队的调用、登记着的事。 */
    view() {
      const now = Date.now();
      const j = (x) => (x ? { kind: x.kind, label: x.label, priority: NAMES[x.priority] || "background" } : { kind: "other", label: "", priority: "background" });
      return {
        slots: slots(),
        running: [...active].map((a) => Object.assign(j(a.job), { step: a.step, secs: Math.round((now - a.at) / 1000) })),
        waiting: waiting.slice().sort((a, b) => a.priority - b.priority || a.seq - b.seq).map((w) => Object.assign(j(w.job), { step: w.step, secs: Math.round((now - w.at) / 1000) })),
        jobs: [...jobs.values()].sort((a, b) => a.priority - b.priority || a.id - b.id).map((x) => Object.assign(j(x), { state: x.state, calls: x.calls, secs: Math.round((now - x.since) / 1000) })),
      };
    },
  };
}
