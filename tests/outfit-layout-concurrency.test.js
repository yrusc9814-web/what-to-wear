const assert = require("assert");
const Module = require("module");
const outfitLayout = require("../miniprogram/services/outfit-layout");

/**
 * Round 2B-1 reviewer fix 回归：页面 load/save 并发安全。
 *  - load：onShow / 下拉刷新并发触发 loadEditor 时，较旧异步响应的 wardrobe+draft+layout
 *    为过期快照，经 _loadToken 校验丢弃，不得覆盖较新的 draft/layout。
 *  - save：保存完成回调使用「保存开始时刻 items+layout 同源快照」，即使保存期间发生
 *    并发 loadEditor 替换了 this.data.draft，也绝不把「新 items」与「旧 saved.layout」
 *    交叉混写入持久化 draft。
 *  - measureCanvas：boundingClientRect 异步回调附带发起时的 load 代次，过期量测整体丢弃，
 *    不得 setCanvasSize / 消费 _pendingSchemaRemap / 覆盖较新 layout。
 *  - 同代次 pending 失效：同一 load token 内用户发生任何布局编辑（拖动/捏合、层级、重置、
 *    换一套、槽位换单品/移除）即经 invalidatePendingSchemaRemap 使挂起 schema 重映射失效，
 *    延迟量测回调不得消费旧 pending、不得用旧 schema 覆盖编辑后的 runtime layout；
 *    未发生用户编辑时正常量测仍把 schema remap 到实测画布（场景 4a 保留验证）。
 *  - 最终落盘校验：loadEditor 在 presentation 之后保留最后一道 token === this._loadToken
 *    校验；代次在最终落盘前被并发新 load 取走的过期代次，绝不调用 persistOutfitDraft，
 *    仅最新代次正常持久化（场景 5）。
 */

let definition;
global.Page = (value) => { definition = value; };

