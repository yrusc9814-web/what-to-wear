const { canUseCloud, callFunction } = require("./cloud");
const { ensurePrivacyAuthorized } = require("../utils/privacy");
const {
  CATEGORIES,
  SEASONS,
  STYLES,
  PRIMARY_COLORS,
  THICKNESSES,
  getCurrentSeason,
  formatLocalDate,
  normalizeCategory,
  normalizeSeason,
  normalizeStyle
} = require("../utils/constants");

const STORAGE = {
  wardrobe: "xiaoyichu_v14_wardrobe",
  outfits: "xiaoyichu_v14_outfits",
  today: "xiaoyichu_v14_today_outfit",
  location: "xiaoyichu_v14_location",
  draft: "xiaoyichu_v14_outfit_draft",
  deletedOutfits: "xiaoyichu_v14_deleted_outfits",
  syncOutbox: "xiaoyichu_v14_sync_outbox",
  legacyQuarantine: "xiaoyichu_v14_legacy_quarantine",
  wardrobeView: "xiaoyichu_v14_wardrobe_view",
  legacyWardrobe: "chuanda_wardrobe_items",
  legacyOutfits: "chuanda_outfit_records",
  tempImages: "xiaoyichu_v14_temp_images"
};

const UNCONFIRMED_SCOPE = "current_wechat_user";
const USER_DATA_KEYS = [
  STORAGE.wardrobe,
  STORAGE.outfits,
  STORAGE.today,
  STORAGE.location,
  STORAGE.draft,
  STORAGE.deletedOutfits,
  STORAGE.syncOutbox,
  STORAGE.wardrobeView,
  STORAGE.legacyWardrobe,
  STORAGE.legacyOutfits
];
const transientStorage = new Map();
const untrustedLegacySources = new Set();
let identitySessionId = uniqueId("identity");
const MAX_QUARANTINE_BYTES = 200 * 1024;
const QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEMP_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
const SYNC_LEASE_MS = 30 * 1000;
const SYNC_LEASE_POLL_MS = 20;

function utf8ByteLength(value) {
  const text = String(value || "");
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
      && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00
      && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function currentUserScope() {
  const app = typeof getApp === "function" ? getApp({ allowDefault: true }) : null;
  const scope = app && app.globalData && app.globalData.userScope;
  return scope && scope !== UNCONFIRMED_SCOPE ? String(scope) : null;
}

function scopedKey(key, scope = currentUserScope()) {
  return scope ? `${key}:${scope}` : null;
}

function hasStoredValue(value) {
  return value !== "" && value != null;
}

function quarantineLegacyValue(key, value, source) {
  if (!hasStoredValue(value)) return true;
  try {
    const existing = wx.getStorageSync(STORAGE.legacyQuarantine);
    const now = Date.now();
    const snapshot = clone(value);
    const hash = JSON.stringify(snapshot);
    const entries = (Array.isArray(existing) ? existing : []).filter((entry) => (
      entry && now - Number(entry.quarantinedAt || 0) <= QUARANTINE_TTL_MS
    ));
    const sameSource = entries.findIndex((entry) => entry.key === key && entry.source === source);
    const nextEntry = { key, source, hash, value: snapshot, quarantinedAt: now };
    if (sameSource >= 0 && entries[sameSource].hash === hash) {
      untrustedLegacySources.delete(source);
      return true;
    }
    if (sameSource >= 0) entries.splice(sameSource, 1);
    entries.push(nextEntry);
    while (utf8ByteLength(JSON.stringify(entries)) > MAX_QUARANTINE_BYTES) entries.shift();
    wx.setStorageSync(STORAGE.legacyQuarantine, entries);
    untrustedLegacySources.delete(source);
    return true;
  } catch (error) {
    console.warn("legacy quarantine unavailable", error);
    untrustedLegacySources.add(source);
    return false;
  }
}

function quarantineLegacyStorage() {
  const marker = `${STORAGE.legacyQuarantine}:complete`;
  USER_DATA_KEYS.forEach((key) => {
    [key, `${key}:${UNCONFIRMED_SCOPE}`].forEach((sourceKey) => {
      try {
        const value = wx.getStorageSync(sourceKey);
        const quarantined = quarantineLegacyValue(key, value, sourceKey);
        if (quarantined && !untrustedLegacySources.has(sourceKey)) wx.removeStorageSync(sourceKey);
      } catch (error) {
        console.warn("legacy storage quarantine failed", sourceKey, error);
      }
    });
  });
  try { wx.setStorageSync(marker, true); } catch (error) { console.warn("legacy quarantine marker failed", error); }
}

function quarantineTransientStorage() {
  transientStorage.forEach((entry, key) => {
    quarantineLegacyValue(key, entry && entry.value, `memory:${entry && entry.sessionId}`);
  });
  transientStorage.clear();
}

function beginIdentityResolution() {
  quarantineTransientStorage();
  identitySessionId = uniqueId("identity");
}

function rebindMigratedValue(key, value, scope) {
  if (key !== STORAGE.syncOutbox) return value;
  const tasks = Array.isArray(value) ? value : value && Array.isArray(value.tasks) ? value.tasks : [];
  return {
    nextQueueSequence: Number(value && value.nextQueueSequence) || tasks.reduce((max, task) => Math.max(max, Number(task.queueSequence || task.sequence || 0)), 0) + 1,
    tasks: tasks.map((task) => ({ ...task, userScope: scope }))
  };
}

function migrateLegacyStorage(scope) {
  if (!scope) return;
  quarantineLegacyStorage();
  const marker = `xiaoyichu_v14_scope_migrated:${scope}`;
  USER_DATA_KEYS.forEach((key) => {
    const destination = scopedKey(key, scope);
    const existingValue = wx.getStorageSync(destination);
    const transientEntry = transientStorage.get(key);
    if (transientEntry && transientEntry.sessionId === identitySessionId) {
      const transientValue = rebindMigratedValue(key, transientEntry.value, scope);
      const migratedValue = Array.isArray(existingValue) && Array.isArray(transientValue)
        ? [...transientValue, ...existingValue]
        : transientValue;
      wx.setStorageSync(destination, clone(migratedValue));
      transientStorage.delete(key);
    }
  });
  wx.setStorageSync(marker, true);
}

function resolveUserScope(userId) {
  const scope = String(userId || "").trim();
  if (!scope || scope === UNCONFIRMED_SCOPE) return null;
  const previousScope = currentUserScope();
  if (!previousScope) migrateLegacyStorage(scope);
  beginIdentityResolution();
  const app = typeof getApp === "function" ? getApp({ allowDefault: true }) : null;
  if (app && app.globalData) {
    app.globalData.userScope = scope;
    app.globalData.identityState = "confirmed";
  }
  if (previousScope) migrateLegacyStorage(scope);
  return scope;
}

function markIdentityUnconfirmed(error) {
  const wasConfirmed = Boolean(currentUserScope());
  if (wasConfirmed) {
    quarantineTransientStorage();
    identitySessionId = uniqueId("identity");
  }
  const app = typeof getApp === "function" ? getApp({ allowDefault: true }) : null;
  if (app && app.globalData) {
    delete app.globalData.userScope;
    app.globalData.identityState = "unconfirmed";
    app.globalData.identityError = error ? String(error.message || error) : "";
  }
}

function read(key, fallback, scope = currentUserScope()) {
  if (!scope) {
    const transientEntry = transientStorage.get(key);
    return transientEntry ? clone(transientEntry.value) : clone(fallback);
  }
  migrateLegacyStorage(scope);
  const value = wx.getStorageSync(scopedKey(key, scope));
  return hasStoredValue(value) ? value : clone(fallback);
}

function write(key, value, scope = currentUserScope()) {
  if (!scope) {
    transientStorage.set(key, { value: clone(value), sessionId: identitySessionId });
    return value;
  }
  migrateLegacyStorage(scope);
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

const CATEGORY_VALUES = new Set(CATEGORIES.map((item) => item.value));
const SEASON_VALUES = new Set(SEASONS.map((item) => item.value));
const STYLE_VALUES = new Set(STYLES.map((item) => item.value));

function imageReference(value) {
  return String(value && (value.imageFileId || value.fileId || value.imageUrl || value.imagePath) || "").trim();
}

function isStableCloudImage(value) {
  return /^cloud:\/\/[A-Za-z0-9_.-]+(?:[/.][^\s]*)?$/i.test(String(value || "").trim());
}

function isOwnedStableCloudImage(value, scope = currentUserScope()) {
  return Boolean(scope && isStableCloudImage(value) && String(value).includes(`/wardrobe/${scope}/`));
}

function validateWardrobeWrite(item) {
  if (!imageReference(item)) throw new Error("请先上传单品图片");
  if (!String(item && item.name || "").trim()) throw new Error("请填写单品名称");
  if (!CATEGORY_VALUES.has(item && item.category)) throw new Error("请选择有效分类");
  if (!Array.isArray(item.seasons) || !item.seasons.length || item.seasons.some((value) => !SEASON_VALUES.has(value))) {
    throw new Error("请至少选择一个有效季节");
  }
  if (!Array.isArray(item.styles) || !item.styles.length || item.styles.some((value) => !STYLE_VALUES.has(value))) {
    throw new Error("请至少选择一个有效风格");
  }
}

function normalizeWardrobeItem(item = {}) {
  const category = normalizeCategory(item.category || item.type, item.name);
  const seasons = normalizeStringArray(
    item.seasons || item.season || "",
    (value) => {
      if (!value || value === "all") return null;
      return normalizeSeason(value);
    },
    []
  );
  const styles = normalizeStringArray(item.styles || item.style || item.tags || "", normalizeStyle, []);
  const primaryColor = item.primaryColor || item.mainColor || item.color || "";
  const imageFileId = item.imageFileId || item.fileId || "";
  const deletedAt = item.deletedAt || (item.isDeleted ? item.updatedAt || Date.now() : null);
  return {
    id: String(item.clientRecordId || item.id || item._id || uniqueId("item")),
    cloudId: String(item.cloudId || item._id || ""),
    createdAt: toTimestamp(item.createdAt, Date.now()),
    updatedAt: toTimestamp(item.updatedAt, Date.now()),
    mutationVersion: Number(item.mutationVersion || item.clientVersion || item.syncVersion || 0),
    imageUrl: item.imageUrl || imageFileId || "",
    imageFileId,
    fileId: imageFileId,
    name: String(item.name || "未命名单品").trim(),
    category,
    type: category,
    seasons,
    season: seasons[0],
    styles,
    style: styles[0],
    primaryColor,
    mainColor: primaryColor,
    thickness: item.thickness || "",
    size: item.size || "",
    purchasePrice: item.purchasePrice == null || item.purchasePrice === "" ? null : Number(item.purchasePrice),
    purchaseDate: item.purchaseDate || "",
    purchaseChannel: item.purchaseChannel || "",
    aiDescription: item.aiDescription || "",
    note: item.note || "",
    deletedAt,
    syncStatus: item.syncStatus || (item.cloudId || item._id ? "synced" : "pending"),
    syncError: item.syncError || ""
  };
}

function wardrobeSnapshot(item) {
  const normalized = normalizeWardrobeItem(item);
  return {
    itemId: normalized.id,
    snapshot: {
      name: normalized.name,
      category: normalized.category,
      imageUrl: normalized.imageUrl,
      imageFileId: normalized.imageFileId,
      primaryColor: normalized.primaryColor
    }
  };
}

function toCloudWardrobePayload(item) {
  return {
    clientRecordId: item.id,
    category: item.category,
    type: item.category === "hat" || item.category === "bag" ? "accessory" : item.category,
    name: item.name,
    season: item.seasons[0] || "all",
    style: item.styles[0] || "",
    mainColor: item.primaryColor,
    tags: item.styles,
    seasons: item.seasons,
    styles: item.styles,
    primaryColor: item.primaryColor,
    thickness: item.thickness,
    size: item.size,
    purchasePrice: item.purchasePrice,
    purchaseDate: item.purchaseDate,
    purchaseChannel: item.purchaseChannel,
    aiDescription: item.aiDescription,
    note: item.note,
    imageFileId: item.imageFileId || item.imageUrl
  };
}

function readSyncOutbox(scope = currentUserScope()) {
  const value = read(STORAGE.syncOutbox, { nextQueueSequence: 1, tasks: [] }, scope);
  const tasks = Array.isArray(value) ? value : value && Array.isArray(value.tasks) ? value.tasks : [];
  let legacySequence = 0;
  return tasks
    .filter((entry) => !entry.userScope || entry.userScope === scope || (!scope && entry.userScope === UNCONFIRMED_SCOPE))
    .map((entry) => {
      const entity = entry.entity || String(entry.entityKey || entry.id || "").split(":")[0];
      const clientRecordId = entry.clientRecordId || String(entry.entityKey || entry.id || "").split(":").slice(1).join(":");
      const legacyTaskId = `legacy_sync_${entry.id || `${entity}:${clientRecordId}`}_${legacySequence}`;
      const taskId = entry.taskId || legacyTaskId;
      const queueSequence = Number(entry.queueSequence || entry.sequence || entry.version || 0) || (legacySequence + 1);
      legacySequence = Math.max(legacySequence, queueSequence);
      return {
        ...entry,
        taskId,
        id: entry.id || taskId,
        entity,
        clientRecordId,
        entityKey: entry.entityKey || `${entity}:${clientRecordId}`,
        operation: entry.operation || entry.action,
        queueSequence,
        sequence: queueSequence,
        version: queueSequence,
        mutationVersion: Number(entry.mutationVersion || entry.record && entry.record.mutationVersion || 0),
        payload: clone(entry.payload || entry.record || {}),
        record: clone(entry.record || entry.payload || {}),
        userScope: entry.userScope || scope || UNCONFIRMED_SCOPE
      };
    });
}

function resequenceOutbox(tasks) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const sequenceDifference = Number(left.task.queueSequence || 0) - Number(right.task.queueSequence || 0);
      return sequenceDifference || left.index - right.index;
    })
    .map(({ task }, index) => {
      const queueSequence = index + 1;
      return {
        ...task,
        queueSequence,
        sequence: queueSequence,
        version: queueSequence
      };
    });
}

