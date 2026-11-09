/**
 * 站点适配器注册表。源配置写 "adapter": "<id>" 即启用；适配器拿到整页 HTML（browse 的 html 模式或 http 直取）后
 * 返回统一条目（含源头热度信号）。新增适配器：在本目录加 <id>.mjs 并在下面登记，再配一份 tests/fixtures/<id>.html.gz。
 */
import techflow from "./techflow.mjs";
import jiemian from "./jiemian.mjs";
import thepaper from "./thepaper.mjs";
import apnews from "./apnews.mjs";

const REGISTRY = new Map([techflow, jiemian, thepaper, apnews].map((a) => [a.id, a]));

export function getAdapter(id) { return id ? REGISTRY.get(id) || null : null; }
export function adapterIds() { return Array.from(REGISTRY.keys()); }
