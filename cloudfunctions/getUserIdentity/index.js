const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || (context && context.OPENID);
  if (!openid) return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  return { ok: true, data: { userId: openid } };
};
