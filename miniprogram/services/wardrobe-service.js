const localStore = require("../utils/wardrobe-store");
const { canUseCloud, callFunction } = require("./cloud");

function normalizeCloudItem(item) {
  const mainColor = item.mainColor || item.color || "";
  return {
    id: item._id || item.id,
    type: item.type,
    name: item.name,
    color: item.color || "",
    style: item.style || "",
    season: item.season || "all",
    tempRange: item.tempRange || null,
    mainColor,
    tags: Array.isArray(item.tags) ? item.tags : [],
    imageUrl: item.imageFileId || item.imageUrl || "",
    imageFileId: item.imageFileId || "",
    createdAt: item.createdAt || 0,
    updatedAt: item.updatedAt || 0
  };
}

async function uploadImageIfNeeded(filePath) {
  if (!filePath || filePath.startsWith("cloud://") || filePath.startsWith("http")) {
    return filePath;
  }

  if (!canUseCloud()) return filePath;

  const extMatch = filePath.match(/\.(jpg|jpeg|png|webp|gif)(?:\?.*)?$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
  const cloudPath = `wardrobe/${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`;
  const result = await wx.cloud.uploadFile({
    cloudPath,
    filePath
  });
  return result.fileID;
}

async function getWardrobe() {
  if (!canUseCloud()) return localStore.readWardrobe();

  try {
    const data = await callFunction("getWardrobe", { page: 1, pageSize: 100 });
    const items = (data.items || []).map(normalizeCloudItem);
    localStore.writeWardrobe(items);
    return items;
  } catch (err) {
    console.warn("getWardrobe cloud failed, fallback to local", err);
    return localStore.readWardrobe();
  }
}

async function saveClothing(payload) {
  if (!canUseCloud()) {
    return localStore.createWardrobeItem(payload);
  }

  const imageFileId = await uploadImageIfNeeded(payload.imageUrl);
  const data = await callFunction("saveClothing", {
    type: payload.type,
      name: payload.name,
      color: payload.color,
      style: payload.style,
      season: payload.season,
      tempRange: payload.tempRange,
      mainColor: payload.mainColor,
      tags: payload.tags,
      imageFileId
    });
  const item = normalizeCloudItem(data);
  const cached = localStore.readWardrobe().filter((oldItem) => oldItem.id !== item.id);
  localStore.writeWardrobe([item, ...cached]);
  return item;
}

async function updateClothing(id, payload) {
  if (!canUseCloud() || String(id).startsWith("local_")) {
    const item = localStore.updateWardrobeItem(id, payload);
    if (!item) throw new Error("本地衣物不存在");
    return item;
  }

  const imageFileId = await uploadImageIfNeeded(payload.imageUrl || payload.imageFileId);
  const data = await callFunction("updateClothing", {
    id,
    type: payload.type,
    name: payload.name,
    color: payload.color,
    style: payload.style,
    season: payload.season,
    tempRange: payload.tempRange,
    mainColor: payload.mainColor,
    tags: payload.tags,
    imageFileId
  });
  const item = normalizeCloudItem(data);
  const cached = localStore.readWardrobe().map((oldItem) => (oldItem.id === item.id ? item : oldItem));
  localStore.writeWardrobe(cached);
  return item;
}

async function analyzeClothing(payload) {
  if (!canUseCloud()) {
    return {
      type: payload.type || "top",
      name: payload.name || "未命名衣物",
      color: "",
      style: "",
      source: "local_fallback"
    };
  }

  const imageFileId = await uploadImageIfNeeded(payload.imageUrl);
  const data = await callFunction("analyzeClothing", {
    imageFileId,
    originalName: payload.name
  });
  return {
    ...data,
    imageFileId
  };
}

async function deleteClothing(item) {
  if (canUseCloud() && item && !String(item.id).startsWith("local_")) {
    await callFunction("deleteClothing", { id: item.id });
  }

  return localStore.deleteWardrobeItem(item.id);
}

module.exports = {
  getWardrobe,
  saveClothing,
  updateClothing,
  analyzeClothing,
  deleteClothing
};
