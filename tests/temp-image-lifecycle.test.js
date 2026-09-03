const assert = require("assert");

const storage = new Map();
const uploads = [];
const deletedFiles = [];
let uploadImpl = null;
let deleteImpl = null;

global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); },
  saveFile({ tempFilePath, success }) {
    success({ savedFilePath: `wxfile://saved/${String(tempFilePath).split("/").pop()}` });
  },
  cloud: {
    callFunction() { return Promise.resolve({ result: { ok: true, data: {} } }); },
    uploadFile({ cloudPath, filePath }) {
      uploads.push({ cloudPath, filePath });
      if (uploadImpl) return uploadImpl(cloudPath);
      return Promise.resolve({ fileID: `cloud://env/${cloudPath}` });
    },
    deleteFile({ fileList }) {
      const ids = (fileList || []).map(String);
      deletedFiles.push(...ids);
      if (deleteImpl) return deleteImpl(ids);
      return Promise.resolve({ fileList: ids.map((fileID) => ({ fileID, status: 0 })) });
    }
  }
};
global.getApp = () => ({ globalData: { userScope: "user_a" } });

const service = require("../miniprogram/services/app-service");

function registry(scope = "user_a") {
  return storage.get(`${service.STORAGE.tempImages}:${scope}`) || [];
}

