const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

/**
 * Round 1.5.1 视觉重构第二轮：独立验证
 *  - WXML 槽卡内三操作（↑↓×）与 moveLayer/clearSlot（onSelectItem 置空）的换绑语义
 *  - 画布底部无工具按钮；重置画布独立于左栏底部
 *  - 四宫格选衣卡结构与卡片瘦身（仅图+名+选中态）
 *  - 空槽 / 已选槽（filled vs empty）UI 分态
 *  - 页面阅读顺序：标题/分段 → 两栏 → 保存按钮 → 说明行 → 可选衣物卡
 */

const root = path.resolve(__dirname, "..");
const wxml = fs.readFileSync(path.join(root, "miniprogram/pages/outfit/index.wxml"), "utf8");
const wxss = fs.readFileSync(path.join(root, "miniprogram/pages/outfit/index.wxss"), "utf8");

// ---- WXML：槽卡操作换绑（命令仍复用 moveLayer / onSelectItem）----
assert(wxml.includes('catchtap="onLayerUp"'), "槽卡内必须有上移操作（↑）");
assert(wxml.includes('catchtap="onLayerDown"'), "槽卡内必须有下移操作（↓）");
assert(wxml.includes('data-category="{{item.slot}}" data-id="" catchtap="onSelectItem"'), "删除必须复用 onSelectItem 置空（clearSlot 语义）");
assert(!wxml.includes('onResetSlot'), "「重置当前」工具按钮随画布工具栏一并移除");
assert(wxml.includes('wx:if="{{item.filled}}"'), "槽卡必须区分已选（filled）态");
assert(wxml.includes('class="slot-empty-label"'), "槽卡必须区分空槽（empty）占位态");
assert(wxml.includes('slot-action-disabled'), "未选中槽位时操作必须呈现禁用态");
assert(wxml.includes('class="reset-canvas'), "重置画布按钮必须保留");
assert(wxml.indexOf('class="reset-canvas') < wxml.indexOf('class="canvas-panel"'), "重置画布应位于左栏（画板之前）");

// ---- WXML：画布底部不再堆 button，仅保留提示行 ----
assert(!wxml.includes('canvas-toolbar'), "画布底部工具栏必须移除");
assert(wxml.includes('class="canvas-hint"'), "画布提示行保留");

// ---- WXML：已选卡瘦身（仅槽名/衣物名/缩略图/选中态/操作）----
assert(wxml.includes('class="slot-thumb"'), "已选卡保留小缩略图");
assert(wxml.includes('class="slot-tag"'), "已选卡保留槽名标签");
assert(wxml.includes('class="slot-check"'), "已选卡保留当前选中态标记");

// ---- WXML：四宫格选衣卡（图片主体 + 一行名称 + 选中态）----
assert(wxml.includes('class="item-frame"'), "四宫格卡必须有图片主体容器");
assert(wxml.includes('class="check-mark"'), "四宫格卡必须保留 micro-check 选中态");
assert(wxml.includes('class="item-name"'), "四宫格卡必须保留一行名称");

// ---- WXSS：左右栏 47.5:52.5（326:360），四列网格 ----
  assert(wxss.includes("width: 326rpx;") && wxss.includes("flex: 0 0 326rpx;"), "左栏必须为 326rpx（≈47.5%）");
assert(wxss.includes("grid-template-columns: repeat(4, minmax(0, 1fr))"), "选衣区必须为四列定宽网格");
assert(!wxss.includes("repeat(3"), "不得残留三列网格");
assert(wxss.includes("align-items: stretch;"), "两栏必须 flex stretch 等高");