function queueSync(entity, action, record) {
  const clientRecordId = String(record.id || record.clientRecordId || "");
  const userScope = currentUserScope() || UNCONFIRMED_SCOPE;
  const entityKey = `${entity}:${clientRecordId}`;
  const scope = currentUserScope();
  const rawState = read(STORAGE.syncOutbox, { nextQueueSequence: 1, tasks: [] }, scope);
  let existingTasks = readSyncOutbox(scope);
  let nextQueueSequence = Math.max(
    Number(rawState && rawState.nextQueueSequence) || 1,
    existingTasks.reduce((max, entry) => Math.max(max, Number(entry.queueSequence || 0)), 0) + 1
  );
  if (!Number.isSafeInteger(nextQueueSequence) || nextQueueSequence >= Number.MAX_SAFE_INTEGER) {
    existingTasks = resequenceOutbox(existingTasks);
    nextQueueSequence = existingTasks.length + 1;
    if (!Number.isSafeInteger(nextQueueSequence)) {
      throw new Error("同步队列过大，无法分配安全的顺序号。");
    }
  }
  const taskId = uniqueId("sync");
  const task = {
    taskId,
    id: taskId,
    entityKey,
    entity,
    action,
    operation: action,
    clientRecordId,
    queueSequence: nextQueueSequence,
    sequence: nextQueueSequence,
    version: nextQueueSequence,
    mutationVersion: Number(record.mutationVersion || record.syncVersion || 0),
    createdAt: Date.now(),
    userScope,
    identitySessionId,
    cloudId: String(record.cloudId || ""),
    payload: clone(record),
    record: clone(record),
    status: "pending",
    attempts: 0,
    lastError: "",
    updatedAt: Date.now()
  };
  const outbox = [...existingTasks, task];
  write(STORAGE.syncOutbox, { nextQueueSequence: nextQueueSequence + 1, tasks: outbox }, scope);
  return task;
}

function updateSyncTask(taskId, patch, scope = currentUserScope()) {
  const next = readSyncOutbox(scope).map((entry) => entry.taskId === taskId ? { ...entry, ...patch } : entry);
  const current = read(STORAGE.syncOutbox, { nextQueueSequence: 1, tasks: [] }, scope);
  write(STORAGE.syncOutbox, { nextQueueSequence: Number(current && current.nextQueueSequence) || 1, tasks: next }, scope);
}