async function run() {
  // ---- 1. temp / clothing / reference 路径生成 + temp 自动登记 ----
  const temp = await service.uploadImage("wxfile://tmp/a.jpg", undefined, undefined, "temp");
  assert.strictEqual(temp.uploadState, "success");
  assert(/^cloud:\/\/env\/wardrobe\/user_a\/tmp\/\d+_[0-9a-f]+\.jpg$/.test(temp.fileId), "temp 上传 cloudPath 必须落在 wardrobe/{scope}/tmp/");
  assert(/^wardrobe\/user_a\/tmp\/\d+_[0-9a-f]+\.jpg$/.test(uploads[0].cloudPath));
  assert(registry().some((entry) => entry.fileId === temp.fileId), "temp 上传成功后必须登记到当前 scope 的注册表");

  const clothing = await service.uploadImage("wxfile://tmp/b.jpg");
  assert.strictEqual(clothing.uploadState, "success");
  assert(/^wardrobe\/user_a\/\d+_[0-9a-f]+\.jpg$/.test(uploads[1].cloudPath), "默认用途必须保持原 wardrobe 路径风格");
  assert(!uploads[1].cloudPath.includes("/tmp/"));

  const clothingExplicit = await service.uploadImage("wxfile://tmp/c.jpg", undefined, undefined, "clothing");
  assert(/^wardrobe\/user_a\/\d+_[0-9a-f]+\.jpg$/.test(uploads[2].cloudPath));

  const reference = await service.uploadImage("wxfile://tmp/d.jpg", undefined, undefined, "reference");
  assert(/^wardrobe\/user_a\/references\/\d+_[0-9a-f]+\.jpg$/.test(uploads[3].cloudPath), "reference 必须落在 wardrobe/{scope}/references/ 前缀内以通过云校验");
  assert.strictEqual(reference.uploadState, "success");

  // ---- 2. clearTempImage 删除云文件并注销登记 ----
  const clearTarget = await service.uploadImage("wxfile://tmp/clear_target.jpg", undefined, undefined, "temp");
  await service.clearTempImage(clearTarget.fileId);
  assert(deletedFiles.includes(clearTarget.fileId), "clearTempImage 必须调用 wx.cloud.deleteFile");
  assert(!registry().some((entry) => entry.fileId === clearTarget.fileId), "删除成功后必须注销登记");
  assert(!registry().some((entry) => entry.fileId === clothing.fileId), "clothing 正式上传不得登记为 temp");

  // ---- 3. 删除失败只记录不抛错，登记保留以便重试 ----
  const orphan = await service.uploadImage("wxfile://tmp/e.jpg", undefined, undefined, "temp");
  deleteImpl = () => Promise.reject(new Error("permission denied"));
  const cleared = await service.clearTempImage(orphan.fileId);
  assert.strictEqual(cleared, false, "删除失败不应抛错");
  assert(registry().some((entry) => entry.fileId === orphan.fileId), "删除失败后登记表应保留条目");
  deleteImpl = null;

  // ---- 4. TTL=24h 清扫 ----
  const oldFile = await service.uploadImage("wxfile://tmp/f.jpg", undefined, undefined, "temp");
  const recent = await service.uploadImage("wxfile://tmp/g.jpg", undefined, undefined, "temp");
  const later = Date.now() + 25 * 60 * 60 * 1000;
  const entriesBeforeSweep = registry().length;
  assert(entriesBeforeSweep >= 2, "清扫前登记表应包含此前的 temp 条目");
  deleteImpl = (ids) => Promise.resolve({ fileList: ids.map((fileID) => ({ fileID, status: 0 })) });
  const swept = await service.sweepExpiredTempImages(later);
  assert.strictEqual(swept, entriesBeforeSweep, "超过 24 小时的 temp 应全部被清扫");
  assert(deletedFiles.includes(oldFile.fileId));
  assert(deletedFiles.includes(recent.fileId));
  assert.strictEqual(registry().length, 0, "清扫成功后登记表应清空");

  const fresh = await service.uploadImage("wxfile://tmp/h.jpg", undefined, undefined, "temp");
  const sweptFresh = await service.sweepExpiredTempImages(Date.now() + 60 * 60 * 1000);
  assert.strictEqual(sweptFresh, 0, "未满 24 小时的 temp 不应被清扫");
  assert(registry().some((entry) => entry.fileId === fresh.fileId));

  // 清扫时删除失败不阻塞主流程
  deleteImpl = () => Promise.reject(new Error("denied"));
  const sweptFailed = await service.sweepExpiredTempImages(Date.now() + 25 * 60 * 60 * 1000);
  assert.strictEqual(sweptFailed, 1, "清扫遇到删除失败也要返回统计且不抛错");
  assert(registry().some((entry) => entry.fileId === fresh.fileId), "清扫删除失败应保留条目等待重试");
  deleteImpl = null;

  // ---- 5. 登记表跨用户隔离 ----
  const crossA = await service.uploadImage("wxfile://tmp/cross_a.jpg", undefined, undefined, "temp");
  global.getApp = () => ({ globalData: { userScope: "user_b" } });
  const crossB = await service.uploadImage("wxfile://tmp/cross_b.jpg", undefined, undefined, "temp");
  assert(registry("user_a").some((entry) => entry.fileId === crossA.fileId), "user_a 条目应落在自己的 scoped key");
  assert(registry("user_b").some((entry) => entry.fileId === crossB.fileId), "user_b 条目应落在自己的 scoped key");
  assert(!registry("user_a").some((entry) => entry.fileId === crossB.fileId), "不得跨 scope 混入登记表");
  assert(!registry("user_b").some((entry) => entry.fileId === crossA.fileId));

  // user_b 不能删除 user_a 的 temp
  deletedFiles.length = 0;
  const clearCross = await service.clearTempImage(crossA.fileId);
  assert.strictEqual(clearCross, false, "他人 temp 不应被删除");
  assert(!deletedFiles.includes(crossA.fileId), "clearTempImage 不得删除他人文件");
  assert(registry("user_a").some((entry) => entry.fileId === crossA.fileId), "他人登记条目不得被注销");

  // sweep 只清当前 scope（user_b）
  const sweptB = await service.sweepExpiredTempImages(Date.now() + 25 * 60 * 60 * 1000);
  assert.strictEqual(sweptB, 1, "仅清扫当前 scope 的过期条目");
  assert(!deletedFiles.includes(crossA.fileId), "清扫不得触碰他人文件");
  assert(registry("user_a").some((entry) => entry.fileId === crossA.fileId), "他人登记表不得被动");
  assert.strictEqual(registry("user_b").length, 0);

  console.log("temp image lifecycle service tests passed");

  // ===================== 页面级测试 =====================
  const Module = require("module");

  function createDeferredService() {
    const pending = [];
    const calls = { clearTemp: [], unregistered: [], purposes: [], created: [] };
    const serviceMock = {
      persistLocalImage(path) { return Promise.resolve(path); },
      uploadImage(path, scope, guard, purpose) {
        calls.purposes.push(purpose || "clothing");
        const entry = { path, purpose, resolve: null, fileId: `cloud://env/wardrobe/user_a/tmp/p${pending.length}.jpg` };
        entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
        pending.push(entry);
        return entry.promise;
      },
      clearTempImage(fileId) { if (fileId) calls.clearTemp.push(fileId); return Promise.resolve(true); },
      unregisterTempImage(fileId) { if (fileId) calls.unregistered.push(fileId); },
      sweepExpiredTempImages() { return Promise.resolve(0); },
      createWardrobeItem(payload) { calls.created.push(payload); return Promise.resolve({ syncStatus: "synced", id: "item_1" }); },
      updateWardrobeItem(payload) { calls.created.push(payload); return Promise.resolve({ syncStatus: "synced", id: "item_1" }); }
    };
    return { pending, calls, serviceMock };
  }

  function loadPage(pagePath, serviceMock) {
    let definition;
    global.Page = (value) => { definition = value; };
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
      if (request === "../../services/app-service") return serviceMock;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(pagePath)];
    require(pagePath);
    Module._load = originalLoad;
    delete global.Page;
    return definition;
  }

  // ---- 6. 快速重选竞态：A 上传中选 B，最终 UI/temp 必须是 B ----
  {
    const { pending, calls, serviceMock } = createDeferredService();
    const definition = loadPage("../miniprogram/pages/item-upload/item-upload", serviceMock);
    global.wx = { showLoading() {}, hideLoading() {}, showToast() {}, showModal() {}, navigateBack() {}, pageScrollTo() {} };
    const page = {
      ...definition,
      data: { ...definition.data, localImagePath: "wxfile://store/a.jpg", sourceTempFileId: "" },
      setData(patch) { Object.assign(this.data, patch); }
    };
    const promiseA = page.uploadTempImage();
    // 模拟选择 B
    page._imageGeneration = (page._imageGeneration || 0) + 1;
    page.setData({ localImagePath: "wxfile://store/b.jpg", imageUrl: "", fileId: "", uploadState: "idle", step: 1 });
    const promiseB = page.uploadTempImage();
    assert.strictEqual(pending.length, 2, "A 上传中选 B 必须发起新的上传");
    // A 先完成（过期结果）
    pending[0].resolve({ uploadState: "success", imageUrl: pending[0].fileId, fileId: pending[0].fileId });
    await promiseA;
    assert.strictEqual(page.data.sourceTempFileId, "", "A 的过期结果不得写回 UI");
    assert(calls.clearTemp.includes(pending[0].fileId), "过期 A 的临时云图必须回收");
    // B 后完成
    pending[1].resolve({ uploadState: "success", imageUrl: pending[1].fileId, fileId: pending[1].fileId });
    await promiseB;
    assert.strictEqual(page.data.sourceTempFileId, pending[1].fileId, "最终 temp 必须是 B");
    assert.strictEqual(page.data.imageUrl, pending[1].fileId, "最终 UI 图片必须是 B");
    assert.strictEqual(page.data.uploadState, "success");
  }

  // item-edit 同样竞态修复
  {
    const d = createDeferredService();
    const definition = loadPage("../miniprogram/pages/item-edit/item-edit", d.serviceMock);
    const page = {
      ...definition,
      data: { ...definition.data, imageUrl: "wxfile://store/a.jpg", imageChanged: true, tempFileId: "" },
      setData(patch) { Object.assign(this.data, patch); }
    };
    const promiseA = page.uploadTempImage();
    page._imageGeneration = (page._imageGeneration || 0) + 1;
    page.setData({ imageUrl: "wxfile://store/b.jpg", fileId: "", imageChanged: true, tempFileId: "" });
    const promiseB = page.uploadTempImage();
    d.pending[0].resolve({ uploadState: "success", imageUrl: d.pending[0].fileId, fileId: d.pending[0].fileId });
    await promiseA;
    assert.strictEqual(page.data.tempFileId, "", "item-edit A 过期结果不得写回");
    assert(d.calls.clearTemp.includes(d.pending[0].fileId));
    d.pending[1].resolve({ uploadState: "success", imageUrl: d.pending[1].fileId, fileId: d.pending[1].fileId });
    await promiseB;
    assert.strictEqual(page.data.tempFileId, d.pending[1].fileId, "item-edit 最终 temp 必须是 B");
  }

  // ---- 7. 离线保存回归：无云/身份未确认时本地 imageUrl + 空 fileId 继续保存 ----
  {
    const { calls, serviceMock } = createDeferredService();
    serviceMock.uploadImage = () => Promise.resolve({
      imageUrl: "wxfile://saved/offline.jpg",
      fileId: "",
      storage: "local",
      uploadState: "pending",
      errorCode: "IDENTITY_UNCONFIRMED"
    });
    const definition = loadPage("../miniprogram/pages/item-upload/item-upload", serviceMock);
    global.wx = { showLoading() {}, hideLoading() {}, showToast() {}, showModal() {}, navigateBack() {}, pageScrollTo() {} };
    const page = {
      ...definition,
      data: {
        ...definition.data,
        localImagePath: "wxfile://store/offline.jpg",
        sourceTempFileId: "",
        uploadState: "idle",
        form: { ...definition.data.form, name: "离线单品", category: "top", seasons: ["summer"], styles: ["casual"] }
      },
      setData(patch) { Object.assign(this.data, patch); }
    };
    await page.saveItem();
    assert.strictEqual(calls.created.length, 1, "离线场景必须继续保存（V1.4 语义）");
    assert.strictEqual(calls.created[0].imageFileId, "", "离线保存 imageFileId 必须为空");
    assert.strictEqual(calls.created[0].imageUrl, "wxfile://saved/offline.jpg", "离线保存 imageUrl 使用本地路径");
    assert.strictEqual(page.data.saving, false);
  }

  // ---- 8. 禁止 tmp 转正：staging 状态下保存被拦，不得保存、temp 保留 ----
  {
    const { calls, serviceMock } = createDeferredService();
    serviceMock.uploadImage = (path, scope, guard, purpose) => {
      calls.purposes.push(purpose || "clothing");
      if (purpose === "clothing") {
        return Promise.resolve({ uploadState: "failed", fileId: "", storage: "cloud", errorCode: "UPLOAD_FAILED" });
      }
      return Promise.resolve({ uploadState: "success", imageUrl: "cloud://env/wardrobe/user_a/tmp/fb.jpg", fileId: "cloud://env/wardrobe/user_a/tmp/fb.jpg", storage: "cloud" });
    };
    const definition = loadPage("../miniprogram/pages/item-upload/item-upload", serviceMock);
    global.wx = {
      showLoading() {}, hideLoading() {},
      showToast() {}, showModal() {}, navigateBack() {}, pageScrollTo() {}
    };
    const page = {
      ...definition,
      data: {
        ...definition.data,
        localImagePath: "wxfile://store/fb.jpg",
        sourceTempFileId: "cloud://env/wardrobe/user_a/tmp/fb.jpg",
        imageUrl: "cloud://env/wardrobe/user_a/tmp/fb.jpg",
        fileId: "cloud://env/wardrobe/user_a/tmp/fb.jpg",
        uploadState: "success",
        form: { ...definition.data.form, name: "测试", category: "top", seasons: ["summer"], styles: ["casual"] }
      },
      setData(patch) { Object.assign(this.data, patch); }
    };
    await page.saveItem();
    assert.strictEqual(calls.created.length, 0, "staging 状态下不得保存单品（Round 2A-2 保存未开放）");
    assert(!calls.unregistered.includes("cloud://env/wardrobe/user_a/tmp/fb.jpg"), "不得停止跟踪待重试的 temp");
    assert(!calls.clearTemp.includes("cloud://env/wardrobe/user_a/tmp/fb.jpg"), "不得删除待重试的 temp");
    assert.strictEqual(page.data.sourceTempFileId, "cloud://env/wardrobe/user_a/tmp/fb.jpg", "staging 必须保留供重试");
    assert.strictEqual(page.data.saving, false);
  }

  // ---- 9. staging 状态下保存被明确拦住：不得假装成功，也不得触碰 temp ----
  {
    const { calls, serviceMock } = createDeferredService();
    serviceMock.uploadImage = (path, scope, guard, purpose) => {
      calls.purposes.push(purpose || "clothing");
      return Promise.resolve({ uploadState: "success", imageUrl: "cloud://env/wardrobe/user_a/formal.jpg", fileId: "cloud://env/wardrobe/user_a/formal.jpg", storage: "cloud" });
    };
    const definition = loadPage("../miniprogram/pages/item-upload/item-upload", serviceMock);
    const modalCalls = [];
    global.wx = { showLoading() {}, hideLoading() {}, showToast() {}, showModal(options) { modalCalls.push(options && options.title); }, navigateBack() {}, pageScrollTo() {} };
    const page = {
      ...definition,
      data: {
        ...definition.data,
        localImagePath: "wxfile://store/b.jpg",
        sourceTempFileId: "cloud://env/wardrobe/user_a/tmp/old.jpg",
        cutoutTempFileId: "cloud://env/wardrobe/user_a/tmp/cutout_old.png",
        imageUrl: "cloud://env/wardrobe/user_a/tmp/old.jpg",
        fileId: "cloud://env/wardrobe/user_a/tmp/old.jpg",
        uploadState: "success",
        stagingConfirmed: true,
        form: { ...definition.data.form, name: "测试上衣", category: "top", seasons: ["summer"], styles: ["casual"] }
      },
      setData(patch) { Object.assign(this.data, patch); }
    };
    await page.saveItem();
    assert.strictEqual(calls.created.length, 0, "Round 2A-4：未完成标准化的 staging 状态下绝不调用 createWardrobeItem");
    assert(!calls.purposes.includes("clothing"), "staging 状态下不得发起正式用途上传");
    assert(!calls.clearTemp.includes("cloud://env/wardrobe/user_a/tmp/old.jpg"), "拦住保存时不得清理 temp");
    assert.strictEqual(page.data.sourceTempFileId, "cloud://env/wardrobe/user_a/tmp/old.jpg", "staging 必须保留供重试");
    assert.strictEqual(page.data.saving, false);
  }

  // ---- 10. 重选图：已有 staging 时再次上传必须先删除旧原图与旧抠图 ----
  {
    const { pending, calls, serviceMock } = createDeferredService();
    const definition = loadPage("../miniprogram/pages/item-upload/item-upload", serviceMock);
    global.wx = { showLoading() {}, hideLoading() {}, showToast() {}, showModal() {}, navigateBack() {}, pageScrollTo() {} };
    const page = {
      ...definition,
      data: {
        ...definition.data,
        localImagePath: "wxfile://store/a.jpg",
        sourceTempFileId: "cloud://env/wardrobe/user_a/tmp/old.jpg",
        cutoutTempFileId: "cloud://env/wardrobe/user_a/tmp/cutout_old.png",
        uploadState: "success"
      },
      setData(patch) { Object.assign(this.data, patch); }
    };
    const p = page.uploadTempImage();
    pending[0].resolve({ uploadState: "success", imageUrl: "cloud://env/wardrobe/user_a/tmp/new.jpg", fileId: "cloud://env/wardrobe/user_a/tmp/new.jpg", storage: "cloud" });
    await p;
    assert(calls.clearTemp.includes("cloud://env/wardrobe/user_a/tmp/old.jpg"), "重选图时旧原图 temp 必须被删除");
    assert(calls.clearTemp.includes("cloud://env/wardrobe/user_a/tmp/cutout_old.png"), "重选图时旧抠图 temp 必须被删除");
    assert.strictEqual(page.data.sourceTempFileId, "cloud://env/wardrobe/user_a/tmp/new.jpg");
    assert.strictEqual(page.data.cutoutTempFileId, "", "新 staging 建立时不得残留旧抠图引用");
  }

  console.log("temp image lifecycle page tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
