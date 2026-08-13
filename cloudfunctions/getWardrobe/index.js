const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function mapItem(item) {
  return {
    id: item.clientRecordId || item._id,
    _id: item._id,
    cloudId: item._id,
    clientRecordId: item.clientRecordId || "",
    type: item.type,
    category: item.category || (item.type === "accessory" ? "bag" : item.type),
    name: item.name,
    color: item.color || "",
    style: item.style || "",
    season: item.season || "all",
    tempRange: item.tempRange || null,
    mainColor: item.mainColor || item.color || "",
    tags: Array.isArray(item.tags) ? item.tags : [],
    imageFileId: item.imageFileId,
    seasons: Array.isArray(item.seasons) ? item.seasons : (item.season && item.season !== "all" ? [item.season] : []),
    styles: Array.isArray(item.styles) ? item.styles : [],
    primaryColor: item.primaryColor || "",
    thickness: item.thickness || "",
    size: item.size || "",
    purchasePrice: item.purchasePrice == null ? null : item.purchasePrice,
    purchaseDate: item.purchaseDate || "",
    purchaseChannel: item.purchaseChannel || "",
    aiDescription: item.aiDescription || "",
    note: item.note || "",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    mutationVersion: Number(item.mutationVersion || 0),
    isDeleted: item.isDeleted === true
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
  const result = await db.collection("clothing_items")
    .where(where)
    .orderBy("_id", "asc")
    .limit(pageSize + 1)
    .get();
  const rawItems = Array.isArray(result.data) ? result.data : [];
  const hasMore = rawItems.length > pageSize;
  const consumed = rawItems.slice(0, pageSize);
  const items = consumed.filter((item) => item.isDeleted !== true).map(mapItem);
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