function isSyncTaskOwned(taskId, scope, sessionId) {
  const task = readSyncOutbox(scope).find((entry) => entry.taskId === taskId);
  return Boolean(
    task
    && task.userScope === scope
    && task.status === "syncing"
    && task.syncingSessionId === sessionId
  );
}

function claimSyncTask(taskId, scope, sessionId) {
  const task = readSyncOutbox(scope).find((entry) => entry.taskId === taskId);
  if (!task || task.userScope !== scope) return { claimed: false, task: null };
  const now = Date.now();
  const leaseUntil = Number(task.leaseUntil || 0);
  const ownedByAnotherActiveSession = task.status === "syncing"
    && task.syncingSessionId
    && task.syncingSessionId !== sessionId
    && leaseUntil > now;
  if (ownedByAnotherActiveSession) return { claimed: false, waiting: true, task };

  const patch = {
    status: "syncing",
    syncingSessionId: sessionId,
    syncStartedAt: now,
    leaseUntil: now + SYNC_LEASE_MS,
    attempts: Number(task.attempts || 0) + 1,
    updatedAt: now
  };
  updateSyncTask(task.taskId, patch, scope);
  return { claimed: true, task: { ...task, ...patch } };
}

function removeSyncTaskIfOwned(taskId, scope, sessionId) {
  if (!isSyncTaskOwned(taskId, scope, sessionId)) return false;
  removeSyncTask(taskId, scope);
  return true;
}

function removeSyncTask(taskId, scope = currentUserScope()) {
  const current = read(STORAGE.syncOutbox, { nextQueueSequence: 1, tasks: [] }, scope);
  write(STORAGE.syncOutbox, {
    nextQueueSequence: Number(current && current.nextQueueSequence) || 1,
    tasks: readSyncOutbox(scope).filter((entry) => entry.taskId !== taskId)
  }, scope);
}

function updateLocalSyncState(entity, clientRecordId, status, error, cloudId, task, scope = currentUserScope(), response = null) {
  const mutationVersion = Number(task && task.mutationVersion || 0);
  const canUpdateStatus = (item) => !task || Number(item.mutationVersion || 0) <= mutationVersion;
  const resolvedCloudId = String(cloudId || response && (response.cloudId || response._id || response.id) || "");
  if (entity === "wardrobe") {
    const next = readWardrobeAll(scope).map((item) => item.id === clientRecordId ? {
      ...item,
      cloudId: resolvedCloudId || item.cloudId,
      syncStatus: canUpdateStatus(item) ? status : item.syncStatus,
      syncError: canUpdateStatus(item) ? (error || "") : item.syncError
    } : item);
    write(STORAGE.wardrobe, next, scope);
    return next.find((item) => item.id === clientRecordId) || null;
  }
  const next = readOutfitsAll(scope).map((item) => item.id === clientRecordId ? {
    ...item,
    cloudId: resolvedCloudId || item.cloudId,
    syncStatus: canUpdateStatus(item) ? status : item.syncStatus,
    syncError: canUpdateStatus(item) ? (error || "") : item.syncError
  } : item);
  write(STORAGE.outfits, next, scope);
  return next.find((item) => item.id === clientRecordId) || null;
}

function normalizeSlot(value, category) {
  if (!value) return null;
  if (value.snapshot) {
    return {
      itemId: value.itemId == null ? null : String(value.itemId),
      snapshot: {
        name: value.snapshot.name || "已保存单品",
        category: normalizeCategory(value.snapshot.category || category, value.snapshot.name),
        imageUrl: value.snapshot.imageUrl || value.snapshot.imageFileId || "",
        imageFileId: value.snapshot.imageFileId || "",
        primaryColor: value.snapshot.primaryColor || ""
      }
    };
  }
  const normalized = normalizeWardrobeItem({ ...value, category: value.category || value.type || category });
  return wardrobeSnapshot(normalized);
}

function normalizeOutfit(record = {}) {
  const oldAccessory = record.accessory || null;
  const rawItems = record.items || {};
  const title = record.title || record.name || record.note || "我的穿搭";
  const createdAt = toTimestamp(record.createdAt, Date.now());
  const updatedAt = toTimestamp(record.updatedAt, createdAt);
  return {
    id: String(record.clientRecordId || record.id || record._id || uniqueId("outfit")),
    cloudId: String(record.cloudId || record._id || ""),
    createdAt,
    updatedAt,
    savedAt: toTimestamp(record.savedAt, updatedAt || createdAt),
    mutationVersion: Number(record.mutationVersion || record.clientVersion || record.syncVersion || 0),
    title: String(title).trim().slice(0, 30) || "我的穿搭",
    season: record.season ? normalizeSeason(record.season) : normalizeSeason(record.weatherSnapshot && record.weatherSnapshot.season),
    style: record.style ? normalizeStyle(record.style) : normalizeStyle(record.note),
    items: {
      hat: normalizeSlot(rawItems.hat || (/帽|cap|hat/i.test((oldAccessory && oldAccessory.name) || "") ? oldAccessory : null), "hat"),
      top: normalizeSlot(rawItems.top || record.top, "top"),
      bottom: normalizeSlot(rawItems.bottom || record.bottom, "bottom"),
      shoes: normalizeSlot(rawItems.shoes || record.shoes, "shoes"),
      bag: normalizeSlot(rawItems.bag || (oldAccessory && !/帽|cap|hat/i.test(oldAccessory.name || "") ? oldAccessory : null), "bag")
    },
    previewImageUrl: record.previewImageUrl || "",
    previewFileId: record.previewFileId || "",
    syncStatus: record.syncStatus || (record.cloudId || record._id ? "synced" : "pending"),
    syncError: record.syncError || ""
  };
}

function mergeById(primary, secondary, normalizer) {
  const map = new Map();
  [...secondary, ...primary].forEach((item) => {
    const normalized = normalizer(item);
    const existing = map.get(normalized.id);
    const incomingVersion = Number(normalized.mutationVersion || 0);
    const existingVersion = Number(existing && existing.mutationVersion || 0);
    if (!existing || incomingVersion > existingVersion || (incomingVersion === existingVersion && normalized.updatedAt >= existing.updatedAt)) {
      map.set(normalized.id, {
        ...normalized,
        cloudId: normalized.cloudId || (existing && existing.cloudId) || ""
      });
    }
  });
  return [...map.values()];
}

function readWardrobeAll(scope = currentUserScope()) {
  const current = read(STORAGE.wardrobe, [], scope);
  const legacy = read(STORAGE.legacyWardrobe, [], scope);
  const merged = mergeById(current, legacy, normalizeWardrobeItem).sort((a, b) => b.createdAt - a.createdAt);
  write(STORAGE.wardrobe, merged, scope);
  return merged;
}

function readOutfitsAll(scope = currentUserScope()) {
  const current = read(STORAGE.outfits, [], scope);
  const legacy = read(STORAGE.legacyOutfits, [], scope);
  const deletedIds = new Set(read(STORAGE.deletedOutfits, [], scope));
  const merged = mergeById(current, legacy, normalizeOutfit)
    .filter((item) => !deletedIds.has(item.id))
    .sort((a, b) => b.createdAt - a.createdAt);
  write(STORAGE.outfits, merged, scope);
  return merged;
}

async function hydrateWardrobeFromCloud() {
  if (!canUseCloud()) return readWardrobeAll();
  const scope = currentUserScope() || await ensureUserScope();
  if (!scope) return readWardrobeAll();
  await reconcilePendingSync();
  try {
    const cloudItems = [];
    let cursor = null;
    const seenCursors = new Set();
    while (true) {
      const request = { pageSize: 99 };
      if (cursor) request.cursor = cursor;
      const data = await callFunction("getWardrobe", request);
      const batch = (data && data.items) || [];
      cloudItems.push(...batch);
      if (!data || !data.hasMore) break;
      const nextId = data.nextCursor && data.nextCursor.lastId;
      const currentId = cursor && cursor.lastId;
      if (!nextId || nextId === currentId || seenCursors.has(nextId)) {
        const error = new Error("分页 cursor 未前进。");
        error.code = "CURSOR_NOT_ADVANCING";
        throw error;
      }
      seenCursors.add(nextId);
      cursor = { lastId: nextId };
    }
    const localItems = readWardrobeAll(scope);
    const eligibleCloudItems = cloudItems.filter((item) => {
      const clientId = item.clientRecordId || item.id || item._id;
      return !localItems.some((local) => local.id === String(clientId) && local.deletedAt);
    });
    const merged = mergeById(eligibleCloudItems, localItems, normalizeWardrobeItem);
    write(STORAGE.wardrobe, merged, scope);
    return merged;
  } catch (err) {
    console.warn("wardrobe cloud sync failed", err);
    if (err && err.code === "CURSOR_NOT_ADVANCING") throw err;
    return readWardrobeAll();
  }
}

