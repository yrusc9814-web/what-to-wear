const STORAGE_KEY = "chuanda_wardrobe_items";

function readWardrobe() {
  return wx.getStorageSync(STORAGE_KEY) || [];
}

function writeWardrobe(items) {
  wx.setStorageSync(STORAGE_KEY, items);
}

function createWardrobeItem(payload) {
  const items = readWardrobe();
  const mainColor = payload.mainColor || payload.color || "";
  const item = {
    id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: payload.type,
    name: payload.name,
    color: payload.color || "",
    style: payload.style || "",
    season: payload.season || "all",
    tempRange: payload.tempRange || null,
    mainColor,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    imageUrl: payload.imageUrl || "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  items.unshift(item);
  writeWardrobe(items);
  return item;
}

function updateWardrobeItem(id, payload) {
  const items = readWardrobe();
  const updatedAt = Date.now();
  let updatedItem = null;
  const nextItems = items.map((item) => {
    if (item.id !== id) return item;
    updatedItem = {
      ...item,
      type: payload.type,
      name: payload.name,
      color: payload.color || "",
      style: payload.style || "",
      season: payload.season || "all",
      tempRange: payload.tempRange || null,
      mainColor: payload.mainColor || payload.color || "",
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      imageUrl: payload.imageUrl || item.imageUrl || "",
      imageFileId: payload.imageFileId || item.imageFileId || "",
      updatedAt
    };
    return updatedItem;
  });

  writeWardrobe(nextItems);
  return updatedItem;
}

function deleteWardrobeItem(id) {
  const items = readWardrobe().filter((item) => item.id !== id);
  writeWardrobe(items);
  return items;
}

module.exports = {
  readWardrobe,
  writeWardrobe,
  createWardrobeItem,
  updateWardrobeItem,
  deleteWardrobeItem
};
