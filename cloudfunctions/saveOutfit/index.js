const cloud = require("wx-server-sdk");
const {
  getOpenId,
  validateCloudFileId,
  applyMutation
} = require("./shared/cloudbase");
const {
  buildTrustedSlots,
  revalidateTrustedSlots,
  alignOutfitLayout
} = require("./shared/outfit-slots");

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
  const date = stringValue(event.date, 10);
  if (!clientRecordId || !title || !SEASONS.has(event.season) || !STYLES.has(event.style) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, errorCode: "OUTFIT_REQUIRED", errorMessage: "请完整填写搭配名称、日期、季节和风格。" };
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
    operation: "create",
    payload: event,
    buildRecord: async ({ current, transaction }) => {
      const now = new Date();
      const finalItems = await revalidateTrustedSlots(transaction, openid, trusted);
      // Round 2B-1：layout 与 items 分离持久化；payload 显式携带 layout（含 null）时以其为准，
      // 否则沿用 current（create 时为 null，legacy 不自动回填）；再与已复核槽位对齐
      // （无单品槽位 → null，有单品缺 entry → 服务端默认布局，数值/字段经 sanitize）。
      const rawLayout = Object.prototype.hasOwnProperty.call(event, "layout")
        ? event.layout
        : (current && current.layout) || null;
      return {
        ...(current || {}),
        date,
        title,
        season: event.season,
        style: event.style,
        items: finalItems,
        layout: alignOutfitLayout(rawLayout, finalItems),
        previewImageUrl: preview,
        previewFileId: preview,
        note: stringValue(event.note, 50),
        weatherSnapshot: event.weatherSnapshot || null,
        createdAt: current && current.createdAt || now,
        updatedAt: now,
        savedAt: now
      };
    }
  });
};
