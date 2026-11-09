/**
 * 面板预览（开发用）：用假宿主挂载插件，在本地起一个 HTTP 服务，把面板（client.js）用真 React 渲染出来，
 * 接口走插件真实的 /api/newswire/* 路由、读真实数据目录。用于在浏览器里检查布局、明暗主题与窄屏。
 *
 *   node scripts/preview.mjs --data <数据目录（含 sources.json / news.sqlite）> [--port 4319] [--theme <宿主 ui-theme/lib/client.js>]
 *   打开 http://127.0.0.1:4319/?theme=dark&w=1280&platform=darwin   （theme=light|dark，w/h=窗口尺寸，sidebar=0 收起侧栏）
 *
 * --client <文件> 渲染另一个 client.js（例如旧版本，用来复现问题）。
 * --llm <OpenAI 兼容的 /v1 地址> [--llm-model <模型名>] 给假宿主接一个模型服务，用来预览简报与解读（不给则面板显示「没有可用模型」）。
 * --theme 给出时，从宿主主题包里抽取 body / body[data-ds-dark-theme] 的变量块，配色与宿主完全一致；不给则用 client.js 内置的兜底色。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? acc.concat([[v.slice(2), a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : true]]) : acc), []));
if (!args.data) { console.error("用法：node scripts/preview.mjs --data <数据目录> [--port 4319] [--theme <ui-theme/lib/client.js>]"); process.exit(2); }
const PORT = Number(args.port || 4319);

function themeCss(file) {
  if (!file || !fs.existsSync(file)) return "";
  const s = fs.readFileSync(file, "utf8");
  const out = [];
  const re = /(body(?:\[data-ds-dark-theme\])?)\{([^{}]*--dsw-[a-z0-9-]+:[^{}]*)\}/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] + "{" + m[2] + "}");
  return out.join("\n");
}

function collect(stream) {
  const parts = [];
  stream.on("data", (b) => parts.push(b));
  return { readFrom: () => ({ text: Buffer.concat(parts).toString("utf8") }) };
}

/** 把 OpenAI 兼容接口包成宿主 llm.stream 的样子（一次性返回，够预览用）。 */
function previewLlm(base) {
  const root = String(base).replace(/\/$/, "");
  return {
    listProviders: () => [{ id: "preview", name: "Preview" }],
    async listModels(provider) {
      if (provider !== "preview") return [];
      try { const j = await (await fetch(root + "/models")).json(); return (j.data || []).map((m) => ({ provider, id: m.id, name: m.id })); } catch { return []; }
    },
    stream(o) {
      return (async function* () {
        const messages = [{ role: "system", content: o.system }].concat(o.messages.map((m) => ({ role: m.role, content: m.content.map((c) => c.text || "").join("") })));
        const r = await fetch(String(base).replace(/\/$/, "") + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: o.model, messages, temperature: o.temperature, max_tokens: o.maxTokens }), signal: o.signal });
        if (!r.ok) { yield { type: "finish", reason: { kind: "error", failure: { message: "HTTP " + r.status } } }; return; }
        const j = await r.json();
        yield { type: "text-delta", text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "" };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
}

const routes = [];
const ctx = {
  effect(fn) { return fn(); },
  inject(deps, fn) {
    if (!args.llm) return;
    if (deps[0] === "llm") fn({ llm: previewLlm(args.llm), effect() {} });
    if (deps[0] === "agentDefaultModel") fn({ agentDefaultModel: { currentSelection: () => ({ provider: "preview", model: String(args["llm-model"] || "default") }) }, effect() {} });
  },
  tools: { register: () => () => {} },
  connection: { fetch: { register: (def) => { routes.push(def); return () => {}; } } },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 10 },
  logger: { info: (m) => console.log("[host]", m), warn: (m) => console.log("[host]", m) },
  subprocess: {
    spawn: ({ argv, cwd }) => {
      const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const out = { stdout: collect(child.stdout), stderr: collect(child.stderr) };
      const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (exitCode) => resolve({ exitCode })); });
      return { done, collected: out, terminate: () => child.kill("SIGTERM"), waitForExit: () => done };
    },
  },
};
const mod = await import(path.join(PKG, "index.js"));
mod.apply(ctx, { dataDir: path.resolve(args.data) });

