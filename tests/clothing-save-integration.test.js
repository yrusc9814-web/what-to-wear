const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

const root = path.resolve(__dirname, "..");
const pagePath = path.resolve(root, "miniprogram/pages/item-upload/item-upload.js");

const SOURCE = "cloud://env/wardrobe/user_a/tmp/source_abc.jpg";
const CUTOUT = "cloud://env/wardrobe/user_a/tmp/cutout_abc.png";
const STANDARD = "cloud://env/wardrobe/user_a/tmp/standardized_abc.png";
const FORMAL = "cloud://env/wardrobe/user_a/clothing/abc123def456.png";
const LEGACY_FORMAL = "cloud://env/wardrobe/user_a/legacy_old.jpg";
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]).buffer;

function validForm() {
  return { name: "测试上衣", category: "top", seasons: ["summer"], styles: ["casual"], primaryColor: "blue", thickness: "medium", size: "M", purchasePrice: "99.9", purchaseDate: "2026-01-01", purchaseChannel: "淘宝", aiDescription: "描述", note: "备注" };
}

function loadPage(serviceMock, cloudMock = { canUseCloud: () => true, callFunction: () => Promise.reject(new Error("not implemented")) }) {
  let definition;
  global.Page = (value) => { definition = value; };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "../../services/app-service") return serviceMock;
    if (request === "../../services/cloud") return cloudMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(pagePath)];
  require(pagePath);
  Module._load = originalLoad;
  delete global.Page;
  return definition;
}

function makePage(definition, overrides = {}, wxOverride = {}) {
  global.wx = {
    pageScrollTo() {},
    showToast() {},
    showLoading() {},
    hideLoading() {},
    navigateBack() {},
    showModal() {},
    chooseMedia() {},
    getFileSystemManager: () => ({ readFile({ success }) { success({ data: PNG_HEADER }); } }),
    ...wxOverride
  };
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { this._setDataLog = this._setDataLog || []; this._setDataLog.push(patch); Object.assign(this.data, patch); }
  };
  Object.assign(page.data, overrides);
  return page;
}

// 页面 harness：完整 mock appService 的保存链路
function makeSaveHarness(options = {}) {
  const calls = { promote: [], created: [], cleared: [], registered: [], unregistered: [], setData: [], toasts: [], modals: [], navigatedBack: 0 };
  const serviceMock = {
    persistLocalImage: (value) => Promise.resolve(value),
    uploadImage: () => Promise.resolve({ uploadState: "success", imageUrl: SOURCE, fileId: SOURCE, storage: "cloud" }),
    registerTempImage(id) { if (id) calls.registered.push(id); },
    unregisterTempImage(id) { if (id) calls.unregistered.push(id); },
    clearTempImage(id) { if (id) calls.cleared.push(id); return Promise.resolve(options.clearSucceeds !== false); },
    sweepExpiredTempImages: () => Promise.resolve(0),
    standardizeCutoutImage: () => Promise.resolve({ standardizedTempFileId: STANDARD, width: 20, height: 20, bytes: 100, elapsedMs: 2 }),
    promoteStandardizedClothingAsset: (id) => {
      calls.promote.push(id);
      if (options.promote) return options.promote(id);
      return Promise.resolve({ formalImageFileId: FORMAL, sha256: "abc", width: 20, height: 20, bytes: 100, status: "PROMOTED" });
    },
    createWardrobeItem: (payload) => {
      calls.created.push(payload);
      if (options.create) return options.create(payload);
      return Promise.resolve({ syncStatus: "synced", id: payload.clientRecordId, imageFileId: payload.imageFileId });
    }
  };
  const definition = loadPage(serviceMock);
  const page = makePage(definition, {
    localImagePath: "",
    imageUrl: STANDARD,
    fileId: STANDARD,
    sourceTempFileId: SOURCE,
    cutoutTempFileId: CUTOUT,
    standardizedTempFileId: STANDARD,
    stagingConfirmed: true,
    standardizeState: "success",
    uploadState: "success",
    cutoutState: "success",
    form: validForm(),
    step: 3
  });
  return { page, calls, serviceMock };
}

async function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

