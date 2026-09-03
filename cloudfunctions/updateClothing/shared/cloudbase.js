const crypto = require("crypto");
const cloud = require("wx-server-sdk");
const cloudbase = require("@cloudbase/node-sdk");

const cloudbaseApp = cloudbase.init({
  env: cloudbase.SYMBOL_CURRENT_ENV || cloudbase.SYMBOL_DEFAULT_ENV
});

function getOpenId() {
  const context = cloud.getWXContext();
  return String(context && context.OPENID || "").trim();
}

function getDatabase() {
  return cloudbaseApp.database();
}

function normalizeCloudFileId(value) {
  return String(value || "").trim();
}

function isOwnedCloudFileId(fileId, openid) {
  const value = normalizeCloudFileId(fileId);
  return /^cloud:\/\//.test(value)
    && value.includes(`/wardrobe/${openid}/`)
    && value.length <= 512;
}

// 正式服装图片边界：属于 wardrobe/{openid}/ 且不含 /tmp/、/references/。
// 允许 legacy wardrobe/{openid}/<旧文件名> 与 wardrobe/{openid}/clothing/<sha256>.png。
// 临时/非正式图片（source/cutout/standardized）与 references 一律视为非正式。
function isFormalClothingCloudFileId(fileId, openid) {
  const value = normalizeCloudFileId(fileId);
  if (!isOwnedCloudFileId(value, openid)) return false;
  if (value.includes("/tmp/")) return false;
  if (value.includes("/references/")) return false;
  return true;
}

async function validateCloudFileId(fileId, openid, cache = new Map()) {
  const value = normalizeCloudFileId(fileId);
  if (!isOwnedCloudFileId(value, openid)) return false;
  if (cache.has(value)) return cache.get(value);

  const result = await cloudbaseApp.getTempFileURL({ fileList: [value] });
  const entry = result && Array.isArray(result.fileList) ? result.fileList[0] : null;
  const valid = Boolean(
    entry
    && entry.code === "SUCCESS"
    && entry.fileID === value
    && typeof entry.tempFileURL === "string"
    && entry.tempFileURL.length > 0
  );
  cache.set(value, valid);
  return valid;
}

function stableRecordId(openid, clientRecordId) {
  return crypto
    .createHash("sha256")
    .update(`${openid}\u0000${clientRecordId}`)
    .digest("hex")
    .slice(0, 32);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function mutationIdentity(operation, clientRecordId, payload) {
  const identityPayload = { ...(payload || {}) };
  ["id", "cloudId", "userScope", "clientVersion", "taskId", "queueSequence", "identitySessionId", "createdAt", "updatedAt", "savedAt", "deletedAt", "syncStatus", "syncError"].forEach((key) => {
    delete identityPayload[key];
  });
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue({ operation, clientRecordId, payload: identityPayload })))
    .digest("hex");
}

