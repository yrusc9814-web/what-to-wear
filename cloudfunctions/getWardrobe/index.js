const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COLLECTION = "clothing_items";

exports.main = async (event = {}, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || (context && context.OPENID);
  const pageSize = Math.min(Math.max(Number(event.pageSize) || 50, 1), 100);
  const page = Math.max(Number(event.page) || 1, 1);

  if (!openid) {
    return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  }

  const result = await db
    .collection(COLLECTION)
    .where({ openid, isDeleted: false })
    .orderBy("createdAt", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  const items = result.data.map((item) => ({
    id: item._id,
    _id: item._id,
    type: item.type,
    name: item.name,
    color: item.color || "",
    style: item.style || "",
    season: item.season || "all",
    tempRange: item.tempRange || null,
    mainColor: item.mainColor || item.color || "",
    tags: Array.isArray(item.tags) ? item.tags : [],
    imageFileId: item.imageFileId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }));

  return {
    ok: true,
    data: {
      items,
      page,
      pageSize
    }
  };
};
