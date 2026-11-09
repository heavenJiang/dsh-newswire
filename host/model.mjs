/**
 * 模型解读（Host 侧）：用 dsh 的默认模型（或插件设置里指定的模型），通过宿主的 llm 服务做一次性调用，不进入任何会话。
 *
 *   - 事件解读：为重点事件写「发生了什么 / 为什么值得关注 / 接下来看什么」，存 events.llm_notes。
 *   - 简报：把一段时间内的重点事件归纳为总括、要点和值得关注的事，存 briefings。
 *   - 推送消息：在规则生成的消息上加简报总括和每条事件的一句话摘要。
 *
 * 模型只看到插件给的材料（标题、来源、时间、摘要），被要求不编造；输出必须是 JSON，解析不了就丢弃，退回规则版。
 * 任何失败都不影响抓取与推送。
 */

export const PROMPT_VERSION = 1;
const SYSTEM = "你是严谨的新闻编辑。只根据给出的材料作答，不编造材料里没有的事实、数字或引语；材料不足时宁可写得保守。只输出要求的 JSON。";

// ------------------------------------------------------------------ 解析
/** 去掉推理标签与代码围栏，取第一个完整 JSON 对象。失败返回 null。 */
export function parseJsonLoose(text) {
  let s = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const str = (v, n) => (typeof v === "string" && v.trim() ? clip(v, n) : "");

// ------------------------------------------------------------------ 调用
/**
 * @param o { getLlm(): ctx.llm|undefined, getDefault(): ctx.agentDefaultModel|undefined, pinned?(): {provider, model}|null, provider?, model?, timeoutMs }
 */
export function createModel(o) {
  const selection = () => {
    // 面板里选定的模型（pinned）优先，其次插件写死的，最后 harness 默认模型
    const pin = typeof o.pinned === "function" ? o.pinned() : null;
    if (pin && pin.provider && pin.model) return { provider: pin.provider, model: pin.model };
    if (o.provider && o.model) return { provider: o.provider, model: o.model };
    const d = o.getDefault && o.getDefault();
    const sel = d && typeof d.currentSelection === "function" ? d.currentSelection() : null;
    return sel && sel.provider && sel.model ? sel : null;
  };
  // 最近的调用记录：耗时、输入 / 输出 / 缓存命中 token，用来测速度、记账
  const recent = [];
  return {
    selection,
    recent: () => recent.slice(),
    /** 速度画像：最近成功调用的输出速度与单次耗时中位数。 */
    profile() {
      const ok = recent.filter((r) => r.ok).slice(-20);
      const med = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
      return { calls: ok.length, tps: med(ok.filter((r) => r.out > 50).map((r) => r.out / Math.max(0.5, r.ms / 1000))), ms: med(ok.map((r) => r.ms)), cache_rate: ok.length ? Math.round((100 * ok.reduce((s, r) => s + r.cache, 0)) / Math.max(1, ok.reduce((s, r) => s + r.in + r.cache, 0))) : null };
    },
    available: () => Boolean(o.getLlm && o.getLlm() && selection()),
    label: () => { const s = selection(); return s ? s.provider + "/" + s.model : null; },
    /** 一次调用，返回正文文字（不含推理过程）。超时、出错、被拒都抛错。 */
    async complete(user, opt) {
      const llm = o.getLlm && o.getLlm();
      const sel = selection();
      if (!llm || !sel) throw new Error("model_unavailable");
      // 每天的 token 预算用完了：模型步骤不再调用，退回程序结果
      const blocked = typeof o.gate === "function" ? o.gate(opt && opt.step) : null;
      if (blocked) throw new Error(blocked);
      const t0 = Date.now();
      let usage = null;
      let failure = null;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error("timeout")), (opt && opt.timeoutMs) || o.timeoutMs || 90000);
      let text = "";
      try {
        for await (const chunk of llm.stream({
          provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
          system: SYSTEM,
          messages: [{ role: "user", content: [{ type: "text", text: user }] }],
          temperature: 0.2, maxTokens: (opt && opt.maxTokens) || 1200, signal: ctl.signal,
        })) {
          if (chunk.type === "text-delta") text += chunk.text;
          else if (chunk.type === "usage") usage = chunk.usage;
          else if (chunk.type === "finish") {
            const k = chunk.reason && chunk.reason.kind;
            if (k === "error" || k === "aborted") throw new Error((chunk.reason.failure && (chunk.reason.failure.message || chunk.reason.failure.code)) || k);
          }
        }
      } catch (e) {
        failure = e;
        throw e;
      } finally {
        clearTimeout(timer);
        // 记账：宿主给了 usage 就用它，否则按字数估（中文约 1.6 字一个 token）
        const rec = { step: (opt && opt.step) || "other", model: sel.provider + "/" + sel.model, ms: Date.now() - t0, ok: !failure && Boolean(text.trim()),
          in: usage ? usage.inputTokens || 0 : Math.round(String(user).length / 1.6), out: usage ? usage.outputTokens || 0 : Math.round(text.length / 1.6),
          cache: usage ? usage.cacheReadTokens || 0 : 0, est: !usage, error: failure ? String(failure.message || failure).slice(0, 80) : !text.trim() ? "empty_reply" : null };
        recent.push(rec);
        if (recent.length > 60) recent.shift();
        try { if (typeof o.onCall === "function") o.onCall(rec); } catch { /* 记账失败不影响调用 */ }
      }
      // 推理模型可能把 token 全用在推理上，正文为空
      if (!text.trim()) throw new Error("empty_reply");
      return text;
    },
  };
}