async function run() {
  // ---- 1: 未标准化成功不能 save ----
  {
    const h = makeSaveHarness();
    h.page.setData({ standardizeState: "idle", standardizedTempFileId: "" });
    h.calls.promote.length = 0;
    h.calls.created.length = 0;
    await h.page.saveItem();
    assert.strictEqual(h.calls.promote.length, 0, "未标准化成功不得触发 promotion");
    assert.strictEqual(h.calls.created.length, 0, "未标准化成功不得调用 createWardrobeItem");
    assert.strictEqual(h.page.data.saving, false);
  }

  // ---- 2: validate 先于 promotion ----
  {
    const h = makeSaveHarness();
    h.page.setData({ form: { ...h.page.data.form, name: "" } });
    h.calls.promote.length = 0;
    h.calls.created.length = 0;
    await h.page.saveItem();
    assert.strictEqual(h.calls.promote.length, 0, "表单校验失败不得触发 promotion");
    assert.strictEqual(h.calls.created.length, 0);
    assert.strictEqual(h.page.data.saving, false);
  }

  // ---- 3: save 才会调用 promotion（confirm 不触发 promote） ----
  {
    const h = makeSaveHarness();
    await h.page.confirmCutout();
    assert.strictEqual(h.calls.promote.length, 0, "confirmCutout 不得触发 promotion");
    h.calls.promote.length = 0;
    await h.page.saveItem();
    assert.strictEqual(h.calls.promote.length, 1, "saveItem 必须触发 promotion");
    assert.strictEqual(h.calls.promote[0], STANDARD);
    assert.strictEqual(h.calls.created.length, 1, "save 必须调用 createWardrobeItem");
  }

  // ---- 4-7: promotion 只接受 standardized temp（页面级：只把 standardized 传给 promote） ----
  {
    const h = makeSaveHarness();
    await h.page.saveItem();
    assert.strictEqual(h.calls.promote[0], STANDARD, "promotion 入参必须是 standardized temp");
    assert(h.calls.promote[0].includes("/tmp/standardized_"), "promotion 入参必须含 standardized 标记");
  }

  // ---- 15/16: save payload 只引用 formal，无 tmp ----
  {
    const h = makeSaveHarness();
    await h.page.saveItem();
    const payload = h.calls.created[0];
    assert.strictEqual(payload.imageFileId, FORMAL, "imageFileId 必须是 formal");
    assert.strictEqual(payload.imageUrl, FORMAL, "imageUrl 必须是 formal");
    assert.strictEqual(payload.fileId, FORMAL, "fileId 必须是 formal");
    const serialized = JSON.stringify(payload);
    assert(!serialized.includes("/tmp/"), "save payload 不得包含任何 tmp 引用");
    assert(!serialized.includes(STANDARD), "save payload 不得包含 standardized temp");
    assert(!serialized.includes(CUTOUT), "save payload 不得包含 cutout temp");
    assert(!serialized.includes(SOURCE), "save payload 不得包含 source temp");
  }

  // ---- 14: formal 不进 temp registry（页面不 registerTempImage(formal)） ----
  {
    const h = makeSaveHarness();
    h.calls.registered.length = 0;
    await h.page.saveItem();
    assert(!h.calls.registered.includes(FORMAL), "formal 不得登记进 temp registry");
    assert(!h.calls.unregistered.includes(FORMAL), "formal 不得从 temp registry 移除（未登记过）");
  }

  // ---- 17/18: createWardrobeItem 接受稳定 clientRecordId + 本地幂等（同 payload） ----
  {
    const storage = new Map();
    let requestLog = [];
    global.getApp = () => ({ globalData: { userScope: "user_a" } });
    global.wx = {
      getStorageSync: (key) => storage.has(key) ? storage.get(key) : "",
      setStorageSync: (key, value) => storage.set(key, JSON.parse(JSON.stringify(value))),
      removeStorageSync: (key) => storage.delete(key),
      cloud: {
        callFunction: ({ name, data }) => {
          requestLog.push({ name, data });
          if (name === "saveClothing") {
            // 云端保存失败，任务保留在 outbox（验证 outbox 去重）
            return Promise.resolve({ result: { ok: false, errorCode: "CLOUD_DOWN", errorMessage: "down" } });
          }
          return Promise.reject(new Error("unexpected function " + name));
        }
      }
    };
    const appService = require("../miniprogram/services/app-service");
    const payload = {
      clientRecordId: "item_stable_1",
      imageFileId: FORMAL,
      imageUrl: FORMAL,
      fileId: FORMAL,
      name: "稳定单品",
      category: "top",
      seasons: ["summer"],
      styles: ["casual"]
    };
    const first = await appService.createWardrobeItem(payload);
    assert.strictEqual(first.id, "item_stable_1", "id 必须使用稳定 clientRecordId");
    assert.strictEqual(first.imageFileId, FORMAL);
    // 记录数唯一
    const wardrobe = storage.get("xiaoyichu_v14_wardrobe:user_a") || [];
    assert.strictEqual(wardrobe.filter((item) => item.id === "item_stable_1").length, 1, "本地 wardrobe 不得重复");
    // outbox 有一条 create
    const outbox = (storage.get("xiaoyichu_v14_sync_outbox:user_a") || {}).tasks || [];
    const createTasks = outbox.filter((task) => task.entityKey === "wardrobe:item_stable_1" && task.operation === "create");
    assert.strictEqual(createTasks.length, 1, "outbox 只有一条 create task");

    // 同 clientRecordId 同 payload 再次调用 → 本地幂等
    requestLog = [];
    const beforeTasks = ((storage.get("xiaoyichu_v14_sync_outbox:user_a") || {}).tasks || []).length;
    const second = await appService.createWardrobeItem(payload);
    assert.strictEqual(second.id, "item_stable_1");
    const wardrobe2 = storage.get("xiaoyichu_v14_wardrobe:user_a") || [];
    assert.strictEqual(wardrobe2.filter((item) => item.id === "item_stable_1").length, 1, "幂等保存不得新增本地记录");
    const outbox2 = (storage.get("xiaoyichu_v14_sync_outbox:user_a") || {}).tasks || [];
    const createTasks2 = outbox2.filter((task) => task.entityKey === "wardrobe:item_stable_1" && task.operation === "create");
    assert.strictEqual(createTasks2.length, 1, "幂等保存不得追加 outbox create task");
    assert.strictEqual(outbox2.length, beforeTasks, "幂等保存 outbox 长度不变");

    // 同 id 不同 payload → CLIENT_RECORD_ID_CONFLICT
    await assert.rejects(
      () => appService.createWardrobeItem({ ...payload, name: "完全不同的名字" }),
      (error) => error && error.code === "CLIENT_RECORD_ID_CONFLICT"
    );
    // 清理全局
    delete global.wx;
    delete global.getApp;
  }

  // ---- 36/37/38: synced / pending / failed UI 提示 ----
  {
    // synced → 保存成功
    {
      const h = makeSaveHarness();
      await h.page.saveItem();
      assert.strictEqual(h.calls.navigatedBack, 0, "synced 用 toast+延迟导航");
      assert.strictEqual(h.page.data.saving, false);
    }
    // pending/failed → 已保存到本机 modal
    {
      const h = makeSaveHarness({
        create: () => Promise.resolve({ syncStatus: "pending", id: "item_pending", imageFileId: FORMAL })
      });
      await h.page.saveItem();
      assert.strictEqual(h.page.data.saving, false);
    }
    {
      const h = makeSaveHarness({
        create: () => Promise.resolve({ syncStatus: "failed", id: "item_failed", imageFileId: FORMAL })
      });
      await h.page.saveItem();
      assert.strictEqual(h.page.data.saving, false);
    }
  }

  // ---- 24/25: promotion fail 不创建 Clothing，staging 保留 ----
  {
    const h = makeSaveHarness({
      promote: () => Promise.reject(Object.assign(new Error("promotion failed"), { code: "PROMOTE_FAILED" }))
    });
    await h.page.saveItem();
    assert.strictEqual(h.calls.created.length, 0, "promotion fail 不得创建 Clothing");
    assert.strictEqual(h.page.data.standardizedTempFileId, STANDARD, "promotion fail staging 保留");
    assert.strictEqual(h.page.data.saving, false, "promotion fail 释放锁");
    assert.strictEqual(h.page.data.stagingConfirmed, true, "promotion fail 停留在本页");
  }

  // ---- 26: create fail staging 保留 ----
  {
    const h = makeSaveHarness({
      create: () => Promise.reject(new Error("create failed"))
    });
    await h.page.saveItem();
    assert.strictEqual(h.page.data.standardizedTempFileId, STANDARD, "create fail staging 保留");
    assert.strictEqual(h.page.data.saving, false);
  }

  // ---- 27/28: create fail retry 复用 formal + clientRecordId ----
  {
    let createAttempt = 0;
    const h = makeSaveHarness({
      create: (payload) => {
        createAttempt += 1;
        if (createAttempt === 1) return Promise.reject(new Error("create failed"));
        return Promise.resolve({ syncStatus: "synced", id: payload.clientRecordId, imageFileId: payload.imageFileId });
      }
    });
    await h.page.saveItem();
    assert.strictEqual(createAttempt, 1);
    assert.strictEqual(h.calls.promote.length, 1, "第一次 promote 调用一次");
    await h.page.saveItem();
    assert.strictEqual(createAttempt, 2);
    assert.strictEqual(h.calls.promote.length, 1, "重试必须复用已 promoted 的 formal，不重复 promote");
    const firstPayload = h.calls.created[0];
    const secondPayload = h.calls.created[1];
    assert.strictEqual(firstPayload.clientRecordId, secondPayload.clientRecordId, "重试复用 clientRecordId");
    assert.strictEqual(firstPayload.imageFileId, secondPayload.imageFileId, "重试复用 formal");
  }

  // ---- 23: 双击 save 只一次有效 commit ----
  {
    let createCalls = 0;
    const h = makeSaveHarness({
      create: (payload) => {
        createCalls += 1;
        return Promise.resolve({ syncStatus: "synced", id: payload.clientRecordId, imageFileId: payload.imageFileId });
      }
    });
    const first = h.page.saveItem();
    const second = h.page.saveItem();
    await Promise.all([first, second]);
    assert.strictEqual(createCalls, 1, "双击 save 只 commit 一次");
    assert.strictEqual(h.calls.promote.length, 1, "双击 save 只 promote 一次");
    assert.strictEqual(h.page.data.saving, false);
  }

  // ---- 29/30/31/32: save success → cleanup 三 temp；cleanup fail Clothing 仍成功；formal 不被 cleanup ----
  {
    const h = makeSaveHarness({ clearSucceeds: true });
    await h.page.saveItem();
    assert(h.calls.cleared.includes(SOURCE), "成功后必须清理 source temp");
    assert(h.calls.cleared.includes(CUTOUT), "成功后必须清理 cutout temp");
    assert(h.calls.cleared.includes(STANDARD), "成功后必须清理 standardized temp");
    assert(!h.calls.cleared.includes(FORMAL), "formal 不得被 cleanup");
    assert(h.calls.created.length === 1, "cleanup 完成 Clothing 仍成功");
  }
  {
    // cleanup fail 不回滚 Clothing
    const h = makeSaveHarness({ clearSucceeds: false });
    await h.page.saveItem();
    assert.strictEqual(h.calls.created.length, 1, "cleanup fail Clothing 仍成功");
    assert.strictEqual(h.page.data.saving, false);
  }

  // ---- 31: cleanup fail → registry 保留待 TTL（服务层验证 clearTempImage 失败保留登记） ----
  {
    const storage = new Map();
    global.getApp = () => ({ globalData: { userScope: "user_a" } });
    global.wx = {
      getStorageSync: (key) => storage.has(key) ? storage.get(key) : "",
      setStorageSync: (key, value) => storage.set(key, JSON.parse(JSON.stringify(value))),
      removeStorageSync: (key) => storage.delete(key),
      saveFile: ({ tempFilePath, success }) => success({ savedFilePath: `wxfile://saved/${tempFilePath}` }),
      cloud: {
        callFunction: () => Promise.resolve({ result: { ok: true, data: {} } }),
        uploadFile: () => Promise.resolve({ fileID: "cloud://env/wardrobe/user_a/tmp/test.png" }),
        deleteFile: () => Promise.reject(new Error("permission denied"))
      }
    };
    const appService = require("../miniprogram/services/app-service");
    const id = "cloud://env/wardrobe/user_a/tmp/std_1.png";
    appService.registerTempImage(id);
    const registryKey = `${appService.STORAGE.tempImages}:user_a`;
    assert((storage.get(registryKey) || []).some((entry) => entry.fileId === id), "登记必须存在");
    const deleted = await appService.clearTempImage(id);
    assert.strictEqual(deleted, false, "删除失败返回 false");
    assert((storage.get(registryKey) || []).some((entry) => entry.fileId === id), "删除失败登记保留待 TTL");
    delete global.wx;
    delete global.getApp;
  }

  // ---- 33/34/35: source/cutout/standardized 永远不成为正式 image ----
  {
    const h = makeSaveHarness();
    await h.page.saveItem();
    const payload = h.calls.created[0];
    assert.notStrictEqual(payload.imageFileId, SOURCE, "source 永远不成为正式 image");
    assert.notStrictEqual(payload.imageFileId, CUTOUT, "cutout 永远不成为正式 image");
    assert.notStrictEqual(payload.imageFileId, STANDARD, "standardized temp 永远不成为正式 image");
  }

  // ---- 39/40/41: saving 时 rechoose/chooseImage/cancel 被拒 ----
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = makeSaveHarness({
      create: (payload) => gate.then(() => ({ syncStatus: "synced", id: payload.clientRecordId, imageFileId: payload.imageFileId }))
    });
    const modals = [];
    const originalShowModal = global.wx.showModal;
    global.wx.showModal = (opts) => { modals.push(opts && opts.title); };
    const savePromise = h.page.saveItem();
    await flush();
    // rechoose / chooseImage / cancel 在保存中
    h.page.rechooseImage();
    h.page.chooseImage(["album"]);
    h.page.cancel();
    global.wx.showModal = originalShowModal;
    assert(modals.some((title) => title === "正在保存"), "保存中必须弹出正在保存提示");
    assert(h.page.data.standardizedTempFileId === STANDARD, "保存中 staging 不得被清");
    release();
    await savePromise;
  }

  // ---- 42/43/44: onUnload during save 不提前删 staging；unloaded 后成功仍 cleanup ids；不 setData/navigate ----
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = makeSaveHarness({
      create: (payload) => gate.then(() => ({ syncStatus: "synced", id: payload.clientRecordId, imageFileId: payload.imageFileId }))
    });
    const savePromise = h.page.saveItem();
    await flush();
    const clearedBefore = h.calls.cleared.slice();
    h.page.onUnload();
    assert(h.page._unloaded === true, "保存中 onUnload 必须标记 _unloaded");
    assert.deepStrictEqual(h.calls.cleared, clearedBefore, "保存中 onUnload 不得提前删 staging");
    assert.strictEqual(h.page.data.standardizedTempFileId, STANDARD, "保存中 onUnload 不得清 staging");
    const setDataCount = h.calls.setData.length;
    release();
    await savePromise;
    // 成功后仍 cleanup captured ids
    assert(h.calls.cleared.includes(SOURCE) && h.calls.cleared.includes(CUTOUT) && h.calls.cleared.includes(STANDARD), "unloaded 后成功仍 cleanup captured ids");
    assert.strictEqual(h.calls.setData.length, setDataCount, "unloaded 后不得 setData");
  }

  // ---- 45: 新 standardized 后旧 save intent/cache 清空 ----
  {
    const h = makeSaveHarness();
    await h.page.saveItem();
    assert(h.page._promotedAsset && h.page._promotedAsset.standardizedTempFileId === STANDARD, "保存后有 promoted cache");
    assert(h.page._saveClientRecordId, "保存后有 clientRecordId cache");
    // 重新选择（新 staging）
    h.page.rechooseImage();
    assert.strictEqual(h.page._promotedAsset, null, "新 staging 后旧 promoted cache 清空");
    assert.strictEqual(h.page._saveClientRecordId, null, "新 staging 后旧 clientRecordId 清空");
  }

  // ---- 46: legacy formal 仍可 update（服务层 isFormalClothingCloudFileId 允许非 tmp 旧路径） ----
  {
    const cloudbasePath = path.resolve(root, "cloudfunctions/shared/cloudbase.js");
    delete require.cache[cloudbasePath];
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
      if (request === "wx-server-sdk") return { DYNAMIC_CURRENT_ENV: "test", init() {}, getWXContext() { return { OPENID: "user_a" }; } };
      if (request === "@cloudbase/node-sdk") return { SYMBOL_CURRENT_ENV: "test", SYMBOL_DEFAULT_ENV: "test", init() { return { database() { return {}; } }; } };
      return originalLoad.call(this, request, parent, isMain);
    };
    let isFormalClothingCloudFileId;
    try {
      isFormalClothingCloudFileId = require(cloudbasePath).isFormalClothingCloudFileId;
    } finally {
      Module._load = originalLoad;
    }
    assert.strictEqual(isFormalClothingCloudFileId(LEGACY_FORMAL, "user_a"), true, "legacy 非 tmp 路径必须视为正式");
    assert.strictEqual(isFormalClothingCloudFileId(STANDARD, "user_a"), false, "tmp 必须视为非正式");
    assert.strictEqual(isFormalClothingCloudFileId(FORMAL, "user_a"), true, "clothing 路径必须视为正式");
  }

  // ---- 服务端边界 + 幂等（22/47/48/49/50） ----
  {
    const fake = createFakeCloud({ clothing_items: [] }, "user_123");
    // 预置正式文件 + tmp/references 文件的可访问性（existence 校验通过与否由 fake 决定）
    fake.registerCloudFile(`cloud://env.bucket/wardrobe/user_123/clothing/formal1.png`);
    fake.registerCloudFile(`cloud://env.bucket/wardrobe/user_123/tmp/standardized_x.png`);
    fake.registerCloudFile(`cloud://env.bucket/wardrobe/user_123/tmp/source_y.jpg`);
    fake.registerCloudFile(`cloud://env.bucket/wardrobe/user_123/tmp/cutout_z.png`);
    fake.registerCloudFile(`cloud://env.bucket/wardrobe/user_123/references/ref.png`);
    fake.registerCloudFile(`cloud://env.bucket/wardrobe/user_123/legacy_old.jpg`);

    function loadCloudFunction(relativePath) {
      const filename = path.resolve(root, relativePath);
      delete require.cache[filename];
      const originalLoad = Module._load;
      Module._load = function load(request, parent, isMain) {
        if (request === "wx-server-sdk") return fake.cloud;
        if (request === "@cloudbase/node-sdk") return fake.cloudbase;
        return originalLoad.call(this, request, parent, isMain);
      };
      try {
        return require(filename);
      } finally {
        Module._load = originalLoad;
      }
    }
    const saveClothing = loadCloudFunction("cloudfunctions/saveClothing/index.js");
    const updateClothing = loadCloudFunction("cloudfunctions/updateClothing/index.js");
    const deleteClothing = loadCloudFunction("cloudfunctions/deleteClothing/index.js");

    const baseEvent = {
      clientRecordId: "client_server_1",
      mutationVersion: 1,
      type: "top",
      category: "top",
      name: "服务端上衣",
      seasons: ["summer"],
      styles: ["casual"]
    };

    // 47: saveClothing 拒绝 tmp
    for (const tmpId of [
      `cloud://env.bucket/wardrobe/user_123/tmp/standardized_x.png`,
      `cloud://env.bucket/wardrobe/user_123/tmp/source_y.jpg`,
      `cloud://env.bucket/wardrobe/user_123/tmp/cutout_z.png`
    ]) {
      const result = await saveClothing.main({ ...baseEvent, imageFileId: tmpId });
      assert.strictEqual(result.ok, false, `saveClothing 必须拒绝 tmp: ${tmpId}`);
      assert.strictEqual(result.errorCode, "IMAGE_FILE_INVALID");
    }
    // 49: saveClothing 拒绝 references
    {
      const result = await saveClothing.main({ ...baseEvent, imageFileId: `cloud://env.bucket/wardrobe/user_123/references/ref.png` });
      assert.strictEqual(result.ok, false, "saveClothing 必须拒绝 references");
      assert.strictEqual(result.errorCode, "IMAGE_FILE_INVALID");
    }

    // 48: updateClothing 拒绝 tmp（对存在的记录，需先创建）
    {
      const created = await saveClothing.main({ ...baseEvent, imageFileId: `cloud://env.bucket/wardrobe/user_123/clothing/formal1.png` });
      assert.strictEqual(created.ok, true, "saveClothing 正式文件必须通过");
      const createdId = created.data._id || created.data.id;
      const updateTmp = await updateClothing.main({
        id: createdId,
        clientRecordId: "client_server_1",
        mutationVersion: 2,
        type: "top",
        category: "top",
        name: "更新",
        imageFileId: `cloud://env.bucket/wardrobe/user_123/tmp/standardized_x.png`,
        seasons: ["summer"],
        styles: ["casual"]
      });
      assert.strictEqual(updateTmp.ok, false, "updateClothing 必须拒绝 tmp");
      assert.strictEqual(updateTmp.errorCode, "IMAGE_FILE_INVALID");
      // updateClothing 拒绝 references
      const updateRef = await updateClothing.main({
        id: createdId,
        clientRecordId: "client_server_1",
        mutationVersion: 3,
        type: "top",
        category: "top",
        name: "更新",
        imageFileId: `cloud://env.bucket/wardrobe/user_123/references/ref.png`,
        seasons: ["summer"],
        styles: ["casual"]
      });
      assert.strictEqual(updateRef.ok, false, "updateClothing 必须拒绝 references");
    }

    // 50: formal image 可通过真实 existence 校验（saveClothing 正式文件成功）
    {
      const formalEvent = { ...baseEvent, clientRecordId: "client_formal_ok", imageFileId: `cloud://env.bucket/wardrobe/user_123/clothing/formal1.png` };
      const result = await saveClothing.main(formalEvent);
      assert.strictEqual(result.ok, true, "formal image 必须通过真实 existence 校验");
    }

    // 22: saveClothing retry 同 mutation → IDEMPOTENT
    {
      const retryEvent = { ...baseEvent, clientRecordId: "client_idem", imageFileId: `cloud://env.bucket/wardrobe/user_123/clothing/formal1.png` };
      const first = await saveClothing.main(retryEvent);
      const second = await saveClothing.main(retryEvent);
      assert.strictEqual(first.ok, true);
      assert.strictEqual(second.ok, true);
      assert.strictEqual(second.data.mutationStatus, "IDEMPOTENT");
      assert.strictEqual(fake.collections.clothing_items.filter((item) => item.clientRecordId === "client_idem").length, 1, "retry 不得产生重复记录");
    }

    // legacy 非 tmp 旧文件仍可保存（46 服务端验证）
    {
      const legacyEvent = { ...baseEvent, clientRecordId: "client_legacy", imageFileId: `cloud://env.bucket/wardrobe/user_123/legacy_old.jpg` };
      const result = await saveClothing.main(legacyEvent);
      assert.strictEqual(result.ok, true, "legacy 非 tmp 旧路径必须仍可保存");
    }
  }

  // ---- Round 2A-4：legacy 保存必须占用 _saveInFlight，choose/rechoose/cancel/onUnload 不得改 staging ----
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const definition = loadPage({
      persistLocalImage: (value) => Promise.resolve(value),
      uploadImage: () => Promise.resolve({ uploadState: "success", imageUrl: LEGACY_FORMAL, fileId: LEGACY_FORMAL, storage: "cloud" }),
      registerTempImage() {},
      unregisterTempImage() {},
      clearTempImage() { return Promise.resolve(true); },
      sweepExpiredTempImages: () => Promise.resolve(0),
      createWardrobeItem: (payload) => gate.then(() => ({ syncStatus: "synced", id: payload.clientRecordId || "legacy_item", imageFileId: payload.imageFileId }))
    });
    const page = makePage(definition, {
      localImagePath: "wxfile://tmp/legacy.jpg",
      imageUrl: LEGACY_FORMAL,
      fileId: LEGACY_FORMAL,
      sourceTempFileId: "",
      cutoutTempFileId: "",
      standardizedTempFileId: "",
      stagingConfirmed: false,
      form: validForm(),
      step: 3
    });
    const modals = [];
    const originalShowModal = global.wx.showModal;
    global.wx.showModal = (opts) => { modals.push(opts && opts.title); };
    const savePromise = page.saveItem();
    await flush();
    assert.strictEqual(Boolean(page._saveInFlight), true, "legacy 保存必须占用 _saveInFlight");
    page.rechooseImage();
    page.chooseImage(["album"]);
    page.cancel();
    global.wx.showModal = originalShowModal;
    assert(modals.some((title) => title === "正在保存"), "legacy 保存中必须弹出正在保存提示");
    assert.strictEqual(page.data.fileId, LEGACY_FORMAL, "legacy 保存中不得清 fileId");
    const clearedBeforeUnload = (page._setDataLog || []).length;
    page.onUnload();
    assert.strictEqual(page._unloaded, true, "legacy 保存中 onUnload 必须标记 _unloaded");
    assert.strictEqual((page._setDataLog || []).length, clearedBeforeUnload, "legacy 保存中 onUnload 不得清 staging");
    release();
    await savePromise;
  }

  console.log("clothing save integration tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});