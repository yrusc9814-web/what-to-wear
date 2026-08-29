const cloud = require("wx-server-sdk");
const {
  getOpenId,
  validateCloudFileId,
  applyMutation
} = require("./shared/cloudbase");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COLLECTION = "outfit_references";
const SEASONS = new Set(["spring", "summer", "autumn", "winter"]);
const STYLES = new Set(["casual", "commute", "sweet", "cool"]);
const SOURCES = new Set(["self", "web", "other"]);

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
  const name = stringValue(event.name, 50);
  const seasons = enumArray(event.seasons, SEASONS, 4);
  const styles = enumArray(event.styles, STYLES, 4);
  const occasion = stringValue(event.occasion, 30);
  const note = stringValue(event.note, 200);
  const source = SOURCES.has(event.source) ? event.source : "";
  const imageFileId = stringValue(event.imageFileId || event.imageUrl, 512);

  if (!clientRecordId || !name || !seasons || !styles || !source) {
    return { ok: false, errorCode: "OUTFIT_REFERENCE_REQUIRED", errorMessage: "请完整填写图片、名称、季节、风格和来源。" };
  }
  const imageCache = new Map();
  if (!await validateCloudFileId(imageFileId, openid, imageCache)) {
    return { ok: false, errorCode: "IMAGE_FILE_INVALID", errorMessage: "图片必须是当前用户真实可访问的云文件。" };
  }

  return applyMutation({
    collectionName: COLLECTION,
    openid,
    clientRecordId,
    requestedId: event.id,
    operation: "create",
    payload: event,
    buildRecord: async ({ current }) => {
      const now = new Date();
      return {
        ...(current || {}),
        name,
        seasons,
        styles,
        occasion,
        note,
        source,
        imageFileId,
        createdAt: current && current.createdAt || now,
        updatedAt: now
      };
    }
  });
};
