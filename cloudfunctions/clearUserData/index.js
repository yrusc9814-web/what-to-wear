const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

async function softDeleteCollection(collectionName, openid) {
  const result = await db
    .collection(collectionName)
    .where({ openid, isDeleted: false })
    .update({
      data: {
        isDeleted: true,
        dataDeleteRequestedAt: db.serverDate(),
        deletedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  return result.stats ? result.stats.updated : 0;
}

exports.main = async (event = {}, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || (context && context.OPENID);

  if (!openid) {
    return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  }

  const clothingDeleted = await softDeleteCollection("clothing_items", openid);
  const outfitDeleted = await softDeleteCollection("outfit_records", openid);

  return {
    ok: true,
    data: {
      clothingDeleted,
      outfitDeleted
    }
  };
};
