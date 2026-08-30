const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// Round 2A-2：服务端临时文件删除入口。
// 背景：segmentClothing 上传的 cutout 文件在客户端 wx.cloud.deleteFile 会返回
// STORAGE_EXCEED_AUTHORITY（客户端对云函数产出的文件无删除权限），
// 因此 temp 生命周期需要一个服务端删除入口，且必须永不接触正式资产。

const FILE_ID_MAX_LENGTH = 512;
const MAX_BATCH = 10;

const ERROR_MESSAGES = {
  AUTH_REQUIRED: "缺少用户身份，请重新进入页面后再试。",
  TEMP_DELETE_INVALID: "待删除的临时文件标识无效。",
  TEMP_DELETE_FORBIDDEN: "只能删除本人临时目录（wardrobe/{openid}/tmp/）下的文件。"
};

// 纯函数：判定给定 openid 下是否允许删除该 fileId。
// 返回 "ok" | "forbidden" | "invalid"：
//  - invalid：非字符串/为空/超长/非 cloud:// 前缀/非 wardrobe 资产/含路径穿越段；
//  - forbidden：他人路径（含他人 tmp）、本人 wardrobe/{openid}/ 正式路径（无 /tmp/ 段）、
//    本人或他人 references 路径、本人 tmp 下的嵌套路径。
function classifyTempFileId(fileId, openid) {
  if (typeof fileId !== "string") return "invalid";
  const id = fileId.trim();
  if (!id || id.length > FILE_ID_MAX_LENGTH) return "invalid";
  if (!id.startsWith("cloud://")) return "invalid";
  const withoutScheme = id.slice("cloud://".length);
  const firstSlash = withoutScheme.indexOf("/");
  if (firstSlash <= 0) return "invalid";
  const path = withoutScheme.slice(firstSlash + 1);
  const segments = path.split("/");
  if (segments[0] !== "wardrobe") return "invalid";
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "invalid";
  if (segments[1] !== openid) return "forbidden";
  if (segments.length !== 4 || segments[2] !== "tmp") return "forbidden";
  return "ok";
}

// 日志脱敏：openid 段替换为 ***，避免在日志中暴露用户身份。
function maskFileId(fileId) {
  return String(fileId || "").replace(/(wardrobe\/)[^/]+(\/)/, "$1***$2");
}

// 入参解析：tempFileId（单个字符串或数组，上限 MAX_BATCH），兼容 tempFileIds 数组别名。
// 非法整体形态返回 { error: "TEMP_DELETE_INVALID" }；否则返回去重后的字符串数组。
function parseRequestedIds(event) {
  const raw = event && event.tempFileId !== undefined ? event.tempFileId : (event && event.tempFileIds);
  let list = null;
  if (typeof raw === "string") list = [raw];
  else if (Array.isArray(raw)) list = raw;
  if (!list) return { error: "TEMP_DELETE_INVALID" };
  if (list.length < 1 || list.length > MAX_BATCH) return { error: "TEMP_DELETE_INVALID" };
  const seen = new Set();
  const ids = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids };
}

function failure(errorCode, extra) {
  return {
    ok: false,
    errorCode,
    errorMessage: ERROR_MESSAGES[errorCode] || "临时文件删除失败，请稍后重试。",
    ...(extra || {})
  };
}

// 存在性探测：仅用于删除抛错后区分 notFound / failed；返回 true/false/null（未知）。
async function probeFileExists(fileId) {
  try {
    const response = await cloud.getTempFileURL({ fileList: [fileId] });
    const entry = response && Array.isArray(response.fileList) ? response.fileList[0] : null;
    if (!entry) return null;
    if (entry.tempFileURL) return true;
    const status = Number(entry.status);
    if (Number.isFinite(status) && status !== 0) return false;
    return null;
  } catch (error) {
    return null;
  }
}

// 删除不存在的文件按幂等成功处理（cloud.deleteFile 对缺失文件同样可能正常返回）。
async function deleteSingleFileId(fileId) {
  try {
    await cloud.deleteFile({ fileList: [fileId] });
    return { fileId, status: "deleted" };
  } catch (error) {
    const exists = await probeFileExists(fileId);
    if (exists === false) return { fileId, status: "notFound" };
    console.warn("deleteWardrobeTemp delete failed", {
      fileId: maskFileId(fileId),
      reason: String((error && (error.errMsg || error.message)) || error).slice(0, 120)
    });
    return { fileId, status: "failed" };
  }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext && wxContext.OPENID;
  if (!openid) return failure("AUTH_REQUIRED");

  const parsed = parseRequestedIds(event);
  if (parsed.error) return failure(parsed.error);

  const entries = parsed.ids.map((id) => ({ fileId: id, verdict: classifyTempFileId(id, openid) }));
  const allowedIds = entries.filter((entry) => entry.verdict === "ok").map((entry) => entry.fileId);

  // 全部参数非法才整体拒绝；混合批次只处理合法部分并在明细中逐文件回报（保持入参顺序）。
  if (allowedIds.length === 0) {
    const firstRejected = entries[0] || { verdict: "invalid" };
    const errorCode = firstRejected.verdict === "forbidden" ? "TEMP_DELETE_FORBIDDEN" : "TEMP_DELETE_INVALID";
    console.warn("deleteWardrobeTemp rejected", {
      openid: "***",
      errorCode,
      rejectedCount: entries.length
    });
    return failure(errorCode, { details: entries.map(toDetail) });
  }

  console.log("deleteWardrobeTemp deleting", {
    openid: "***",
    count: allowedIds.length,
    fileIds: allowedIds.map(maskFileId)
  });

  const statusById = new Map();
  for (const id of allowedIds) {
    statusById.set(id, await deleteSingleFileId(id));
  }
  const details = entries.map((entry) => (entry.verdict === "ok" ? statusById.get(entry.fileId) : toDetail(entry)));
  const deletedCount = details.filter((entry) => entry.status === "deleted" || entry.status === "notFound").length;
  console.log("deleteWardrobeTemp done", { openid: "***", deletedCount, total: details.length });

  return {
    ok: true,
    data: {
      details
    }
  };
};

function toDetail(entry) {
  return {
    fileId: entry.fileId,
    status: entry.verdict === "forbidden" ? "forbidden" : "invalid"
  };
}

exports._test = {
  classifyTempFileId,
  maskFileId,
  parseRequestedIds,
  MAX_BATCH,
  FILE_ID_MAX_LENGTH,
  ERROR_MESSAGES
};
