const cloud = require("wx-server-sdk");
const { validateCloudFileId } = require("./cloudbase");

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

module.exports = { buildTrustedSlots, findActiveWardrobeItem, revalidateTrustedSlots };