async function hydrateOutfitsFromCloud() {
  if (!canUseCloud()) return readOutfitsAll();
  const scope = currentUserScope() || await ensureUserScope();
  if (!scope) return readOutfitsAll();
  await reconcilePendingSync();
  try {
    const allCloudItems = [];
    let cursor = null;
    const seenCursors = new Set();
    while (true) {
      const request = { pageSize: 99 };
      if (cursor) request.cursor = cursor;
      const data = await callFunction("getOutfitRecords", request);
      const batch = (data && data.items) || [];
      allCloudItems.push(...batch);
      if (!data || !data.hasMore) break;
      const nextId = data.nextCursor && data.nextCursor.lastId;
      const currentId = cursor && cursor.lastId;
      if (!nextId || nextId === currentId || seenCursors.has(nextId)) {
        const error = new Error("分页 cursor 未前进。");
        error.code = "CURSOR_NOT_ADVANCING";
        throw error;
      }
      seenCursors.add(nextId);
      cursor = { lastId: nextId };
    }
    const deletedIds = new Set(read(STORAGE.deletedOutfits, []));
    const cloudItems = allCloudItems.filter((item) => !deletedIds.has(String(item.clientRecordId || item.id || item._id)));
    const merged = mergeById(cloudItems, readOutfitsAll(scope), normalizeOutfit);
    write(STORAGE.outfits, merged, scope);
    return merged;
  } catch (err) {
    console.warn("outfit cloud sync failed", err);
    if (err && err.code === "CURSOR_NOT_ADVANCING") throw err;
    return readOutfitsAll();
  }
}

async function listWardrobeItems(options = {}) {
  const items = await hydrateWardrobeFromCloud();
  return items.filter((item) => {
    if (!options.includeDeleted && item.deletedAt) return false;
    if (options.category && item.category !== options.category) return false;
    return true;
  });
}

async function ensureUserScope() {
  const app = typeof getApp === "function" ? getApp({ allowDefault: true }) : null;
  if (app && app.globalData && app.globalData.userScope && app.globalData.userScope !== UNCONFIRMED_SCOPE) {
    return String(app.globalData.userScope);
  }
  if (!canUseCloud()) {
    markIdentityUnconfirmed(new Error("当前环境不支持云开发"));
    return null;
  }
  beginIdentityResolution();
  try {
    const identity = await callFunction("getUserIdentity", {});
    const userId = identity && identity.userId;
    if (!userId) throw new Error("未能确认微信用户身份");
    return resolveUserScope(userId);
  } catch (error) {
    markIdentityUnconfirmed(error);
    return null;
  }
}

async function getWardrobeItem(itemId) {
  await hydrateWardrobeFromCloud();
  return readWardrobeAll().find((item) => item.id === String(itemId)) || null;
}

function persistLocalImage(localPath) {
  if (!localPath || typeof wx.saveFile !== "function") return Promise.resolve(localPath);
  return new Promise((resolve) => {
    wx.saveFile({
      tempFilePath: localPath,
      success: (result) => resolve(result.savedFilePath || localPath),
      fail: () => resolve(localPath)
    });
  });
}

function imageCloudPath(userScope, extension, purpose) {
  const stamp = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  if (purpose === "temp") return `wardrobe/${userScope}/tmp/${stamp}.${extension}`;
  if (purpose === "reference") return `wardrobe/${userScope}/references/${stamp}.${extension}`;
  return `wardrobe/${userScope}/${stamp}.${extension}`;
}

