const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COLLECTION = "outfit_records";

exports.main = async (event = {}, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || (context && context.OPENID);
  const id = String(event.id || "").trim();

  if (!openid) {
    return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  }

  if (!id) {
    return { ok: false, errorCode: "ID_REQUIRED", errorMessage: "缺少记录ID。" };
  }

  const result = await db
    .collection(COLLECTION)
    .where({ _id: id, openid, isDeleted: false })
    .update({
      data: {
        isDeleted: true,
        deletedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });

  if (!result.stats || result.stats.updated === 0) {
    return { ok: false, errorCode: "NOT_FOUND", errorMessage: "记录不存在或无权删除。" };
  }

  return { ok: true };
};
