const assert = require("assert");
const Module = require("module");
const path = require("path");
const zlib = require("zlib");
const fs = require("fs");
const os = require("os");

const root = path.resolve(__dirname, "..");
const ENTRY = path.resolve(root, "cloudfunctions/standardizeClothingImage/index.js");
const GEOMETRY = path.resolve(root, "cloudfunctions/standardizeClothingImage/image-standardize.js");
const PNG_ALPHA = path.resolve(root, "cloudfunctions/segmentClothing/png-alpha.js");

// pngjs 解析顺序：PNGJS_PATH 环境变量 → 仓库根 node_modules/pngjs（pngjs 为零依赖纯 JS，
// 直接拷贝或 npm install 均可）。云函数目录自身不携带 node_modules（部署走云端安装）。
function resolvePngjsPath() {
  if (process.env.PNGJS_PATH) return process.env.PNGJS_PATH;
  const repoLocal = path.join(root, "node_modules", "pngjs");
  if (fs.existsSync(path.join(repoLocal, "package.json"))) return repoLocal;
  throw new Error("pngjs not found: set PNGJS_PATH or install pngjs into repo-root node_modules");
}
const PNGJS_PATH = resolvePngjsPath();

const OPENID = "user_123";
const OTHER_OPENID = "other_user";
const CUTOUT_ID = `cloud://env.bucket/wardrobe/${OPENID}/tmp/cutout_100_abc.png`;
const SOURCE_ID = `cloud://env.bucket/wardrobe/${OPENID}/tmp/100_abc.jpg`;
const OTHER_CUTOUT_ID = `cloud://env.bucket/wardrobe/${OTHER_OPENID}/tmp/cutout_100_abc.png`;
const FORMAL_ID = `cloud://env.bucket/wardrobe/${OPENID}/formal.png`;
const REFERENCE_ID = `cloud://env.bucket/wardrobe/${OPENID}/references/ref.png`;
const STANDARD_ID = `cloud://env.bucket/wardrobe/${OPENID}/tmp/standardized_100_abc.png`;

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

function encodeScanlines(rows) {
  const parts = [];
  rows.forEach((row) => {
    parts.push(Buffer.concat([Buffer.from([0]), Buffer.from(row)]));
  });
  return Buffer.concat(parts);
}

