/**
 * 原始快照保留：raw/YYYYMMDD/[HH/]<文件>。今天之前的文件压缩为 .gz（原名 + .gz）；超过保留天数的日期目录整体删除。
 * 每轮抓取结束时跑一次，开销很小（只扫目录名，压缩只发生在跨天后的第一轮）。
 */
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

function walk(dir, fn) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, fn); else fn(p);
  }
}

/**
 * @param o { rawDir, today（本地日期 YYYYMMDD）, retentionDays }
 * @returns { compressed, removedDays, savedBytes }
 */
export function applyRetention(o) {
  const out = { compressed: 0, removedDays: 0, savedBytes: 0 };
  if (!fs.existsSync(o.rawDir)) return out;
  const t = o.today;
  const cutoff = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(4, 6)) - 1, Number(t.slice(6, 8))) - (o.retentionDays || 180) * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  for (const day of fs.readdirSync(o.rawDir)) {
    if (!/^\d{8}$/.test(day)) continue;
    const dir = path.join(o.rawDir, day);
    if (day < cutoff) { fs.rmSync(dir, { recursive: true, force: true }); out.removedDays++; continue; }
    if (day >= t) continue;
    walk(dir, (file) => {
      if (file.endsWith(".gz")) return;
      const buf = fs.readFileSync(file);
      const gz = gzipSync(buf, { level: 9 });
      fs.writeFileSync(file + ".gz", gz);
      fs.unlinkSync(file);
      out.compressed++;
      out.savedBytes += buf.length - gz.length;
    });
  }
  return out;
}
