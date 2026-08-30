const assert = require("assert");
const Module = require("module");
const path = require("path");
const zlib = require("zlib");

const FAKE_KEY_ID = "LTAI5tFakeKeyIdForTests0001";
const FAKE_SECRET = "FakeSecretValueDoNotLeak_abcdef0123456789";
const OPENID = "user_123";
const TEMP_FILE_ID = `cloud://env.bucket/wardrobe/${OPENID}/tmp/100_abc.jpg`;
const ENTRY = path.resolve(__dirname, "../cloudfunctions/segmentClothing/index.js");

// ============ PNG fixture 构造（程序化生成最小合法 PNG） ============

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

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

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
    else if (filterType === 4) value = raw[i] - paethPredictor(left, up, upLeft);
    else throw new Error(`bad filter ${filterType}`);
    out[i] = value & 0xff;
  }
  return out;
}

// rows: 每行是未过滤的原始字节序列（按 PNG 排布，已是最终字节），filters: 每行 filter 类型
function encodeScanlines(rows, bitDepth, channels, filters) {
  const bitsPerPixel = channels * bitDepth;
  const bytesPerCompletePixel = Math.max(1, Math.floor((bitsPerPixel + 7) / 8));
  const parts = [];
  let previous = null;
  rows.forEach((row, index) => {
    assert.strictEqual(row.length, rows[0].length, "fixture 每行字节数必须一致");
    const raw = Buffer.from(row);
    const filterType = filters ? filters[index] : 0;
    parts.push(Buffer.concat([Buffer.from([filterType]), filterRowBytes(filterType, raw, previous, bytesPerCompletePixel)]));
    previous = raw;
  });
  return Buffer.concat(parts);
}

function buildPng({ width, height, colorType, bitDepth = 8, rows, trns = null, plte = null, filters = null, interlace = 0 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr)
  ];
  if (plte) parts.push(pngChunk("PLTE", plte));
  if (trns) parts.push(pngChunk("tRNS", trns));
  parts.push(pngChunk("IDAT", zlib.deflateSync(rows)));
  parts.push(pngChunk("IEND", Buffer.alloc(0)));
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

function buildRgbaPng(width, height, pixelFn, options = {}) {
  return buildPng({
    width,
    height,
    colorType: 6,
    rows: encodeScanlines(pixelRows(width, height, 4, pixelFn), 8, 4, options.filters),
    filters: options.filters
  });
}

function buildRgbPng(width, height, pixelFn) {
  return buildPng({
    width,
    height,
    colorType: 2,
    rows: encodeScanlines(pixelRows(width, height, 3, pixelFn), 8, 3, null)
  });
}

function buildGrayAlphaPng(width, height, pixelFn) {
  return buildPng({
    width,
    height,
    colorType: 4,
    rows: encodeScanlines(pixelRows(width, height, 2, pixelFn), 8, 2, null)
  });
}

function buildGrayTrnsPng(width, height, valueFn, trnsValue) {
  return buildPng({
    width,
    height,
    colorType: 0,
    rows: encodeScanlines(pixelRows(width, height, 1, (x, y) => [valueFn(x, y)]), 8, 1, null),
    trns: Buffer.from([trnsValue])
  });
}

function buildPalettePng(width, height, indexFn, plte, trns) {
  return buildPng({
    width,
    height,
    colorType: 3,
    rows: encodeScanlines(pixelRows(width, height, 1, (x, y) => [indexFn(x, y)]), 8, 1, null),
    plte,
    trns
  });
}

function buildRgba16Png(width, height, pixelFn) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelFn(x, y);
      row.push((r >> 8) & 0xff, r & 0xff, (g >> 8) & 0xff, g & 0xff, (b >> 8) & 0xff, b & 0xff, (a >> 8) & 0xff, a & 0xff);
    }
    rows.push(row);
  }
  return buildPng({ width, height, colorType: 6, bitDepth: 16, rows: encodeScanlines(rows, 16, 4, null) });
}

const ADAM7_PASSES = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 }
];

