const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COLLECTION = "clothing_items";
const TYPES = new Set(["top", "bottom", "shoes", "accessory"]);
const SEASONS = new Set(["spring", "summer", "autumn", "winter", "all"]);

function normalizeString(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeTempRange(value) {
  if (!value || typeof value !== "object") return null;
  const min = Number(value.min);
  const max = Number(value.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : String(value || "").split(/[,\s，、/]+/);
  return tags.map((tag) => normalizeString(tag, 12)).filter(Boolean).slice(0, 6);
}

exports.main = async (event = {}, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || (context && context.OPENID);
  const id = normalizeString(event.id, 64);

  if (!openid) {
    return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  }

  if (!id) {
    return { ok: false, errorCode: "ID_REQUIRED", errorMessage: "缺少衣物ID。" };
  }

  const type = normalizeString(event.type, 20);
  const name = normalizeString(event.name, 20);
  const color = normalizeString(event.color, 12);
  const style = normalizeString(event.style, 16);
  const season = SEASONS.has(event.season) ? event.season : "all";
  const tempRange = normalizeTempRange(event.tempRange);
  const mainColor = normalizeString(event.mainColor || event.color, 12);
  const tags = normalizeTags(event.tags || event.style);
  const imageFileId = normalizeString(event.imageFileId || event.imageUrl, 256);

  if (!TYPES.has(type)) {
    return { ok: false, errorCode: "INVALID_TYPE", errorMessage: "衣物分类不正确。" };
  }

  if (!name) {
    return { ok: false, errorCode: "NAME_REQUIRED", errorMessage: "请填写衣物名称。" };
  }

  const result = await db
    .collection(COLLECTION)
    .where({ _id: id, openid, isDeleted: false })
    .update({
      data: {
        type,
        name,
        color,
        style,
        season,
        tempRange,
        mainColor,
        tags,
        imageFileId,
        updatedAt: db.serverDate()
      }
    });

  if (!result.stats || result.stats.updated === 0) {
    return { ok: false, errorCode: "NOT_FOUND", errorMessage: "衣物不存在或无权更新。" };
  }

  return {
    ok: true,
    data: {
      id,
      _id: id,
      type,
      name,
      color,
      style,
      season,
      tempRange,
      mainColor,
      tags,
      imageFileId
    }
  };
};
