const assert = require("assert");
const Module = require("module");

let definition;
global.Page = (value) => { definition = value; };
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "../../services/app-service") return {};
  return originalLoad.call(this, request, parent, isMain);
};
require("../miniprogram/pages/outfit/index");
Module._load = originalLoad;
delete global.Page;

const historicalTop = {
  itemId: "item_changed",
  snapshot: { name: "原上衣", category: "top", imageUrl: "cloud://history/top.jpg", imageFileId: "cloud://history/top.jpg" }
};
const liveBottom = {
  id: "item_changed",
  itemId: "item_changed",
  name: "已改成下装",
  category: "bottom",
  imageUrl: "cloud://live/bottom.jpg",
  imageFileId: "cloud://live/bottom.jpg"
};
const draft = definition.reconcileDraft({
  sourceOutfitId: "outfit_1",
  mode: "edit",
  slots: { top: historicalTop },
  title: "历史搭配",
  season: "summer",
  style: "casual"
}, [liveBottom]);

assert.strictEqual(draft.slots.top.missing, true);
assert.strictEqual(draft.slots.top.invalidCategory, true);
assert.strictEqual(draft.slots.top.name, "原上衣", "分类变化后应保留历史快照展示");
assert.notStrictEqual(draft.slots.top.name, liveBottom.name, "不得把当前下装自动塞入 top 槽");
console.log("outfit category-change reconciliation tests passed");
