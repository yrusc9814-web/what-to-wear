/**
 * OutfitReference 客户端数据层（独立新文件，零修改既有文件）。
 *
 * 本轮（第一轮 C 任务）已实现：
 *  - normalizeOutfitReference / buildOutfitReferenceRecord（生成 clientRecordId、mutationVersion 等本地字段）
 *  - saveReference / updateReference / removeReference / listReferences / getReference
 *  - 本地存储（scope 隔离 key）+ 独立 referenceOutbox（task 形状与 app-service 的
 *    queueSync 产物一致，entity='outfitReference'），供后续整合阶段直接消费。
 *
 * 说明：app-service.js 的 module.exports 清单中并未导出 queueSync / readSyncOutbox /
 * read / write（内部私有），因此本模块采用「形状兼容」的独立 outbox 存储键
 * （STORAGE.referenceOutbox，见下），避免与共享 outbox（xiaoyichu_v14_sync_outbox）
 * 冲突——在 performSyncTask 的 outfitReference 分支接线之前，现有同步管线不会消费它，
 * 也就不会把 reference 任务误发给 saveOutfit/deleteOutfitRecord。
 *
 * 整合阶段 TODO（由主代理安排 C 接线，本轮明确不做）：
 *  - performSyncTask 增加 entity === 'outfitReference' 分支：读取 STORAGE.referenceOutbox
 *    的任务，调用 saveOutfitReference / updateOutfitReference / deleteOutfitReference，
 *    成功后回写 record.cloudId 与 syncStatus 并删除任务（可复刻 app-service 的
 *    claimSyncTask / mutationEnvelope / callWorkerFunction 会话守卫模式）。
 *  - hydrateReferencesFromCloud：分页调用 getOutfitReferences，mergeById 到本地
 *    STORAGE.references（注意 deletedAt 保护），对齐 hydrateWardrobeFromCloud。
 *  - clearUserData 接入：清空 STORAGE.references / STORAGE.referenceOutbox 的 scope key。
 *  - 身份会话守卫：把 identitySessionId 从 app-service 传入任务，避免未接线前伪同步。
 */
const { SEASONS, STYLES } = require("../utils/constants");

const STORAGE = {
  references: "xiaoyichu_v14_outfit_references",
  referenceOutbox: "xiaoyichu_v14_outfit_reference_outbox"
};

const UNCONFIRMED_SCOPE = "current_wechat_user";
const SEASON_VALUES = new Set(SEASONS.map((item) => item.value));
const STYLE_VALUES = new Set(STYLES.map((item) => item.value));
const SOURCE_VALUES = new Set(["self", "web", "other"]);
const MAX_OCCASION_LENGTH = 30;
const MAX_NOTE_LENGTH = 200;
const MAX_NAME_LENGTH = 50;

const transientStorage = new Map();

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function currentScope() {
  const app = typeof getApp === "function" ? getApp({ allowDefault: true }) : null;
  const scope = app && app.globalData && app.globalData.userScope;
  return scope && scope !== UNCONFIRMED_SCOPE ? String(scope) : null;
}

function scopedKey(key, scope = currentScope()) {
  return scope ? `${key}:${scope}` : null;
}

function hasStoredValue(value) {
  return value !== "" && value != null;
}

function read(key, fallback, scope = currentScope()) {
  if (!scope) {
    const entry = transientStorage.get(key);
    return entry ? clone(entry.value) : clone(fallback);
  }
  const value = wx.getStorageSync(scopedKey(key, scope));
  return hasStoredValue(value) ? value : clone(fallback);
}

function write(key, value, scope = currentScope()) {
  if (!scope) {
    transientStorage.set(key, { value: clone(value) });
    return value;
  }
  wx.setStorageSync(scopedKey(key, scope), value);
  return value;
}

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function toTimestamp(value, fallback = 0) {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value && typeof value === "object" && Number.isFinite(value.$date)) return value.$date;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStringArray(value, normalizer, fallback) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[、,，/\s]+/);
  const result = [...new Set(source.filter(Boolean).map(normalizer).filter(Boolean))];
  return result.length ? result : fallback;
}

