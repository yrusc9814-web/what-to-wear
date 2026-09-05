const cloud = require("wx-server-sdk");

const CATEGORIES = new Set(["hat", "top", "bottom", "shoes", "bag"]);

function normalizeString(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeSnapshotReference(value) {
  if (!value || typeof value !== "object") return null;
  const source = value.snapshot || value;
  return {
    itemId: normalizeString(value.itemId || value.id || value._id, 80),
    requestedCategory: normalizeString(source.category, 20)
  };
}

async function validateCloudFileId(fileId, openid, cache = new Map()) {
  // 惰性 require：read 侧函数（getOutfitRecords 等只带 wx-server-sdk 依赖）可复用本模块
  // sanitize 而不被 cloudbase（@cloudbase/node-sdk）加载；write 侧函数均自带 cloudbase。
  const { validateCloudFileId: validate } = require("./cloudbase");
  return validate(fileId, openid, cache);
}

async function findActiveWardrobeItem(openid, itemId) {
  const collection = cloud.database().collection("clothing_items");
  let result = await collection.where({ openid, clientRecordId: itemId, isDeleted: cloud.database().command.neq(true) }).limit(1).get();
  if (!result.data || !result.data.length) {
    result = await collection.where({ openid, _id: itemId, isDeleted: cloud.database().command.neq(true) }).limit(1).get();
  }
  return result.data && result.data[0];
}

function liveCategory(item) {
  if (!item) return "";
  if (CATEGORIES.has(item.category)) return item.category;
  if (item.type === "accessory") return /帽|cap|hat/i.test(item.name || "") ? "hat" : "bag";
  return CATEGORIES.has(item.type) ? item.type : "";
}

async function buildTrustedSlots(openid, sourceItems, imageCache = new Map()) {
  const items = {};
  const records = {};
  for (const slot of ["hat", "top", "bottom", "shoes", "bag"]) {
    const reference = normalizeSnapshotReference(sourceItems && sourceItems[slot]);
    if (!reference || !reference.itemId) {
      if (["top", "bottom", "shoes"].includes(slot)) {
        return { ok: false, errorCode: "SLOTS_REQUIRED", errorMessage: "请选择上衣、下装和鞋子。" };
      }
      items[slot] = null;
      records[slot] = null;
      continue;
    }
    const live = await findActiveWardrobeItem(openid, reference.itemId);
    const category = liveCategory(live);
    if (!live || live.isDeleted === true || category !== slot) {
      return { ok: false, errorCode: "INVALID_SLOTS", errorMessage: "搭配槽位包含无效、已删除或不属于当前用户的单品。" };
    }
    const imageFileId = normalizeString(live.imageFileId || live.fileId, 512);
    if (!await validateCloudFileId(imageFileId, openid, imageCache)) {
      return { ok: false, errorCode: "IMAGE_FILE_INVALID", errorMessage: "搭配单品图片不是当前用户可访问的云文件。" };
    }
    items[slot] = {
      itemId: normalizeString(live.clientRecordId || live._id, 80),
      snapshot: {
        name: normalizeString(live.name, 30) || "已保存单品",
        category: slot,
        imageUrl: imageFileId,
        imageFileId,
        primaryColor: normalizeString(live.primaryColor || live.mainColor, 20)
      }
    };
    records[slot] = {
      documentId: normalizeString(live._id, 80),
      itemId: normalizeString(live.clientRecordId || live._id, 80),
      mutationVersion: Number(live.mutationVersion || 0),
      imageFileId
    };
  }
  return { ok: true, items, records };
}

async function revalidateTrustedSlots(transaction, openid, trusted) {
  const items = {};
  for (const slot of ["hat", "top", "bottom", "shoes", "bag"]) {
    const expected = trusted && trusted.records && trusted.records[slot];
    if (!expected) {
      items[slot] = null;
      continue;
    }
    if (!expected.documentId) {
      const error = new Error("搭配单品缺少可供事务复核的云端记录。");
      error.code = "INVALID_SLOTS";
      throw error;
    }
    const snapshot = await transaction.collection("clothing_items").doc(expected.documentId).get();
    const live = snapshot && snapshot.data;
    const category = liveCategory(live);
    const liveItemId = normalizeString(live && (live.clientRecordId || live._id), 80);
    const liveImageFileId = normalizeString(live && (live.imageFileId || live.fileId), 512);
    if (!live
      || live.openid !== openid
      || live.isDeleted === true
      || category !== slot
      || liveItemId !== expected.itemId
      || Number(live.mutationVersion || 0) !== expected.mutationVersion
      || liveImageFileId !== expected.imageFileId) {
      const error = new Error("搭配槽位在保存期间已失效、被删除或发生变化，请重新选择。");
      error.code = "INVALID_SLOTS";
      throw error;
    }
    items[slot] = {
      itemId: liveItemId,
      snapshot: {
        name: normalizeString(live.name, 30) || "已保存单品",
        category: slot,
        imageUrl: liveImageFileId,
        imageFileId: liveImageFileId,
        primaryColor: normalizeString(live.primaryColor || live.mainColor, 20)
      }
    };
  }
  return items;
}

// ---- Round 2B-1：outfit layout 顶层 schema 的服务端收口 ----
// 与 miniprogram/services/outfit-layout.js 的 sanitize/align 语义镜像（JSON-safe：
// 有限数值、白名单字段、固定五槽、数值限幅），保证云端持久化与客户端读回一致。
// 无法在 shared/ 内跨层引用 miniprogram 模块（云函数单目录部署），故镜像此实现。

const LAYOUT_SLOTS = ["hat", "top", "bottom", "shoes", "bag"];
const LAYOUT_VERSION = 1;
const MAX_CANVAS_DIMENSION = 10000;
const MAX_COORDINATE = 100000;
const MAX_Z_INDEX = 9999;
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;
const DEFAULT_CANVAS = { width: 360, height: 300 };
const DEFAULT_LAYOUT_ENTRY = {
  hat: { x: 176, y: 38, scale: 1.15, zIndex: 8 },
  top: { x: 180, y: 122, scale: 1, zIndex: 7 },
  bottom: { x: 188, y: 216, scale: 0.78, zIndex: 5 },
  shoes: { x: 186, y: 276, scale: 1, zIndex: 6 },
  bag: { x: 286, y: 150, scale: 1, zIndex: 10 }
};

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** JSON-safe 数值：保留 2 位小数，消除浮点噪声。 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/** 校验画布基准：正有限数值且不超过上限；非法返回 null。 */
function sanitizeCanvasDimension(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const width = value.width;
  const height = value.height;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION) return null;
  // Round 2B-1 reviewer fix：极小正数（如 0.004）round2 后为 0，会产出非法画布基准；
  // round 后必须复验 > 0（0.004 这类输入判非法 → 调用方回退默认画布）。
  const roundedWidth = round2(width);
  const roundedHeight = round2(height);
  if (roundedWidth <= 0 || roundedHeight <= 0) return null;
  return { width: roundedWidth, height: roundedHeight };
}