function pixelRows(width, height, pixelFn) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelFn(x, y);
      for (let c = 0; c < 4; c += 1) row.push(pixel[c] & 0xff);
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
    pngChunk("IDAT", zlib.deflateSync(encodeScanlines(pixelRows(width, height, pixelFn)))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function buildRgbPng(width, height, pixelFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelFn(x, y);
      row.push(pixel[0] & 0xff, pixel[1] & 0xff, pixel[2] & 0xff);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(encodeScanlines(rows))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngToRgba(png) {
  const { decodePngAlpha } = require(PNG_ALPHA);
  const decoded = decodePngAlpha(png);
  assert(decoded, "fixture PNG 必须可被 png-alpha 解码");
  let pos = 8;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = decoded.width * 4;
  const out = Buffer.alloc(decoded.height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < decoded.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? cur[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 0xff;
      }
      cur[x] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { ...decoded, rgba: out };
}

function rectGarment({ canvasW, canvasH, x0, y0, x1, y1, alpha = 255, fringe = 0 }) {
  return buildRgbaPng(canvasW, canvasH, (x, y) => {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return [40, 80, 160, alpha];
    if (fringe > 0) {
      const nearX = x >= x0 - fringe && x <= x1 + fringe;
      const nearY = y >= y0 - fringe && y <= y1 + fringe;
      if (nearX && nearY && !(x >= x0 && x <= x1 && y >= y0 && y <= y1)) {
        return [40, 80, 160, 40];
      }
    }
    return [0, 0, 0, 0];
  });
}

function createFakes(options = {}) {
  const state = { uploads: [], downloads: [] };
  const wxServerSdk = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    getWXContext() { return { OPENID: options.openid === undefined ? OPENID : options.openid }; },
    downloadFile({ fileID }) {
      state.downloads.push(fileID);
      if (options.downloadImpl) return options.downloadImpl(fileID);
      return Promise.resolve({ fileContent: options.input || Buffer.alloc(0) });
    },
    uploadFile({ cloudPath, fileContent }) {
      state.uploads.push({ cloudPath, bytes: fileContent ? fileContent.length : 0, buffer: fileContent });
      return Promise.resolve({ fileID: `cloud://env.bucket/${cloudPath}` });
    }
  };
  return { state, wxServerSdk };
}

function loadModule(fakes) {
  delete require.cache[ENTRY];
  delete require.cache[GEOMETRY];
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

function assertRatioKept(aW, aH, bW, bH, label) {
  const a = aW / aH;
  const b = bW / bH;
  assert.ok(Math.abs(a - b) / a < 0.02, `${label} 宽高比必须保持: ${aW}x${aH} vs ${bW}x${bH}`);
}

async function run() {
  const geometry = require(GEOMETRY);
  const { decodePngAlpha } = require(PNG_ALPHA);
  const classify = geometry.classifyCutoutFileId;

  // ---- 17-20. 输入权限边界 ----
  assert.strictEqual(classify(CUTOUT_ID, OPENID), "ok", "当前用户 cutout 路径必须通过");
  assert.strictEqual(classify(SOURCE_ID, OPENID), "forbidden", "source temp 路径必须拒绝");
  assert.strictEqual(classify(STANDARD_ID, OPENID), "forbidden", "standardized 文件不得作为输入");
  assert.strictEqual(classify(OTHER_CUTOUT_ID, OPENID), "forbidden", "他人 cutout 必须拒绝");
  assert.strictEqual(classify(FORMAL_ID, OPENID), "forbidden", "正式 clothing 路径必须拒绝");
  assert.strictEqual(classify(REFERENCE_ID, OPENID), "forbidden", "references 路径必须拒绝");
  assert.strictEqual(classify("https://evil.example/wardrobe/user_123/tmp/cutout_1.png", OPENID), "invalid");
  assert.strictEqual(classify(`cloud://env.bucket/wardrobe/${OPENID}/tmp/../cutout_1.png`, OPENID), "invalid");
  assert.strictEqual(classify(`cloud://env.bucket/wardrobe/${OPENID}/tmp/a/cutout_1.png`, OPENID), "forbidden");

  // ---- 几何：padding 与 resize ----
  assert.strictEqual(geometry.computePadding({ width: 10, height: 10 }), 8, "极小主体使用最小 padding");
  assert.strictEqual(geometry.computePadding({ width: 2000, height: 2000 }), 48, "极大主体使用最大 padding");
  assert.strictEqual(geometry.computePadding({ width: 500, height: 400 }), 20, "中等主体使用 4% padding");
  const noResize = geometry.computeTargetSize(200, 300, 1024);
  assert.deepStrictEqual(noResize, { width: 200, height: 300, resized: false, scale: 1 }, "小图不得无意义放大");
  const resized = geometry.computeTargetSize(2000, 1000, 1024);
  assert.strictEqual(resized.resized, true);
  assert.strictEqual(resized.width, 1024);
  assert.strictEqual(resized.height, 512);

  // ---- 1. 普通 RGBA 主体 + 大透明边 ----
  {
    const png = rectGarment({ canvasW: 80, canvasH: 80, x0: 20, y0: 20, x1: 49, y1: 59 });
    const { rgba, width, height } = pngToRgba(png);
    const plan = geometry.planStandardize(rgba, width, height);
    assert.strictEqual(plan.ok, true);
    assert.deepStrictEqual(plan.bbox, { minX: 20, minY: 20, maxX: 49, maxY: 59, width: 30, height: 40 });
    assert.deepStrictEqual(plan.trim, { left: 20, top: 20, right: 30, bottom: 20 });
    assert.strictEqual(plan.padding, 8);
    assert.strictEqual(plan.paddedWidth, 46);
    assert.strictEqual(plan.paddedHeight, 56);
    assert.strictEqual(plan.resized, false);

    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ cutoutTempFileId: CUTOUT_ID });
    assert.strictEqual(result.ok, true, `大透明边必须 PASS: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.width, 46);
    assert.strictEqual(result.data.height, 56);
    assert.strictEqual(result.data.resized, false);
    assert.ok(result.data.hasAlpha);
    assert.ok(result.data.transparentPixelCount > 0);
    assert.ok(result.data.foregroundPixelCount > 0);
    assert.ok(result.data.standardizedTempFileId.includes("/tmp/standardized_"));
    assert.ok(result.data.standardizedTempFileId.endsWith(".png"));
    assert.notStrictEqual(fakes.state.uploads[0].buffer.equals(png), true, "输出不得原图透传");
    const outDecoded = decodePngAlpha(fakes.state.uploads[0].buffer);
    assert.strictEqual(outDecoded.hasAlpha, true);
    assert.ok(outDecoded.foregroundPixelCount > 0);
    assertRatioKept(plan.paddedWidth, plan.paddedHeight, outDecoded.width, outDecoded.height, "case1");
  }

  // ---- 2-6. 主体贴边 ----
  const edgeCases = [
    { name: "left", x0: 0, y0: 10, x1: 19, y1: 29 },
    { name: "right", x0: 60, y0: 10, x1: 79, y1: 29 },
    { name: "top", x0: 20, y0: 0, x1: 39, y1: 19 },
    { name: "bottom", x0: 20, y0: 60, x1: 39, y1: 79 },
    { name: "all", x0: 1, y0: 1, x1: 78, y1: 78 }
  ];
  for (const edge of edgeCases) {
    const png = rectGarment({ canvasW: 80, canvasH: 80, x0: edge.x0, y0: edge.y0, x1: edge.x1, y1: edge.y1 });
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ cutoutTempFileId: CUTOUT_ID });
    assert.strictEqual(result.ok, true, `贴${edge.name}边必须 PASS: ${JSON.stringify(result)}`);
    assert.ok(result.data.foregroundPixelCount > 0, `贴${edge.name}边不得裁断主体`);
    const bbox = result.data.bbox;
    assert.strictEqual(bbox.minX, edge.x0, `贴${edge.name}边 bbox.minX`);
    assert.strictEqual(bbox.minY, edge.y0, `贴${edge.name}边 bbox.minY`);
    assert.strictEqual(bbox.maxX, edge.x1, `贴${edge.name}边 bbox.maxX`);
    assert.strictEqual(bbox.maxY, edge.y1, `贴${edge.name}边 bbox.maxY`);
  }

  // ---- 7. 半透明抗锯齿边缘不得被裁掉 ----
  {
    const png = rectGarment({ canvasW: 60, canvasH: 60, x0: 20, y0: 20, x1: 39, y1: 39, fringe: 2 });
    const { rgba, width, height } = pngToRgba(png);
    const plan = geometry.planStandardize(rgba, width, height);
    assert.ok(plan.bbox.minX <= 18 && plan.bbox.maxX >= 41, "alpha=40 的抗锯齿边缘必须进入 bbox");
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ cutoutTempFileId: CUTOUT_ID });
    assert.strictEqual(result.ok, true);
    assert.ok(result.data.transparentPixelCount > 0);
    assert.ok(result.data.foregroundPixelCount > 0);
  }

  // ---- 8. 全透明 PNG FAIL ----
  {
    const png = buildRgbaPng(12, 10, () => [10, 20, 30, 0]);
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ cutoutTempFileId: CUTOUT_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "RESULT_NO_FOREGROUND");
    assert.strictEqual(fakes.state.uploads.length, 0);
  }

  // ---- 9. 全不透明 PNG FAIL ----
  {
    const png = buildRgbPng(12, 10, () => [200, 30, 40]);
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ cutoutTempFileId: CUTOUT_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "RESULT_NO_ALPHA");
    assert.strictEqual(fakes.state.uploads.length, 0);
  }

  // ---- 10. 极窄主体 ----
  {
    const png = rectGarment({ canvasW: 40, canvasH: 40, x0: 18, y0: 5, x1: 19, y1: 34 });
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ cutoutTempFileId: CUTOUT_ID });
    assert.strictEqual(result.ok, true, `极窄主体必须 PASS: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.bbox.width, 2);
    assert.ok(result.data.foregroundPixelCount > 0);
    assertRatioKept(result.data.bbox.width + result.data.padding * 2, result.data.bbox.height + result.data.padding * 2, result.data.width, result.data.height, "narrow");
  }

  // ---- 11. 极宽主体 ----
  {
    const png = rectGarment({ canvasW: 50, canvasH: 20, x0: 2, y0: 8, x1: 47, y1: 9 });
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ cutoutTempFileId: CUTOUT_ID });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.bbox.height, 2);
    assert.ok(result.data.foregroundPixelCount > 0);
  }

  // ---- 12. 超大图片缩小 ----
  {
    const png = rectGarment({ canvasW: 80, canvasH: 80, x0: 10, y0: 10, x1: 69, y1: 69 });
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const origPlan = geometry.planStandardize(pngToRgba(png).rgba, 80, 80, { maxSide: 40 });
    assert.strictEqual(origPlan.resized, true);
    const rendered = mod._test.processStandardizedPng(png, origPlan);
    const decoded = decodePngAlpha(rendered);
    assert.ok(decoded.width <= 40 && decoded.height <= 40);
    assert.ok(decoded.hasAlpha && decoded.foregroundPixelCount > 0);
    assertRatioKept(origPlan.paddedWidth, origPlan.paddedHeight, decoded.width, decoded.height, "resize");
  }

  // ---- 13. 小图片不无意义放大 ----
  {
    const png = rectGarment({ canvasW: 30, canvasH: 30, x0: 8, y0: 8, x1: 21, y1: 21 });
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ cutoutTempFileId: CUTOUT_ID });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.resized, false);
    assert.ok(result.data.width < 1024 && result.data.height < 1024);
  }

  // ---- 14-16. 比例 / alpha / foreground ----
  {
    const png = rectGarment({ canvasW: 64, canvasH: 48, x0: 12, y0: 8, x1: 43, y1: 39 });
    const fakes = createFakes({ input: png });
    const mod = loadModule(fakes);
    const result = await mod.main({ cutoutTempFileId: CUTOUT_ID });
    assert.strictEqual(result.ok, true);
    assertRatioKept(result.data.bbox.width + result.data.padding * 2, result.data.bbox.height + result.data.padding * 2, result.data.width, result.data.height, "keep-ratio");
    assert.strictEqual(result.data.hasAlpha, true);
    assert.ok(result.data.transparentPixelCount > 0);
    assert.ok(result.data.foregroundPixelCount > 0);
  }

  // ---- 云函数权限拒绝不会下载 ----
  {
    const fakes = createFakes({ input: rectGarment({ canvasW: 20, canvasH: 20, x0: 4, y0: 4, x1: 10, y1: 10 }) });
    const mod = loadModule(fakes);
    const sourceReject = await mod.main({ cutoutTempFileId: SOURCE_ID });
    assert.strictEqual(sourceReject.errorCode, "TEMP_FILE_FORBIDDEN");
    const otherReject = await mod.main({ cutoutTempFileId: OTHER_CUTOUT_ID });
    assert.strictEqual(otherReject.errorCode, "TEMP_FILE_FORBIDDEN");
    const formalReject = await mod.main({ cutoutTempFileId: FORMAL_ID });
    assert.strictEqual(formalReject.errorCode, "TEMP_FILE_FORBIDDEN");
    const refReject = await mod.main({ cutoutTempFileId: REFERENCE_ID });
    assert.strictEqual(refReject.errorCode, "TEMP_FILE_FORBIDDEN");
    assert.strictEqual(fakes.state.downloads.length, 0, "权限拒绝不得下载文件");
    assert.strictEqual(fakes.state.uploads.length, 0);
  }

  {
    const fakes = createFakes({ openid: "" });
    const mod = loadModule(fakes);
    const result = await mod.main({ cutoutTempFileId: CUTOUT_ID });
    assert.strictEqual(result.errorCode, "AUTH_REQUIRED");
  }

  // deleteWardrobeTemp 必须仍能识别 standardized 路径为本人 tmp 文件
  {
    const delEntry = path.resolve(root, "cloudfunctions/deleteWardrobeTemp/index.js");
    delete require.cache[delEntry];
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
      if (request === "wx-server-sdk") {
        return {
          DYNAMIC_CURRENT_ENV: "test",
          init() {},
          getWXContext() { return { OPENID }; }
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      const del = require(delEntry);
      assert.strictEqual(del._test.classifyTempFileId(STANDARD_ID, OPENID), "ok", "deleteWardrobeTemp 必须能删除 standardized tmp");
      assert.strictEqual(del._test.classifyTempFileId(CUTOUT_ID, OPENID), "ok");
      assert.strictEqual(del._test.classifyTempFileId(SOURCE_ID, OPENID), "ok");
    } finally {
      Module._load = originalLoad;
    }
  }

  // 云函数目录必须能独立 require（部署结构）
  {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoyichu-standardize-"));
    try {
      const isolatedFunction = path.join(isolatedRoot, "standardizeClothingImage");
      fs.cpSync(path.dirname(ENTRY), isolatedFunction, { recursive: true });
      assert(fs.existsSync(path.join(isolatedFunction, "png-alpha.js")));
      assert(fs.existsSync(path.join(isolatedFunction, "image-standardize.js")));
      assert(fs.existsSync(path.join(isolatedFunction, "image-process.js")));
      assert(fs.existsSync(path.join(isolatedFunction, "package.json")));
      const pkg = JSON.parse(fs.readFileSync(path.join(isolatedFunction, "package.json"), "utf8"));
      assert.strictEqual(pkg.dependencies.pngjs, "7.0.0");
      assert.ok(!pkg.dependencies.sharp, "不得再依赖 sharp native binary");
    } finally {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }

  console.log("standardize clothing image tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