function normalizeOutfitReference(record = {}) {
  const createdAt = toTimestamp(record.createdAt, Date.now());
  const updatedAt = toTimestamp(record.updatedAt, createdAt);
  const id = String(record.clientRecordId || record.id || record._id || uniqueId("reference"));
  const imageFileId = record.imageFileId || record.fileId || record.imageUrl || "";
  return {
    id,
    clientRecordId: id,
    cloudId: String(record.cloudId || record._id || ""),
    createdAt,
    updatedAt,
    mutationVersion: Number(record.mutationVersion || record.clientVersion || record.syncVersion || 0),
    imageFileId,
    imageUrl: record.imageUrl || imageFileId,
    fileId: imageFileId,
    name: String(record.name || "未命名参考").trim().slice(0, MAX_NAME_LENGTH),
    seasons: normalizeStringArray(
      record.seasons || record.season || "",
      (value) => {
        if (!value || value === "all") return null;
        return SEASON_VALUES.has(value) ? value : null;
      },
      []
    ),
    season: (normalizeStringArray(record.seasons || record.season || "", (value) => SEASON_VALUES.has(value) ? value : null, []) || [])[0] || "",
    styles: normalizeStringArray(record.styles || record.style || "", (value) => (STYLE_VALUES.has(value) ? value : null), []),
    style: (normalizeStringArray(record.styles || record.style || "", (value) => STYLE_VALUES.has(value) ? value : null, []) || [])[0] || "",
    occasion: String(record.occasion || "").trim().slice(0, MAX_OCCASION_LENGTH),
    note: String(record.note || "").trim().slice(0, MAX_NOTE_LENGTH),
    source: SOURCE_VALUES.has(record.source) ? record.source : "other",
    deletedAt: record.deletedAt || (record.isDeleted ? record.updatedAt || Date.now() : null),
    syncStatus: record.syncStatus || (record.cloudId || record._id ? "synced" : "pending"),
    syncError: record.syncError || ""
  };
}

function validateReferenceWrite(record) {
  if (!record.imageFileId && !record.fileId && !record.imageUrl) throw new Error("请先上传参考图片");
  if (!String(record.name || "").trim()) throw new Error("请填写参考名称");
  if (!Array.isArray(record.seasons) || !record.seasons.length || record.seasons.some((value) => !SEASON_VALUES.has(value))) {
    throw new Error("请至少选择一个有效季节");
  }
  if (!Array.isArray(record.styles) || !record.styles.length || record.styles.some((value) => !STYLE_VALUES.has(value))) {
    throw new Error("请至少选择一个有效风格");
  }
  if (!SOURCE_VALUES.has(record.source)) throw new Error("请选择有效来源");
}

function buildOutfitReferenceRecord(payload, existing) {
  const source = existing || {};
  const candidate = { ...source, ...(payload || {}) };
  validateReferenceWrite(candidate);
  const mutationVersion = existing ? Number(existing.mutationVersion || 0) + 1 : 1;
  const record = normalizeOutfitReference({
    ...candidate,
    id: source.id || uniqueId("reference"),
    createdAt: source.createdAt || Date.now(),
    updatedAt: Date.now(),
    mutationVersion
  });
  record.syncStatus = "pending";
  record.syncError = "";
  return record;
}

function readReferencesAll(scope = currentScope()) {
  return read(STORAGE.references, [], scope);
}

function readReferenceOutbox(scope = currentScope()) {
  const value = read(STORAGE.referenceOutbox, { nextQueueSequence: 1, tasks: [] }, scope);
  const tasks = Array.isArray(value) ? value : value && Array.isArray(value.tasks) ? value.tasks : [];
  return tasks
    .filter((entry) => !entry.userScope || entry.userScope === scope || (!scope && entry.userScope === UNCONFIRMED_SCOPE))
    .map((entry) => ({
      ...entry,
      entity: entry.entity || "outfitReference",
      operation: entry.operation || entry.action,
      queueSequence: Number(entry.queueSequence || entry.sequence || entry.version || 0),
      mutationVersion: Number(entry.mutationVersion || entry.record && entry.record.mutationVersion || 0),
      payload: clone(entry.payload || entry.record || {}),
      record: clone(entry.record || entry.payload || {}),
      userScope: entry.userScope || scope || UNCONFIRMED_SCOPE
    }));
}

