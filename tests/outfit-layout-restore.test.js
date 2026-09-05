const assert = require("assert");
const Module = require("module");

let definition;
global.Page = (value) => { definition = value; };

const state = {
  wardrobe: [],
  storedDraft: null,
  created: 0,
  updated: 0
};
const fakeAppService = {
  async listWardrobeItems() {
    return state.wardrobe;
  },
  getOutfitDraft() {
    return state.storedDraft;
  },
  persistOutfitDraft(draft) {
    state.storedDraft = JSON.parse(JSON.stringify(draft));
  },
  async createSavedOutfit(payload) {
    state.created += 1;
    return { id: "outfit_new_1", layout: payload.layout, syncStatus: "synced" };
  },
  async updateSavedOutfit(id, payload) {
    state.updated += 1;
    return { id, layout: payload.layout, syncStatus: "synced" };
  }
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
    this._setDataLog = this._setDataLog || [];
    this._setDataLog.push(patch);
    Object.keys(patch).forEach((key) => {
      this.data[key] = patch[key];
    });
  };
  instance.hasLoadedLayout = false;
  instance.lastLayoutFingerprint = "";
  instance._pendingSchemaRemap = null;
  instance._saveInFlight = false;
  return instance;
}

function liveItem(id, category, name) {
  return {
    id,
    itemId: id,
    name,
    category,
    imageUrl: `cloud://live/${id}.jpg`,
    imageFileId: `cloud://live/${id}.jpg`,
    seasons: ["summer"],
    styles: ["casual"]
  };
}

function slotSnapshot(id, category, name) {
  const item = liveItem(id, category, name);
  return { ...item, snapshot: { name, category, imageUrl: item.imageUrl, imageFileId: item.imageFileId, primaryColor: "" } };
}

const wardrobeAll = [
  liveItem("topA", "top", "白T"),
  liveItem("topB", "top", "条纹衫"),
  liveItem("bottomA", "bottom", "牛仔裙"),
  liveItem("shoesA", "shoes", "帆布鞋"),
  liveItem("bagA", "bag", "斜挎包")
];
const savedLayout = (topOverride) => ({
  version: 1,
  canvas: { width: 360, height: 300 },
  slots: {
    top: { ...{ x: 240, y: 120, scale: 1.6, zIndex: 7 }, ...(topOverride || {}) },
    bottom: { x: 188, y: 216, scale: 0.78, zIndex: 5 },
    shoes: { x: 186, y: 276, scale: 1, zIndex: 6 },
    hat: null,
    bag: null
  }
});

