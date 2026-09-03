const assert = require("assert");
const Module = require("module");
const path = require("path");
const crypto = require("crypto");
const { PNG } = require(path.resolve(__dirname, "..", "cloudfunctions/standardizeClothingImage/node_modules/pngjs"));

const root = path.resolve(__dirname, "..");
const FUNCTION_DIR = path.resolve(root, "cloudfunctions/promoteClothingAsset");
const ENTRY = path.resolve(FUNCTION_DIR, "index.js");
const PNGJS_PATH = path.resolve(root, "cloudfunctions/standardizeClothingImage/node_modules/pngjs");

const OPENID = "user_123";
const OTHER_OPENID = "other_user";
const ENV = "test-env";

function buildRgbaPng(width, height, pixelFn) {
  const png = new PNG({ width, height, colorType: 6, inputHasAlpha: true });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelFn(x, y);
      const idx = (y * width + x) * 4;
      png.data[idx] = pixel[0] & 0xff;
      png.data[idx + 1] = pixel[1] & 0xff;
      png.data[idx + 2] = pixel[2] & 0xff;
      png.data[idx + 3] = pixel[3] & 0xff;
    }
  }
  return PNG.sync.write(png, { colorType: 6 });
}

function buildRgbPng(width, height, pixelFn) {
  const png = new PNG({ width, height, colorType: 2 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelFn(x, y);
      const idx = (y * width + x) * 3;
      png.data[idx] = pixel[0] & 0xff;
      png.data[idx + 1] = pixel[1] & 0xff;
      png.data[idx + 2] = pixel[2] & 0xff;
    }
  }
  return PNG.sync.write(png, { colorType: 2 });
}

function validPng() {
  return buildRgbaPng(20, 20, (x, y) => {
    if (x >= 4 && x <= 15 && y >= 4 && y <= 15) return [40, 80, 160, 255];
    return [0, 0, 0, 0];
  });
}

function standardizedFileId(openid) {
  return `cloud://${ENV}/wardrobe/${openid}/tmp/standardized_abc123.png`;
}

function sourceFileId(openid) {
  return `cloud://${ENV}/wardrobe/${openid}/tmp/source_abc.jpg`;
}

function cutoutFileId(openid) {
  return `cloud://${ENV}/wardrobe/${openid}/tmp/cutout_abc.png`;
}

function otherStandardizedFileId() {
  return `cloud://${ENV}/wardrobe/${OTHER_OPENID}/tmp/standardized_abc.png`;
}

function formalFileId(openid, sha256) {
  return `cloud://${ENV}/wardrobe/${openid}/clothing/${sha256}.png`;
}

function createFakes(options = {}) {
  const cloudFiles = new Map();
  const downloadHistory = [];
  const uploadHistory = [];
  const tempFileUrlHistory = [];
  let shouldFailUpload = false;
  let shouldFailDownload = false;

  function setCloudFile(fileId, content) {
    cloudFiles.set(fileId, { content: Buffer.isBuffer(content) ? content : Buffer.from(content || ""), exists: true });
  }

  const wxServerSdk = {
    DYNAMIC_CURRENT_ENV: ENV,
    init() {},
    getWXContext() { return { OPENID: options.openid === undefined ? OPENID : options.openid, ENV }; },
    downloadFile({ fileID }) {
      downloadHistory.push(fileID);
      if (shouldFailDownload) return Promise.reject(new Error("download failed"));
      const entry = cloudFiles.get(fileID);
      if (entry && entry.exists) return Promise.resolve({ fileContent: Buffer.from(entry.content) });
      return Promise.reject(new Error("FILE_NOT_FOUND"));
    },
    uploadFile({ cloudPath, fileContent }) {
      uploadHistory.push({ cloudPath, bytes: fileContent ? fileContent.length : 0 });
      if (shouldFailUpload) return Promise.reject(new Error("upload failed"));
      const fileId = `cloud://${ENV}/${cloudPath}`;
      setCloudFile(fileId, fileContent);
      return Promise.resolve({ fileID: fileId });
    },
    getTempFileURL({ fileList }) {
      tempFileUrlHistory.push(fileList);
      return Promise.resolve({
        fileList: fileList.map((fileId) => {
          const entry = cloudFiles.get(fileId);
          const exists = entry && entry.exists;
          const base = { fileID: fileId };
          if (options.tempShape === "status") {
            // 线上实际形状（Round 2A-4）：无 code 字段，只有 status(0=存在/1=已删) + tempFileURL
            return Object.assign(base, {
              tempFileURL: exists ? `https://temp/${fileId}` : "",
              status: exists ? 0 : 1
            });
          }
          return Object.assign(base, {
            code: exists ? "SUCCESS" : "FILE_NOT_FOUND",
            tempFileURL: exists ? `https://temp/${fileId}` : ""
          });
        })
      });
    }
  };

  // 预置 standardized temp 文件
  const inputPng = options.input || validPng();
  setCloudFile(standardizedFileId(options.openid || OPENID), inputPng);

  return {
    wxServerSdk,
    cloudFiles,
    setCloudFile,
    downloadHistory,
    uploadHistory,
    tempFileUrlHistory,
    get shouldFailUpload() { return shouldFailUpload; },
    set shouldFailUpload(v) { shouldFailUpload = v; },
    get shouldFailDownload() { return shouldFailDownload; },
    set shouldFailDownload(v) { shouldFailDownload = v; }
  };
}

