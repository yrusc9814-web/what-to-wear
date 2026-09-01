const assert = require("assert");
const Module = require("module");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const pagePath = path.resolve(root, "miniprogram/pages/item-upload/item-upload.js");
const SOURCE = "cloud://env/wardrobe/user_a/tmp/source.jpg";
const CUTOUT = "cloud://env/wardrobe/user_a/tmp/cutout_1.png";
const STANDARD = "cloud://env/wardrobe/user_a/tmp/standardized_1.png";
// 合法 PNG 文件头（12 字节），readImageHeader 成功返回
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]).buffer;

function flushAsync() { return new Promise((resolve) => setTimeout(resolve, 0)); }

function loadPage(serviceMock) {
  let definition;
  global.Page = (value) => { definition = value; };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "../../services/app-service") return serviceMock;
    if (request === "../../services/cloud") return {
      canUseCloud: () => true,
      callFunction: (name, data) => Promise.resolve({ result: { ok: true, data: { resultFileId: CUTOUT } } })
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(pagePath)];
  require(pagePath);
  Module._load = originalLoad;
  delete global.Page;
  return definition;
}

function makeHarness(options = {}) {
  const calls = { standardize: [], cleared: [], registered: [], created: [], setData: [] };
  const pending = [];
  let uploadIndex = 0;
  const defaultUpload = () => {
    const pickId = (options.uploadIds && options.uploadIds[uploadIndex]) || SOURCE;
    uploadIndex += 1;
    return Promise.resolve({ uploadState: "success", imageUrl: pickId, fileId: pickId });
  };
  const service = {
    persistLocalImage: (value) => Promise.resolve(value),
    uploadImage: options.uploadImage || defaultUpload,
    registerTempImage: (id) => { calls.registered.push(id); },
    clearTempImage: (id) => { calls.cleared.push(id); return Promise.resolve(true); },
    unregisterTempImage() {},
    sweepExpiredTempImages: () => Promise.resolve(0),
    createWardrobeItem: (payload) => { calls.created.push(payload); return Promise.resolve({ syncStatus: "synced" }); },
    standardizeCutoutImage: (id) => {
      calls.standardize.push(id);
      if (options.standardize) return options.standardize(id, pending);
      return Promise.resolve({ standardizedTempFileId: STANDARD, width: 100, height: 120, bytes: 10, elapsedMs: 3 });
    }
  };
  const definition = loadPage(service);
  global.wx = {
    pageScrollTo() {}, showToast() {}, showLoading() {}, hideLoading() {}, navigateBack() {},
    showModal() {},
    getFileSystemManager: () => ({
      readFile({ success }) { success({ data: PNG_HEADER }); }
    })
  };
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { calls.setData.push(patch); Object.assign(this.data, patch); }
  };
  page.setData({ localImagePath: "wxfile://store/item.jpg", imageUrl: SOURCE, fileId: SOURCE, sourceTempFileId: SOURCE, cutoutTempFileId: CUTOUT, cutoutState: "success", uploadState: "success" });
  return { page, service, calls, pending };
}