function pushReferenceOutboxTask(action, record, scope = currentScope()) {
  const clientRecordId = String(record.id || record.clientRecordId || "");
  const entityKey = `outfitReference:${clientRecordId}`;
  const rawState = read(STORAGE.referenceOutbox, { nextQueueSequence: 1, tasks: [] }, scope);
  let existingTasks = readReferenceOutbox(scope);
  let nextQueueSequence = Math.max(
    Number(rawState && rawState.nextQueueSequence) || 1,
    existingTasks.reduce((max, entry) => Math.max(max, Number(entry.queueSequence || 0)), 0) + 1
  );
  if (!Number.isSafeInteger(nextQueueSequence) || nextQueueSequence >= Number.MAX_SAFE_INTEGER) {
    const resequenced = existingTasks
      .map((task, index) => ({ task, index }))
      .sort((left, right) => {
        const difference = Number(left.task.queueSequence || 0) - Number(right.task.queueSequence || 0);
        return difference || left.index - right.index;
      })
      .map(({ task }, index) => ({ ...task, queueSequence: index + 1, sequence: index + 1, version: index + 1 }));
    existingTasks = resequenced;
    nextQueueSequence = existingTasks.length + 1;
    if (!Number.isSafeInteger(nextQueueSequence)) throw new Error("同步队列过大，无法分配安全的顺序号。");
  }
  const taskId = uniqueId("sync");
  const task = {
    taskId,
    id: taskId,
    entityKey,
    entity: "outfitReference",
    action,
    operation: action,
    clientRecordId,
    queueSequence: nextQueueSequence,
    sequence: nextQueueSequence,
    version: nextQueueSequence,
    mutationVersion: Number(record.mutationVersion || record.syncVersion || 0),
    createdAt: Date.now(),
    userScope: scope || UNCONFIRMED_SCOPE,
    identitySessionId: "",
    cloudId: String(record.cloudId || ""),
    payload: clone(record),
    record: clone(record),
    status: "pending",
    attempts: 0,
    lastError: "",
    updatedAt: Date.now()
  };
  write(STORAGE.referenceOutbox, { nextQueueSequence: nextQueueSequence + 1, tasks: [...existingTasks, task] }, scope);
  return task;
}

function saveReference(payload) {
  const record = buildOutfitReferenceRecord(payload);
  write(STORAGE.references, [record, ...readReferencesAll()]);
  pushReferenceOutboxTask("create", record);
  return readReferencesAll().find((item) => item.id === record.id) || record;
}

function updateReference(referenceId, patch) {
  const list = readReferencesAll();
  const existing = list.find((item) => item.id === String(referenceId));
  if (!existing) throw new Error("参考不存在或已被删除");
  const record = buildOutfitReferenceRecord(patch, existing);
  write(STORAGE.references, list.map((item) => (item.id === record.id ? record : item)));
  pushReferenceOutboxTask("update", record);
  return readReferencesAll().find((item) => item.id === record.id) || record;
}

function removeReference(referenceId) {
  const list = readReferencesAll();
  const existing = list.find((item) => item.id === String(referenceId));
  if (!existing) throw new Error("参考不存在或已被删除");
  const record = {
    ...existing,
    deletedAt: Date.now(),
    mutationVersion: Number(existing.mutationVersion || 0) + 1,
    updatedAt: Date.now(),
    syncStatus: "pending",
    syncError: ""
  };
  write(STORAGE.references, list.map((item) => (item.id === existing.id ? record : item)));
  pushReferenceOutboxTask("delete", record);
  return record;
}

function listReferences(options = {}) {
  const items = readReferencesAll().slice().sort((a, b) => b.createdAt - a.createdAt);
  return items.filter((item) => {
    if (!options.includeDeleted && item.deletedAt) return false;
    if (Array.isArray(options.seasons) && options.seasons.length && !options.seasons.some((value) => item.seasons.includes(value))) return false;
    if (Array.isArray(options.styles) && options.styles.length && !options.styles.some((value) => item.styles.includes(value))) return false;
    if (options.source && item.source !== options.source) return false;
    return true;
  });
}

function getReference(referenceId) {
  return readReferencesAll().find((item) => item.id === String(referenceId)) || null;
}

module.exports = {
  STORAGE,
  normalizeOutfitReference,
  buildOutfitReferenceRecord,
  saveReference,
  updateReference,
  removeReference,
  listReferences,
  getReference,
  readReferenceOutbox
};