// ---- WXSS：新的画布与槽位兜底几何（与 outfit-layout DEFAULT_LAYOUT/BASE_SIZES 对齐）----
const layout = require("../miniprogram/services/outfit-layout");
[
  ["layer-hat", 176, 38, 103, 67],
  ["layer-top", 180, 122, 90, 114],
  ["layer-bottom", 188, 216, 105, 133],
  ["layer-shoes", 186, 276, 109, 48],
  ["layer-bag", 286, 150, 80, 92]
].forEach(([cls, x, y, w, h]) => {
  const m = wxss.match(new RegExp(`\\.${cls} \\{([^}]*)\\}`));
  assert(m, `.${cls} 兜底样式必须存在`);
  const body = m[1];
  assert(body.includes(`left: ${x}rpx;`), `.${cls} left 应为 ${x}rpx`);
  assert(body.includes(`top: ${y}rpx;`), `.${cls} top 应为 ${y}rpx`);
  assert(body.includes(`width: ${w}rpx;`), `.${cls} width 应为 ${w}rpx`);
  assert(body.includes(`height: ${h}rpx;`), `.${cls} height 应为 ${h}rpx`);
});
assert(wxss.includes("height: 100%;"), "点阵画布必须吃满右栏剩余高度");
assert(!/^\s*height:\s*300rpx;/m.test(wxss.match(/\.composition \{([^}]*)\}/)[1]), "点阵画布不得再写死 300rpx");
const compMatch = wxss.match(/\.composition \{([^}]*)\}/);
assert(compMatch && compMatch[1].includes("width: 100%"), "画布宽度随右栏（360rpx）自适应");
assert(wxss.includes("pointer-events: none;"), "提示文案不得挡住画布手势");

// ---- JS：换绑语义 —— 槽卡触发与选中态触发等价，均复用 moveLayer ----
let definition;
global.Page = (value) => { definition = value; };
const state = { wardrobe: [], storedDraft: null };
const fakeAppService = {
  async listWardrobeItems() { return state.wardrobe; },
  getOutfitDraft() { return state.storedDraft; },
  persistOutfitDraft() {}
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "../../services/app-service") return fakeAppService;
  return originalLoad.call(this, request, parent, isMain);
};
require("../miniprogram/pages/outfit/index");
Module._load = originalLoad;
delete global.Page;

function createPage() {
  const instance = Object.create(definition);
  instance.data = JSON.parse(JSON.stringify(definition.data));
  instance.setData = function (patch) {
    Object.keys(patch).forEach((key) => {
      this.data[key] = patch[key];
    });
  };
  return instance;
}

(async () => {
  state.wardrobe = [{ id: "t1", itemId: "t1", name: "上衣", category: "top", imageUrl: "cloud://live/top.jpg" }];
  state.storedDraft = { slots: { top: { id: "t1", itemId: "t1", name: "上衣", category: "top", imageUrl: "cloud://live/top.jpg" } } };
  const page = createPage();
  page.hasLoadedLayout = false;
  page.lastLayoutFingerprint = "";
  await page.loadEditor();

  // 未选中、无事件：onLayerUp 不动作（对应槽卡禁用态点击被拦）
  const before = JSON.stringify(page.data.layouts);
  page.onLayerUp();
  assert.strictEqual(JSON.stringify(page.data.layouts), before, "无选中且无事件时上移不得动作");

  // 槽卡 ↑ 换绑：event.currentTarget.dataset.slot 指向 top，等价于先 selectSlot 再 moveLayer
  page.onLayerUp({ currentTarget: { dataset: { slot: "top" } } });
  assert.strictEqual(page.data.layouts.top.zIndex, 8, "槽卡 ↑ 应把 top 与 hat 层互换");
  assert.strictEqual(page.data.layouts.hat.zIndex, 7, "槽卡 ↑ 互换 hat 层");
  assert.strictEqual(page.data.selectedSlot, "top", "槽卡操作后该槽位应处于选中态");

  // 槽卡 ↓ 换回
  page.onLayerDown({ currentTarget: { dataset: { slot: "top" } } });
  assert.strictEqual(page.data.layouts.top.zIndex, 7, "槽卡 ↓ 应换回原层级");

  // 空 data-slot 回退选中槽位（保持旧调用兼容）
  page.onLayerDown();
  assert.strictEqual(page.data.layouts.top.zIndex, 6, "无事件时回退当前选中槽位执行下移");

  // × 换绑：onSelectItem 置空 = 清除当前槽位（画布空态）
  page.onSelectItem({ currentTarget: { dataset: { category: "top", id: "" } } });
  assert.strictEqual(page.data.draft.slots.top, null, "× 应清除 top 槽位");
  assert.strictEqual(page.data.selectedSlot, "", "清除后应取消选中（画布/槽卡回到空态）");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

console.log("outfit layout v2 (round 1.5.1 ui rebind) tests passed");