// ------------------------------------------------------------------ 事件解读
const tz = (iso) => {
  if (!iso) return "";
  const d = new Date(String(iso).replace(" ", "T") + (String(iso).includes("T") ? "" : "Z"));
  return isNaN(d) ? "" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(/\//g, "-");
};

export function eventPrompt(members) {
  const lines = members.slice(0, 10).map((m, i) => (i + 1) + ". " + clip(m.title, 120) + "｜" + (m.source_name || m.source_id) + "｜" + tz(m.published_at || m.first_seen_at) + (m.summary ? "\n   摘要：" + clip(m.summary, 200) : ""));
  return "以下是同一新闻事件的 " + members.length + " 条报道（标题｜来源｜时间）：\n" + lines.join("\n") +
    '\n\n只输出一个 JSON 对象：{"summary":"一句话说清发生了什么（不超过50字）","why":"为什么值得关注（不超过50字）","watch":"接下来要关注什么（不超过40字）"}' +
    "\n各家说法不一致时在 summary 里点明。";
}

/** 需要解读的事件：给定的事件中，还没有解读、或报道家数变了的。 */
function needsNotes(e) {
  if (!e.llm_notes) return true;
  try { const n = JSON.parse(e.llm_notes); return n.v !== PROMPT_VERSION || n.members !== e.member_count; } catch { return true; }
}

/**
 * 给事件写解读。@returns { done, failed, skipped }
 * @param o { eventIds（按优先级）, max }
 */
export async function analyzeEvents(db, model, o) {
  const out = { done: 0, failed: 0, skipped: 0, errors: [] };
  if (!model.available() || !o.eventIds.length) return out;
  const evQ = db.prepare("SELECT event_id, member_count, llm_notes FROM events WHERE event_id = ?");
  const memQ = db.prepare(`SELECT a.title, a.summary, a.published_at, a.first_seen_at, a.source_id, s.name AS source_name FROM event_members m JOIN articles a ON a.id = m.article_id LEFT JOIN sources s ON s.id = a.source_id
    WHERE m.event_id = ? ORDER BY COALESCE(a.published_at, a.first_seen_at) LIMIT 10`);
  const up = db.prepare("UPDATE events SET llm_notes = ? WHERE event_id = ?");
  for (const id of o.eventIds) {
    if (out.done + out.failed >= (o.max || 6)) break;
    const e = evQ.get(id);
    if (!e || (!o.force && !needsNotes(e))) { out.skipped++; continue; }
    try {
      const t0 = Date.now();
      const prompt = eventPrompt(memQ.all(id));
      // 本地推理模型偶尔输出被截断或不是 JSON：重试一次
      let j = null;
      for (let k = 0; k < 2 && !(j && str(j.summary, 80)); k++) {
        try { j = parseJsonLoose(await model.complete(prompt, { step: "notes", maxTokens: 3000 })); } catch (e) { if (k === 1) throw e; }
      }
      const notes = j && { summary: str(j.summary, 80), why: str(j.why, 80), watch: str(j.watch, 70) };
      if (!notes || !notes.summary) throw new Error("bad_json");
      up.run(JSON.stringify(Object.assign(notes, { model: model.label(), at: new Date().toISOString(), members: e.member_count, v: PROMPT_VERSION, ms: Date.now() - t0 })), id);
      out.done++;
    } catch (err) {
      out.failed++;
      out.errors.push(id + ": " + String(err && err.message ? err.message : err).slice(0, 120));
    }
  }
  return out;
}

// ------------------------------------------------------------------ 简报
const CRED = { single: "单源", corroborated: "已印证", confirmed: "权威确认", disputed: "存在分歧" };

export function briefingPrompt(events, names) {
  const lines = events.map((e, i) => {
    const labels = JSON.parse(e.labels || "[]").map((l) => (names && names[l]) || l).join("/");
    let notes = "";
    try { const n = e.llm_notes ? JSON.parse(e.llm_notes) : null; if (n && n.summary) notes = "｜" + n.summary; } catch { notes = ""; }
    return "[" + (i + 1) + "] " + clip(e.title, 90) + "｜" + (CRED[e.credibility] || e.credibility) + "·" + e.source_count + "家｜重要度" + Math.round(e.importance) + (labels ? "｜" + labels : "") + notes;
  });
  return "以下是这段时间按重要度排序的新闻事件（编号、标题、可信度与报道家数、重要度、分类、摘要）：\n" + lines.join("\n") +
    '\n\n请写一份简报，帮读者快速了解发生了什么、什么值得关注。只输出一个 JSON 对象：\n{"headline":"一句话总括（不超过40字）","points":[{"text":"一条要点，可合并相关事件（不超过60字）","refs":[事件编号]}],"watch":[{"text":"值得继续关注的一件事及原因（不超过50字）","refs":[事件编号]}]}\n' +
    "points 3 到 5 条，按重要性排序；watch 1 到 3 条。只依据给出的事件，不要编造。";
}

function mapRefs(refs, events) {
  return Array.from(new Set((Array.isArray(refs) ? refs : []).map((n) => events[Number(n) - 1]).filter(Boolean).map((e) => e.event_id)));
}

/**
 * 生成并保存一份简报。@returns 保存的简报行（含 content），或 { ok:false, error }
 * @param o { pack, since, hours, runId, names, limit }
 */
export async function makeBriefing(db, model, o) {
  if (!model.available()) return { ok: false, error: "model_unavailable" };
  const where = ["e.last_seen_at >= ?", "e.importance >= 30"];
  const args = [o.since];
  if (o.pack && o.pack !== "all") { where.push("e.pack = ?"); args.push(o.pack); }
  const events = db.prepare("SELECT e.* FROM events e WHERE " + where.join(" AND ") + " ORDER BY e.importance DESC LIMIT ?").all(...args, o.limit || 12);
  if (events.length < 2) return { ok: false, error: "too_few_events" };
  const t0 = Date.now();
  const ins = db.prepare("INSERT INTO briefings (pack, run_id, created_at, model, hours, headline, content, event_ids, ok, error, ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  try {
    const prompt = briefingPrompt(events, o.names);
    const ok = (x) => x && str(x.headline, 60) && Array.isArray(x.points) && x.points.length;
    let j = null;
    for (let k = 0; k < 2 && !ok(j); k++) {
      try { j = parseJsonLoose(await model.complete(prompt, { step: "brief", maxTokens: 3000, timeoutMs: 180000 })); } catch (e) { if (k === 1) throw e; }
    }
    if (!j || !str(j.headline, 60) || !Array.isArray(j.points) || !j.points.length) throw new Error("bad_json");
    const content = {
      headline: str(j.headline, 60),
      points: j.points.slice(0, 6).map((p) => ({ text: str(p && p.text, 90), event_ids: mapRefs(p && p.refs, events) })).filter((p) => p.text),
      watch: (Array.isArray(j.watch) ? j.watch : []).slice(0, 4).map((p) => ({ text: str(p && p.text, 80), event_ids: mapRefs(p && p.refs, events) })).filter((p) => p.text),
    };
    const r = ins.run(o.pack || "all", o.runId || null, now, model.label(), o.hours || null, content.headline, JSON.stringify(content), JSON.stringify(events.map((e) => e.event_id)), 1, null, Date.now() - t0);
    return { ok: true, id: Number(r.lastInsertRowid), pack: o.pack || "all", created_at: now, model: model.label(), hours: o.hours || null, headline: content.headline, content, ms: Date.now() - t0 };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).slice(0, 200);
    ins.run(o.pack || "all", o.runId || null, now, model.label(), o.hours || null, null, null, null, 0, msg, Date.now() - t0);
    return { ok: false, error: msg };
  }
}