function parseMutationVersion(event) {
  if (!Object.prototype.hasOwnProperty.call(event || {}, "mutationVersion")) return null;
  const value = Number(event.mutationVersion);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function mutationVersionError(event) {
  if (!Object.prototype.hasOwnProperty.call(event || {}, "mutationVersion")) {
    return { ok: false, errorCode: "MUTATION_VERSION_REQUIRED", errorMessage: "缺少 mutationVersion。" };
  }
  return { ok: false, errorCode: "MUTATION_VERSION_INVALID", errorMessage: "mutationVersion 必须是大于等于 1 的整数。" };
}

async function resolveCanonicalId(db, collectionName, openid, clientRecordId, requestedId) {
  const collection = db.collection(collectionName);
  const suppliedId = String(requestedId || "").trim();
  if (suppliedId) {
    const result = await collection.doc(suppliedId).get();
    const raw = result && result.data;
    // @cloudbase/node-sdk 3.x 非事务 doc.get() 返回 {data: [doc]} 数组, 事务内返回单对象
    const current = Array.isArray(raw) ? raw[0] : raw;
    if (!current || current.openid !== openid || current.clientRecordId !== clientRecordId) {
      const error = new Error("记录不存在或无权访问。");
      error.code = "RECORD_NOT_FOUND";
      throw error;
    }
    return suppliedId;
  }

  const legacy = await collection.where({ openid, clientRecordId }).limit(100).get();
  const rows = Array.isArray(legacy && legacy.data) ? legacy.data : [];
  if (rows.length) {
    rows.sort((left, right) => String(left._id).localeCompare(String(right._id)));
    return rows[0]._id;
  }
  return stableRecordId(openid, clientRecordId);
}

function publicRecord(record, id) {
  return { ...record, id: id || record._id, _id: id || record._id };
}

async function applyMutation({
  collectionName,
  openid,
  clientRecordId,
  requestedId,
  operation,
  payload,
  buildRecord,
  allowCreate = operation === "create",
  allowMissingDelete = true
}) {
  const mutationVersion = parseMutationVersion(payload);
  if (!mutationVersion) return mutationVersionError(payload);
  if (!openid) return { ok: false, errorCode: "AUTH_REQUIRED", errorMessage: "缺少用户身份。" };
  if (!clientRecordId) return { ok: false, errorCode: "CLIENT_RECORD_ID_REQUIRED", errorMessage: "缺少客户端记录 ID。" };

  let canonicalId;
  try {
    canonicalId = await resolveCanonicalId(
      getDatabase(),
      collectionName,
      openid,
      clientRecordId,
      requestedId
    );
  } catch (error) {
    if (operation === "delete" && error.code === "RECORD_NOT_FOUND" && allowMissingDelete) {
      return { ok: true, data: { clientRecordId, mutationVersion, mutationStatus: "ALREADY_DELETED" } };
    }
    return { ok: false, errorCode: error.code || "RECORD_NOT_FOUND", errorMessage: error.message };
  }

  const db = getDatabase();
  const identity = mutationIdentity(operation, clientRecordId, payload);
  try {
    const result = await db.runTransaction(async (transaction) => {
      const ref = transaction.collection(collectionName).doc(canonicalId);
      const snapshot = await ref.get();
      const current = snapshot && snapshot.data ? snapshot.data : null;
      if (current && current.openid !== openid) {
        const error = new Error("记录不存在或无权访问。");
        error.code = "RECORD_NOT_FOUND";
        throw error;
      }
      if (current && current.clientRecordId !== clientRecordId) {
        const error = new Error("记录逻辑地址不匹配。");
        error.code = "RECORD_ID_CONFLICT";
        throw error;
      }

      const currentVersion = current && Number.isInteger(Number(current.mutationVersion))
        ? Number(current.mutationVersion)
        : 0;
      if (mutationVersion < currentVersion) {
        return {
          ...publicRecord(current, canonicalId),
          mutationStatus: "STALE",
          serverVersion: currentVersion
        };
      }
      if (mutationVersion === currentVersion && currentVersion > 0) {
        if (current.mutationIdentity !== identity || current.lastMutationOperation !== operation) {
          const error = new Error("同一 mutationVersion 不得复用不同业务 mutation。");
          error.code = "VERSION_REUSE_CONFLICT";
          throw error;
        }
        return {
          ...publicRecord(current, canonicalId),
          mutationStatus: "IDEMPOTENT",
          serverVersion: currentVersion
        };
      }

      if (current && current.isDeleted === true && operation !== "delete") {
        const error = new Error("记录已经删除，普通保存和更新不得复活。");
        error.code = "TOMBSTONED";
        throw error;
      }
      if (!current && operation !== "create" && operation !== "delete") {
        const error = new Error("记录不存在或无权更新。");
        error.code = "RECORD_NOT_FOUND";
        throw error;
      }
      if (!current && operation === "delete" && allowMissingDelete) {
        return { clientRecordId, mutationVersion, mutationStatus: "ALREADY_DELETED" };
      }
      if (!allowCreate && !current && operation === "create") {
        const error = new Error("该 mutation 不允许创建记录。");
        error.code = "CREATE_NOT_ALLOWED";
        throw error;
      }

      const next = await buildRecord({ current, mutationVersion, identity, canonicalId, transaction });
      if (operation === "delete") {
        next.isDeleted = true;
        next.deletedAt = cloudbaseApp.database().serverDate();
      } else {
        next.isDeleted = false;
      }
      next.openid = openid;
      next.clientRecordId = clientRecordId;
      next.mutationVersion = mutationVersion;
      next.mutationIdentity = identity;
      next.lastMutationOperation = operation;

      if (current) {
        const record = { ...next };
        // @cloudbase/node-sdk 3.x 不允许 update 数据包含 _id
        delete record._id;
        await ref.update(record);
      } else {
        await ref.set(next);
      }
      return {
        ...publicRecord(next, canonicalId),
        mutationStatus: "APPLIED",
        serverVersion: mutationVersion
      };
    });
    return { ok: true, data: result };
  } catch (error) {
    return {
      ok: false,
      errorCode: error.code || "MUTATION_FAILED",
      errorMessage: error.message || "mutation 事务失败。",
      data: error.data
    };
  }
}

module.exports = {
  cloudbaseApp,
  getOpenId,
  getDatabase,
  isOwnedCloudFileId,
  isFormalClothingCloudFileId,
  validateCloudFileId,
  stableRecordId,
  mutationIdentity,
  parseMutationVersion,
  mutationVersionError,
  applyMutation
};
