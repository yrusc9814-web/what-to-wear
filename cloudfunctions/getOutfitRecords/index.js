const cloud = require("wx-server-sdk");
const { sanitizeOutfitLayout } = require("./shared/outfit-slots");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function mapOutfit(record) {
  // Round 2B-1 reviewer fix：layout 透传 raw 会被客户端当作可信数据消费；读侧同样用
  // 服务端 sanitizeOutfitLayout 收口（与 saveOutfit/updateSavedOutfit 写入镜像语义一致），
  // 返回收口后的 layout（非法/legacy 无 layout → null，客户端走运行时默认布局回退）。
  const rawLayout = record.layout || null;
  return {
    id: record.clientRecordId || record._id,
    _id: record._id,
    cloudId: record._id,
    clientRecordId: record.clientRecordId || "",
    date: record.date,
    title: record.title || record.note || "我的穿搭",
    season: record.season || "",
    style: record.style || "",
    items: record.items || null,
    layout: rawLayout ? sanitizeOutfitLayout(rawLayout) : null,
    top: record.top || null,
    bottom: record.bottom || null,
    shoes: record.shoes || null,
    accessory: record.accessory || null,
    note: record.note || "",
    weatherSnapshot: record.weatherSnapshot || null,
    previewImageUrl: record.previewImageUrl || "",
    previewFileId: record.previewFileId || "",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    savedAt: record.savedAt || record.updatedAt || record.createdAt,
    mutationVersion: Number(record.mutationVersion || 0),
    isDeleted: record.isDeleted === true
  };
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = String(wxContext && wxContext.OPENID || "").trim();
  const pageSize = Math.min(Math.max(Number(event.pageSize) || 50, 1), 99);
  if (!openid) return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  if (Number(event.page) > 1 && !event.cursor) {
    return { ok: false, errorCode: "CURSOR_REQUIRED", errorMessage: "分页必须使用稳定 cursor。" };
  }

  const db = cloud.database();
  const where = { openid };
  if (event.cursor && event.cursor.lastId) {
    where._id = db.command.gt(String(event.cursor.lastId));
  }
  const result = await db.collection("outfit_records")
    .where(where)
    .orderBy("_id", "asc")
    .limit(pageSize + 1)
    .get();
  const rawItems = Array.isArray(result.data) ? result.data : [];
  const hasMore = rawItems.length > pageSize;
  const consumed = rawItems.slice(0, pageSize);
  const items = consumed.filter((item) => item.isDeleted !== true).map(mapOutfit);
  return {
    ok: true,
    data: {
      items,
      pageSize,
      hasMore,
      nextCursor: consumed.length ? { lastId: consumed[consumed.length - 1]._id } : null
    }
  };
};
