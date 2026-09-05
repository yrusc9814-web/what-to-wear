const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

/**
 * Round 2B-1 reviewer fix：getOutfitRecords 读侧对 layout 做服务端收口。
 * mapOutfit 不再原样透传 raw layout，而是经 shared/outfit-slots.sanitizeOutfitLayout 收口：
 *  - 合法 layout 原样返回（数值 JSON-safe）
 *  - 病态 layout（Infinity/NaN/白名单外字段/越界数值）被收口为合法 schema
 *  - 非法 version（含字符串 "1"）→ layout: null
 *  - legacy（无 layout 字段）→ layout: null
 *  - 纯读操作，不得改写入库 raw 记录（不 backfill）
 */

const openid = "openid_read_sanitize";
const rows = [
  {
    _id: "read_clean",
    clientRecordId: "read_clean",
    openid,
    title: "干净搭配",
    season: "summer",
    style: "casual",
    items: {},
    isDeleted: false,
    layout: {
      version: 1,
      canvas: { width: 360, height: 300 },
      slots: {
        top: { x: 240, y: 120, scale: 1.6, zIndex: 7 },
        hat: null
      }
    }
  },
  {
    _id: "read_poison",
    clientRecordId: "read_poison",
    openid,
    title: "病态搭配",
    season: "summer",
    style: "casual",
    items: {},
    isDeleted: false,
    layout: {
      version: 1,
      canvas: { width: Infinity, height: 300 },
      slots: {
        top: { x: "bad", y: 1e9, scale: 999, zIndex: 1e9, width: 777, selected: true },
        bag: { itemId: "ghost", snapshot: {} },
        bottom: null
      }
    }
  },
  {
    _id: "read_legacy",
    clientRecordId: "read_legacy",
    openid,
    title: "旧搭配",
    season: "summer",
    style: "casual",
    items: {},
    isDeleted: false
  },
  {
    _id: "read_version_string",
    clientRecordId: "read_version_string",
    openid,
    title: "字符串版本",
    season: "summer",
    style: "casual",
    items: {},
    isDeleted: false,
    layout: { version: "1", canvas: { width: 360, height: 300 }, slots: { top: { x: 10, y: 10, scale: 1, zIndex: 1 } } }
  },
  {
    _id: "read_version_2",
    clientRecordId: "read_version_2",
    openid,
    title: "未来版本",
    season: "summer",
    style: "casual",
    items: {},
    isDeleted: false,
    layout: { version: 2, canvas: { width: 360, height: 300 }, slots: {} }
  }
];

const fake = createFakeCloud({ clothing_items: [], outfit_records: rows }, openid, {
  autoRegisterCloudFiles: false
});

function load(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  delete require.cache[filename];
  const originalLoad = Module._load;
  Module._load = function loadModule(request, parent, isMain) {
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

const getOutfits = load("cloudfunctions/getOutfitRecords/index.js");

(async () => {
  const result = await getOutfits.main({ pageSize: 99 });
  assert.strictEqual(result.ok, true);
  const items = result.data.items;

  // ---- 1. 合法 layout 读回一致 ----
  const clean = items.find((item) => item.id === "read_clean");
  assert(clean, "干净记录可读回");
  assert.strictEqual(clean.layout.version, 1);
  assert.deepStrictEqual(clean.layout.slots.top, { x: 240, y: 120, scale: 1.6, zIndex: 7 });
  assert.strictEqual(clean.layout.slots.hat, null);

  // ---- 2. 病态 layout 读侧收口：有限数值、白名单字段、限幅、默认画布回退 ----
  const poison = items.find((item) => item.id === "read_poison");
  assert(poison, "病态记录可读回");
  assert.strictEqual(poison.layout.version, 1);
  assert.deepStrictEqual(poison.layout.canvas, { width: 360, height: 300 }, "非法画布（Infinity）回退默认基准");
  assert.deepStrictEqual(poison.layout.slots.top, { x: 180, y: 122, scale: 3, zIndex: 9999 },
    "读侧同样限幅 scale/zIndex、x/y 越界回退默认（与写入侧一致）");
  assert.deepStrictEqual(poison.layout.slots.bag, { x: 286, y: 150, scale: 1, zIndex: 10 },
    "白名单外字段的伪造 entry 收口为该槽默认值（读侧无 items 对齐上下文，语义同客户端 sanitizeLayout）");
  assert.strictEqual(poison.layout.slots.bottom, null);
  assert.deepStrictEqual(Object.keys(poison.layout.slots).sort(), ["bag", "bottom", "hat", "shoes", "top"], "固定五槽白名单");
  const json = JSON.parse(JSON.stringify(poison.layout));
  assert(Number.isFinite(json.canvas.width) && Number.isFinite(json.canvas.height), "返回 layout 必须 JSON-safe");

  // ---- 3. legacy（无 layout 字段）→ null ----
  const legacy = items.find((item) => item.id === "read_legacy");
  assert.strictEqual(legacy.layout, null, "legacy 记录 layout 读回 null");

  // ---- 4. 字符串 version "1" / 未知版本 2 → 整体判无效 → null（与客户端 sanitizeLayout 一致）----
  const stringVersion = items.find((item) => item.id === "read_version_string");
  assert.strictEqual(stringVersion.layout, null, "字符串 \"1\" 必须按未知版本整体判无效（读侧）");
  const futureVersion = items.find((item) => item.id === "read_version_2");
  assert.strictEqual(futureVersion.layout, null, "未知 version 必须按无效处理（读侧）");

  // ---- 5. 纯读收口：不得改写入库 raw 记录（不 backfill、不回写）----
  const rawClean = fake.collections.outfit_records.find((row) => row._id === "read_clean");
  assert.deepStrictEqual(rawClean.layout.slots.top, { x: 240, y: 120, scale: 1.6, zIndex: 7 }, "合法记录原样保留");
  const rawPoison = fake.collections.outfit_records.find((row) => row._id === "read_poison");
  assert.notStrictEqual(rawPoison.layout.canvas.width, 360,
    "入库 raw 记录不得被读侧改写（收口仅在响应面，raw 画布保持未收口的非 360 值）");
  assert.deepStrictEqual(rawPoison.layout.slots.top, { x: "bad", y: 1e9, scale: 999, zIndex: 1e9, width: 777, selected: true },
    "raw 记录保持未收口字段（读侧不得回写 sanitize 结果）");
  const rawLegacy = fake.collections.outfit_records.find((row) => row._id === "read_legacy");
  assert(!Object.prototype.hasOwnProperty.call(rawLegacy, "layout"), "读侧不得给 legacy 记录回填 layout");
  const rawStringVersion = fake.collections.outfit_records.find((row) => row._id === "read_version_string");
  assert(rawStringVersion.layout && rawStringVersion.layout.version === "1", "字符串 version raw 记录原样保留");

  console.log("getOutfitRecords read-side layout sanitize tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