function buildInterlacedRgbaPng(width, height, pixelFn) {
  const full = pixelRows(width, height, 4, pixelFn);
  const parts = [];
  ADAM7_PASSES.forEach((pass) => {
    const passRows = [];
    for (let y = pass.yStart; y < height; y += pass.yStep) {
      const row = [];
      for (let x = pass.xStart; x < width; x += pass.xStep) {
        for (let c = 0; c < 4; c += 1) row.push(full[y][x * 4 + c]);
      }
      if (row.length) passRows.push(row);
    }
    if (passRows.length) parts.push(encodeScanlines(passRows, 8, 4, null));
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[12] = 1;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(parts))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// ============ 云函数加载 harness（Module._load 劫持） ============

function createFakes(options = {}) {
  const state = { uploads: [], advanceCalls: [], clientConfigs: [], runtimeOptions: [], downloads: [] };
  const wxServerSdk = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    getWXContext() { return { OPENID: options.openid === undefined ? OPENID : options.openid }; },
    downloadFile({ fileID }) {
      if (options.downloadFile) return options.downloadFile({ fileID });
      return Promise.reject(new Error("no download impl"));
    },
    uploadFile({ cloudPath, fileContent }) {
      state.uploads.push({ cloudPath, bytes: fileContent ? fileContent.length : 0, isBuffer: Buffer.isBuffer(fileContent) });
      if (options.uploadFile) return options.uploadFile({ cloudPath, fileContent });
      return Promise.resolve({ fileID: `cloud://env.bucket/${cloudPath}` });
    }
  };
  class FakeAdvanceRequest {
    constructor(map) { Object.assign(this, map || {}); }
  }
  const imageseg = {
    default: class FakeSegmentClient {
      constructor(config) { state.clientConfigs.push(config); }
      async segmentClothAdvance(request, runtime) {
        state.advanceCalls.push({ request, runtime });
        if (options.advanceImpl) return options.advanceImpl(request, runtime);
        throw new Error("no advance impl");
      }
    },
    SegmentClothAdvanceRequest: FakeAdvanceRequest
  };
  const openapi = {
    Config: class FakeConfig {
      constructor(map) { Object.assign(this, map || {}); this.endpoint = ""; }
    }
  };
  class FakeRuntimeOptions {
    constructor(map) { Object.assign(this, map || {}); }
  }
  const teaUtil = { default: { RuntimeOptions: FakeRuntimeOptions }, RuntimeOptions: FakeRuntimeOptions };
  return { state, options, wxServerSdk, imageseg, openapi, teaUtil };
}

async function readStreamAll(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

function loadModule(fakes) {
  delete require.cache[ENTRY];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return fakes.wxServerSdk;
    if (request === "@alicloud/imageseg20191230") return fakes.imageseg;
    if (request === "@alicloud/openapi-client") return fakes.openapi;
    if (request === "@alicloud/tea-util") return fakes.teaUtil;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const mod = require(ENTRY);
    if (fakes.options.httpDownload) mod._test.setResultDownloader(fakes.options.httpDownload);
    return mod;
  } finally {
    Module._load = originalLoad;
  }
}

function assertNoSecretLeak(value) {
  const text = JSON.stringify(value);
  assert(!text.includes(FAKE_KEY_ID), "返回值不得包含 AccessKey ID");
  assert(!text.includes(FAKE_SECRET), "返回值/错误信息不得包含 AccessKey Secret");
}

// ============ 用例 ============

async function run() {
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = FAKE_KEY_ID;
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = FAKE_SECRET;

  const transparentPng = buildRgbaPng(6, 4, (x, y) => (y === 0 ? [10, 20, 30, 0] : [40, 50, 60, 255]));
  const opaqueRgbPng = buildRgbPng(6, 4, () => [200, 30, 40]);

  // ---- 0. png-alpha.js 解码器直接验证 ----
  const mod0 = loadModule(createFakes({}));
  const decoder = mod0._test.decodePngAlpha;

  assert.strictEqual(mod0._test.isPngSignature(transparentPng), true);
  assert.strictEqual(mod0._test.isPngSignature(Buffer.from("not a png")), false);
  assert.strictEqual(decoder(Buffer.from("not a png")), null);
  assert.strictEqual(decoder(Buffer.alloc(0)), null);

  const decodedTransparent = decoder(transparentPng);
  assert.deepStrictEqual(
    { width: decodedTransparent.width, height: decodedTransparent.height, hasAlpha: decodedTransparent.hasAlpha, transparentPixelCount: decodedTransparent.transparentPixelCount },
    { width: 6, height: 4, hasAlpha: true, transparentPixelCount: 6 }
  );

  const decodedRgb = decoder(opaqueRgbPng);
  assert.strictEqual(decodedRgb.hasAlpha, false);
  assert.strictEqual(decodedRgb.transparentPixelCount, 0);

  // 全部 5 种 filter 类型逐行覆盖
  const filterPng = buildRgbaPng(4, 5, (x, y) => [x * 10, y * 7, 128, (x + y) % 2 ? 255 : 0], { filters: [0, 1, 2, 3, 4] });
  const decodedFilters = decoder(filterPng);
  assert.strictEqual(decodedFilters.transparentPixelCount, 10, "5 种 filter 类型都必须正确 unfilter");

  // 灰度+alpha（colorType 4）
  const grayAlphaPng = buildGrayAlphaPng(3, 2, (x) => [100 + x, x === 1 ? 0 : 255]);
  const decodedGrayAlpha = decoder(grayAlphaPng);
  assert.strictEqual(decodedGrayAlpha.hasAlpha, true);
  assert.strictEqual(decodedGrayAlpha.transparentPixelCount, 2, "两行中 x=1 的像素均为透明");

  // 灰度 + tRNS（colorType 0）
  const grayTrnsPng = buildGrayTrnsPng(4, 2, (x) => (x === 2 ? 0 : 88), 0);
  const decodedGrayTrns = decoder(grayTrnsPng);
  assert.strictEqual(decodedGrayTrns.hasAlpha, true);
  assert.strictEqual(decodedGrayTrns.transparentPixelCount, 2, "tRNS 命中像素计为透明");

  // 调色板 + tRNS（colorType 3）
  const palettePng = buildPalettePng(4, 2, (x) => (x === 0 ? 1 : 0), Buffer.from([255, 0, 0, 0, 255, 0]), Buffer.from([255, 0]));
  const decodedPalette = decoder(palettePng);
  assert.strictEqual(decodedPalette.hasAlpha, true);
  assert.strictEqual(decodedPalette.transparentPixelCount, 2, "调色板 tRNS alpha=0 的索引计为透明");

  // 16-bit RGBA
  const rgba16Png = buildRgba16Png(2, 2, (x) => (x === 0 ? [0, 0, 0, 0x00ff] : [65535, 65535, 65535, 65535]));
  const decoded16 = decoder(rgba16Png);
  assert.strictEqual(decoded16.transparentPixelCount, 2, "16-bit alpha 归一化后 <255 计为透明");

  // Adam7 隔行 RGBA
  const interlacedPng = buildInterlacedRgbaPng(5, 5, (x, y) => (x === y ? [1, 2, 3, 0] : [9, 9, 9, 255]));
  const decodedInterlaced = decoder(interlacedPng);
  assert.deepStrictEqual(
    { width: decodedInterlaced.width, height: decodedInterlaced.height, transparentPixelCount: decodedInterlaced.transparentPixelCount },
    { width: 5, height: 5, transparentPixelCount: 5 },
    "Adam7 隔行 PNG 必须能正确统计透明像素"
  );

  // 截断的 IDAT（signature + IHDR + IDAT 头被截断，必属非法 PNG）
  assert.strictEqual(decoder(transparentPng.subarray(0, 49)), null);
  mod0._test.setResultDownloader(null);

  // ---- 1. 非本人 temp fileId 被拒 ----
  {
    const fakes = createFakes({});
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: "cloud://env.bucket/wardrobe/other_user/tmp/1.jpg" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "TEMP_FILE_FORBIDDEN");
    assert.strictEqual(fakes.state.uploads.length, 0);
    assert.strictEqual(fakes.state.advanceCalls.length, 0);
  }

  // ---- 2. 非 tmp 路径被拒 ----
  {
    const fakes = createFakes({});
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: `cloud://env.bucket/wardrobe/${OPENID}/formal.jpg` });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "TEMP_FILE_FORBIDDEN");
    const scheme = await loadModule(createFakes({})).main({ tempFileId: "https://evil.example/wardrobe/user_123/tmp/1.jpg" });
    assert.strictEqual(scheme.errorCode, "TEMP_FILE_FORBIDDEN");
  }

  // ---- 3. 缺少 fileId 入参被拒 ----
  {
    const mod = loadModule(createFakes({}));
    assert.strictEqual((await mod.main({})).errorCode, "TEMP_FILE_FORBIDDEN");
    assert.strictEqual((await mod.main({ tempFileId: "" })).errorCode, "TEMP_FILE_FORBIDDEN");
    assert.strictEqual((await mod.main({ tempFileId: 12345 })).errorCode, "TEMP_FILE_FORBIDDEN");
  }

  // ---- 4. SegmentCloth 成功响应被正确解析（含流式上传与上传路径） ----
  {
    const jpegInput = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);
    const fakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: jpegInput }),
      advanceImpl: async (request, runtime) => {
        assert.strictEqual(runtime.connectTimeout, 10000);
        assert.strictEqual(runtime.readTimeout, 45000);
        const uploaded = await readStreamAll(request.imageURLObject);
        assert(uploaded.equals(jpegInput), "原图必须通过流完整交给 SDK");
        return {
          body: {
            requestId: "req-1",
            data: { elements: [{ imageURL: "https://tmp.example.test/segmented.png" }] }
          }
        };
      },
      httpDownload: async (url, opts) => {
        fakes.state.downloads.push({ url, opts });
        return { statusCode: 200, contentType: "image/png", buffer: transparentPng };
      }
    });
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TEMP_FILE_ID, clothClass: "tops" });
    assert.strictEqual(result.ok, true, `成功场景不应失败: ${JSON.stringify(result)}`);
    assert(result.data.resultFileId.startsWith(`cloud://env.bucket/wardrobe/${OPENID}/tmp/cutout_`));
    assert(result.data.resultFileId.endsWith(".png"));
    assert.strictEqual(result.data.width, 6);
    assert.strictEqual(result.data.height, 4);
    assert.strictEqual(result.data.hasAlpha, true);
    assert.strictEqual(result.data.transparentPixelCount, 6);
    assert(typeof result.data.elapsedMs === "number" && result.data.elapsedMs >= 0);

    const call = fakes.state.advanceCalls[0];
    assert.deepStrictEqual(call.request.clothClass, ["tops"], "clothClass 必须按 SDK 3.0.1 的 string[] 传递");
    assert.strictEqual(fakes.state.clientConfigs[0].endpoint, "imageseg.cn-shanghai.aliyuncs.com");
    assert.strictEqual(fakes.state.clientConfigs[0].accessKeyId, FAKE_KEY_ID);
    assert.strictEqual(fakes.state.clientConfigs[0].accessKeySecret, FAKE_SECRET);

    const upload = fakes.state.uploads[0];
    assert(upload, "成功后必须调用 uploadFile");
    assert(upload.cloudPath.startsWith(`wardrobe/${OPENID}/tmp/cutout_`) && upload.cloudPath.endsWith(".png"));
    assert(upload.isBuffer && upload.bytes === transparentPng.length, "上传的必须是下载到的透明 PNG Buffer");
    assert.deepStrictEqual(fakes.state.downloads.map((entry) => entry.url), ["https://tmp.example.test/segmented.png"]);
    assertNoSecretLeak(result);
  }

  // ---- 5. API 抛错 → ok:false + 正确 errorCode + 不含原图 ----
  {
    const fakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: transparentPng }),
      advanceImpl: async () => {
        const error = new Error(`InvalidApi.NotPurchase: the NV API has not been activated for ${FAKE_KEY_ID} / ${FAKE_SECRET}`);
        error.code = "InvalidApi.NotPurchase";
        error.data = { Code: "InvalidApi.NotPurchase" };
        throw error;
      }
    });
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "SEGMENT_API_FAILED");
    assert.strictEqual(result.aliCode, "InvalidApi.NotPurchase");
    assert(!JSON.stringify(result).includes(TEMP_FILE_ID), "失败返回不得包含原图 fileId");
    assert(!JSON.stringify(result).includes("https://tmp.example.test"), "失败返回不得包含结果 URL");
    assert(!JSON.stringify(result).includes(FAKE_KEY_ID) && !JSON.stringify(result).includes(FAKE_SECRET));
    assert.strictEqual(fakes.state.uploads.length, 0);
  }

  // ---- 6. API 失败绝不 fallback 原图 ----
  {
    const fakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: transparentPng }),
      advanceImpl: async () => {
        const error = new Error("throttling by user");
        error.code = "Throttling.User";
        error.data = { Code: "Throttling.User" };
        throw error;
      }
    });
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "SEGMENT_API_FAILED");
    assert.strictEqual(result.aliCode, "Throttling.User");
    assert.strictEqual(result.resultFileId, undefined, "失败不得返回任何 resultFileId");
    assert.strictEqual(fakes.state.uploads.length, 0, "API 失败不得上传任何文件（包括原图）");
    assert.strictEqual(fakes.state.downloads.length, 0);
  }

  // ---- 7. 结果下载失败（超时 / 非 200） ----
  {
    const timeoutFakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/slow.png" }] } } }),
      httpDownload: async () => {
        const error = new Error("socket hang up");
        error.code = "RESULT_DOWNLOAD_TIMEOUT";
        throw error;
      }
    });
    const timeoutMod = loadModule(timeoutFakes);
    const timeoutResult = await timeoutMod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(timeoutResult.errorCode, "RESULT_DOWNLOAD_TIMEOUT");
    assert.strictEqual(timeoutFakes.state.uploads.length, 0);

    const statusFakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/forbidden.png" }] } } }),
      httpDownload: async () => ({ statusCode: 403, contentType: "application/xml", buffer: Buffer.alloc(0) })
    });
    const statusMod = loadModule(statusFakes);
    const statusResult = await statusMod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(statusResult.errorCode, "RESULT_DOWNLOAD_FAILED");
    assert.strictEqual(statusFakes.state.uploads.length, 0);
  }

  // ---- 8. 下载内容非 PNG（伪造 JPEG / HTML）被拒 ----
  {
    const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
    const fakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/fake.jpg" }] } } }),
      httpDownload: async () => ({ statusCode: 200, contentType: "image/jpeg", buffer: fakeJpeg })
    });
    const mod = loadModule(fakes);
    assert.strictEqual((await mod.main({ tempFileId: TEMP_FILE_ID })).errorCode, "RESULT_NOT_PNG");

    const htmlFakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/error.html" }] } } }),
      httpDownload: async () => ({ statusCode: 200, contentType: "image/png", buffer: Buffer.from("<html><body>AccessDenied</body></html>") })
    });
    const htmlMod = loadModule(htmlFakes);
    assert.strictEqual((await htmlMod.main({ tempFileId: TEMP_FILE_ID })).errorCode, "RESULT_NOT_PNG");
  }

  // ---- 9. 无 alpha 的 PNG 被拒（RESULT_NO_ALPHA） ----
  {
    const fakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/rgb.png" }] } } }),
      httpDownload: async () => ({ statusCode: 200, contentType: "image/png", buffer: opaqueRgbPng })
    });
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "RESULT_NO_ALPHA");
    assert.strictEqual(fakes.state.uploads.length, 0);

    const opaqueRgba = buildRgbaPng(3, 3, () => [1, 2, 3, 255]);
    const rgbaFakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/opaque.png" }] } } }),
      httpDownload: async () => ({ statusCode: 200, contentType: "image/png", buffer: opaqueRgba })
    });
    const rgbaMod = loadModule(rgbaFakes);
    const rgbaResult = await rgbaMod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(rgbaResult.errorCode, "RESULT_NO_ALPHA", "全不透明的 RGBA 也必须拒绝");
    assert.strictEqual(rgbaFakes.state.uploads.length, 0);
  }

  // ---- 10. 真透明 PNG（含 tRNS）验证 PASS ----
  {
    const fakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/cut.png" }] } } }),
      httpDownload: async () => ({ statusCode: 200, contentType: "application/octet-stream", buffer: transparentPng })
    });
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(result.ok, true, "部分像素 alpha<255 的 RGBA PNG 必须通过");
    assert.strictEqual(result.data.transparentPixelCount, 6);

    const grayTrns = buildGrayTrnsPng(3, 3, (x) => (x === 0 ? 0 : 200), 0);
    const trnsFakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/trns.png" }] } } }),
      httpDownload: async () => ({ statusCode: 200, contentType: "image/png", buffer: grayTrns })
    });
    const trnsMod = loadModule(trnsFakes);
    const trnsResult = await trnsMod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(trnsResult.ok, true, "靠 tRNS 实现透明的 PNG 也必须通过");
    assert.strictEqual(trnsResult.data.transparentPixelCount, 3);
  }

  // ---- 11. 结果上传路径必须以 wardrobe/{openid}/tmp/ 开头 ----
  {
    const fakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/ok.png" }] } } }),
      httpDownload: async () => ({ statusCode: 200, contentType: "image/png", buffer: transparentPng })
    });
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(result.ok, true);
    const cloudPath = fakes.state.uploads[0].cloudPath;
    assert(cloudPath.startsWith(`wardrobe/${OPENID}/tmp/`), `cloudPath 必须落在 wardrobe/{openid}/tmp/ 下: ${cloudPath}`);
    assert(/cutout_\d+_[0-9a-f]+\.png$/.test(cloudPath), "文件名必须带 cutout_ 前缀且为 png");
    assert(!cloudPath.includes(".."));
  }

  // ---- 12. 返回值/错误信息不含 secret ----
  {
    const fakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => {
        const error = new Error(`AuthFailed: signature mismatch for ${FAKE_KEY_ID}:${FAKE_SECRET}`);
        error.code = "AuthFailed";
        error.data = { Code: "AuthFailed" };
        throw error;
      }
    });
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TEMP_FILE_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "SEGMENT_API_FAILED");
    assert(!result.errorMessage.includes(FAKE_KEY_ID) && !result.errorMessage.includes(FAKE_SECRET), "errorMessage 不得携带原始 SDK 消息");
    assertNoSecretLeak(result);

    const successFakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/ok.png" }] } } }),
      httpDownload: async () => ({ statusCode: 200, contentType: "image/png", buffer: transparentPng })
    });
    const successMod = loadModule(successFakes);
    assertNoSecretLeak(await successMod.main({ tempFileId: TEMP_FILE_ID }));
  }

  // ---- 13. 输入校验补充：CONFIG_MISSING / AUTH_REQUIRED / 输入类型与大小 / 空结果 ----
  {
    const previousId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
    const previousSecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
    try {
      delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
      delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
      const mod = loadModule(createFakes({}));
      const result = await mod.main({ tempFileId: TEMP_FILE_ID });
      assert.strictEqual(result.errorCode, "CONFIG_MISSING");
      assert(!JSON.stringify(result).includes("undefined"));
    } finally {
      process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = previousId;
      process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = previousSecret;
    }

    assert.strictEqual((await loadModule(createFakes({ openid: "" })).main({ tempFileId: TEMP_FILE_ID })).errorCode, "AUTH_REQUIRED");

    const webpInput = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]);
    const webpFakes = createFakes({ downloadFile: () => Promise.resolve({ fileContent: webpInput }) });
    assert.strictEqual((await loadModule(webpFakes).main({ tempFileId: TEMP_FILE_ID })).errorCode, "INPUT_TYPE_UNSUPPORTED");

    const oversized = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3 * 1024 * 1024)]);
    const sizeFakes = createFakes({ downloadFile: () => Promise.resolve({ fileContent: oversized }) });
    assert.strictEqual((await loadModule(sizeFakes).main({ tempFileId: TEMP_FILE_ID })).errorCode, "INPUT_INVALID");

    const downloadFailFakes = createFakes({ downloadFile: () => Promise.reject(new Error("file not found")) });
    assert.strictEqual((await loadModule(downloadFailFakes).main({ tempFileId: TEMP_FILE_ID })).errorCode, "INPUT_UNAVAILABLE");

    const emptyFakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [] } } })
    });
    assert.strictEqual((await loadModule(emptyFakes).main({ tempFileId: TEMP_FILE_ID })).errorCode, "SEGMENT_RESULT_EMPTY");

    const missingElementsFakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: {} } })
    });
    assert.strictEqual((await loadModule(missingElementsFakes).main({ tempFileId: TEMP_FILE_ID })).errorCode, "SEGMENT_RESULT_EMPTY");
  }

  // ---- 14. 纯函数与入参选项补充 ----
  {
    const mod = loadModule(createFakes({}));
    const test = mod._test;
    assert.strictEqual(test.isAllowedTempFileId(TEMP_FILE_ID, OPENID), true);
    assert.strictEqual(test.isAllowedTempFileId(TEMP_FILE_ID, "other_user"), false);
    assert.strictEqual(test.isAllowedTempFileId("cloud://env.bucket/wardrobe/user_123/tmp/x.jpg".padEnd(600, "a"), OPENID), false, "超长 fileId 拒绝");
    assert.strictEqual(test.pickClass("tops"), "tops");
    assert.strictEqual(test.pickClass("dress"), null);
    assert.strictEqual(test.pickClass(undefined), null);
    assert.strictEqual(test.detectImageKind(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "jpeg");
    assert.strictEqual(test.detectImageKind(Buffer.concat([Buffer.from("BM"), Buffer.alloc(10)])), "bmp");
    assert.strictEqual(test.detectImageKind(Buffer.from("plain text buffer!!")), "");
    assert.deepStrictEqual(test.extractResultImageURL({ body: { data: { elements: [{ imageURL: "https://a/b" }, {}] } } }), "https://a/b");
    assert.strictEqual(test.extractResultImageURL({ body: { data: { elements: [{}] } } }), null);
    assert.strictEqual(test.extractResultImageURL(null), null);
    assert.deepStrictEqual(test.mapSegmentError({ code: "TIMEOUT" }), { errorCode: "SEGMENT_TIMEOUT", aliCode: "" });
    assert.deepStrictEqual(test.mapSegmentError({ data: { Code: "InternalError" } }), { errorCode: "SEGMENT_API_FAILED", aliCode: "InternalError" });

    // 非法 clothClass 会被忽略，不进入请求
    const noClassFakes = createFakes({
      downloadFile: () => Promise.resolve({ fileContent: opaqueRgbPng }),
      advanceImpl: async () => ({ body: { data: { elements: [{ imageURL: "https://tmp.example.test/ok.png" }] } } }),
      httpDownload: async () => ({ statusCode: 200, contentType: "image/png", buffer: transparentPng })
    });
    const noClassMod = loadModule(noClassFakes);
    await noClassMod.main({ tempFileId: TEMP_FILE_ID, clothClass: "dress" });
    assert.strictEqual(noClassFakes.state.advanceCalls[0].request.clothClass, undefined);
    assert.strictEqual(noClassFakes.state.advanceCalls[0].request.imageURLObject && typeof noClassFakes.state.advanceCalls[0].request.imageURLObject.on, "function", "imageURLObject 必须是 Readable 流");

    assert(test.buildResultCloudPath(OPENID).startsWith(`wardrobe/${OPENID}/tmp/cutout_`));
    const stream = test.bufferToReadable(Buffer.from("abc"));
    assert.strictEqual((await readStreamAll(stream)).toString(), "abc");
  }

  // ---- 15. item-upload 页面「抠图预览(Spike)」最小 UI 行为 ----
  {
    const CUT_FILE_ID = `cloud://env.bucket/wardrobe/user_a/tmp/cutout_1.png`;
    const calls = { registered: [] };
    const appServiceMock = {
      registerTempImage(fileId) { calls.registered.push(fileId); return { fileId }; },
      sweepExpiredTempImages() { return Promise.resolve(0); }
    };
    let cloudImpl = null;
    const cloudMock = {
      canUseCloud() { return true; },
      // 与 services/cloud.js 的 callFunction 契约一致：成功返回 result.data，失败抛带 code 的错误
      callFunction(name, data) {
        calls.functionName = name;
        calls.functionData = data;
        if (!cloudImpl) return Promise.reject(Object.assign(new Error("云函数调用失败"), { code: "CALL_FAILED" }));
        return cloudImpl(name, data).then(({ result }) => {
          if (!result || !result.ok) {
            throw Object.assign(new Error((result && result.errorMessage) || "云函数调用失败"), { code: result && result.errorCode });
          }
          return result.data;
        });
      }
    };
    global.wx = { showLoading() {}, hideLoading() {}, showToast() {}, showModal() {}, navigateBack() {}, pageScrollTo() {} };
    global.Page = (definition) => { calls.pageDefinition = definition; };
    const pagePath = path.resolve(__dirname, "../miniprogram/pages/item-upload/item-upload.js");
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
      if (request === "../../services/app-service") return appServiceMock;
      if (request === "../../services/cloud") return cloudMock;
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      delete require.cache[require.resolve(pagePath)];
      require(pagePath);
    } finally {
      Module._load = originalLoad;
      delete global.Page;
    }
    const definition = calls.pageDefinition;
    assert(definition.previewCutout, "页面必须提供 previewCutout 处理函数");

    const makePage = () => ({
      ...definition,
      data: { ...definition.data, tempFileId: `cloud://env.bucket/wardrobe/user_a/tmp/1.jpg`, uploadState: "success" },
      setData(patch) { Object.assign(this.data, patch); }
    });

    // 成功：结果登记进 temp registry，展示透明图与 alpha 信息
    cloudImpl = () => Promise.resolve({
      result: { ok: true, data: { resultFileId: CUT_FILE_ID, width: 6, height: 4, hasAlpha: true, transparentPixelCount: 6, elapsedMs: 12 } }
    });
    const page = makePage();
    await page.previewCutout();
    assert.strictEqual(page.data.cutoutState, "success");
    assert.strictEqual(page.data.cutoutImageUrl, CUT_FILE_ID);
    assert(page.data.cutoutInfo.includes("6×4") && page.data.cutoutInfo.includes("6"), "必须展示尺寸与透明像素数");
    assert.deepStrictEqual(calls.registered, [CUT_FILE_ID], "抠图结果必须登记进 temp registry 复用 24h TTL");
    assert.strictEqual(calls.functionName, "segmentClothing");
    assert.strictEqual(calls.functionData.tempFileId, `cloud://env.bucket/wardrobe/user_a/tmp/1.jpg`);

    // 失败：明确显示 errorCode/errorMessage，不得显示原图或伪成功
    cloudImpl = () => Promise.resolve({ result: { ok: false, errorCode: "RESULT_NO_ALPHA", errorMessage: "抠图结果没有透明像素，可能未识别出服饰主体。" } });
    const failedPage = makePage();
    await failedPage.previewCutout();
    assert.strictEqual(failedPage.data.cutoutState, "error");
    assert(failedPage.data.cutoutError.includes("RESULT_NO_ALPHA"), "失败必须展示 errorCode");
    assert(failedPage.data.cutoutError.includes("抠图结果没有透明像素"), "失败必须展示 errorMessage");
    assert.strictEqual(failedPage.data.cutoutImageUrl, "", "失败不得展示任何图片");
    assert.strictEqual(failedPage.data.cutoutState !== "success", true);

    // 云函数 reject（如网络失败）也要落到明确错误
    cloudImpl = () => Promise.reject(Object.assign(new Error("当前环境不支持云开发"), { code: "CLOUD_UNAVAILABLE" }));
    const rejectPage = makePage();
    await rejectPage.previewCutout();
    assert.strictEqual(rejectPage.data.cutoutState, "error");
    assert(rejectPage.data.cutoutError.includes("CLOUD_UNAVAILABLE"));
    assert.strictEqual(rejectPage.data.cutoutLoading, false);
  }

  console.log("segment clothing cloud function tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
