/* 转载不算独立印证。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { markReposts } from "../../engine/pipeline/select.mjs";

const t = (min) => Date.UTC(2026, 10, 9, 8, min);
test("别家几小时内标题几乎一字不差的算转载；措辞不同的独立报道不算；同一家不算；原发方不会被反算成转载", () => {
  const ms = markReposts([
    { grp: "ws", title: "沙特首都利雅得传出剧烈爆炸声", t: t(3) },
    { grp: "cls", title: "沙特首都利雅得传出剧烈爆炸声", t: t(1) },
    { grp: "jm", title: "沙特首都利雅得传出剧烈爆炸声。", t: t(9) },
    { grp: "ap", title: "利雅得金融区遇袭 阿美大楼受损", t: t(30) },
    { grp: "cls", title: "沙特首都利雅得传出剧烈爆炸声（更新）", t: t(40) },
  ]);
  assert.deepEqual(ms.map((m) => m.repost_of), ["cls", null, "cls", null, null]);
  const late = markReposts([{ grp: "a", title: "某市发布暴雨红色预警", t: t(0) }, { grp: "b", title: "某市发布暴雨红色预警", t: t(0) + 5 * 3600000 }]);
  assert.equal(late[1].repost_of, null, "隔了几个小时的不算转载");
});