const state = {
  wardrobe: [],
  storedDraft: null,
  payloads: [],
  persistedDrafts: []
};
const fakeAppService = {
  async listWardrobeItems() {
    return state.wardrobe;
  },
  getOutfitDraft() {
    return state.storedDraft;
  },
  persistOutfitDraft(draft) {
    state.persistedDrafts.push(JSON.parse(JSON.stringify(draft)));
    state.storedDraft = JSON.parse(JSON.stringify(draft));
  },
  async createSavedOutfit(payload) {
    state.payloads.push(JSON.parse(JSON.stringify(payload)));
    return { id: "outfit_saved_1", layout: JSON.parse(JSON.stringify(payload.layout)), syncStatus: "synced" };
  },
  async updateSavedOutfit(id, payload) {
    state.payloads.push(JSON.parse(JSON.stringify(payload)));
    return { id, layout: JSON.parse(JSON.stringify(payload.layout)), syncStatus: "synced" };
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
  instance.windowWidth = 375;
  instance.rpxPerPx = 2;
  instance._gesture = null;
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

function savedLayout(topOverride) {
  return {
    version: 1,
    canvas: { width: 360, height: 300 },
    slots: {
      top: { ...{ x: 240, y: 120, scale: 1.6, zIndex: 7 }, ...(topOverride || {}) },
      bottom: { x: 188, y: 216, scale: 0.78, zIndex: 5 },
      shoes: { x: 186, y: 276, scale: 1, zIndex: 6 },
      hat: null,
      bag: null
    }
  };
}

function fullDraft(sourceOutfitId, topId, layout) {
  return {
    sourceOutfitId,
    mode: sourceOutfitId ? "edit" : "create",
    dirty: true,
    title: sourceOutfitId ? `编辑${sourceOutfitId}` : "新建搭配",
    season: "summer",
    style: "casual",
    slots: {
      top: slotSnapshot(topId, "top", topId === "topA" ? "白T" : "条纹衫"),
      bottom: slotSnapshot("bottomA", "bottom", "牛仔裙"),
      shoes: slotSnapshot("shoesA", "shoes", "帆布鞋")
    },
    layout: layout || null
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  // ---- 1. 并发 loadEditor：旧响应（后返回）不得覆盖较新 draft/layout ----
  {
    state.wardrobe = wardrobeAll;
    const gates = [];
    state.persistedDrafts.length = 0;
    fakeAppService.listWardrobeItems = () => new Promise((resolve) => gates.push(resolve));
    const page = createPage();
    // 先发起较旧的 load（request 1），再发起较新的 load（request 2）
    const staleLoad = page.loadEditor();   // request 1
    const freshLoad = page.loadEditor();   // request 2
    assert.strictEqual(gates.length, 2, "两次 loadEditor 各发起一次 wardrobe 请求");
    // 新请求先返回：其时的草稿 = 新布局（top.x 150）
    state.storedDraft = fullDraft("outfit_B", "topB", savedLayout({ x: 150, y: 80, scale: 1.2 }));
    gates[1](wardrobeAll);
    await freshLoad;
    assert.strictEqual(page.data.layouts.top.x, 150, "新请求布局必须先落地");
    assert.strictEqual(page.data.draft.sourceOutfitId, "outfit_B");
    assert.strictEqual(state.persistedDrafts.length, 1, "新请求成功应持久化一次草稿");
    assert.strictEqual(state.persistedDrafts[0].layout.slots.top.x, 150);
    // 旧请求后返回：其时的草稿 = 旧布局（top.x 240）—— 必须被代次校验整体丢弃
    state.storedDraft = fullDraft("outfit_A", "topA", savedLayout());
    gates[0](wardrobeAll);
    await staleLoad;
    assert.strictEqual(page.data.draft.sourceOutfitId, "outfit_B", "旧 load 响应不得覆盖较新 draft");
    assert.strictEqual(page.data.layouts.top.x, 150, "旧 load 响应不得覆盖较新 layout（不得回退 top.x=240）");
    assert.strictEqual(page.data.layouts.bottom.x, 188);
    assert.strictEqual(state.persistedDrafts.length, 1, "旧 load 响应不得再触发持久化（不得写回旧草稿 A）");
    assert.strictEqual(state.persistedDrafts[0].layout.slots.top.x, 150, "持久化草稿必须保持较新 layout");
    fakeAppService.listWardrobeItems = async () => state.wardrobe;
  }

  // ---- 2. 保存完成回调：items 与 layout 必须同源快照（保存开始时刻）----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = fullDraft(null, "topA", savedLayout());
    const page = createPage();
    await page.loadEditor(); // 画布物化 A 布局 top.x=240
    assert.strictEqual(page.data.layouts.top.x, 240);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let createCalls = 0;
    const originalCreate = fakeAppService.createSavedOutfit;
    fakeAppService.createSavedOutfit = (payload) => {
      createCalls += 1;
      state.payloads.length = 0;
      state.payloads.push(JSON.parse(JSON.stringify(payload)));
      return gate.then(() => ({
        id: "outfit_saved_2",
        layout: JSON.parse(JSON.stringify(payload.layout)),
        syncStatus: "synced"
      }));
    };
    global.wx = { showToast() {}, showModal() {} };
    const savePromise = page.commitSave("create");
    await flush();
    assert.strictEqual(createCalls, 1, "commitSave 必须触发一次 createSavedOutfit");
    // 保存尚未返回期间，并发 loadEditor 载入「新 items（topB）+ 新布局（top.x=150）」的草稿
    state.storedDraft = fullDraft(null, "topB", savedLayout({ x: 150, y: 80, scale: 1.2 }));
    await page.loadEditor();
    assert.strictEqual(page.data.draft.slots.top.id, "topB", "前置：并发 load 已替换页面草稿为 topB");
    assert.strictEqual(page.data.layouts.top.x, 150);
    // 保存请求此刻返回（携带的是保存开始时刻快照的 layout top.x=240）
    release();
    await savePromise;
    fakeAppService.createSavedOutfit = originalCreate;
    delete global.wx;

    // 入云 payload 必须 = 保存开始时刻的 A 快照（topA + top.x 240）
    const payload = state.payloads[0];
    assert(payload, "必须捕获到 createSavedOutfit 的 payload");
    assert.strictEqual(payload.items.top.itemId || payload.items.top.id, "topA", "payload items 必须来自保存开始时刻快照");
    assert.strictEqual(payload.layout.slots.top.x, 240, "payload layout 必须与 items 同源（A 布局）");
    // 落盘的持久化 draft 不得交叉混写：要么是保存快照（topA + x240），
    // 绝不可能是「新 items topB + 旧 layout x240」或「topB + 任意旧 layout」。
    const persisted = state.storedDraft;
    assert.strictEqual(persisted.dirty, false);
    assert.strictEqual(persisted.layout.version, 1);
    assert.strictEqual(persisted.slots.top.itemId || persisted.slots.top.id, "topA",
      "保存完成后持久化 draft 不得残留并发 load 引入的 topB items（items 与 layout 必须同源）");
    assert.strictEqual(persisted.layout.slots.top.x, 240, "layout 必须与保存快照 items 同源");
    assert.strictEqual(page.data.draft.slots.top.itemId || page.data.draft.slots.top.id, "topA");
    // 显式反例断言：若出现 topB + x240 即证明旧实现交叉混写仍在
    assert(!(page.data.draft.slots.top.id === "topB" && page.data.layouts.top.x === 240), "禁止交叉混写新 items + 旧 layout");
  }

  // ---- 3. update 路径同源快照：保存期间并发 load 也不得交叉混写 ----
  {
    state.wardrobe = wardrobeAll;
    state.storedDraft = fullDraft("outfit_U", "topA", savedLayout());
    const page = createPage();
    await page.loadEditor();

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let updateCalls = 0;
    const originalUpdate = fakeAppService.updateSavedOutfit;
    fakeAppService.updateSavedOutfit = (id, payload) => {
      updateCalls += 1;
      state.payloads.length = 0;
      state.payloads.push(JSON.parse(JSON.stringify(payload)));
      return gate.then(() => ({
        id,
        layout: JSON.parse(JSON.stringify(payload.layout)),
        syncStatus: "synced"
      }));
    };
    global.wx = { showToast() {}, showModal() {} };
    const savePromise = page.commitSave("update");
    await flush();
    assert.strictEqual(updateCalls, 1);
    state.storedDraft = fullDraft("outfit_U", "topB", savedLayout({ x: 150, y: 80, scale: 1.2 }));
    await page.loadEditor();
    release();
    await savePromise;
    fakeAppService.updateSavedOutfit = originalUpdate;
    delete global.wx;

    const payload = state.payloads[0];
    assert.strictEqual(payload.items.top.itemId || payload.items.top.id, "topA");
    assert.strictEqual(payload.layout.slots.top.x, 240);
    const persisted = state.storedDraft;
    assert.strictEqual(persisted.sourceOutfitId, "outfit_U");
    assert.strictEqual(persisted.slots.top.itemId || persisted.slots.top.id, "topA",
      "update 保存完成后持久化 draft 不得混入并发 load 的 topB items");
    assert.strictEqual(persisted.layout.slots.top.x, 240);
  }

  // ---- 4. measureCanvas 过期量测回调（boundingClientRect）不得覆盖较新 layout ----
  // 原状：旧测试的 global.wx 只有 showToast/showModal，wx.createSelectorQuery 缺失，
  // loadEditor 内 measureCanvas 直接 return，此路径从未被覆盖。
  // 本块 stub createSelectorQuery 返回可控异步 rect：exec() 只登记回调不自动触发，
  // 由测试按需手动落地（先落地者即可视为「先返回的过期量测」）。
  function installMeasureRecorder() {
    const measureCbs = [];
    global.wx = {
      showToast() {},
      showModal() {},
      createSelectorQuery() {
        const query = {
          select() { return query; },
          boundingClientRect(cb) { query._cb = cb; return query; },
          exec() { measureCbs.push(query._cb); }
        };
        return query;
      }
    };
    return measureCbs;
  }
  const RECT_PX = { width: 200, height: 150 }; // rpxPerPx=2 → 实测画布 400×300 rpx

  // 4a：新 load 已整体落地（B 布局）后，旧量测回调 C1 才返回 —— 必须整体丢弃：
  // 不 setData、不消费新代次 _pendingSchemaRemap、不写模块画布；
  // 只有新量测回调 C2 执行实测画布重映射（B schema 按 400/360 等比放大）。
  {
    state.wardrobe = wardrobeAll;
    const measureCbs = installMeasureRecorder();
    const canvasBefore = { width: outfitLayout.CANVAS.width, height: outfitLayout.CANVAS.height };
    state.storedDraft = fullDraft("outfit_A", "topA", savedLayout());
    const page = createPage();
    await page.loadEditor(); // 代次 1 → 注册 C1
    assert.strictEqual(measureCbs.length, 1, "第一次 load 完成后应注册量测回调 C1");
    assert.strictEqual(page.data.layouts.top.x, 240, "前置：代次 1 物化 A 布局");
    assert.strictEqual(page._pendingSchemaRemap.slots.top.x, 240, "前置：A schema 待重映射挂起");

    state.storedDraft = fullDraft("outfit_B", "topB", savedLayout({ x: 150, y: 80, scale: 1.2 }));
    await page.loadEditor(); // 代次 2 → 注册 C2；新 layout 先落地
    assert.strictEqual(measureCbs.length, 2, "第二次 load 完成后应再注册量测回调 C2");
    assert.strictEqual(page.data.layouts.top.x, 150, "前置：新 load 布局必须已落地");
    assert.strictEqual(page.data.draft.sourceOutfitId, "outfit_B");
    const pendingSchemaB = page._pendingSchemaRemap;
    assert(pendingSchemaB && pendingSchemaB.slots.top.x === 150, "前置：B schema 待重映射挂起");
    const logLen = (page._setDataLog || []).length;

    measureCbs.shift()(RECT_PX); // 过期 C1（代次 1）此刻才返回
    assert.strictEqual(page.data.layouts.top.x, 150, "过期量测回调不得覆盖较新 B layout");
    assert.strictEqual(page.data.draft.sourceOutfitId, "outfit_B");
    assert.strictEqual(page._pendingSchemaRemap, pendingSchemaB, "过期量测不得消费新代次 pending");
    assert.strictEqual((page._setDataLog || []).length, logLen, "过期量测不得触发任何 setData");
    assert.strictEqual(outfitLayout.CANVAS.width, canvasBefore.width, "过期量测不得写入模块画布宽度");
    assert.strictEqual(outfitLayout.CANVAS.height, canvasBefore.height, "过期量测不得写入模块画布高度");

    measureCbs.shift()(RECT_PX); // 新 C2（代次 2）落地
    assert.strictEqual(page._pendingSchemaRemap, null, "新量测消费 B pending 并完成重映射");
    assert.strictEqual(outfitLayout.CANVAS.width, 400, "只有新量测更新模块画布宽度");
    assert.strictEqual(outfitLayout.CANVAS.height, 300, "只有新量测更新模块画布高度");
    const expectedTopX = 150 * (400 / 360);
    assert(Math.abs(page.data.layouts.top.x - expectedTopX) < 1e-9,
      `新量测按实测画布重映射 B layout（top.x=${page.data.layouts.top.x}，期望≈${expectedTopX}）`);
    delete global.wx;
  }

  // 4b：旧量测回调在新 loadEditor 进行中返回（代次已推进、新 load 尚未落地）——
  // 若未加代次校验，旧 C1 会用旧 schema 重映射覆盖「已就绪画布上的用户调整」。
  {
    state.wardrobe = wardrobeAll;
    const measureCbs = installMeasureRecorder();
    const canvasBefore = { width: outfitLayout.CANVAS.width, height: outfitLayout.CANVAS.height };
    const gates = [];
    fakeAppService.listWardrobeItems = () => new Promise((resolve) => gates.push(resolve));
    state.storedDraft = fullDraft("outfit_A", "topA", savedLayout());
    const page = createPage();
    const firstLoad = page.loadEditor(); // 代次 1
    assert.strictEqual(gates.length, 1);
    gates[0](wardrobeAll);
    await firstLoad; // 就绪 → 注册 C1
    assert.strictEqual(measureCbs.length, 1, "代次 1 完成注册量测回调 C1");
    assert.strictEqual(page._loadToken, 1);

    // 用户就绪后调整画布（模拟拖动落点：top.x +30），该调整属于「较新的画布状态」
    const xEdited = page.data.layouts.top.x + 30;
    page.applyLayout("top", { x: xEdited });
    assert.strictEqual(page.data.layouts.top.x, xEdited, "前置：用户画布调整已生效");

    const secondLoad = page.loadEditor(); // 代次 2 开始（wardrobe 响应挂起）
    assert.strictEqual(gates.length, 2);
    assert.strictEqual(page._loadToken, 2, "代次 2 已取号，C1 此刻已过期");
    const pendingSchemaA = page._pendingSchemaRemap;
    const logLen = (page._setDataLog || []).length;

    measureCbs.shift()(RECT_PX); // 过期 C1 在新 loadEditor 进行中落地
    assert.strictEqual(page.data.layouts.top.x, xEdited, "过期量测不得覆盖用户调整后的 layout");
    assert.strictEqual(page._pendingSchemaRemap, pendingSchemaA, "过期量测不得消费待重映射");
    assert.strictEqual((page._setDataLog || []).length, logLen, "过期量测不得触发 setData");
    assert.strictEqual(outfitLayout.CANVAS.width, canvasBefore.width, "过期量测不得写模块画布宽度");
    assert.strictEqual(outfitLayout.CANVAS.height, canvasBefore.height, "过期量测不得写模块画布高度");

    gates[1](wardrobeAll);
    await secondLoad; // 代次 2（同指纹）完成 → 注册 C2；保留用户布局
    assert.strictEqual(page.data.layouts.top.x, xEdited, "新 load（同指纹）应保留用户布局调整");
    assert.strictEqual(page._pendingSchemaRemap, null, "同指纹 reload 无待重映射");
    assert.strictEqual(measureCbs.length, 1, "代次 2 完成注册其量测回调 C2");
    measureCbs.shift()(RECT_PX); // 新 C2 落地：无 pending 时只更新模块画布尺寸、不动布局
    assert.strictEqual(page.data.layouts.top.x, xEdited, "新量测（无 pending）不得改动保留的布局");
    fakeAppService.listWardrobeItems = async () => state.wardrobe;
    delete global.wx;
  }

  // 4c：同一 load 代次内，量测回调落地前用户编辑布局并持久化 —— 用户布局编辑必须使挂起
  // schema 重映射失效：延迟量测回调不得消费 pending、不得用旧 schema 覆盖编辑后的
  // runtime layout（runtime 与已持久化 draft 不得分叉）；实测画布尺寸仍正常写入。
  // 此前缺陷：回调仅校验 load 代次，同代次内 applyLayout/persistDraft 后回调仍消费旧
  // pending，把用户拖动后的画布覆盖回保存时的 schema 摆放。
  {
    state.wardrobe = wardrobeAll;
    const measureCbs = installMeasureRecorder();
    // 复位模块画布基准为回退值：前置块（4a/4b）的量测把 CANVAS 写成了 400×300，
    // 复位后 schema（canvas 360×300）物化 ratio=1，A 布局 top.x=240 数值可读；
    // 同时让末尾「量测写入 400×300」的断言真正可证（起点确为 360×300）。
    outfitLayout.setCanvasSize(360, 300);
    state.storedDraft = fullDraft("outfit_A", "topA", savedLayout());
    const page = createPage();
    await page.loadEditor(); // 代次 1 → 注册 C1，挂起 A schema 待重映射
    assert.strictEqual(page._loadToken, 1);
    assert.strictEqual(page.data.layouts.top.x, 240, "前置：代次 1 物化 A 布局");
    assert(page._pendingSchemaRemap && page._pendingSchemaRemap.slots.top.x === 240,
      "前置：A schema 待重映射挂起");

    // 同一 load token 内：用户拖动编辑（onLayerTouchMove → applyLayout 等价路径）并持久化
    //（onLayerTouchEnd → persistDraft 等价路径），期间未发生新 loadEditor
    const xEdited = page.data.layouts.top.x + 30;
    page.applyLayout("top", { x: xEdited });
    page.persistDraft({ dirty: true });
    assert.strictEqual(page.data.layouts.top.x, xEdited, "前置：用户画布调整已生效");
    assert.strictEqual(state.storedDraft.layout.slots.top.x, xEdited, "前置：用户编辑已随 draft 持久化");
    assert.strictEqual(page._pendingSchemaRemap, null, "用户布局编辑必须使挂起 schema 重映射失效");
    const logLen = (page._setDataLog || []).length;

    measureCbs.shift()(RECT_PX); // 延迟量测回调此刻才落地（同代次，token 校验可通过）
    assert.strictEqual(page.data.layouts.top.x, xEdited,
      "量测回调不得用旧 schema 覆盖用户编辑后的 runtime layout");
    assert.strictEqual(page._pendingSchemaRemap, null, "已失效的 pending 不得被量测回调复活/消费");
    assert.strictEqual((page._setDataLog || []).length, logLen, "失效后的量测回调不得触发布局 setData");
    assert.strictEqual(outfitLayout.CANVAS.width, 400, "量测仍应正常写入实测画布宽度（clamp 基准）");
    assert.strictEqual(outfitLayout.CANVAS.height, 300, "量测仍应正常写入实测画布高度（clamp 基准）");
    // runtime 与已持久化 draft 保持一致，不分叉
    assert.strictEqual(page.data.draft.layout.slots.top.x, xEdited, "runtime 与已持久化 draft.layout 不得分叉");
    delete global.wx;
  }

  // ---- 5. 最终落盘校验前代次失效：过期代次绝不 persistOutfitDraft，新代次正常落盘 ----
  // loadEditor 在上一次 await 之后是纯同步链（setData → refreshPresentation → 最终落盘
  // 校验），常规测试夹具无法在「最终校验前」自然制造代次失效。本场景用最小、可解释的
  // 实例级 hook（只挂在本测试页面实例上，不改任何生产语义）：在旧代次 refreshPresentation
  // 的时机并发发起一次真实 loadEditor —— 等价于 onShow / 下拉刷新恰在旧 load 的
  // presentation 阶段重入、同步取走新代次。随后按序放行两次 wardrobe 响应：
  //   - 代次 1（A）：其同步链走到最终落盘校验时 token 已失效 → 不得持久化 A；
  //   - 代次 2（B）：正常落地并恰好持久化一次 B 草稿。
  {
    state.wardrobe = wardrobeAll;
    const gates = [];
    fakeAppService.listWardrobeItems = () => new Promise((resolve) => gates.push(resolve));
    state.persistedDrafts.length = 0;
    const page = createPage();
    let hookArmed = true;
    const originalRefreshPresentation = page.refreshPresentation;
    page.refreshPresentation = function hookedRefreshPresentation() {
      originalRefreshPresentation.apply(this, arguments);
      if (!hookArmed) return;
      hookArmed = false;
      this.loadEditor(); // 并发新 load：同步取走新代次后挂起于 wardrobe 请求
    };
    state.storedDraft = fullDraft("outfit_A", "topA", savedLayout());
    const staleLoad = page.loadEditor(); // 代次 1：挂起于 wardrobe 请求
    assert.strictEqual(gates.length, 1, "代次 1 已发出 wardrobe 请求");
    assert.strictEqual(page._loadToken, 1);
    gates[0](wardrobeAll); // 代次 1 响应返回：落地 A，refreshPresentation 期间触发代次 2
    await staleLoad;
    assert.strictEqual(page._loadToken, 2, "新 load 已在最终落盘校验前取走代次");
    assert.strictEqual(gates.length, 2, "代次 2 已发出自己的 wardrobe 请求");
    assert.strictEqual(state.persistedDrafts.length, 0,
      "过期代次（1）到达最终落盘校验时 token 已失效，不得调用 persistOutfitDraft");
    // 代次 1 的 stale 草稿（outfit_A）已被证明不会落盘；换入代次 2 将读取的草稿（outfit_B）并放行
    const schemaB = savedLayout({ x: 150, y: 80, scale: 1.2 });
    state.storedDraft = fullDraft("outfit_B", "topB", schemaB);
    gates[1](wardrobeAll);
    await flush(); // 代次 2 由 hook 同步发起、未被测试 await，排空微任务等待其完成
    const expectedLayoutsB = outfitLayout.materializeLayout(schemaB);
    assert.strictEqual(state.persistedDrafts.length, 1, "新代次（2）应恰好持久化一次草稿");
    assert.strictEqual(state.persistedDrafts[0].sourceOutfitId, "outfit_B");
    assert.strictEqual(state.persistedDrafts[0].slots.top.itemId || state.persistedDrafts[0].slots.top.id, "topB");
    assert.strictEqual(state.persistedDrafts[0].layout.slots.top.x, 150, "新代次持久化 B schema（不得残留旧代次 A 的 x=240）");
    assert.strictEqual(page.data.draft.sourceOutfitId, "outfit_B", "新代次草稿应整体落地");
    assert.strictEqual(page.data.draft.slots.top.itemId || page.data.draft.slots.top.id, "topB");
    assert(Math.abs(page.data.layouts.top.x - expectedLayoutsB.top.x) < 1e-9, "新代次 layout 应按 B schema 物化落地");
    assert(page._pendingSchemaRemap && page._pendingSchemaRemap.slots.top.x === 150, "新代次的 schema 重映射挂起保持完好");
    assert.strictEqual(page.data.state, "ready");
    assert.strictEqual(page._loadToken, 2);
    fakeAppService.listWardrobeItems = async () => state.wardrobe;
  }

  console.log("outfit layout load/save concurrency guard tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
