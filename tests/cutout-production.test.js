const assert = require("assert");
const Module = require("module");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");

// ============================================================
// Part A：前景校验（png-alpha foregroundPixelCount + segmentClothing RESULT_NO_FOREGROUND）
// ============================================================

const FAKE_KEY_ID = "LTAI5tFakeKeyIdForR2A2Tests001";
const FAKE_SECRET = "FakeSecretValueDoNotLeak_r2a2_0123456789";
const OPENID = "user_123";
const TEMP_FILE_ID = `cloud://env.bucket/wardrobe/${OPENID}/tmp/100_abc.jpg`;
const SEGMENT_ENTRY = path.resolve(root, "cloudfunctions/segmentClothing/index.js");

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function filterRowBytes(filterType, raw, previous, bytesPerCompletePixel) {
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    const left = i >= bytesPerCompletePixel ? raw[i - bytesPerCompletePixel] : 0;
    const up = previous ? previous[i] : 0;
    const upLeft = (i >= bytesPerCompletePixel && previous) ? previous[i - bytesPerCompletePixel] : 0;
    let value;
    if (filterType === 0) value = raw[i];
    else if (filterType === 1) value = raw[i] - left;
    else if (filterType === 2) value = raw[i] - up;
    else if (filterType === 3) value = raw[i] - ((left + up) >> 1);
    else value = raw[i] - paethPredictor(left, up, upLeft);
    out[i] = value & 0xff;
  }
  return out;
}

function encodeScanlines(rows, bitDepth, channels) {
  const bitsPerPixel = channels * bitDepth;
  const bytesPerCompletePixel = Math.max(1, Math.floor((bitsPerPixel + 7) / 8));
  const parts = [];
  let previous = null;
  rows.forEach((row) => {
    const raw = Buffer.from(row);
    parts.push(Buffer.concat([Buffer.from([0]), filterRowBytes(0, raw, previous, bytesPerCompletePixel)]));
    previous = raw;
  });
  return Buffer.concat(parts);
}

function pixelRows(width, height, channels, pixelFn) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelFn(x, y);
      for (let c = 0; c < channels; c += 1) row.push(pixel[c] & 0xff);
    }
    rows.push(row);
  }
  return rows;
}

function buildRgbaPng(width, height, pixelFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(encodeScanlines(pixelRows(width, height, 4, pixelFn), 8, 4))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function buildRgbPng(width, height, pixelFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(encodeScanlines(pixelRows(width, height, 3, pixelFn), 8, 3))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function createSegmentFakes(options = {}) {
  const state = { uploads: [], advanceCalls: [] };
  const wxServerSdk = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    getWXContext() { return { OPENID: options.openid === undefined ? OPENID : options.openid }; },
    downloadFile() { return Promise.resolve({ fileContent: options.input || Buffer.alloc(0) }); },
    uploadFile({ cloudPath, fileContent }) {
      state.uploads.push({ cloudPath, bytes: fileContent ? fileContent.length : 0 });
      return Promise.resolve({ fileID: `cloud://env.bucket/${cloudPath}` });
    }
  };
  class FakeAdvanceRequest { constructor(map) { Object.assign(this, map || {}); } }
  const imageseg = {
    default: class FakeSegmentClient {
      async segmentClothAdvance(request) {
        state.advanceCalls.push({ request });
        if (options.advanceImpl) return options.advanceImpl(request);
        return { body: { data: { elements: [{ imageURL: "https://tmp.example.test/segmented.png" }] } } };
      }
    },
    SegmentClothAdvanceRequest: FakeAdvanceRequest
  };
  const openapi = { Config: class { constructor(map) { Object.assign(this, map || {}); } } };
  const teaUtil = { RuntimeOptions: class { constructor(map) { Object.assign(this, map || {}); } } };
  return {
    state,
    wxServerSdk,
    imageseg,
    openapi,
    teaUtil,
    httpDownload: options.httpDownload
  };
}

function loadSegmentModule(fakes) {
  delete require.cache[SEGMENT_ENTRY];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return fakes.wxServerSdk;
    if (request === "@alicloud/imageseg20191230") return fakes.imageseg;
    if (request === "@alicloud/openapi-client") return fakes.openapi;
    if (request === "@alicloud/tea-util") return fakes.teaUtil;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const mod = require(SEGMENT_ENTRY);
    mod._test.setResultDownloader(fakes.httpDownload);
    return mod;
  } finally {
    Module._load = originalLoad;
  }
}

