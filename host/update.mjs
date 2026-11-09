/**
 * 更新检查（做法同 dsh-switchboard）：按安装来源查最新版本。
 *   - GitHub 安装：默认分支最新提交，及该提交 package.json 里的版本号；更新时装 github:owner/repo#<sha>。
 *   - npm 安装：npmjs 与 npmmirror 的 latest。
 * 私有仓库的匿名请求会得到 404/403，这时改用本机的 GitHub 凭据：GITHUB_TOKEN / GH_TOKEN 环境变量，或已登录的 gh CLI（`gh auth token`）。
 * 凭据只用于这两个 GitHub API 请求，不保存、不返回给面板。结果缓存 10 分钟，失败不缓存。
 */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const NPM_REGISTRIES = ["https://registry.npmjs.org", "https://registry.npmmirror.com"];
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10000;

export async function installedPackage() {
  const m = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  return { name: m.name, version: m.version };
}

/** 解析 profile 里的依赖写法：github:owner/repo#ref、版本范围、link:/file: 等。 */
export function parseSource(spec, name) {
  const value = String(spec || "").trim();
  if (value === "") return { kind: "unknown" };
  const gh = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.+))?$/u.exec(value);
  if (gh) return Object.assign({ kind: "github", owner: gh[1], repo: gh[2] }, gh[3] ? { ref: gh[3] } : {});
  if (/^(link:|file:|\/|\.)/u.test(value) || value.endsWith(".tgz")) return { kind: "local", spec: value };
  if (/^(npm:)?[\^~<>=v\d*x\s|.-]+$/u.test(value) || value === "latest") return { kind: "npm", name };
  return { kind: "unknown" };
}

/** 比较 semver：a 更新返回正数。正式版高于同号的预发布版。 */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core = "", pre] = String(v).trim().replace(/^v/u, "").split("+", 1)[0].split(/-(.*)/su);
    return [core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre === undefined || pre === "" ? [] : pre.split(".")];
  };
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  for (let i = 0; i < Math.max(ca.length, cb.length, 3); i++) {
    const d = (ca[i] || 0) - (cb[i] || 0);
    if (d !== 0) return d;
  }
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x), ny = Number(y);
    if (Number.isInteger(nx) && Number.isInteger(ny)) { if (nx !== ny) return nx - ny; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 本机 GitHub 凭据：环境变量优先，其次 gh CLI。取不到返回 null。 */
export async function githubToken(ghBin) {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env.trim();
  if (!ghBin) return null;
  try {
    const { stdout } = await exec(ghBin, ["auth", "token"], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export class UpdateChecker {
  /** @param o { fetchImpl?, token?: () => Promise<string|null> } */
  constructor(o) {
    this.fetchImpl = (o && o.fetchImpl) || fetch;
    this.token = (o && o.token) || (async () => null);
    this.cache = new Map();
  }

  check(spec, force) {
    const key = spec || "";
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = this.run(spec);
    this.cache.set(key, { at: Date.now(), value });
    value.then((r) => { if (r.error !== undefined) this.cache.delete(key); }, () => this.cache.delete(key));
    return value;
  }

  async run(spec) {
    const { name, version } = await installedPackage();
    const source = parseSource(spec, name);
    const base = { installed: version, source, checkedAt: Date.now() };
    try {
      let latest;
      if (source.kind === "github") latest = await this.github(source.owner, source.repo);
      else if (source.kind === "npm") latest = await this.npm(source.name);
      return latest === undefined ? Object.assign(base, { newer: false }) : Object.assign(base, { latest, newer: compareVersions(latest.version, version) > 0 });
    } catch (error) {
      return Object.assign(base, { newer: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async get(url, headers, raw) {
    const r = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) { const e = new Error(new URL(url).host + " answered HTTP " + r.status); e.status = r.status; throw e; }
    return raw ? r.text() : r.json();
  }

  async github(owner, repo) {
    const api = "https://api.github.com/repos/" + owner + "/" + repo;
    const anon = { accept: "application/vnd.github+json", "user-agent": "dsh-newswire" };
    let headers = anon;
    let head;
    try {
      head = await this.get(api + "/commits/HEAD", headers);
    } catch (e) {
      // 私有仓库对匿名请求返回 404/403：用本机凭据再试一次
      if (e.status !== 404 && e.status !== 403) throw e;
      const token = await this.token();
      if (!token) throw new Error("GitHub 仓库是私有的，匿名查询不到；请设置 GITHUB_TOKEN 或登录 gh（gh auth login）");
      headers = Object.assign({}, anon, { authorization: "Bearer " + token });
      head = await this.get(api + "/commits/HEAD", headers);
    }
    const manifest = JSON.parse(await this.get(api + "/contents/package.json?ref=" + head.sha, Object.assign({}, headers, { accept: "application/vnd.github.raw" }), true));
    if (typeof manifest.version !== "string") throw new Error("the repository package.json declares no version");
    const date = head.commit && head.commit.committer && head.commit.committer.date;
    return Object.assign({
      version: manifest.version,
      commit: head.sha,
      summary: String((head.commit && head.commit.message) || "").split("\n", 1)[0],
      url: "https://github.com/" + owner + "/" + repo + "/commits/" + head.sha,
      spec: "github:" + owner + "/" + repo + "#" + head.sha,
    }, date ? { date } : {});
  }

  async npm(name) {
    let failure;
    for (const registry of NPM_REGISTRIES) {
      try {
        const latest = await this.get(registry + "/" + name + "/latest", {});
        return { version: latest.version, url: "https://www.npmjs.com/package/" + name + "/v/" + latest.version, spec: name + "@" + latest.version };
      } catch (e) {
        failure = e;
      }
    }
    throw failure instanceof Error ? failure : new Error("no registry answered");
  }
}