/**
 * 单槽 entry 白名单化：仅保留 {x, y, scale, zIndex}；
 * 非法字段回退该槽默认值；x/y 超出合理数值边界时整槽回退默认，避免病态数据。
 */
function sanitizeOutfitEntry(slot, value) {
  const base = DEFAULT_LAYOUT_ENTRY[slot] || { x: 0, y: 0, scale: 1, zIndex: 2 };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...base };
  }
  let x = base.x;
  let y = base.y;
  if (isFiniteNumber(value.x) && Math.abs(value.x) <= MAX_COORDINATE) x = round2(value.x);
  if (isFiniteNumber(value.y) && Math.abs(value.y) <= MAX_COORDINATE) y = round2(value.y);
  let scale = base.scale;
  if (isFiniteNumber(value.scale)) scale = round2(Math.min(MAX_SCALE, Math.max(MIN_SCALE, value.scale)));
  let zIndex = base.zIndex;
  if (isFiniteNumber(value.zIndex)) {
    zIndex = Math.min(MAX_Z_INDEX, Math.max(-MAX_Z_INDEX, Math.round(value.zIndex)));
  }
  return { x, y, scale, zIndex };
}

/**
 * sanitize 任意输入为顶层 layout schema；非对象/未知版本返回 null。
 * 接受 schema 形状（value.slots）或运行时形状（value 自带五槽键）。
 * 固定五槽：null 槽位保持 null（无单品）；非法槽位回退该槽默认值。
 */
function sanitizeOutfitLayout(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Round 2B-1 reviewer fix：version 必须严格为数值 1（Number.isInteger 且 === 1）；
  // 字符串 "1"（乃至 "1.0" 等）一律按未知版本整体判无效 → 服务端回退默认画布并仅保留
  // 有单品槽位 entry，与客户端 sanitizeLayout 语义保持一致。
  if (value.version !== undefined) {
    if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version !== LAYOUT_VERSION) return null;
  }
  const rawSlots = value.slots && typeof value.slots === "object" && !Array.isArray(value.slots)
    ? value.slots
    : (LAYOUT_SLOTS.some((slot) => value[slot] !== undefined) ? value : null);
  const canvas = sanitizeCanvasDimension(value.canvas) || { ...DEFAULT_CANVAS };
  const slots = {};
  LAYOUT_SLOTS.forEach((slot) => {
    const raw = rawSlots ? rawSlots[slot] : undefined;
    slots[slot] = raw === null || raw === undefined ? null : sanitizeOutfitEntry(slot, raw);
  });
  return { version: LAYOUT_VERSION, canvas, slots };
}

/**
 * items 对齐：保证 schema 与已复核五槽 items 一致。
 * - 无单品槽位 → null（删除/替换不残留旧 layout）。
 * - 有单品但缺/非法 layout entry → 该槽默认布局（与客户端 DEFAULT_LAYOUT 同源）。
 */
function alignOutfitLayout(layout, items) {
  const schema = sanitizeOutfitLayout(layout);
  const canvas = schema ? schema.canvas : { ...DEFAULT_CANVAS };
  const slots = {};
  LAYOUT_SLOTS.forEach((slot) => {
    const item = items && typeof items === "object" ? items[slot] : null;
    const hasItem = Boolean(item && (item.itemId || (item.snapshot && item.snapshot.category)));
    if (!hasItem) {
      slots[slot] = null;
      return;
    }
    slots[slot] = (schema && schema.slots[slot]) || { ...DEFAULT_LAYOUT_ENTRY[slot] };
  });
  return { version: LAYOUT_VERSION, canvas, slots };
}

module.exports = {
  buildTrustedSlots,
  findActiveWardrobeItem,
  revalidateTrustedSlots,
  LAYOUT_SLOTS,
  LAYOUT_VERSION,
  sanitizeOutfitLayout,
  alignOutfitLayout
};