(async () => {
  // ---- 1. 编辑 handoff（outfit-detail 携带 layout）→ 恢复已保存布局而非默认 ----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = {
      sourceOutfitId: "outfit_A",
      mode: "edit",
      dirty: false,
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
      },
      layout: savedLayout()
    };
    const page = createPage();
    await page.loadEditor();
    assert.strictEqual(page.data.layouts.top.x, 240, "编辑恢复应还原保存的 top.x");
    assert.strictEqual(page.data.layouts.top.scale, 1.6, "编辑恢复应还原保存的 scale");
    assert.strictEqual(page.data.layouts.top.zIndex, 7);
    assert.strictEqual(page.data.draft.mode, "edit");
    assert.strictEqual(page.data.draft.sourceOutfitId, "outfit_A");
  }

  // ---- 2. legacy 记录（无 layout）→ 回退默认布局，draft.layout 保持 null（不自动回填）----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = {
      sourceOutfitId: "outfit_legacy",
      mode: "edit",
      dirty: false,
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
      }
    };
    const page = createPage();
    await page.loadEditor();
    assert.strictEqual(page.data.layouts.top.x, 180, "legacy 无 layout 必须回退默认布局");
    assert.strictEqual(page.data.layouts.top.scale, 1);
    assert.strictEqual(page.data.draft.layout, null, "加载 legacy 不得自动 backfill draft.layout");
    // 未改动前不得把默认布局写进持久化草稿
    assert(!Object.prototype.hasOwnProperty.call(state.storedDraft, "layout") || state.storedDraft.layout === null, "加载本身不得改写草稿 layout");
  }

  // ---- 3. 用户拖动/缩放后 persist → 中断后重新 loadEditor 恢复（前后台/重启不丢）----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = {
      sourceOutfitId: "outfit_A",
      mode: "edit",
      dirty: false,
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
      },
      layout: savedLayout()
    };
    const page = createPage();
    await page.loadEditor();
    // 拖到新位置并落盘（onLayerTouchEnd → persistDraft 的等价路径）
    page.applyLayout("top", { x: 260, y: 130, scale: 1.8 }, true);
    page.persistDraft({ dirty: true });
    assert.strictEqual(state.storedDraft.layout.slots.top.x, 260, "变更后草稿必须携带序列化 layout");
    assert.strictEqual(state.storedDraft.dirty, true);
    // 模拟中断后重启：全新页面读同一草稿
    const restarted = createPage();
    await restarted.loadEditor();
    assert.strictEqual(restarted.data.layouts.top.x, 260, "重启后必须恢复拖动过的位置");
    assert.strictEqual(restarted.data.layouts.top.scale, 1.8);
    // 二次 onShow 同指纹不重置用户再调整
    restarted.applyLayout("top", { x: 250 }, true);
    await restarted.loadEditor();
    assert.strictEqual(restarted.data.layouts.top.x, 250, "onShow 同草稿不得重置画布");
  }

  // ---- 4. 同 items 但不同 sourceOutfitId 绝不串布局（B 编辑不沿用 A 的画布）----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = {
      sourceOutfitId: "outfit_A",
      mode: "edit",
      dirty: false,
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
      },
      layout: savedLayout()
    };
    const page = createPage();
    await page.loadEditor();
    page.applyLayout("top", { x: 280, y: 90, scale: 2 }, true);
    page.persistDraft({ dirty: true });
    // 编辑另一套保存布局（同样三个单品，仅摆放不同）
    state.storedDraft = {
      sourceOutfitId: "outfit_B",
      mode: "edit",
      dirty: false,
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
      },
      layout: savedLayout({ x: 150, y: 80, scale: 1.2 })
    };
    await page.loadEditor();
    assert.strictEqual(page.data.layouts.top.x, 150, "切换到另一 sourceOutfitId 必须物化其自己的布局");
    assert.strictEqual(page.data.layouts.top.scale, 1.2);
    assert.strictEqual(page.data.layouts.top.y, 80);
  }

  // ---- 5. 槽位删除不残留 layout（serialize filledSlots 置 null）----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = {
      sourceOutfitId: null,
      mode: "create",
      dirty: false,
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋"),
        bag: slotSnapshot("bagA", "bag", "斜挎包")
      }
    };
    const page = createPage();
    await page.loadEditor();
    // 给 bag 一个自定义摆放，再删除 bag
    page.applyLayout("bag", { x: 300, y: 60, scale: 1.4 }, true);
    page.onSelectItem({ currentTarget: { dataset: { category: "bag", id: "" } } });
    assert.strictEqual(page.data.draft.slots.bag, null, "删除后槽位为空");
    assert.strictEqual(state.storedDraft.layout.slots.bag, null, "删除后序列化 layout 不得残留 bag entry");
    assert.strictEqual(state.storedDraft.layout.slots.top.x, 180, "其余槽位保持默认/现有布局");
  }

  // ---- 6. 槽位替换不残留旧单品布局：换 top 后该槽复位默认并序列化 ----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = {
      sourceOutfitId: null,
      mode: "create",
      dirty: false,
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
      },
      layout: savedLayout({ x: 240, y: 120, scale: 1.6 })
    };
    const page = createPage();
    await page.loadEditor();
    page.applyLayout("top", { x: 260, y: 130, scale: 1.8 }, true);
    page.onSelectItem({ currentTarget: { dataset: { category: "top", id: "topB" } } });
    assert.strictEqual(page.data.draft.slots.top.id, "topB", "top 已替换为新单品");
    assert.strictEqual(page.data.draft.layout.slots.top.x, 180, "换新单品该槽布局必须复位默认，不沿用旧图摆放");
    assert.strictEqual(page.data.draft.layout.slots.top.scale, 1);
  }

  // ---- 6b. 换一套（onShuffle）整套替换：画布复位默认，不残留上一套布局 ----
  {
    // 当前真实季节下的可换单品（seasons 置空即全年可用，规避运行日期影响）
    state.wardrobe = wardrobeAll.map((item) => ({ ...item, seasons: [], styles: ["casual"] }));
    state.storedDraft = {
      sourceOutfitId: null,
      mode: "create",
      dirty: false,
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
      },
      layout: savedLayout({ x: 240, y: 120, scale: 1.6 })
    };
    const page = createPage();
    await page.loadEditor();
    // 自定义摆放（含层级互换）确保 shuffle 前画布非默认
    page.applyLayout("top", { x: 260, y: 130, scale: 1.8 }, true);
    page.onLayerUp({ currentTarget: { dataset: { slot: "top" } } });
    assert.notStrictEqual(page.data.draft.layout.slots.top.x, 180, "前置：shuffle 前确为自定义摆放");
    // 随机化换一套：全套槽位都会被换（单分类池足够且必选槽必然换出）
    global.wx = { showToast() {}, showModal() {} };
    page.onShuffle();
    delete global.wx;
    const after = page.data.draft.layout
    assert.strictEqual(page.data.layouts.top.x, 180, "换一套后画布必须复位默认");
    assert.strictEqual(after.slots.top.x, 180, "换一套后序列化 layout 不得残留上一套摆放");
    assert.strictEqual(after.slots.top.zIndex, 7, "换一套后层级不得残留上一套互换结果");
    assert.strictEqual(after.slots.top.scale, 1);
    assert.strictEqual(after.slots.hat, null, "随机未选中的槽位必须为 null");
    assert.strictEqual(state.storedDraft.dirty, true);
    state.wardrobe = wardrobeAll;
  }

  // ---- 7. buildPayload 携带序列化 layout（保存协议入云）----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = {
      sourceOutfitId: null,
      mode: "create",
      dirty: false,
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
      }
    };
    const page = createPage();
    await page.loadEditor();
    page.persistDraft({ title: "夏日穿搭", season: "summer", style: "casual", dirty: true });
    page.applyLayout("top", { x: 240, y: 120, scale: 1.6 }, true);
    const payload = page.buildPayload();
    assert.strictEqual(payload.layout.version, 1);
    assert.strictEqual(payload.layout.slots.top.x, 240, "buildPayload 必须携带序列化 layout");
    assert.strictEqual(payload.layout.slots.hat, null, "payload 不得包含无单品槽");
  }

  // ---- 8. 保存链：层级调整/重置后也能在 reload 恢复；保存成功写入 draft.layout === 入云 layout ----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = {
      sourceOutfitId: "outfit_A",
      mode: "edit",
      dirty: false,
      title: "保存链",
      season: "summer",
      style: "casual",
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
      },
      layout: savedLayout()
    };
    const page = createPage();
    await page.loadEditor();
    page.selectSlot("top");
    page.onLayerUp({ currentTarget: { dataset: { slot: "top" } } }); // zIndex 互换并落盘
    assert.strictEqual(state.storedDraft.layout.slots.top.zIndex, 8, "层级调整必须落盘 zIndex");
    page.onResetAll();
    assert.strictEqual(state.storedDraft.layout.slots.top.zIndex, 7, "重置后必须落盘默认 zIndex");
    assert.strictEqual(state.storedDraft.layout.slots.top.x, 180);
    // 模拟 commitSave 成功（update 路径）——直接驱动完整方法验证 draft.layout 与入云一致
    global.wx = { showToast() {}, showModal() {} };
    state.updated = 0;
    await page.commitSave("update");
    delete global.wx;
    assert.strictEqual(state.updated, 1);
    assert.strictEqual(page.data.draft.mode, "edit");
    assert.strictEqual(page.data.draft.sourceOutfitId, "outfit_A");
    assert.strictEqual(page.data.draft.dirty, false);
    assert.strictEqual(page.data.draft.layout.version, 1, "保存后 draft 必须带 layout");
    assert.strictEqual(page.data.draft.layout.slots.top.zIndex, 7, "保存后 draft.layout 与落盘画布一致");
  }

  // ---- 9. 保存中重复提交防护：_saveInFlight 锁防重复 create/update ----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = {
      sourceOutfitId: null,
      mode: "create",
      dirty: false,
      title: "防重",
      season: "summer",
      style: "casual",
      slots: {
        top: slotSnapshot("topA", "top", "白T"),
        bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
        shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
      }
    };
    const page = createPage();
    await page.loadEditor();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let createCalls = 0;
    const originalCreate = fakeAppService.createSavedOutfit;
    fakeAppService.createSavedOutfit = () => {
      createCalls += 1;
      return gate.then(() => ({ id: "outfit_guard", layout: page.serializeCurrentLayout(), syncStatus: "synced" }));
    };
    global.wx = { showToast() {}, showModal() {} };
    const first = page.commitSave("create");
    const second = page.commitSave("create"); // 保存中再次点击
    release();
    await Promise.all([first, second]);
    fakeAppService.createSavedOutfit = originalCreate;
    delete global.wx;
    assert.strictEqual(createCalls, 1, "重复点击保存只允许一次 createSavedOutfit 调用");
    assert.strictEqual(page._saveInFlight, false, "保存结束后必须释放锁");
    assert.strictEqual(page.data.saving, false);
  }

  console.log("outfit layout restore / draft / save-chain tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
