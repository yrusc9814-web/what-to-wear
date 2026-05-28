const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COLLECTION = "outfit_records";

function normalizeString(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeItem(item) {
  if (!item) return null;
  return {
    id: normalizeString(item.id || item._id, 64),
    type: normalizeString(item.type, 20),
    name: normalizeString(item.name, 20),
    color: normalizeString(item.color, 12),
    style: normalizeString(item.style, 16),
    season: normalizeString(item.season || "all", 12),
    tempRange: item.tempRange || null,
    mainColor: normalizeString(item.mainColor || item.color, 12),
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => normalizeString(tag, 12)).filter(Boolean).slice(0, 6) : [],
    imageUrl: normalizeString(item.imageUrl || item.imageFileId, 256)
  };
}

exports.main = async (event = {}, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || (context && context.OPENID);
  const date = normalizeString(event.date, 10);

  if (!openid) {
    return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, errorCode: "DATE_REQUIRED", errorMessage: "请选择记录日期。" };
  }

  const record = {
    openid,
    date,
    top: normalizeItem(event.top),
    bottom: normalizeItem(event.bottom),
    shoes: normalizeItem(event.shoes),
    accessory: normalizeItem(event.accessory),
    note: normalizeString(event.note, 50),
    weatherSnapshot: event.weatherSnapshot || null,
    isDeleted: false,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  };

  const result = await db.collection(COLLECTION).add({ data: record });
  return {
    ok: true,
    data: {
      id: result._id,
      _id: result._id,
      date: record.date,
      top: record.top,
      bottom: record.bottom,
      shoes: record.shoes,
      accessory: record.accessory,
      note: record.note,
      weatherSnapshot: record.weatherSnapshot
    }
  };
};