function loadModule(fakes) {
  delete require.cache[ENTRY];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return fakes.wxServerSdk;
    if (request === "pngjs") return originalLoad.call(this, PNGJS_PATH, parent, isMain);
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(ENTRY);
  } finally {
    Module._load = originalLoad;
  }
}

async function run() {
  // 1,7: 未标准化成功不能 save — 拒绝非 standardized temp
  {
    const fakes = createFakes({ input: validPng() });
    const mod = loadModule(fakes);
    const invalidIds = [
      sourceFileId(OPENID),
      cutoutFileId(OPENID),
      otherStandardizedFileId(),
      "cloud://env/wardrobe/user_123/tmp/random.png",
      "not-a-cloud-id",
      ""
    ];
    for (const id of invalidIds) {
      const result = await mod.main({ standardizedTempFileId: id });
      assert.strictEqual(result.ok, false, `非 standardized temp 必须拒绝: ${id}`);
      assert(result.errorCode === "INPUT_FORBIDDEN" || result.errorCode === "INPUT_REQUIRED", `必须返回明确错误码: ${id} -> ${result.errorCode}`);
    }
    // 没有触发任何下载（权限拒绝）
    assert.strictEqual(fakes.downloadHistory.length, 0, "权限拒绝不得下载文件");
  }

  // 2: 他人 standardized 拒绝
  {
    const fakes = createFakes({ openid: OTHER_OPENID });
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "INPUT_FORBIDDEN");
  }

  // 3: promotion 输出 /clothing/ 路径
  {
    const fakes = createFakes({ input: validPng() });
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, true, `promotion 必须成功: ${JSON.stringify(result)}`);
    assert(result.data.formalImageFileId.includes("/clothing/"), "输出路径必须包含 /clothing/");
    assert(!result.data.formalImageFileId.includes("/tmp/"), "输出路径不得包含 /tmp/");
    assert.strictEqual(result.data.status, "PROMOTED");
    assert.strictEqual(fakes.uploadHistory.length, 1);
    assert(fakes.uploadHistory[0].cloudPath.includes("/clothing/"), "上传路径必须包含 /clothing/");
  }

  // 4: 内容寻址 — SHA256 一致
  {
    const png = validPng();
    const sha256 = crypto.createHash("sha256").update(png).digest("hex");
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.sha256, sha256);
    assert(result.data.formalImageFileId.endsWith(`/${sha256}.png`), "formal 路径必须包含 SHA256");
  }

  // 5: 重复 promotion 幂等 — 同一 standardized
  {
    const png = validPng();
    const sha256 = crypto.createHash("sha256").update(png).digest("hex");
    const fakes = createFakes({ input: png });
    // 先手动 mock 已存在目标 formal 文件
    fakes.setCloudFile(formalFileId(OPENID, sha256), png);
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, true, `幂等 promotion 必须成功: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.status, "IDEMPOTENT");
    assert.strictEqual(result.data.sha256, sha256);
    // 不应再次上传
    assert.strictEqual(fakes.uploadHistory.length, 0, "幂等不应再次上传");
  }

  // 6: existing hash 一致 → IDEMPOTENT
  {
    const png = validPng();
    const sha256 = crypto.createHash("sha256").update(png).digest("hex");
    const fakes = createFakes({ input: png });
    fakes.setCloudFile(formalFileId(OPENID, sha256), png);
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.status, "IDEMPOTENT");
  }

  // 7: existing hash 冲突 → FORMAL_ASSET_HASH_CONFLICT
  {
    const png = validPng();
    const sha256 = crypto.createHash("sha256").update(png).digest("hex");
    const differentPng = buildRgbaPng(20, 20, (x, y) => {
      if (x >= 4 && x <= 15 && y >= 4 && y <= 15) return [200, 100, 50, 255];
      return [0, 0, 0, 0];
    });
    const fakes = createFakes({ input: png });
    fakes.setCloudFile(formalFileId(OPENID, sha256), differentPng);
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "FORMAL_ASSET_HASH_CONFLICT");
  }

  // 8: promotion 不删 standardized temp
  {
    const fakes = createFakes({ input: validPng() });
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, true);
    // 验证 standardized temp 仍然存在（未删除）
    const probeResult = await fakes.wxServerSdk.getTempFileURL({ fileList: [standardizedFileId(OPENID)] });
    const probeEntry = probeResult.fileList[0];
    assert.strictEqual(probeEntry.code, "SUCCESS", "standardized temp 必须保留");
  }

  // 9: formal 不进 temp registry（云函数不涉及 temp registry）
  {
    const fakes = createFakes({ input: validPng() });
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, true);
    // 云函数无 temp registry 概念，打日志确认无副作用
    assert(!result.data.formalImageFileId.includes("/tmp/"), "formal 不得在 tmp 目录");
  }

  // 10: PNG 验证 — 不带 alpha 拒绝
  {
    const rgbPng = buildRgbPng(10, 10, () => [200, 30, 40]);
    const fakes = createFakes({ input: rgbPng });
    fakes.setCloudFile(standardizedFileId(OPENID), rgbPng);
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "NO_ALPHA");
  }

  // 11: 全透明 PNG 拒绝
  {
    const transparentPng = buildRgbaPng(10, 10, () => [0, 0, 0, 0]);
    const fakes = createFakes({ input: transparentPng });
    fakes.setCloudFile(standardizedFileId(OPENID), transparentPng);
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "NO_FOREGROUND");
  }

  // 12: 超大 PNG 拒绝
  {
    const largePng = buildRgbaPng(2000, 2000, (x, y) => {
      if (x >= 100 && x <= 1900 && y >= 100 && y <= 1900) return [40, 80, 160, 255];
      return [0, 0, 0, 0];
    });
    const fakes = createFakes({ input: largePng });
    fakes.setCloudFile(standardizedFileId(OPENID), largePng);
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, false);
    assert(result.errorCode === "INPUT_INVALID");
  }

  // 13: 上传失败返回错误
  {
    const fakes = createFakes({ input: validPng() });
    fakes.shouldFailUpload = true;
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "UPLOAD_FAILED");
  }

  // 14: 下载失败返回错误
  {
    const fakes = createFakes({ input: validPng() });
    fakes.shouldFailDownload = true;
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "INPUT_UNAVAILABLE");
  }

  // 15: 未授权
  {
    const fakes = createFakes({ openid: "" });
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "AUTH_REQUIRED");
  }

  // 16: 返回数据完整
  {
    const png = validPng();
    const sha256 = crypto.createHash("sha256").update(png).digest("hex");
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, true);
    assert(typeof result.data.formalImageFileId === "string" && result.data.formalImageFileId.length > 0);
    assert(typeof result.data.sha256 === "string" && result.data.sha256.length > 0);
    assert(Number.isInteger(result.data.width) && result.data.width > 0);
    assert(Number.isInteger(result.data.height) && result.data.height > 0);
    assert(Number.isInteger(result.data.bytes) && result.data.bytes > 0);
    assert(["PROMOTED", "IDEMPOTENT"].includes(result.data.status));
  }

  // 17: 上传后 read-back/existence 校验（上传成功自动验证）
  {
    const fakes = createFakes({ input: validPng() });
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, true);
    // 上传后 formal 文件应可访问
    const probeResult = await fakes.wxServerSdk.getTempFileURL({ fileList: [result.data.formalImageFileId] });
    const entry = probeResult.fileList[0];
    assert.strictEqual(entry.code, "SUCCESS", "上传后 formal 文件必须可访问");
    assert(entry.tempFileURL.length > 0, "formal 文件的 tempFileURL 必须非空");
  }

  // 18: 线上实际形状（无 code 字段，仅 status:0 + tempFileURL）→ 首次 promotion 通过复核
  {
    const png = validPng();
    const sha256 = crypto.createHash("sha256").update(png).digest("hex");
    const fakes = createFakes({ input: png, tempShape: "status" });
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, true, `status-only 形状 promotion 必须成功: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.status, "PROMOTED");
    assert.strictEqual(result.data.sha256, sha256);
    assert(result.data.formalImageFileId.endsWith(`/${sha256}.png`));
    assert.strictEqual(fakes.uploadHistory.length, 1, "status-only 形状下不存在性探测走上传");
  }

  // 19: 线上实际形状 + 目标已存在（status:0）→ 幂等探测通过返回 IDEMPOTENT
  {
    const png = validPng();
    const sha256 = crypto.createHash("sha256").update(png).digest("hex");
    const fakes = createFakes({ input: png, tempShape: "status" });
    fakes.setCloudFile(formalFileId(OPENID, sha256), png);
    const mod = loadModule(fakes);
    const result = await mod.main({ standardizedTempFileId: standardizedFileId(OPENID) });
    assert.strictEqual(result.ok, true, `status-only 形状幂等 promotion 必须成功: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.status, "IDEMPOTENT");
    assert.strictEqual(fakes.uploadHistory.length, 0, "幂等不应再次上传");
  }

  // 20: isExistingTempUrlEntry 兼容判定语义
  {
    const mod = loadModule(createFakes({ input: validPng() }));
    const is = mod._test.isExistingTempUrlEntry;
    // 线上无 code 形状：status:0 + tempFileURL → 存在
    assert.strictEqual(is({ tempFileURL: "https://t/x", status: 0 }), true);
    // 线上无 code 形状 + tempFileURL 非空（code 缺失视为无负向标记）→ 存在
    assert.strictEqual(is({ tempFileURL: "https://t/x" }), true);
    // 无 tempFileURL（不存在/已删）→ 不存在，无论 status 是否给出
    assert.strictEqual(is({ tempFileURL: "", status: 1 }), false);
    assert.strictEqual(is({ status: 1 }), false);
    // 负向 status 优先拒绝，即使仍带回 tempFileURL
    assert.strictEqual(is({ tempFileURL: "https://t/x", status: 1 }), false, "status=1 视为已删/不可用");
    // 带 code 形状：SUCCESS + status=0 → 存在
    assert.strictEqual(is({ tempFileURL: "https://t/x", code: "SUCCESS", status: 0 }), true);
    // 矛盾形状：负向 status 或负向 code 一律拒绝
    assert.strictEqual(is({ tempFileURL: "https://t/x", code: "SUCCESS", status: 1 }), false, "status=1 优先于 SUCCESS");
    assert.strictEqual(is({ tempFileURL: "https://t/x", code: "FILE_NOT_FOUND", status: 0 }), false, "负向 code 优先拒绝");
    // code 明确为负向值（FILE_NOT_FOUND）→ 拒绝为存在
    assert.strictEqual(is({ tempFileURL: "https://t/x", code: "FILE_NOT_FOUND" }), false);
    assert.strictEqual(is(null), false);
    assert.strictEqual(is(undefined), false);
  }

  console.log("promote clothing asset tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});