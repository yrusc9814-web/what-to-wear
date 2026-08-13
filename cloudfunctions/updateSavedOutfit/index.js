const cloud = require("wx-server-sdk");
const { getOpenId, validateCloudFileId, applyMutation } = require("./shared/cloudbase");
const { buildTrustedSlots, revalidateTrustedSlots } = require("./shared/outfit-slots");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const SEASONS = new Set(["spring", "summer", "autumn", "winter"]);
const STYLES = new Set(["casual", "commute", "sweet", "cool"]);

function stringValue(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

async function resolvePreview(event, openid, cache) {
  const values = [event.previewFileId, event.previewImageUrl].filter((value) => value !== undefined && value !== null && value !== "");
  for (const value of values) {
    if (await validateCloudFileId(value, openid, cache)) return stringValue(value, 512);
  }
  return "";
}

exports.main = async (event = {}) => {
  const openid = getOpenId();
  if (!openid) return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  const clientRecordId = stringValue(event.clientRecordId, 80);
  const title = stringValue(event.title, 30);
  if (!clientRecordId || !stringValue(event.id, 80) || !title || !SEASONS.has(event.season) || !STYLES.has(event.style)) {
    return { ok: false, errorCode: "OUTFIT_REQUIRED", errorMessage: "请完整填写名称、季节和风格。" };
  }
  if (!event.items || typeof event.items !== "object" || Array.isArray(event.items)) {
    return { ok: false, errorCode: "SLOTS_REQUIRED", errorMessage: "请选择有效的五槽搭配。" };
  }
  const imageCache = new Map();
  const trusted = await buildTrustedSlots(openid, event.items, imageCache);
  if (!trusted.ok) return trusted;
  const preview = await resolvePreview(event, openid, imageCache);

  return applyMutation({
    collectionName: "outfit_records",
    openid,
    clientRecordId,
    requestedId: event.id,
    operation: "update",
    payload: event,
    allowCreate: false,
    buildRecord: async ({ current, transaction }) => {
      const finalItems = await revalidateTrustedSlots(transaction, openid, trusted);
      return {
        ...current,
        title,
        season: event.season,
        style: event.style,
        items: finalItems,
        previewImageUrl: preview,
        previewFileId: preview,
        note: stringValue(event.note, 50),
        weatherSnapshot: event.weatherSnapshot || current.weatherSnapshot || null,
        updatedAt: new Date(),
        savedAt: new Date()
      };
    }
  });
};