async function uploadImage(localPath, scope, guard, purpose = "clothing") {
  const isTemporaryHttpPath = /^https?:\/\/tmp\//i.test(localPath || "");
  if (!localPath || (isOwnedStableCloudImage(localPath, scope)) || (/^https?:\/\//.test(localPath) && !isTemporaryHttpPath)) {
    const stable = isOwnedStableCloudImage(localPath, scope);
    return {
      imageUrl: stable ? localPath : "",
      fileId: stable ? localPath : "",
      storage: stable ? "cloud" : "remote",
      uploadState: stable ? "success" : "pending"
    };
  }
  if (isStableCloudImage(localPath)) {
    const error = new Error("旧图片需要重新选择并上传");
    error.code = "IMAGE_REUPLOAD_REQUIRED";
    throw error;
  }
  if (!canUseCloud()) {
    const savedPath = await persistLocalImage(localPath);
    return { imageUrl: savedPath, fileId: "", storage: "local" };
  }
  const userScope = scope || await ensureUserScope();
  if (!userScope) {
    const savedPath = await persistLocalImage(localPath);
    return { imageUrl: savedPath, fileId: "", storage: "local", uploadState: "pending", errorCode: "IDENTITY_UNCONFIRMED" };
  }
  const extension = ((localPath.match(/\.([a-z0-9]+)(?:\?.*)?$/i) || [])[1] || "jpg").toLowerCase();
  const cloudPath = imageCloudPath(userScope, extension, purpose);
  try {
    if (guard) guard();
    const result = await wx.cloud.uploadFile({ cloudPath, filePath: localPath });
    if (guard) guard();
    if (purpose === "temp") registerTempImage(result.fileID, userScope);
    return { imageUrl: result.fileID, fileId: result.fileID, storage: "cloud", uploadState: "success" };
  } catch (error) {
    console.warn("cloud image upload failed; local image retained", error);
    const savedPath = await persistLocalImage(localPath);
    return { imageUrl: savedPath, fileId: "", storage: "local", uploadState: "failed", errorCode: "UPLOAD_FAILED" };
  }
}

function tempRegistryKey(scope) {
  return scopedKey(STORAGE.tempImages, scope) || STORAGE.tempImages;
}

function tempFileScope(fileId) {
  const match = String(fileId || "").match(/\/wardrobe\/([^/]+)\/tmp\//);
  return match ? match[1] : null;
}

function readTempRegistry(scope = currentUserScope()) {
  try {
    const value = wx.getStorageSync(tempRegistryKey(scope));
    return Array.isArray(value) ? value.filter((entry) => entry && entry.fileId) : [];
  } catch (error) {
    console.warn("temp image registry unavailable", error);
    return [];
  }
}

function writeTempRegistry(entries, scope = currentUserScope()) {
  try { wx.setStorageSync(tempRegistryKey(scope), entries); } catch (error) { console.warn("temp image registry write failed", error); }
}

function registerTempImage(fileId, scope) {
  const id = String(fileId || "");
  if (!id) return null;
  const fileScope = scope || currentUserScope();
  const entries = readTempRegistry(fileScope);
  const existing = entries.find((entry) => entry.fileId === id);
  if (existing) {
    existing.uploadedAt = Date.now();
    writeTempRegistry(entries, fileScope);
    return existing;
  }
  const entry = { fileId: id, uploadedAt: Date.now(), scope: fileScope || "" };
  entries.push(entry);
  writeTempRegistry(entries, fileScope);
  return entry;
}

function unregisterTempImage(fileId) {
  const id = String(fileId || "");
  if (!id) return false;
  const fileScope = tempFileScope(id);
  if (!fileScope) return false;
  writeTempRegistry(readTempRegistry(fileScope).filter((entry) => entry.fileId !== id), fileScope);
  return true;
}

function readDeleteDetailStatus(data, fileId) {
  const details = data && Array.isArray(data.details) ? data.details : null;
  if (!details) return "";
  const entry = details.find((item) => item && item.fileId === fileId);
  return entry && typeof entry.status === "string" ? entry.status : "";
}

async function deleteTempFile(fileId) {
  const id = String(fileId || "");
  if (!id) return true;
  const scope = currentUserScope();
  if (scope && !id.includes(`/wardrobe/${scope}/tmp/`)) {
    console.warn("temp image delete skipped: not owned by current user", id);
    return false;
  }
  if (!/^cloud:\/\//i.test(id)) return true;
  if (!canUseCloud() || typeof wx.cloud !== "object") {
    console.warn("temp image delete skipped: cloud unavailable", id);
    return false;
  }
  // Round 2A-2：云函数产出的 cutout 文件客户端无删除权限（STORAGE_EXCEED_AUTHORITY），
  // tmp 前缀文件的清理优先走服务端 deleteWardrobeTemp；仅当服务端入口不可用/信封无明细时回退客户端删除。
  if (typeof wx.cloud.callFunction === "function") {
    try {
      const data = await callFunction("deleteWardrobeTemp", { tempFileIds: [id] });
      const status = readDeleteDetailStatus(data, id);
      if (status === "deleted" || status === "notFound") {
        console.log("temp image deleted via deleteWardrobeTemp", status, id);
        return true;
      }
      if (status) {
        console.warn("temp image delete rejected by server", id, status);
        return false;
      }
    } catch (error) {
      console.warn("deleteWardrobeTemp unavailable; fallback to client delete", (error && error.code) || "");
    }
  }
  if (typeof wx.cloud.deleteFile !== "function") {
    console.warn("temp image delete skipped: cloud deleteFile unavailable", id);
    return false;
  }
  try {
    await wx.cloud.deleteFile({ fileList: [id] });
    return true;
  } catch (error) {
    console.warn("temp image delete failed; will retry later", id, error);
    return false;
  }
}

async function clearTempImage(fileId) {
  const deleted = await deleteTempFile(fileId);
  if (deleted) unregisterTempImage(fileId);
  return deleted;
}

async function sweepExpiredTempImages(now = Date.now()) {
  const cutoff = now - TEMP_IMAGE_TTL_MS;
  const scope = currentUserScope();
  const entries = readTempRegistry(scope);
  const kept = [];
  let swept = 0;
  for (const entry of entries) {
    if (Number(entry.uploadedAt || 0) >= cutoff) { kept.push(entry); continue; }
    swept += 1;
    const deleted = await deleteTempFile(entry.fileId);
    if (!deleted) kept.push({ ...entry, uploadedAt: Date.now() });
  }
  writeTempRegistry(kept, scope);
  return swept;
}

async function standardizeCutoutImage(cutoutTempFileId) {
  if (typeof cutoutTempFileId !== "string" || !cutoutTempFileId.trim()) {
    const error = new Error("抠图结果无效，请重试");
    error.code = "INVALID_CUTOUT_TEMP_FILE_ID";
    throw error;
  }
  const data = await callFunction("standardizeClothingImage", { cutoutTempFileId });
  if (!data || typeof data.standardizedTempFileId !== "string" || !data.standardizedTempFileId.trim()) {
    const error = new Error("标准化结果为空，请稍后重试");
    error.code = "STANDARDIZE_INVALID_RESULT";
    throw error;
  }
  registerTempImage(data.standardizedTempFileId);
  return {
    ...data,
    standardizedTempFileId: data.standardizedTempFileId,
    width: data.width,
    height: data.height,
    bytes: data.bytes,
    elapsedMs: data.elapsedMs
  };
}

// Round 2A-4: 提升 standardized temp 为正式 clothing 资产
async function promoteStandardizedClothingAsset(standardizedTempFileId) {
  if (typeof standardizedTempFileId !== "string" || !standardizedTempFileId.trim()) {
    const error = new Error("标准化结果无效，请重试");
    error.code = "INVALID_STANDARDIZED_TEMP_FILE_ID";
    throw error;
  }
  const data = await callFunction("promoteClothingAsset", { standardizedTempFileId });
  if (!data || typeof data.formalImageFileId !== "string" || !data.formalImageFileId.trim()) {
    const error = new Error("正式图片提升失败，请稍后重试");
    error.code = "PROMOTE_INVALID_RESULT";
    throw error;
  }
  if (!/\/clothing\//.test(data.formalImageFileId) || /\/tmp\//.test(data.formalImageFileId)) {
    const error = new Error("提升结果异常，请稍后重试");
    error.code = "PROMOTE_UNEXPECTED_PATH";
    throw error;
  }
  return {
    formalImageFileId: data.formalImageFileId,
    sha256: data.sha256,
    width: data.width,
    height: data.height,
    bytes: data.bytes,
    status: data.status
  };
}

// Round 2A-4: 本地幂等判定忽略的同步元数据字段。
// 业务等价判定只对比 normalizeWardrobeItem 既定业务字段；
// createdAt/updatedAt/mutationVersion/syncStatus/syncError/cloudId 等一律忽略。
const WARDROBE_BUSINESS_KEYS = [
  "imageFileId",
  "imageUrl",
  "name",
  "category",
  "type",
  "seasons",
  "season",
  "styles",
  "style",
  "primaryColor",
  "mainColor",
  "thickness",
  "size",
  "purchasePrice",
  "purchaseDate",
  "purchaseChannel",
  "aiDescription",
  "note",
  "deletedAt"
];

function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (left && typeof left === "object") {
    if (!right || typeof right !== "object" || Array.isArray(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => rightKeys[index] === key && deepEqual(left[key], right[key]));
  }
  return false;
}

function businessFieldsEquivalent(left, right) {
  return WARDROBE_BUSINESS_KEYS.every((key) => deepEqual(left[key], right[key]));
}

async function createWardrobeItem(payload) {
  validateWardrobeWrite(payload || {});
  const clientRecordId = typeof payload.clientRecordId === "string" && payload.clientRecordId.trim()
    ? payload.clientRecordId.trim()
    : uniqueId("item");
  const normalized = normalizeWardrobeItem({ ...payload, id: clientRecordId, mutationVersion: 1, createdAt: Date.now(), updatedAt: Date.now() });
  normalized.syncStatus = "pending";
  const items = readWardrobeAll();
  const existing = items.find((item) => item.id === normalized.id);
  if (existing) {
    // Round 2A-4: 本地幂等 — 同 id 已存在记录
    if (!businessFieldsEquivalent(normalizeWardrobeItem(existing), normalized)) {
      const error = new Error("该单品已存在且内容不一致，请刷新后重试");
      error.code = "CLIENT_RECORD_ID_CONFLICT";
      throw error;
    }
    // 业务字段等价：不新增本地记录、不追加 outbox（queue 前先查同 entityKey+clientRecordId+mutationVersion+operation 已有 pending/failed task 则不再 queue）
    const hasSameTask = readSyncOutbox().some((task) => (
      task.entityKey === `wardrobe:${normalized.id}`
      && String(task.clientRecordId) === normalized.id
      && Number(task.mutationVersion || 0) === Number(normalized.mutationVersion || 0)
      && task.operation === "create"
    ));
    if (!hasSameTask) queueSync("wardrobe", "create", normalized);
    await reconcilePendingSync();
    return readWardrobeAll().find((item) => item.id === normalized.id) || existing;
  }
  write(STORAGE.wardrobe, [normalized, ...items]);
  queueSync("wardrobe", "create", normalized);
  await reconcilePendingSync();
  return readWardrobeAll().find((item) => item.id === normalized.id) || normalized;
}

async function updateWardrobeItem(itemId, patch) {
  const items = readWardrobeAll();
  let updated = null;
  const next = items.map((item) => {
    if (item.id !== String(itemId)) return item;
    const candidate = {
      ...item,
      ...patch,
      id: item.id,
      mutationVersion: Number(item.mutationVersion || 0) + 1,
      createdAt: item.createdAt,
      updatedAt: Date.now()
    };
    validateWardrobeWrite(candidate);
    updated = normalizeWardrobeItem(candidate);
    updated.syncStatus = "pending";
    return updated;
  });
  if (!updated) throw new Error("单品不存在或已被删除");
  write(STORAGE.wardrobe, next);
  queueSync("wardrobe", "update", updated);
  await reconcilePendingSync();
  return readWardrobeAll().find((item) => item.id === updated.id) || updated;
}

async function deleteWardrobeItem(itemOrId) {
  const itemId = String(typeof itemOrId === "object" ? itemOrId.id : itemOrId);
  let existing = readWardrobeAll().find((item) => item.id === itemId);
  if (!existing) existing = await getWardrobeItem(itemId);
  if (!existing) throw new Error("单品不存在或已被删除");
  const items = readWardrobeAll();
  const updated = normalizeWardrobeItem({
    ...existing,
    deletedAt: Date.now(),
    mutationVersion: Number(existing.mutationVersion || 0) + 1,
    updatedAt: Date.now()
  });
  updated.syncStatus = "pending";
  write(STORAGE.wardrobe, items.map((item) => item.id === itemId ? updated : item));
  queueSync("wardrobe", "delete", updated);
  await reconcilePendingSync();
  return readWardrobeAll().find((item) => item.id === updated.id) || updated;
}

async function recognizeWardrobeItem(payload = {}) {
  const image = payload.imageUrl || payload.fileId;
  if (!image) throw new Error("请先选择单品图片");
  if (!canUseCloud()) throw new Error("当前环境未接入 AI 识图，请手动填写");
  const upload = await uploadImage(image);
  if (!isStableCloudImage(upload.fileId)) throw new Error("图片上传失败，请重试或手动填写");
  const data = await callFunction("analyzeClothing", {
    imageFileId: upload.fileId || upload.imageUrl,
    originalName: payload.name || ""
  });
  if (!data || data.status !== "success" || data.source !== "ai" || !data.data) {
    const error = new Error("AI 识别暂不可用，请手动填写");
    error.code = data && data.reason ? data.reason : "MANUAL_REQUIRED";
    throw error;
  }
  const result = data.data;
  const name = result.name || "";
  return {
    name,
    category: normalizeCategory(result.category, name),
    primaryColor: result.primaryColor || "",
    seasons: result.seasons || [],
    styles: result.styles || [],
    thickness: result.thickness || "",
    aiDescription: result.aiDescription || "",
    imageUrl: upload.imageUrl,
    fileId: upload.fileId,
    source: "ai"
  };
}

async function analyzeClothing(payload) {
  return recognizeWardrobeItem(payload);
}

async function generateItemDescription({ item = {} }) {
  if (!item || !item.name) throw new Error("请先填写单品信息");
  return item.aiDescription || "";
}

async function listSavedOutfits(options = {}) {
  let items = await hydrateOutfitsFromCloud();
  if (options.season) items = items.filter((item) => item.season === options.season);
  if (options.style && options.style !== "all") items = items.filter((item) => item.style === options.style);
  items.sort((a, b) => b.savedAt - a.savedAt);
  return options.limit ? items.slice(0, Number(options.limit)) : items;
}

async function getSavedOutfit(outfitId) {
  await hydrateOutfitsFromCloud();
  return readOutfitsAll().find((item) => item.id === String(outfitId)) || null;
}

function buildOutfit(payload, existing) {
  const source = existing || {};
  const rawItems = payload.items || payload.slots || source.items || {};
  const title = String(payload.title || payload.name || "").trim();
  if (!title || !SEASON_VALUES.has(payload.season) || !STYLE_VALUES.has(payload.style)) {
    throw new Error("请完整填写搭配名称、季节和风格");
  }
  const trustedItems = {};
  ["hat", "top", "bottom", "shoes", "bag"].forEach((slot) => {
    const value = rawItems[slot];
    if (!value) {
      if (slot === "top" || slot === "bottom" || slot === "shoes") throw new Error("请选择上衣、下装和鞋子");
      trustedItems[slot] = null;
      return;
    }
    const snapshot = value.snapshot || value;
    const category = snapshot.category || value.category || value.type;
    const ref = value.itemId || value.id;
    if (category !== slot) throw new Error(`${slot} 槽位的单品分类不匹配，请重新选择`);
    if (!ref || !imageReference(snapshot)) throw new Error("搭配单品缺少有效图片或引用");
    const live = readWardrobeAll().find((item) => item.id === String(ref));
    if (!live || live.deletedAt || live.category !== slot) throw new Error(`${slot} 槽位的单品已失效，请重新选择`);
    trustedItems[slot] = wardrobeSnapshot(live);
  });
  const mutationVersion = existing ? Number(existing.mutationVersion || 0) + 1 : 1;
  const record = normalizeOutfit({
    ...source,
    ...payload,
    id: source.id || uniqueId("outfit"),
    createdAt: source.createdAt || Date.now(),
    updatedAt: Date.now(),
    mutationVersion,
    title,
    savedAt: Date.now(),
    items: trustedItems
  });
  return record;
}

function snapshotToCloudItem(value) {
  if (!value || !value.snapshot) return null;
  return {
    id: value.itemId,
    itemId: value.itemId,
    category: value.snapshot.category,
    type: value.snapshot.category,
    name: value.snapshot.name,
    imageUrl: value.snapshot.imageUrl,
    imageFileId: value.snapshot.imageFileId,
    primaryColor: value.snapshot.primaryColor
  };
}

function outfitCloudPayload(record) {
  return {
    clientRecordId: record.id,
    title: record.title,
    season: record.season,
    style: record.style,
    items: record.items,
    date: formatLocalDate(),
    savedAt: record.savedAt,
    mutationVersion: record.mutationVersion,
    clientVersion: record.mutationVersion
  };
}

async function stabilizeWardrobeItem(item, scope = currentUserScope(), task, guard) {
  if (isOwnedStableCloudImage(item.imageFileId, scope)) return item;
  const localReference = imageReference(item);
  const uploaded = await uploadImage(localReference, scope, guard);
  if (!isStableCloudImage(uploaded.fileId)) {
    const error = new Error("图片尚未同步到云端，请重试");
    error.code = uploaded.errorCode || "IMAGE_UPLOAD_PENDING";
    throw error;
  }
  const next = normalizeWardrobeItem({
    ...item,
    imageUrl: uploaded.fileId,
    imageFileId: uploaded.fileId,
    fileId: uploaded.fileId,
    updatedAt: Date.now(),
    syncStatus: "syncing"
  });
  const current = readWardrobeAll(scope).find((entry) => entry.id === next.id);
  if (!task || !current || Number(current.mutationVersion || 0) <= Number(task.mutationVersion || 0)) {
    write(STORAGE.wardrobe, readWardrobeAll(scope).map((entry) => entry.id === next.id ? next : entry), scope);
  }
  return next;
}

async function stabilizePreview(record, scope = currentUserScope(), guard) {
  const preview = record.previewFileId || record.previewImageUrl || "";
  if (!preview) return { ...record, previewImageUrl: "", previewFileId: "" };
  if (isOwnedStableCloudImage(preview, scope)) {
    return { ...record, previewImageUrl: preview, previewFileId: preview };
  }
  let uploaded;
  try {
    uploaded = await uploadImage(preview, scope, guard);
  } catch (error) {
    return { ...record, previewImageUrl: "", previewFileId: "" };
  }
  if (!isStableCloudImage(uploaded.fileId)) {
    return { ...record, previewImageUrl: "", previewFileId: "" };
  }
  return { ...record, previewImageUrl: uploaded.fileId, previewFileId: uploaded.fileId };
}

async function ensureOutfitStableImages(record, scope = currentUserScope(), task, guard, sessionId) {
  const nextItems = { ...record.items };
  for (const slot of ["hat", "top", "bottom", "shoes", "bag"]) {
    const value = nextItems[slot];
    if (!value) continue;
    if (isOwnedStableCloudImage(value.snapshot && value.snapshot.imageFileId, scope)) continue;
    const live = readWardrobeAll(scope).find((item) => item.id === String(value.itemId));
    if (!live || live.deletedAt || live.category !== slot) throw new Error(`${slot} 槽位的单品已失效，请重新选择`);
    const stable = await stabilizeWardrobeItem(live, scope, task, guard);
    let wardrobeCloudId = stable.cloudId;
    if (!wardrobeCloudId || stable.syncStatus !== "synced") {
      const wardrobeTask = {
        ...task,
        taskId: `${task.taskId}:wardrobe:${stable.id}`,
        entity: "wardrobe",
        entityKey: `wardrobe:${stable.id}`,
        operation: "create",
        clientRecordId: stable.id,
        mutationVersion: Number(stable.mutationVersion || 1)
      };
      const wardrobeResult = await callWorkerFunction("saveClothing", mutationEnvelope(wardrobeTask, {
        ...toCloudWardrobePayload(stable),
        mutationVersion: Number(stable.mutationVersion || 1)
      }, scope, { identitySessionId: sessionId }), scope, sessionId, task.taskId);
      if (!wardrobeResult.owned) {
        const error = new Error("同步任务 lease 已失效，停止旧 worker。");
        error.code = "SYNC_LEASE_LOST";
        throw error;
      }
      const wardrobeData = wardrobeResult.data;
      wardrobeCloudId = String(wardrobeData && (wardrobeData._id || wardrobeData.id) || stable.cloudId || "");
      updateLocalSyncState("wardrobe", stable.id, "synced", "", wardrobeCloudId, null, scope);
    }
    nextItems[slot] = wardrobeSnapshot({ ...stable, cloudId: wardrobeCloudId });
  }
  const next = await stabilizePreview({ ...record, items: nextItems }, scope, guard);
  const current = readOutfitsAll(scope).find((entry) => entry.id === next.id);
  if (!task || !current || Number(current.mutationVersion || 0) <= Number(task.mutationVersion || 0)) {
    write(STORAGE.outfits, readOutfitsAll(scope).map((entry) => entry.id === next.id ? next : entry), scope);
  }
  return next;
}

function isWorkerSessionActive(scope, sessionId) {
  return currentUserScope() === scope && identitySessionId === sessionId;
}

function assertWorkerSession(scope, sessionId) {
  if (!isWorkerSessionActive(scope, sessionId)) {
    const error = new Error("身份 session 已变化，停止旧 worker。");
    error.code = "IDENTITY_SESSION_CHANGED";
    throw error;
  }
}

function assertSyncTaskWorker(taskId, scope, sessionId) {
  assertWorkerSession(scope, sessionId);
  if (!isSyncTaskOwned(taskId, scope, sessionId)) {
    const error = new Error("同步任务 lease 已失效，停止旧 worker。");
    error.code = "SYNC_LEASE_LOST";
    throw error;
  }
}

function mutationEnvelope(task, payload, scope, overrides = {}) {
  const businessPayload = clone(payload || {});
  return {
    ...businessPayload,
    taskId: task.taskId,
    entity: overrides.entity || task.entity,
    entityKey: overrides.entityKey || task.entityKey,
    operation: overrides.operation || task.operation,
    queueSequence: task.queueSequence,
    mutationVersion: task.mutationVersion,
    clientRecordId: overrides.clientRecordId || task.clientRecordId,
    userScope: scope,
    identitySessionId: overrides.identitySessionId || task.identitySessionId,
    payload: businessPayload
  };
}

async function callWorkerFunction(name, data, scope, sessionId, taskId) {
  assertWorkerSession(scope, sessionId);
  if (taskId) assertSyncTaskWorker(taskId, scope, sessionId);
  const result = await callFunction(name, data);
  return {
    data: result,
    active: isWorkerSessionActive(scope, sessionId),
    owned: taskId ? isSyncTaskOwned(taskId, scope, sessionId) : true
  };
}

async function performSyncTask(task, scope, sessionId) {
  const guard = () => assertSyncTaskWorker(task.taskId, scope, sessionId);
  if (task.entity === "wardrobe") {
    const liveItem = readWardrobeAll(scope).find((entry) => entry.id === task.clientRecordId);
    const item = task.payload || task.record || liveItem;
    if (!item) return { active: isWorkerSessionActive(scope, sessionId), owned: isSyncTaskOwned(task.taskId, scope, sessionId) };
    if (liveItem && !item.cloudId) item.cloudId = liveItem.cloudId;
    if (task.action === "delete") {
      const result = await callWorkerFunction("deleteClothing", mutationEnvelope(task, {
        id: item.cloudId || task.cloudId,
        clientRecordId: item.id,
        mutationVersion: task.mutationVersion,
        userScope: scope
      }, scope, { identitySessionId: sessionId }), scope, sessionId, task.taskId);
      if (!result.owned) return { active: false, owned: false };
      updateLocalSyncState("wardrobe", item.id, "synced", "", item.cloudId, task, scope);
      return { active: result.active, owned: true };
    }
    const stable = await stabilizeWardrobeItem(item, scope, task, guard);
    const useUpdate = task.action === "update" && stable.cloudId;
    const result = await callWorkerFunction(useUpdate ? "updateClothing" : "saveClothing", mutationEnvelope(task, {
      ...(useUpdate ? { id: stable.cloudId } : {}),
      mutationVersion: task.mutationVersion,
      userScope: scope,
      ...toCloudWardrobePayload(stable)
    }, scope, { identitySessionId: sessionId }), scope, sessionId, task.taskId);
    if (!result.owned) return { active: false, owned: false };
    updateLocalSyncState("wardrobe", stable.id, "synced", "", String(result.data && (result.data._id || result.data.id) || stable.cloudId || ""), task, scope, result.data);
    return { active: result.active, owned: true };
  }

  const liveRecord = readOutfitsAll(scope).find((entry) => entry.id === task.clientRecordId);
  const record = task.payload || task.record || liveRecord;
  if (task.action === "delete") {
    const result = await callWorkerFunction("deleteOutfitRecord", mutationEnvelope(task, {
      id: record && record.cloudId || task.cloudId,
      clientRecordId: task.clientRecordId,
      mutationVersion: task.mutationVersion,
      userScope: scope
    }, scope, { identitySessionId: sessionId }), scope, sessionId, task.taskId);
    return { active: result.active, owned: result.owned };
  }
  if (!record) return { active: isWorkerSessionActive(scope, sessionId), owned: isSyncTaskOwned(task.taskId, scope, sessionId) };
  if (liveRecord && !record.cloudId) record.cloudId = liveRecord.cloudId;
  const stable = await ensureOutfitStableImages(record, scope, task, guard, sessionId);
  const useUpdate = task.action === "update" && stable.cloudId;
  const result = await callWorkerFunction(useUpdate ? "updateSavedOutfit" : "saveOutfit", mutationEnvelope(task, {
    ...(useUpdate ? { id: stable.cloudId } : {}),
    mutationVersion: task.mutationVersion,
    userScope: scope,
    ...outfitCloudPayload(stable),
    previewImageUrl: stable.previewImageUrl,
    previewFileId: stable.previewFileId
  }, scope, { identitySessionId: sessionId }), scope, sessionId, task.taskId);
  if (!result.owned) return { active: false, owned: false };
  updateLocalSyncState("outfit", stable.id, "synced", "", String(result.data && (result.data._id || result.data.id) || stable.cloudId || ""), task, scope, result.data);
  return { active: result.active, owned: true };
}

const reconciliationPromises = new Map();

function waitForSyncLease(scope, task, sessionId) {
  const remaining = Number(task.leaseUntil || 0) - Date.now();
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(1, Math.min(remaining, SYNC_LEASE_POLL_MS)));
  });
}