async function partA() {
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = FAKE_KEY_ID;
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = FAKE_SECRET;
  const jpegInput = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)]);

  // ---- 1. 全透明 RGBA PNG 被拒（RESULT_NO_FOREGROUND），并给出前台像素统计 ----
  const allTransparent = buildRgbaPng(4, 3, () => [10, 20, 30, 0]);
  const dimTransparent = buildRgbaPng(4, 3, () => [10, 20, 30, 64]);
  const staged = buildRgbaPng(6, 4, (x, y) => (y === 0 ? [10, 20, 30, 0] : [40, 50, 60, 255]));
  const opaqueRgb = buildRgbPng(4, 3, () => [200, 30, 40]);

  {
    const fakes = createSegmentFakes({
      input: jpegInput,
      httpDownload: async () => ({ statusCode: 200, contentType: "image/png", buffer: allTransparent })
    });
    const mod = loadSegmentModule(fakes);
    const result = await mod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "RESULT_NO_FOREGROUND", "全透明 PNG 必须被前景校验拒绝");
    assert(result.errorMessage.includes("没有可见的服饰主体"));
    assert.strictEqual(fakes.state.uploads.length, 0, "前景校验失败不得上传任何结果");

    const decoder = mod._test.decodePngAlpha;
    assert.strictEqual(decoder(allTransparent).foregroundPixelCount, 0);
    assert.strictEqual(decoder(allTransparent).transparentPixelCount, 12);

    const dimFakes = createSegmentFakes({
      input: jpegInput,
      httpDownload: async () => ({ statusCode: 200, contentType: "image/png", buffer: dimTransparent })
    });
    const dimMod = loadSegmentModule(dimFakes);
    const dimResult = await dimMod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(dimResult.errorCode, "RESULT_NO_FOREGROUND", "只有低于阈值半透明像素的结果也必须拒绝");
    assert.strictEqual(dimMod._test.decodePngAlpha(dimTransparent).foregroundPixelCount, 0);
  }

  // ---- 2. 有前景 + 透明背景 PASS，data 携带 foregroundPixelCount ----
  {
    const fakes = createSegmentFakes({
      input: jpegInput,
      httpDownload: async () => ({ statusCode: 200, contentType: "image/png", buffer: staged })
    });
    const mod = loadSegmentModule(fakes);
    const result = await mod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(result.ok, true, `有前景+透明背景必须通过: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.foregroundPixelCount, 18, "6x4 中除首行外均为 alpha=255 前景");
    assert.strictEqual(result.data.transparentPixelCount, 6);
    assert.strictEqual(result.data.width, 6);
    assert.strictEqual(result.data.height, 4);

    const decoder = mod._test.decodePngAlpha;
    // 半透明但高于阈值（alpha=200）计入前景；alpha=127 不计入
    const soft = buildRgbaPng(3, 1, (x) => [1, 2, 3, x === 0 ? 200 : x === 1 ? 127 : 255]);
    const decoded = decoder(soft);
    assert.strictEqual(decoded.foregroundPixelCount, 2, "alpha 200 与 255 计入前景，127 不计入");
    assert.strictEqual(decoded.transparentPixelCount, 2, "alpha 200 与 127 计为透明（<255）");
    // 不透明 RGB：前景为全部像素
    assert.strictEqual(decoder(opaqueRgb).foregroundPixelCount, 12);
  }
}

// ============================================================
// Part B：app-service.deleteTempFile 服务端优先（deleteWardrobeTemp）
// ============================================================

const storage = new Map();
const clientDeleted = [];
let serverCallImpl = null;

global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); },
  saveFile({ tempFilePath, success }) { success({ savedFilePath: `wxfile://saved/${String(tempFilePath).split("/").pop()}` }); },
  cloud: {
    callFunction({ name, data }) {
      if (name !== "deleteWardrobeTemp") return Promise.resolve({ result: { ok: true, data: {} } });
      if (serverCallImpl) return serverCallImpl(data);
      return Promise.resolve({ result: { ok: true, data: { details: [{ fileId: data.tempFileIds[0], status: "deleted" }] } } });
    },
    uploadFile({ cloudPath }) { return Promise.resolve({ fileID: `cloud://env/${cloudPath}` }); },
    deleteFile({ fileList }) {
      clientDeleted.push(...(fileList || []).map(String));
      return Promise.resolve({ fileList: (fileList || []).map((fileID) => ({ fileID, status: 0 })) });
    }
  }
};
global.getApp = () => ({ globalData: { userScope: "user_a" } });

const service = require(path.join(root, "miniprogram/services/app-service"));

function registry(scope = "user_a") {
  return storage.get(`${service.STORAGE.tempImages}:${scope}`) || [];
}

async function partB() {
  // ---- B1. 服务端删除成功：deleteWardrobeTemp 被优先调用，客户端 deleteFile 不触发 ----
  clientDeleted.length = 0;
  const fileA = await service.uploadImage("wxfile://tmp/srv_a.jpg", undefined, undefined, "temp");
  const clearedA = await service.clearTempImage(fileA.fileId);
  assert.strictEqual(clearedA, true, "服务端删除成功必须返回 true");
  assert(clientDeleted.length === 0, "服务端成功时不得回退客户端 deleteFile");
  assert(!registry().some((entry) => entry.fileId === fileA.fileId), "删除成功后必须注销登记");

  // ---- B2. 服务端回报 failed：返回 false、登记保留等待 TTL 重试、不回退客户端 ----
  serverCallImpl = (data) => Promise.resolve({ result: { ok: true, data: { details: [{ fileId: data.tempFileIds[0], status: "failed" }] } } });
  const fileB = await service.uploadImage("wxfile://tmp/srv_b.jpg", undefined, undefined, "temp");
  const clearedB = await service.clearTempImage(fileB.fileId);
  assert.strictEqual(clearedB, false, "服务端 failed 必须返回 false");
  assert(registry().some((entry) => entry.fileId === fileB.fileId), "失败必须保留登记供重试");
  assert(clientDeleted.length === 0, "服务端已明确失败时不得再尝试客户端删除");
  serverCallImpl = null;

  // ---- B3. 服务端入口不存在（callFunction reject）：回退客户端 deleteFile ----
  serverCallImpl = () => Promise.reject(Object.assign(new Error("FunctionNameParameter could not be found"), { code: "FUNCTION_NOT_FOUND" }));
  const fileC = await service.uploadImage("wxfile://tmp/srv_c.jpg", undefined, undefined, "temp");
  clientDeleted.length = 0;
  const clearedC = await service.clearTempImage(fileC.fileId);
  assert.strictEqual(clearedC, true, "回退客户端删除必须保持原有能力");
  assert(clientDeleted.includes(fileC.fileId), "回退必须真实调用 wx.cloud.deleteFile");
  serverCallImpl = null;

  // ---- B4. 信封缺明细（旧 mock / 异常信封）：回退客户端删除，保持既有测试契约 ----
  serverCallImpl = () => Promise.resolve({ result: { ok: true, data: {} } });
  const fileD = await service.uploadImage("wxfile://tmp/srv_d.jpg", undefined, undefined, "temp");
  clientDeleted.length = 0;
  const clearedD = await service.clearTempImage(fileD.fileId);
  assert.strictEqual(clearedD, true);
  assert(clientDeleted.includes(fileD.fileId), "信封缺明细时必须回退客户端删除");
  serverCallImpl = null;

  // ---- B5. 非本人 / 非正式资产保护：所有权预检先于服务端调用，正式路径永不进入删除流程 ----
  global.getApp = () => ({ globalData: { userScope: "user_b" } });
  const formalLike = "cloud://env/wardrobe/user_a/formal.jpg";
  clientDeleted.length = 0;
  const clearedOther = await service.clearTempImage(formalLike);
  assert.strictEqual(clearedOther, false, "他人 / 正式路径必须被所有权预检拒绝");
  assert(clientDeleted.length === 0, "被拒路径不得触发任何删除调用");
  global.getApp = () => ({ globalData: { userScope: "user_a" } });

  console.log("app-service server-first temp deletion tests passed");
}

// ============================================================
// Part C：页面级生命周期（重选 / 取消 / 失败 / 确认不保存）
// ============================================================

function loadPage(pagePath, serviceMock, cloudMock) {
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

function createPageMocks() {
  const calls = { cleared: [], registered: [], unregistered: [], created: [], functions: [], modalTitles: [], navigatedBack: 0 };
  const serviceMock = {
    persistLocalImage(p) { return Promise.resolve(p); },
    uploadImage(p, scope, guard, purpose) {
      return Promise.resolve({ uploadState: "success", imageUrl: `cloud://env/wardrobe/user_a/tmp/${calls.functions.length}_up.jpg`, fileId: `cloud://env/wardrobe/user_a/tmp/${calls.functions.length}_up.jpg`, storage: "cloud" });
    },
    clearTempImage(fileId) { if (fileId) calls.cleared.push(fileId); return Promise.resolve(true); },
    standardizeCutoutImage(fileId) {
      calls.functions.push({ name: "standardizeClothingImage", data: { cutoutTempFileId: fileId } });
      return Promise.resolve({ standardizedTempFileId: fileId.replace("cutout_", "standardized_"), width: 2, height: 2, bytes: 10, elapsedMs: 2 });
    },
    promoteStandardizedClothingAsset(fileId) {
      return Promise.resolve({ formalImageFileId: fileId.replace("/tmp/standardized_", "/clothing/").replace(".png", "_formal.png"), sha256: "abc", width: 2, height: 2, bytes: 10, status: "PROMOTED" });
    },
    registerTempImage(fileId) { if (fileId) calls.registered.push(fileId); return { fileId }; },
    unregisterTempImage(fileId) { if (fileId) calls.unregistered.push(fileId); },
    sweepExpiredTempImages() { return Promise.resolve(0); },
    createWardrobeItem(payload) { calls.created.push(payload); return Promise.resolve({ syncStatus: "synced", id: payload.clientRecordId, imageFileId: payload.imageFileId }); }
  };
  let cloudImpl = null;
  const cloudMock = {
    canUseCloud() { return true; },
    callFunction(name, data) {
      calls.functions.push({ name, data });
      if (name === "saveClothing") return Promise.reject(Object.assign(new Error("saveClothing must not be called"), { code: "FORBIDDEN_IN_TEST" }));
      if (!cloudImpl) return Promise.reject(Object.assign(new Error("云函数调用失败"), { code: "CALL_FAILED" }));
      return cloudImpl(name, data).then(({ result }) => {
        if (!result || !result.ok) {
          throw Object.assign(new Error((result && result.errorMessage) || "云函数调用失败"), { code: result && result.errorCode });
        }
        return result.data;
      });
    }
  };
  const wxMock = {
    showLoading() {}, hideLoading() {}, showToast() {},
    showModal(options) { calls.modalTitles.push(options && options.title); if (options && options.success) options.success({ confirm: true }); },
    navigateBack() { calls.navigatedBack += 1; },
    pageScrollTo() {},
    chooseMedia() {}
  };
  return { calls, serviceMock, cloudMock, wxMock, setCloudImpl: (fn) => { cloudImpl = fn; } };
}

function makePage(definition, dataOverrides = {}) {
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); }
  };
  Object.assign(page.data, dataOverrides);
  return page;
}

