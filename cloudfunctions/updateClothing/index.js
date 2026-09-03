const cloud = require("wx-server-sdk");
const {
  getOpenId,
  isFormalClothingCloudFileId,
  validateCloudFileId,
  applyMutation
} = require("./shared/cloudbase");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COLLECTION = "clothing_items";
const SEASONS = new Set(["spring", "summer", "autumn", "winter"]);
const CATEGORIES = new Set(["hat", "top", "bottom", "shoes", "bag"]);
const STYLES = new Set(["casual", "commute", "sweet", "cool"]);
const COLORS = new Set(["pink", "white", "black", "beige", "gray", "blue", "brown", "green", "red", "yellow", "purple", "multicolor", "other"]);
const THICKNESSES = new Set(["thin", "medium", "thick"]);

function stringValue(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function enumArray(value, allowed, maxLength) {
  if (!Array.isArray(value) || !value.length || value.length > maxLength) return null;
  if (value.some((entry) => !allowed.has(entry))) return null;
  return [...new Set(value)];
}

exports.main = async (event = {}) => {
  const openid = getOpenId();
  if (!openid) return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  const clientRecordId = stringValue(event.clientRecordId, 80);
  const name = stringValue(event.name, 20);
  const category = event.category;
  const seasons = enumArray(event.seasons, SEASONS, 4);
  const styles = enumArray(event.styles, STYLES, 4);
  const imageFileId = stringValue(event.imageFileId || event.imageUrl, 512);
  const primaryColor = COLORS.has(event.primaryColor) ? event.primaryColor : "";
  const thickness = THICKNESSES.has(event.thickness) ? event.thickness : "";
  if (!clientRecordId || !name || !CATEGORIES.has(category) || !seasons || !styles) {
    return { ok: false, errorCode: "CLOTHING_REQUIRED", errorMessage: "请完整填写图片、分类、季节和风格。" };
  }
  // Round 2A-4: 正式图片边界校验 — 拒绝 tmp/references/非正式路径
  if (!isFormalClothingCloudFileId(imageFileId, openid)) {
    return { ok: false, errorCode: "IMAGE_FILE_INVALID", errorMessage: "编辑时必须使用当前用户真实可访问的正式云文件。" };
  }
  const imageCache = new Map();
  if (!await validateCloudFileId(imageFileId, openid, imageCache)) {
    return { ok: false, errorCode: "IMAGE_FILE_INVALID", errorMessage: "编辑时必须使用当前用户真实可访问的云文件。" };
  }

  return applyMutation({
    collectionName: COLLECTION,
    openid,
    clientRecordId,
    requestedId: event.id,
    operation: "update",
    payload: event,
    allowCreate: false,
    buildRecord: async ({ current }) => {
      const now = new Date();
      return {
        ...current,
        type: category === "hat" || category === "bag" ? "accessory" : category,
        category,
        name,
        color: stringValue(event.color, 12),
        style: styles[0],
        season: seasons[0],
        tempRange: event.tempRange || null,
        mainColor: stringValue(event.mainColor || event.color, 12),
        tags: Array.isArray(event.tags) ? event.tags.map((tag) => stringValue(tag, 12)).filter(Boolean).slice(0, 6) : styles,
        imageFileId,
        seasons,
        styles,
        primaryColor,
        thickness,
        size: stringValue(event.size, 20),
        purchasePrice: event.purchasePrice !== null && event.purchasePrice !== "" && Number.isFinite(Number(event.purchasePrice)) ? Number(event.purchasePrice) : null,
        purchaseDate: stringValue(event.purchaseDate, 10),
        purchaseChannel: stringValue(event.purchaseChannel, 30),
        aiDescription: stringValue(event.aiDescription, 300),
        note: stringValue(event.note, 200),
        updatedAt: now
      };
    }
  });
};