async function reconcilePendingSync() {
  const scope = currentUserScope();
  if (!canUseCloud() || !scope) return readSyncOutbox(scope);
  const sessionId = identitySessionId;
  const workerKey = `${scope}:${sessionId}`;
  if (reconciliationPromises.has(workerKey)) return reconciliationPromises.get(workerKey);
  const promise = (async () => {
    while (true) {
      if (!isWorkerSessionActive(scope, sessionId)) break;
      const task = readSyncOutbox(scope).slice().sort((left, right) => Number(left.queueSequence || 0) - Number(right.queueSequence || 0))[0];
      if (!task) break;
      const currentTask = readSyncOutbox(scope).find((entry) => entry.taskId === task.taskId);
      if (!currentTask || currentTask.userScope !== scope) continue;
      const claim = claimSyncTask(currentTask.taskId, scope, sessionId);
      if (!claim.claimed) {
        if (claim.waiting) await waitForSyncLease(scope, claim.task, sessionId);
        continue;
      }
      const claimedTask = claim.task;
      updateLocalSyncState(claimedTask.entity, claimedTask.clientRecordId, "syncing", "", claimedTask.cloudId, claimedTask, scope);
      try {
        const result = await performSyncTask(claimedTask, scope, sessionId);
        if (!result || !result.owned) break;
        if (!removeSyncTaskIfOwned(claimedTask.taskId, scope, sessionId)) break;
        if (!result.active) break;
      } catch (error) {
        if (!isSyncTaskOwned(claimedTask.taskId, scope, sessionId)
          || error && ["IDENTITY_SESSION_CHANGED", "SYNC_LEASE_LOST"].includes(error.code)) break;
        if (error && ["STALE", "TOMBSTONED"].includes(error.code)) {
          if (removeSyncTaskIfOwned(claimedTask.taskId, scope, sessionId)) {
            updateLocalSyncState(claimedTask.entity, claimedTask.clientRecordId, "synced", "", claimedTask.cloudId, claimedTask, scope);
          }
          continue;
        }
        const message = String(error && error.message || "云端同步失败");
        updateSyncTask(claimedTask.taskId, {
          status: "failed",
          lastError: message,
          syncingSessionId: "",
          syncStartedAt: 0,
          leaseUntil: 0,
          updatedAt: Date.now()
        }, scope);
        updateLocalSyncState(claimedTask.entity, claimedTask.clientRecordId, "failed", message, claimedTask.cloudId, claimedTask, scope);
        break;
      }
    }
    return readSyncOutbox(scope);
  })().finally(() => {
    reconciliationPromises.delete(workerKey);
  });
  reconciliationPromises.set(workerKey, promise);
  return promise;
}

