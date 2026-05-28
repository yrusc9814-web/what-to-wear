const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COLLECTION = "outfit_records";

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
    .orderBy("date", "desc")
    .orderBy("createdAt", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  const items = result.data.map((record) => ({
    id: record._id,
    _id: record._id,
    date: record.date,
    top: record.top || null,
    bottom: record.bottom || null,
    shoes: record.shoes || null,
    accessory: record.accessory || null,
    note: record.note || "",
    weatherSnapshot: record.weatherSnapshot || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
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