async function partC() {
  const pagePath = path.resolve(root, "miniprogram/pages/item-upload/item-upload.js");
  const SOURCE_OLD = "cloud://env/wardrobe/user_a/tmp/old.jpg";
  const CUT_OLD = "cloud://env/wardrobe/user_a/tmp/cutout_old.png";
  const CUT_NEW = "cloud://env/wardrobe/user_a/tmp/cutout_new.png";

  // ---- C1（任务 8）：重选图触发旧 source + cutout 的（服务端）删除调用 ----
  {
    const { calls, serviceMock, cloudMock, wxMock, setCloudImpl } = createPageMocks();
    global.wx = wxMock;
    const definition = loadPage(pagePath, serviceMock, cloudMock);
    setCloudImpl(() => Promise.resolve({ result: { ok: true, data: { resultFileId: CUT_NEW, width: 2, height: 2, hasAlpha: true, transparentPixelCount: 1, foregroundPixelCount: 3, elapsedMs: 5 } } }));
    const page = makePage(definition, { localImagePath: "wxfile://store/a.jpg", sourceTempFileId: SOURCE_OLD, cutoutTempFileId: CUT_OLD, uploadState: "success" });
    page.setData({ localImagePath: "wxfile://store/new.jpg" });
    await page.uploadTempImage();
    assert(calls.cleared.includes(SOURCE_OLD), "重选图必须触发旧原图 temp 删除");
    assert(calls.cleared.includes(CUT_OLD), "重选图必须触发旧抠图 temp 删除");
    assert(calls.cleared.every((id) => id.includes("/tmp/")), "只允许清理 tmp 前缀文件");
    assert.strictEqual(page.data.sourceTempFileId !== SOURCE_OLD, true, "新 staging 原图必须换新");
  }

  // ---- C2（任务 9）：取消触发 source + cutout 删除并退出 ----
  {
    const { calls, serviceMock, cloudMock, wxMock } = createPageMocks();
    global.wx = wxMock;
    const definition = loadPage(pagePath, serviceMock, cloudMock);
    const page = makePage(definition, { localImagePath: "wxfile://store/a.jpg", sourceTempFileId: SOURCE_OLD, cutoutTempFileId: CUT_OLD, stagingConfirmed: true });
    await page.cancel();
    assert(calls.cleared.includes(SOURCE_OLD) && calls.cleared.includes(CUT_OLD), "取消必须清理原图与抠图 temp");
    assert.strictEqual(calls.navigatedBack, 1, "取消确认后必须退出页面");
    assert(page.data.sourceTempFileId === "" && page.data.cutoutTempFileId === "", "取消后 staging 字段必须复位");
  }

  // ---- C3（任务 10 + 部分 11）：抠图失败无原图 fallback；删除失败不影响确认语义 ----
  {
    const { calls, serviceMock, cloudMock, wxMock, setCloudImpl } = createPageMocks();
    global.wx = wxMock;
    const definition = loadPage(pagePath, serviceMock, cloudMock);
    // clearTempImage 模拟服务端删除失败
    serviceMock.clearTempImage = (fileId) => { calls.cleared.push(fileId); return Promise.resolve(false); };
    setCloudImpl(() => Promise.resolve({ result: { ok: false, errorCode: "RESULT_NO_FOREGROUND", errorMessage: "抠图结果没有可见的服饰主体，请换一张更清晰的单品图片再试。" } }));
    const page = makePage(definition, { localImagePath: "wxfile://store/a.jpg", imageUrl: "cloud://env/wardrobe/user_a/tmp/src.jpg" });
    await page.uploadTempImage();
    assert.strictEqual(page.data.cutoutState, "error", "抠图失败必须进入明确错误态");
    assert.strictEqual(page.data.cutoutTempFileId, "", "抠图失败不得产生抠图结果引用（无原图 fallback）");
    assert.strictEqual(calls.created.length, 0, "抠图失败不得产生任何保存");
    assert(calls.cleared.length === 0, "抠图失败不得清理原图 temp（保留供重试抠图）");
    // 删除失败背景下，标准化成功后确认语义不受影响
    setCloudImpl(() => Promise.resolve({ result: { ok: true, data: { resultFileId: CUT_NEW, width: 2, height: 2, hasAlpha: true, transparentPixelCount: 1, foregroundPixelCount: 3, elapsedMs: 5 } } }));
    await page.retryCutout();
    assert.strictEqual(page.data.cutoutState, "success");
    await page.confirmCutout();
    assert.strictEqual(page.data.stagingConfirmed, true, "标准化成功后进入属性填写状态");
    // V1.5: 未填属性时 validate 先拦，不触发 create
    page.setData({ step: 3 });
    await page.saveItem();
    assert.strictEqual(calls.created.length, 0, "属性未填时保存被 validate 拦住，不得调用 createWardrobeItem");
    // 离开页面：onUnload 清理 staging，且只触碰 staging 字段里的 tmp 文件
    const stagingSource = page.data.sourceTempFileId;
    const stagingCut = page.data.cutoutTempFileId;
    assert(stagingSource && stagingCut, "离开前 staging 必须仍持有原图与抠图引用");
    page.onUnload();
    assert(calls.cleared.includes(stagingSource) && calls.cleared.includes(stagingCut), "离开页面必须清理 staging 原图与抠图 temp");
    assert(stagingSource.includes("/tmp/") && stagingCut.includes("/tmp/"), "清理对象仅限 tmp 前缀文件");
    assert(page.data.sourceTempFileId === "" && page.data.cutoutTempFileId === "", "离开后 staging 字段复位");
  }

  // ---- C4（任务 14 更新）：确认 cutout 后 V1.5 保存正式启用 ----
  {
    const { calls, serviceMock, cloudMock, wxMock, setCloudImpl } = createPageMocks();
    global.wx = wxMock;
    const definition = loadPage(pagePath, serviceMock, cloudMock);
    setCloudImpl((name) => {
      if (name === "segmentClothing") {
        return Promise.resolve({ result: { ok: true, data: { resultFileId: CUT_NEW, width: 2, height: 2, hasAlpha: true, transparentPixelCount: 1, foregroundPixelCount: 3, elapsedMs: 5 } } });
      }
      return Promise.reject(new Error("unexpected function"));
    });
    const page = makePage(definition, { localImagePath: "wxfile://store/a.jpg" });
    await page.uploadTempImage();
    await page.confirmCutout();
    page.setData({
      step: 3,
      form: { ...page.data.form, name: "确认单品", category: "top", seasons: ["summer"], styles: ["casual"] }
    });
    page.goToConfirm();
    await page.saveItem();
    assert.strictEqual(calls.created.length, 1, "确认 cutout 后 V1.5 保存必须调用 createWardrobeItem");
    assert(calls.created[0].imageFileId.includes("/clothing/"), "保存 payload 必须引用正式 clothing 资产");
    assert(!/\/tmp\//.test(calls.created[0].imageFileId), "保存 payload 不得引用 tmp 文件");
    assert(!calls.functions.some((entry) => entry.name === "saveClothing"), "不得直接调用 saveClothing（应走 createWardrobeItem 队列）");
    assert.strictEqual(page.data.saving, false);
  }
}

// ============================================================
// Part D：页面源码断言（Spike 痕迹清除 + 单品提示）
// ============================================================

function partD() {
  const fs = require("fs");
  const uploadJs = fs.readFileSync(path.join(root, "miniprogram/pages/item-upload/item-upload.js"), "utf8");
  const uploadWxml = fs.readFileSync(path.join(root, "miniprogram/pages/item-upload/item-upload.wxml"), "utf8");
  const uploadWxss = fs.readFileSync(path.join(root, "miniprogram/pages/item-upload/item-upload.wxss"), "utf8");

  // ---- 12. 页面 wxml/js/wxss 不出现 Spike / 技术指标文案 ----
  [uploadJs, uploadWxml, uploadWxss].forEach((source, index) => {
    const label = ["js", "wxml", "wxss"][index];
    assert(!/spike/i.test(source), `item-upload.${label} 不得出现 Spike 痕迹`);
  });
  assert(!uploadJs.includes("透明像素") && !uploadWxml.includes("透明像素"), "透明像素数等技术指标不得展示给用户");
  assert(!uploadJs.includes("cutoutInfo") && !uploadWxml.includes("cutoutInfo"), "技术指标字段必须移除");
  assert(!uploadJs.includes("previewCutout") && !uploadWxml.includes("previewCutout"), "手动 Spike 抠图入口必须移除");
  assert(!uploadJs.includes("cutoutLoading") && !uploadWxml.includes("cutoutLoading"), "loading 态统一收敛到 cutoutState");
  // 抠图失败分支不得展示任何图片节点（无原图 fallback）
  assert(uploadWxml.includes("cutoutState === 'error'") && uploadWxml.includes("class=\"staging-empty\""), "抠图失败态必须是空占位节点，不得回显原图");
  // 确认使用语义：确认按钮文案与保存按钮
  assert(uploadWxml.includes("确认使用"), "必须保留「确认使用」入口");
  assert(uploadWxml.includes("saveItem") || uploadWxml.includes("bindtap=\"saveItem\""), "保存按钮必须绑定 saveItem");
  assert(uploadWxml.includes("保存"), "保存按钮必须有文案");

  // ---- 13. 页面含“每次请上传一件单品”提示 ----
  assert(uploadWxml.includes("每次请上传一件单品"), "选图区必须有单品提示");

  console.log("item-upload formal copy assertions passed");
}

(async () => {
  await partA();
  await partB();
  await partC();
  partD();
  console.log("cutout production tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