async function createSavedOutfit(payload) {
  const record = buildOutfit(payload);
  record.syncStatus = "pending";
  write(STORAGE.outfits, [record, ...readOutfitsAll()]);
  queueSync("outfit", "create", record);
  await reconcilePendingSync();
  return readOutfitsAll().find((item) => item.id === record.id) || record;
}

async function saveOutfit(payload) {
  return createSavedOutfit(payload);
}

async function updateSavedOutfit(outfitId, payload) {
  const items = readOutfitsAll();
  const existing = items.find((item) => item.id === String(outfitId));
  if (!existing) throw new Error("搭配不存在");
  const record = buildOutfit(payload, existing);
  record.syncStatus = "pending";
  write(STORAGE.outfits, items.map((item) => (item.id === record.id ? record : item)));
  queueSync("outfit", "update", record);
  await reconcilePendingSync();
  return readOutfitsAll().find((item) => item.id === record.id) || record;
}

async function deleteSavedOutfit(outfitOrId) {
  const outfitId = String(typeof outfitOrId === "object" ? outfitOrId.id : outfitOrId);
  const exists = readOutfitsAll().some((item) => item.id === outfitId);
  if (!exists) throw new Error("搭配不存在");
  const existing = readOutfitsAll().find((item) => item.id === outfitId);
  const deleteMutation = {
    ...existing,
    mutationVersion: Number(existing.mutationVersion || 0) + 1,
    updatedAt: Date.now(),
    deletedAt: Date.now(),
    syncStatus: "pending",
    syncError: ""
  };
  const deletedIds = new Set(read(STORAGE.deletedOutfits, []));
  deletedIds.add(outfitId);
  write(STORAGE.deletedOutfits, [...deletedIds]);
  write(STORAGE.outfits, readOutfitsAll().filter((item) => item.id !== outfitId));
  const today = getValidTodayAssignment();
  if (today && today.outfitId === outfitId) write(STORAGE.today, null);
  queueSync("outfit", "delete", deleteMutation);
  await reconcilePendingSync();
  const pending = readSyncOutbox().find((task) => task.entityKey === `outfit:${outfitId}`);
  return { deleted: true, syncStatus: pending ? pending.status : "synced", syncError: pending ? pending.lastError : "" };
}

