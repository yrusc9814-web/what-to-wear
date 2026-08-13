const cloud = require("wx-server-sdk");
const { getOpenId, applyMutation } = require("./shared/cloudbase");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  const openid = getOpenId();
  if (!openid) return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  const clientRecordId = String(event.clientRecordId || "").trim();
  if (!clientRecordId) return { ok: false, errorCode: "CLIENT_RECORD_ID_REQUIRED", errorMessage: "缺少搭配逻辑 ID。" };
  return applyMutation({
    collectionName: "outfit_records",
    openid,
    clientRecordId,
    requestedId: event.id,
    operation: "delete",
    payload: event,
    allowCreate: false,
    buildRecord: async ({ current }) => ({
      ...current,
      updatedAt: new Date()
    })
  });
};
