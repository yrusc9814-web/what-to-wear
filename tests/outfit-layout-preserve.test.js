const assert = require("assert");
const Module = require("module");

let definition;
global.Page = (value) => { definition = value; };

const state = {
  wardrobe: [],
  storedDraft: null
};
const fakeAppService = {
  async listWardrobeItems() {
    return state.wardrobe;
  },
  getOutfitDraft() {
    return state.storedDraft;
  },
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

function liveTopItem(id) {
  return { id, itemId: id, name: "上衣", category: "top", imageUrl: "cloud://live/top.jpg", imageFileId: "cloud://live/top.jpg" };
}

(async () => {
  // Round 1.5.4：默认回退画布 360×300，top 基尺寸 90×114，默认中心 x=180/y=122。
  // 场景 1：首次 loadEditor 初始化默认布局
  {
    const page = createPage();
    page.hasLoadedLayout = false;
    page.lastLayoutFingerprint = "";
    await page.loadEditor();
    assert.ok(page.data.layouts, "首次加载必须初始化 layouts");
    assert.strictEqual(page.data.layouts.top.x, 180);
    assert.strictEqual(page.data.layouts.top.scale, 1);
    assert.strictEqual(page.data.renderLayers.top.width, 90, "默认渲染宽 = 基尺寸");
  }

  // 场景 2：二次 loadEditor 同 draft 不重置布局（onShow 保留用户调整）
  {
    const page = createPage();
    page.hasLoadedLayout = false;
    page.lastLayoutFingerprint = "";
    await page.loadEditor();
    // 用户拖动 + 缩放 top（x=200/y=200 在回退画布 360×300 内合法，不被 clamp）
    page.applyLayout("top", { x: 200, y: 200, scale: 1.5 }, true);
    assert.strictEqual(page.data.layouts.top.x, 200);
    assert.strictEqual(page.data.layouts.top.scale, 1.5);
    assert.strictEqual(page.data.renderLayers.top.width, Math.round(90 * 1.5), "拖动/缩放后派生渲染尺寸更新");
    // 前后台切换触发再次 loadEditor，draft 内容未变
    await page.loadEditor();
    assert.strictEqual(page.data.layouts.top.x, 200, "二次 loadEditor 同 draft 不得重置位置");
    assert.strictEqual(page.data.layouts.top.scale, 1.5, "二次 loadEditor 同 draft 不得重置缩放");
    assert.strictEqual(page.data.renderLayers.top.width, Math.round(90 * 1.5), "保留的布局派生渲染尺寸同步保持");
  }

  // 场景 3：draft 内容真的变化时重建布局
  {
    const page = createPage();
    page.hasLoadedLayout = false;
    page.lastLayoutFingerprint = "";
    state.wardrobe = [];
    state.storedDraft = null;
    await page.loadEditor();
    page.applyLayout("top", { x: 200, y: 200, scale: 1.5 }, true);
    assert.strictEqual(page.data.layouts.top.x, 200);
    // 衣橱/草稿内容变化：新上衣进入 top 槽
    state.wardrobe = [liveTopItem("t1")];
    state.storedDraft = { slots: { top: { id: "t1", itemId: "t1", name: "上衣", category: "top", imageUrl: "cloud://live/top.jpg" } } };
    await page.loadEditor();
    assert.strictEqual(page.data.layouts.top.x, 180, "draft 内容变化应重建布局");
    assert.strictEqual(page.data.layouts.top.scale, 1);
    assert.strictEqual(page.data.renderLayers.top.width, 90);
  }

  // 场景 4：选中态经 renderLayers 派生，取消选择恢复
  {
    const page = createPage();
    page.hasLoadedLayout = false;
    page.lastLayoutFingerprint = "";
    state.wardrobe = [liveTopItem("t1")];
    state.storedDraft = { slots: { top: { id: "t1", itemId: "t1", name: "上衣", category: "top", imageUrl: "cloud://live/top.jpg" } } };
    await page.loadEditor();
    page.selectSlot("top");
    assert.strictEqual(page.data.selectedSlot, "top");
    assert.strictEqual(page.data.renderLayers.top.selected, true, "选中后渲染层携带 selected");
    page.deselectSlot();
    assert.strictEqual(page.data.renderLayers.top.selected, false, "取消选中后 selected 恢复 false");
  }

  console.log("outfit layout preserve tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