function resolveDeferred(entry, value) { entry.resolve(value); }
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function run() {
  // 1/2/3/5/6/7: 未确认不标准化；成功写标准化、确认、步骤和预览，保留 source/cutout
  {
    const h = makeHarness();
    assert.strictEqual(h.page.data.standardizedTempFileId, "");
    assert.strictEqual(h.page.data.stagingConfirmed, false);
    assert.strictEqual(h.calls.standardize.length, 0);
    await h.page.confirmCutout();
    assert.deepStrictEqual(h.calls.standardize, [CUTOUT]);
    assert.strictEqual(h.page.data.standardizedTempFileId, STANDARD);
    assert.strictEqual(h.page.data.standardizeState, "success");
    assert.strictEqual(h.page.data.stagingConfirmed, true);
    assert.strictEqual(h.page.data.step, 2);
    assert.strictEqual(h.page.data.imageUrl, STANDARD);
    assert.strictEqual(h.page.data.sourceTempFileId, SOURCE);
    assert.strictEqual(h.page.data.cutoutTempFileId, CUTOUT);
  }

  // 4: 连击只产生一次调用，且 loading 状态存在期间代码锁生效
  {
    const d = deferred();
    const h = makeHarness({ standardize: () => d.promise });
    const first = h.page.confirmCutout();
    const second = h.page.confirmCutout();
    assert.strictEqual(h.calls.standardize.length, 1);
    assert.strictEqual(h.page.data.standardizeState, "loading");
    resolveDeferred(d, { standardizedTempFileId: STANDARD });
    await Promise.all([first, second]);
  }

  // 8/9/10: 失败不推进、不落标准化、不 fallback 到 cutout，重试可成功
  {
    let attempt = 0;
    const h = makeHarness({ standardize: () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(Object.assign(new Error("标准化失败，请重试"), { code: "STANDARDIZE_FAILED" })) : Promise.resolve({ standardizedTempFileId: STANDARD });
    } });
    h.page.setData({ step: 2 });
    await h.page.confirmCutout();
    assert.strictEqual(h.page.data.step, 2);
    assert.strictEqual(h.page.data.stagingConfirmed, false);
    assert.strictEqual(h.page.data.standardizedTempFileId, "");
    assert.strictEqual(h.page.data.cutoutTempFileId, CUTOUT);
    assert.strictEqual(h.page.data.standardizeState, "error");
    assert.strictEqual(h.page.data.standardizeError, "标准化失败，请重试");
    assert.strictEqual(h.page.data.standardizeErrorCode, "STANDARDIZE_FAILED");
    await h.page.confirmCutout();
    assert.strictEqual(h.page.data.standardizedTempFileId, STANDARD);
    assert.strictEqual(h.page.data.stagingConfirmed, true);
    assert(!h.page.data.standardizedTempFileId.includes("cutout_"));
  }

  // 11/13: 重选释放三类且去重，清理状态复位（含 stagingConfirmed/standardizeState）
  {
    const h = makeHarness();
    h.page.setData({ standardizedTempFileId: CUTOUT, stagingConfirmed: true, standardizeState: "error", standardizeError: "x", standardizeErrorCode: "E" });
    const ids = h.page.releaseStagingAssets();
    assert.deepStrictEqual(ids.sort(), [SOURCE, CUTOUT].sort());
    assert.deepStrictEqual(h.calls.cleared.sort(), [SOURCE, CUTOUT].sort());
    assert.strictEqual(h.page.data.standardizedTempFileId, "");
    assert.strictEqual(h.page.data.stagingConfirmed, false, "releaseStagingAssets 必须复位 stagingConfirmed");
    assert.strictEqual(h.page.data.standardizeState, "idle", "releaseStagingAssets 必须复位 standardizeState");
    assert.strictEqual(h.page.data.standardizeError, "");
    assert.strictEqual(h.page.data.standardizeErrorCode, "");
  }

  // 12: onUnload 覆盖仅 source / source+cutout / 三类组合
  for (const state of [
    { sourceTempFileId: SOURCE, cutoutTempFileId: "", standardizedTempFileId: "" },
    { sourceTempFileId: SOURCE, cutoutTempFileId: CUTOUT, standardizedTempFileId: "" },
    { sourceTempFileId: SOURCE, cutoutTempFileId: CUTOUT, standardizedTempFileId: STANDARD }
  ]) {
    const h = makeHarness();
    h.page.setData(state);
    h.page.onUnload();
    assert.deepStrictEqual(h.calls.cleared.sort(), Object.values(state).filter(Boolean).sort());
    assert.strictEqual(h.page.data.sourceTempFileId, "");
    assert.strictEqual(h.page.data.cutoutTempFileId, "");
    assert.strictEqual(h.page.data.standardizedTempFileId, "");
  }

  // 14: A 响应过期时不得写 UI，只回收 A 产物；B 状态不受影响
  {
    const a = deferred();
    const h = makeHarness({ standardize: () => a.promise });
    h.page._imageGeneration = 1;
    const confirmA = h.page.confirmCutout();
    h.page._imageGeneration = 2;
    h.page.setData({ localImagePath: "wxfile://store/b.jpg", sourceTempFileId: "source_b", cutoutTempFileId: "cutout_b", cutoutState: "success", standardizeState: "idle", stagingConfirmed: false, step: 2 });
    const before = h.calls.setData.length;
    resolveDeferred(a, { standardizedTempFileId: "standardized_a" });
    await confirmA;
    assert.strictEqual(h.page.data.cutoutTempFileId, "cutout_b");
    assert.strictEqual(h.page.data.step, 2);
    assert.strictEqual(h.page.data.stagingConfirmed, false);
    assert.strictEqual(h.page.data.standardizedTempFileId, "");
    assert(h.calls.cleared.includes("standardized_a"));
    assert.strictEqual(h.calls.setData.length, before);
  }

  // 15: onUnload 后 pending 响应无异常且无 setData 副作用，且该响应携带的 standardizedTempFileId 被 best-effort clearTempImage
  {
    const a = deferred();
    const h = makeHarness({ standardize: () => a.promise });
    const pending = h.page.confirmCutout();
    h.page.onUnload();
    const count = h.calls.setData.length;
    const clearedBefore = h.calls.cleared.length;
    resolveDeferred(a, { standardizedTempFileId: "standardized_after_unload" });
    await pending;
    assert.strictEqual(h.calls.setData.length, count);
    assert.strictEqual(h.page.data.step, 1);
    assert.strictEqual(h.page.data.standardizedTempFileId, "");
    // 孤立的 standardized 产物被 best-effort 回收
    assert(h.calls.cleared.includes("standardized_after_unload"), "onUnload 后 pending 返回的 standardized 产物必须被回收");
  }

  // 16: 仅有标准化 staging 仍阻止正式保存
  {
    const h = makeHarness();
    h.page.setData({ sourceTempFileId: "", cutoutTempFileId: "", standardizedTempFileId: STANDARD, stagingConfirmed: true, step: 3, form: { ...h.page.data.form, name: "测试", category: "top", seasons: ["summer"], styles: ["casual"] } });
    await h.page.saveItem();
    assert.strictEqual(h.calls.created.length, 0);
  }

  // 前置 gate: cutout 未成功时不调用标准化
  {
    const h = makeHarness();
    h.page.setData({ cutoutState: "error", cutoutTempFileId: "" });
    await h.page.confirmCutout();
    assert.strictEqual(h.calls.standardize.length, 0);
  }

  // 服务层契约：参数校验、云函数 envelope 归一、结果校验与 standardized temp 登记
  {
    const storage = new Map();
    let request = null;
    global.getApp = () => ({ globalData: { userScope: "user_a" } });
    global.wx = {
      getStorageSync: (key) => storage.has(key) ? storage.get(key) : "",
      setStorageSync: (key, value) => storage.set(key, JSON.parse(JSON.stringify(value))),
      cloud: {
        callFunction: ({ name, data }) => {
          request = { name, data };
          return Promise.resolve({ result: { ok: true, data: { standardizedTempFileId: STANDARD, width: 2, height: 3, bytes: 20, elapsedMs: 4 } } });
        }
      }
    };
    const appService = require("../miniprogram/services/app-service");
    await assert.rejects(() => appService.standardizeCutoutImage(""), (error) => error && error.code === "INVALID_CUTOUT_TEMP_FILE_ID");
    const result = await appService.standardizeCutoutImage(CUTOUT);
    assert.strictEqual(request.name, "standardizeClothingImage");
    assert.deepStrictEqual(request.data, { cutoutTempFileId: CUTOUT });
    assert.strictEqual(result.standardizedTempFileId, STANDARD);
    assert((storage.get(`${appService.STORAGE.tempImages}:user_a`) || []).some((entry) => entry.fileId === STANDARD));
    global.wx.cloud.callFunction = () => Promise.resolve({ result: { ok: true, data: {} } });
    await assert.rejects(() => appService.standardizeCutoutImage(CUTOUT), (error) => error && error.code === "STANDARDIZE_INVALID_RESULT");
  }

  // F5a: 真实 rechooseImage 路径 —— 已确认状态下三 id 全清理、字段清空、generation 递增
  {
    const h = makeHarness();
    const before = h.page._imageGeneration || 0;
    h.page.setData({ standardizedTempFileId: STANDARD, stagingConfirmed: true, standardizeState: "success", cutoutState: "success", cutoutTempFileId: CUTOUT, sourceTempFileId: SOURCE, uploadState: "success" });
    h.calls.cleared.length = 0;
    h.page.rechooseImage();
    assert.deepStrictEqual(h.calls.cleared.sort(), [SOURCE, CUTOUT, STANDARD].sort(), "rechooseImage 必须清理 source/cutout/standardized 三 id");
    assert.strictEqual(h.page.data.sourceTempFileId, "");
    assert.strictEqual(h.page.data.cutoutTempFileId, "");
    assert.strictEqual(h.page.data.standardizedTempFileId, "");
    assert.strictEqual(h.page.data.stagingConfirmed, false);
    assert.strictEqual(h.page.data.standardizeState, "idle");
    assert.strictEqual(h.page.data.step, 1);
    assert.strictEqual(h.page._imageGeneration, before + 1, "rechooseImage 必须递增 generation");
  }

  // F5a2: standardize pending 中 rechooseImage —— pending A 返回无 setData 副作用，产物被 best-effort 回收
  {
    const a = deferred();
    const h = makeHarness({ standardize: () => a.promise });
    const pendingA = h.page.confirmCutout();
    h.page.rechooseImage();
    const count = h.calls.setData.length;
    resolveDeferred(a, { standardizedTempFileId: "standardized_stale_rechoose" });
    await pendingA;
    assert.strictEqual(h.calls.setData.length, count, "rechoose 后 pending A 不得产生任何 setData 副作用");
    assert.strictEqual(h.page.data.standardizedTempFileId, "");
    assert(h.calls.cleared.includes("standardized_stale_rechoose"), "rechoose 后 pending A 的 standardized 产物必须被回收");
  }

  // F5c: chooseImage(B1)/chooseImage(B2) 并发交错 —— 较晚 pick 恒赢，B1 作废，A（更早）完全失效
  {
    const a = deferred();
    let uploadCallCount = 0;
    const h = makeHarness({
      standardize: () => a.promise,
      uploadImage: () => {
        uploadCallCount += 1;
        // B1 在真正 upload 前已被 B2 超代（generation 校验提前 return），
        // 因此实际发生的首次 upload 必属于 B2。
        const id = uploadCallCount === 1 ? "cloud://env/wardrobe/user_a/tmp/pick_b2.jpg" : "cloud://env/wardrobe/user_a/tmp/pick_b1.jpg";
        return Promise.resolve({ uploadState: "success", imageUrl: id, fileId: id });
      }
    });
    // A：更早的 pending standardize（generation 0）
    const pendingA = h.page.confirmCutout();
    // 捕获两次 chooseMedia 的 success 回调，同步触发制造交错
    let success1 = null;
    let success2 = null;
    global.wx.chooseMedia = (opts) => {
      if (!success1) success1 = opts.success;
      else success2 = opts.success;
    };
    h.page.chooseImage(["album"]);
    h.page.chooseImage(["album"]);
    assert(success1 && success2, "两次 chooseMedia 都必须被捕获");
    const p1 = success1({ tempFiles: [{ tempFilePath: "wxfile://store/b1.jpg" }] });
    const p2 = success2({ tempFiles: [{ tempFilePath: "wxfile://store/b2.jpg" }] });
    // 此时 B1 已过代际（B2 较晚 pick），A 仍 pending
    resolveDeferred(a, { standardizedTempFileId: "standardized_earlier_a" });
    await Promise.all([p1, p2, pendingA]);
    assert.strictEqual(h.page.data.localImagePath, "wxfile://store/b2.jpg", "最终页状态必须属于 B2（较晚 pick 赢）");
    assert.strictEqual(h.page.data.sourceTempFileId, "cloud://env/wardrobe/user_a/tmp/pick_b2.jpg", "B2 的暂存产物必须被采用");
    assert.strictEqual(h.page.data.standardizedTempFileId, "", "A 的标准化结果不得写回 UI");
    assert(h.calls.cleared.includes("standardized_earlier_a"), "A 的标准化产物必须被回收");
    // 旧 staging（SOURCE/CUTOUT）已被 chooseImage 清理
    assert(h.calls.cleared.includes(SOURCE), "旧 staging source 必须被清理");
    assert(h.calls.cleared.includes(CUTOUT), "旧 staging cutout 必须被清理");
  }

  // F5d: 幂等 confirm —— standardize 成功后再调 confirmCutout 不产生第二次云调用、standardizedTempFileId 不变
  {
    const h = makeHarness();
    await h.page.confirmCutout();
    assert.strictEqual(h.calls.standardize.length, 1);
    const before = h.calls.standardize.length;
    const beforeId = h.page.data.standardizedTempFileId;
    await h.page.confirmCutout();
    assert.strictEqual(h.calls.standardize.length, before, "幂等 confirm 不得产生第二次云调用");
    assert.strictEqual(h.page.data.standardizedTempFileId, beforeId, "幂等 confirm 不得覆盖 standardizedTempFileId");
    assert.strictEqual(h.page.data.stagingConfirmed, true);
  }

  // F5e: WXML 渲染分支断言（沿用 cutout-production Part D 的源码断言风格）
  {
    const wxml = fs.readFileSync(path.join(root, "miniprogram/pages/item-upload/item-upload.wxml"), "utf8");
    // 预览区存在 standardized 分支且引用 standardizedTempFileId
    assert(wxml.includes("standardizedTempFileId") && wxml.includes('src="{{standardizedTempFileId}}"'), "预览区必须渲染 standardized 分支并引用 standardizedTempFileId");
    // loading 分支仍显示 cutout
    assert(wxml.includes("standardizeState === 'loading'") && wxml.includes('src="{{cutoutTempFileId}}"'), "standardize loading 分支必须仍显示 cutout 预览");
    // 确认按钮存在 disabled/loading 绑定
    assert(wxml.includes('loading="{{standardizeState === \'loading\'}}"') && wxml.includes('disabled="{{standardizeState === \'loading\'}}"'), "确认按钮必须绑定 loading/disabled 状态");
    // standardize 失败分支只展示友好文案，不向用户渲染 standardizeErrorCode
    assert(wxml.includes("standardizeError || '图片处理失败，请重试'"), "standardize 失败分支必须展示友好文案");
    assert(!wxml.includes("{{standardizeErrorCode}}"), "standardize 失败分支不得渲染 standardizeErrorCode");
  }

  console.log("standardize integration tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