/**
 * 页面结构照搬宿主 AppFrame：.frame（网格：侧栏 | 中间列，height:100%，overflow:hidden）
 *   → .centerCol（纵向弹性，overflow:hidden）→ .mainPanel（纵向弹性，flex:1，min-height:0）→ 插件页面。
 * 中间列不滚动，所以插件页面必须自己滚动、自己撑满宽度——布局问题在这里就能复现。
 *   ?w=<窗口宽>  ?h=<窗口高>  ?sidebar=0（收起侧栏，默认 260px）  ?platform=darwin（macOS 桌面：顶部 48px 留白）
 */
const PAGE = (theme) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-newswire 预览</title>
<style>${theme}
html,body{margin:0;height:100%;background:#888;color:var(--dsw-alias-label-primary,#111);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
html[data-platform=darwin]{--dsh-frame-top-clearance:48px}
#window{height:100%;margin:0 auto;overflow:hidden}
.frame{position:relative;display:grid;grid-template-rows:minmax(0,1fr) auto;grid-template-columns:var(--sidebar-w,260px) minmax(0,1fr);height:100%;box-sizing:border-box;overflow:hidden;background:var(--dsw-alias-bg-base,#f3f4f6)}
.sidebarCol{grid-column:1;grid-row:1;min-width:0;overflow:hidden;background:var(--dsw-specific-sidebar-fill,#eceef1);border-right:.5px solid var(--dsw-alias-border-l3,#0000001f)}
.centerCol{grid-column:2;grid-row:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.mainPanel{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
</style></head><body>
<div id="window"><div class="frame"><div class="sidebarCol"></div><div class="centerCol"><div class="mainPanel" data-global-panel="true" id="root"></div></div></div></div>
<script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script>
var q = new URLSearchParams(location.search);
if (q.get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
if (q.get('platform')) document.documentElement.setAttribute('data-platform', q.get('platform'));
var win = document.getElementById('window');
if (q.get('w')) win.style.width = q.get('w') + 'px';
if (q.get('h')) win.style.height = q.get('h') + 'px';
if (q.get('sidebar') === '0') document.querySelector('.frame').style.setProperty('--sidebar-w', '0px');
var mods = { react: React };
window.__ModuleLoader__ = { load: function (m) {
  var plugin = m.factory(function (name) { return mods[name] });
  var main = null;
  plugin.apply({
    inject: function (deps, fn) { if (deps[0] === 'locale') fn({ locale: { register: function () {}, getLocale: function () { return { active: q.get('lang') || 'zh' } } }, on: function () { return function () {} } }) },
    slots: { inject: function (n, fn) { fn() }, register: function (def, comp) { if (def.name === 'main') main = comp; return function () {} } },
  });
  // 宿主的 renderSlot 直接把组件渲染进 .mainPanel，不额外包一层
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(main));
} };
</script>
<script src="/client.js"></script>
</body></html>`;

const theme = themeCss(args.theme);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/" || url.pathname === "/index.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE(theme)); return; }
  if (url.pathname === "/client.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); res.end(fs.readFileSync(args.client ? path.resolve(args.client) : path.join(PKG, "client.js"))); return; }
  const def = routes.find((r) => r.path === url.pathname && r.methods.includes(req.method));
  if (!def) { res.writeHead(404); res.end("not found"); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const request = new Request("http://127.0.0.1" + req.url, { method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  try {
    const out = await def.fetch(request);
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message) }));
  }
});
server.listen(PORT, "127.0.0.1", () => console.log("预览：http://127.0.0.1:" + PORT + "/  （?theme=dark&w=1280&h=800&platform=darwin&sidebar=0）" + (theme ? "" : "  未加载宿主主题，使用兜底色")));