function getValidTodayAssignment(date = new Date()) {
  const assignment = read(STORAGE.today, null);
  if (!assignment) return null;
  if (assignment.date !== formatLocalDate(date)) {
    write(STORAGE.today, null);
    return null;
  }
  return assignment;
}

async function setTodayOutfit(outfitId, date = new Date()) {
  const outfit = await getSavedOutfit(outfitId);
  if (!outfit) throw new Error("搭配不存在");
  return write(STORAGE.today, { date: formatLocalDate(date), outfitId: String(outfitId) });
}

async function getTodayOutfit(date = new Date()) {
  const assignment = getValidTodayAssignment(date);
  return {
    assignment,
    outfit: assignment ? await getSavedOutfit(assignment.outfitId) : null
  };
}

function persistOutfitDraft(draft) {
  return write(STORAGE.draft, draft);
}

function getOutfitDraft() {
  return read(STORAGE.draft, null);
}

function clearOutfitDraft() {
  const key = scopedKey(STORAGE.draft);
  if (key) wx.removeStorageSync(key);
  else transientStorage.delete(STORAGE.draft);
}

function getWardrobeView() {
  const value = read(STORAGE.wardrobeView, "grid");
  return value === "list" ? "list" : "grid";
}

function setWardrobeView(viewMode) {
  const value = viewMode === "list" ? "list" : "grid";
  return write(STORAGE.wardrobeView, value);
}

async function getCurrentUser() {
  const userId = await ensureUserScope();
  if (!userId) throw new Error("身份同步失败，请稍后重试");
  await reconcilePendingSync();
  return { userId, avatarUrl: "" };
}

function getLocation() {
  return read(STORAGE.location, { cityName: "未选择城市", source: "manual" });
}

function saveLocation(location) {
  const normalized = {
    cityName: String(location.cityName || "").trim(),
    latitude: Number.isFinite(Number(location.latitude != null ? location.latitude : location.lat))
      ? Number(location.latitude != null ? location.latitude : location.lat)
      : undefined,
    longitude: Number.isFinite(Number(location.longitude != null ? location.longitude : location.lng))
      ? Number(location.longitude != null ? location.longitude : location.lng)
      : undefined,
    source: location.source === "device" ? "device" : "manual"
  };
  if (!normalized.cityName) throw new Error("请选择城市");
  return write(STORAGE.location, normalized);
}

function getWeather(location = getLocation()) {
  if (!canUseCloud()) return Promise.reject(new Error("当前环境不支持云端天气服务"));
  const data = location.latitude != null && location.longitude != null
    ? { lat: location.latitude, lng: location.longitude }
    : { cityName: location.cityName };
  return callFunction("getWeather", data).then((result) => {
    const current = (result.forecast || [])[0] || {};
    return {
      cityName: result.cityName,
      latitude: result.lat,
      longitude: result.lng,
      source: result.source === "location" ? "device" : "manual",
      condition: result.weatherText,
      currentTemp: result.temp,
      minTemp: current.tempMin,
      maxTemp: current.tempMax,
      icon: result.weatherCode,
      outfitAdvice: result.outfitSuggestion,
      forecast: result.forecast || []
    };
  });
}

function locateCurrentCity() {
  return ensurePrivacyAuthorized().then(() => new Promise((resolve, reject) => {
    wx.getLocation({
      type: "gcj02",
      success: ({ latitude, longitude }) => {
        const transient = { cityName: "当前位置", latitude, longitude, source: "device" };
        getWeather(transient).then((weather) => resolve({
          cityName: weather.cityName,
          latitude,
          longitude,
          source: "device",
          weather
        })).catch(reject);
      },
      fail: reject
    });
  }));
}

const COMMON_CITIES = ["北京", "上海", "广州", "深圳", "杭州", "成都", "重庆", "南京", "武汉", "西安", "苏州", "天津"];

async function searchCities(keyword) {
  const query = String(keyword || "").trim();
  if (!query) return COMMON_CITIES.map((cityName) => ({ cityName, source: "manual" }));
  const matched = COMMON_CITIES.filter((cityName) => cityName.includes(query));
  return (matched.length ? matched : [query]).map((cityName) => ({ cityName, source: "manual" }));
}

module.exports = {
  STORAGE,
  SYNC_LEASE_MS,
  CATEGORIES,
  SEASONS,
  STYLES,
  PRIMARY_COLORS,
  THICKNESSES,
  normalizeWardrobeItem,
  normalizeOutfit,
  wardrobeSnapshot,
  listWardrobeItems,
  getWardrobeItem,
  createWardrobeItem,
  updateWardrobeItem,
  deleteWardrobeItem,
  uploadImage,
  persistLocalImage,
  registerTempImage,
  unregisterTempImage,
  clearTempImage,
  standardizeCutoutImage,
  promoteStandardizedClothingAsset,
  sweepExpiredTempImages,
  recognizeWardrobeItem,
  analyzeClothing,
  generateItemDescription,
  listSavedOutfits,
  getSavedOutfit,
  createSavedOutfit,
  saveOutfit,
  updateSavedOutfit,
  deleteSavedOutfit,
  setTodayOutfit,
  getTodayOutfit,
  getValidTodayAssignment,
  persistOutfitDraft,
  getOutfitDraft,
  clearOutfitDraft,
  getWardrobeView,
  setWardrobeView,
  getCurrentUser,
  getLocation,
  getWeather,
  locateCurrentCity,
  searchCities,
  saveLocation,
  reconcilePendingSync,
  getCurrentSeason,
  formatLocalDate,
  ensureUserScope,
  resolveUserScope,
  markIdentityUnconfirmed,
  isStableCloudImage
};
