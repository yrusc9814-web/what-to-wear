const localStore = require("../utils/outfit-store");
const { canUseCloud, callFunction } = require("./cloud");

function normalizeRecord(record) {
  return {
    id: record._id || record.id,
    date: record.date,
    top: record.top || null,
    bottom: record.bottom || null,
    shoes: record.shoes || null,
    accessory: record.accessory || null,
    note: record.note || "",
    weatherSnapshot: record.weatherSnapshot || null,
    createdAt: record.createdAt || 0,
    updatedAt: record.updatedAt || 0
  };
}

async function getOutfits() {
  if (!canUseCloud()) return localStore.readOutfits();

  try {
    const data = await callFunction("getOutfitRecords", { page: 1, pageSize: 50 });
    const records = (data.items || []).map(normalizeRecord);
    localStore.writeOutfits(records);
    return records;
  } catch (err) {
    console.warn("getOutfitRecords cloud failed, fallback to local", err);
    return localStore.readOutfits();
  }
}

async function saveOutfit(payload) {
  if (!canUseCloud()) return localStore.createOutfit(payload);

  const data = await callFunction("saveOutfit", payload);
  const record = normalizeRecord(data);
  const cached = localStore.readOutfits().filter((oldRecord) => oldRecord.id !== record.id);
  localStore.writeOutfits([record, ...cached]);
  return record;
}

async function deleteOutfit(record) {
  if (canUseCloud() && record && !String(record.id).startsWith("local_")) {
    await callFunction("deleteOutfitRecord", { id: record.id });
  }

  return localStore.deleteOutfit(record.id);
}

module.exports = {
  getOutfits,
  saveOutfit,
  deleteOutfit
};
