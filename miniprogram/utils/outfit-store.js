const STORAGE_KEY = "chuanda_outfit_records";

function readOutfits() {
  return wx.getStorageSync(STORAGE_KEY) || [];
}

function writeOutfits(items) {
  wx.setStorageSync(STORAGE_KEY, items);
}

function createOutfit(payload) {
  const items = readOutfits();
  const record = {
    id: `local_outfit_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    date: payload.date,
    top: payload.top || null,
    bottom: payload.bottom || null,
    shoes: payload.shoes || null,
    accessory: payload.accessory || null,
    note: payload.note || "",
    weatherSnapshot: payload.weatherSnapshot || null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  items.unshift(record);
  writeOutfits(items);
  return record;
}

function deleteOutfit(id) {
  const items = readOutfits().filter((item) => item.id !== id);
  writeOutfits(items);
  return items;
}

module.exports = {
  readOutfits,
  writeOutfits,
  createOutfit,
  deleteOutfit
};