export function latestBriefing(db, pack) {
  if (!db) return null;
  const r = db.prepare("SELECT * FROM briefings WHERE ok = 1 AND pack = ? ORDER BY id DESC LIMIT 1").get(pack || "all");
  if (!r) return null;
  return { id: r.id, pack: r.pack, run_id: r.run_id, created_at: r.created_at, model: r.model, hours: r.hours, headline: r.headline, content: JSON.parse(r.content || "{}"), ms: r.ms };
}

// ------------------------------------------------------------------ 推送消息
/**
 * 在规则消息上加模型内容：标题行后插入「📝 总括」，每条事件标题行后插入一句摘要。消息结构不变，规则部分原样保留。
 * @param message 规则生成的消息；@param picks [{ event_id }]（与消息里的序号一一对应）
 */
export function enrichMessage(message, picks, notesById, briefing, modelLabel) {
  const lines = String(message).split("\n");
  if (!picks.length) return message;
  const out = [];
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (i === 1 && briefing && briefing.headline) out.push("📝 " + briefing.headline);
    const m = lines[i].match(/^(\d+)\./);
    if (m && Number(m[1]) === idx + 1) {
      const n = notesById.get(picks[idx] && picks[idx].event_id);
      if (n && n.summary) out.push("   " + n.summary);
      idx++;
    }
  }
  if (modelLabel && (briefing || notesById.size)) out.push("（摘要由 " + modelLabel + " 生成）");
  return out.join("\n");
}
