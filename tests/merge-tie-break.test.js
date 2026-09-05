const assert = require("assert");

/**
 * Round 2B-1 reviewer fix 回归：mergeById 完全平局（mutationVersion 与 updatedAt 均相等）处理。
 *  - outfit 云读侧 hydrate 平局时优先保留本地已保存记录：无 layout / 旧 layout 的旧云副本
 *    不得覆盖本地已保存 layout。
 *  - wardrobe 各路径（云读侧 / 本地×legacy）语义不回归：primary 平局时仍胜出。
 */

const storage = new Map();
const app = { globalData: { userScope: "openid_merge", identityState: "confirmed" } };
const clothingDb = new Map();
const outfitDb = new Map();
let remoteWardrobe = [];
let remoteOutfits = [];

function response(data) {
  return Promise.resolve({ result: { ok: true, data } });
}

global.getApp = () => app;
global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); },
  cloud: {
    callFunction({ name, data }) {
      if (name === "getUserIdentity") return response({ userId: app.globalData.userScope });
      if (name === "getWardrobe") return response({ items: remoteWardrobe, pageSize: 99, hasMore: false, nextCursor: null });
      if (name === "getOutfitRecords") return response({ items: remoteOutfits, pageSize: 99, hasMore: false, nextCursor: null });
      if (name === "saveClothing") {
        const id = `cloud_${data.clientRecordId}`;
        clothingDb.set(data.clientRecordId, { ...data, _id: id, cloudId: id });
        return response({ id, _id: id });
      }
      if (name === "updateClothing") {
        clothingDb.set(data.clientRecordId, { ...clothingDb.get(data.clientRecordId), ...data });
        return response({ id: data.id, _id: data.id });
      }
      if (name === "saveOutfit") {
        const id = `cloud_${data.clientRecordId}`;
        outfitDb.set(data.clientRecordId, { ...data, _id: id, cloudId: id });
        return response({ id, _id: id });
      }
      if (name === "updateSavedOutfit") {
        const prev = outfitDb.get(data.clientRecordId) || {};
        outfitDb.set(data.clientRecordId, { ...prev, ...data, _id: prev._id || data.id });
        return response({ id: prev._id || data.id, _id: prev._id || data.id });
      }
      return Promise.reject(new Error(`unexpected cloud function: ${name}`));
    }
  }
};

const service = require("../miniprogram/services/app-service");
const stable = (name) => `cloud://env.bucket/wardrobe/openid_merge/${name}.jpg`;

function wardrobeRows() {
  return storage.get(`${service.STORAGE.wardrobe}:openid_merge`) || [];
}

function outfitRows() {
  return storage.get(`${service.STORAGE.outfits}:openid_merge`) || [];
}

function layout(topX) {
  return {
    version: 1,
    canvas: { width: 360, height: 300 },
    slots: {
      top: { x: topX, y: 120, scale: 1.6, zIndex: 7 },
      bottom: { x: 188, y: 216, scale: 0.78, zIndex: 5 },
      shoes: { x: 186, y: 276, scale: 1, zIndex: 6 },
      hat: null,
      bag: null
    }
  };
}

(async () => {
  // ---- 0. 衣橱三件套（全链路创建，逐字段稳定）----
  const top = await service.createWardrobeItem({
    name: "白T", category: "top", seasons: ["summer"], styles: ["casual"],
    imageUrl: stable("top"), imageFileId: stable("top"), primaryColor: "white"
  });
  const bottom = await service.createWardrobeItem({
    name: "牛仔裙", category: "bottom", seasons: ["summer"], styles: ["casual"],
    imageUrl: stable("bottom"), imageFileId: stable("bottom"), primaryColor: "blue"
  });
  const shoes = await service.createWardrobeItem({
    name: "帆布鞋", category: "shoes", seasons: ["summer"], styles: ["casual"],
    imageUrl: stable("shoes"), imageFileId: stable("shoes"), primaryColor: "beige"
  });
  assert.strictEqual(top.syncStatus, "synced");
  assert.strictEqual(bottom.syncStatus, "synced");
  assert.strictEqual(shoes.syncStatus, "synced");

  // ---- 1. 本地保存 layout L300 的搭配（编辑也保存过 layout）----
  const outfitA = await service.createSavedOutfit({
    title: "平局搭配A", season: "summer", style: "casual",
    items: { top, bottom, shoes }, layout: layout(300)
  });
  assert.strictEqual(outfitA.layout.slots.top.x, 300);
  const localA = outfitRows().find((row) => row.id === outfitA.id);
  assert(localA && localA.layout && localA.layout.slots.top.x === 300, "本地必须带 layout");
  assert.strictEqual(localA.cloudId, `cloud_${outfitA.id}`);
  const localUpdatedAt = localA.updatedAt;
  const localVersion = localA.mutationVersion;
  assert(localVersion >= 1);

  // ---- 2. 完全平局的「旧云副本（无 layout）」不得覆盖本地已保存 layout ----
  remoteWardrobe = [...clothingDb.values()];
  remoteOutfits = [{
    _id: localA.cloudId,
    clientRecordId: outfitA.id,
    cloudId: localA.cloudId,
    openid: "openid_merge",
    title: "平局搭配A（云端旧副本）",
    season: "summer",
    style: "casual",
    items: { top: { itemId: top.id, snapshot: { name: "白T", category: "top", imageUrl: stable("top"), imageFileId: stable("top") } }, bottom: null, shoes: null, hat: null, bag: null },
    // 故意不带 layout：与本地 record 完全同 version + 同 updatedAt 的旧云副本
    mutationVersion: localVersion,
    updatedAt: localUpdatedAt,
    createdAt: localA.createdAt,
    savedAt: localA.savedAt
  }];
  const hydratedA = await service.getSavedOutfit(outfitA.id); // 触发 hydrate + merge
  assert(hydratedA, "搭配A 必须可读回");
  assert.strictEqual(hydratedA.layout.slots.top.x, 300, "平局的旧云副本（无 layout）不得覆盖本地已保存 layout");
  const storedA = outfitRows().find((row) => row.id === outfitA.id);
  assert(storedA.layout && storedA.layout.slots.top.x === 300, "本地持久化记录必须保持 layout（不被云端空 layout 覆盖）");

  // ---- 3. 完全平局的「旧 layout（top.x=100）」云副本同样不得覆盖本地 ----
  const outfitB = await service.createSavedOutfit({
    title: "平局搭配B", season: "summer", style: "casual",
    items: { top, bottom, shoes }, layout: layout(310)
  });
  const localB = outfitRows().find((row) => row.id === outfitB.id);
  remoteOutfits = [...remoteOutfits, {
    _id: `cloud_${outfitB.id}`,
    clientRecordId: outfitB.id,
    cloudId: `cloud_${outfitB.id}`,
    openid: "openid_merge",
    title: "平局搭配B（云端旧布局）",
    season: "summer",
    style: "casual",
    items: { top: { itemId: top.id, snapshot: { name: "白T", category: "top", imageUrl: stable("top"), imageFileId: stable("top") } }, bottom: null, shoes: null, hat: null, bag: null },
    layout: layout(100), // 旧 layout 但 version/updatedAt 与本地完全一致
    mutationVersion: localB.mutationVersion,
    updatedAt: localB.updatedAt,
    createdAt: localB.createdAt,
    savedAt: localB.savedAt
  }];
  const hydratedB = await service.getSavedOutfit(outfitB.id);
  assert.strictEqual(hydratedB.layout.slots.top.x, 310, "平局的旧 layout 云副本不得覆盖本地新 layout");

  // ---- 4. 版本更新的云副本仍胜出（不回退 merge 基本语义）：云 mutationVersion 更高 → 云端 layout 覆盖 ----
  const outfitC = await service.createSavedOutfit({
    title: "可覆盖搭配C", season: "summer", style: "casual",
    items: { top, bottom, shoes }, layout: layout(320)
  });
  const localC = outfitRows().find((row) => row.id === outfitC.id);
  remoteOutfits = [...remoteOutfits, {
    _id: `cloud_${outfitC.id}`,
    clientRecordId: outfitC.id,
    cloudId: `cloud_${outfitC.id}`,
    openid: "openid_merge",
    title: "可覆盖搭配C（新版云端）",
    season: "summer",
    style: "casual",
    items: { top: { itemId: top.id, snapshot: { name: "白T", category: "top", imageUrl: stable("top"), imageFileId: stable("top") } }, bottom: null, shoes: null, hat: null, bag: null },
    layout: layout(330),
    mutationVersion: Number(localC.mutationVersion || 0) + 1,
    updatedAt: Number(localC.updatedAt || 0) + 1,
    createdAt: localC.createdAt,
    savedAt: localC.savedAt
  }];
  const hydratedC = await service.getSavedOutfit(outfitC.id);
  assert.strictEqual(hydratedC.layout.slots.top.x, 330, "更高 mutationVersion 的云副本必须仍能覆盖本地（不破坏新版本优先）");

  // ---- 5. wardrobe 云读侧语义不回归：平局（same version + same updatedAt）仍由云端（primary）胜出 ----
  const wLocal = wardrobeRows().find((row) => row.id === top.id);
  remoteWardrobe = [...clothingDb.values()].map((row) => (
    row.clientRecordId === top.id
      ? { ...row, name: "远端覆盖名", mutationVersion: wLocal.mutationVersion, updatedAt: wLocal.updatedAt }
      : row
  ));
  const wardrobeAfterHydrate = await service.listWardrobeItems({ includeDeleted: false });
  const wItem = wardrobeAfterHydrate.find((item) => item.id === top.id);
  assert.strictEqual(wItem.name, "远端覆盖名", "wardrobe 云读侧平局必须保持云端（primary）胜出的既有语义");
  assert.strictEqual(wItem.category, "top");

  // ---- 6. wardrobe 本地×legacy 语义不回归：平局仍由 current（primary）胜出 ----
  const legacyScope = "openid_merge_legacy";
  app.globalData.userScope = legacyScope;
  const sharedId = "item_tie_legacy";
  const currentRow = { id: sharedId, cloudId: "", category: "top", type: "top", name: "当前记录名", imageUrl: stable("cur"), imageFileId: stable("cur"), seasons: ["summer"], styles: ["casual"], mutationVersion: 1, updatedAt: 900, createdAt: 900 };
  const legacyRow = { id: sharedId, cloudId: "", category: "top", type: "top", name: "旧库记录名", imageUrl: stable("legacy"), imageFileId: stable("legacy"), seasons: ["summer"], styles: ["casual"], mutationVersion: 1, updatedAt: 900, createdAt: 900 };
  storage.set(`${service.STORAGE.wardrobe}:${legacyScope}`, [currentRow]);
  storage.set(`${service.STORAGE.legacyWardrobe}:${legacyScope}`, [legacyRow]);
  remoteWardrobe = [];
  const mergedLegacy = await service.listWardrobeItems({ includeDeleted: false });
  const tieLegacyItem = mergedLegacy.find((item) => item.id === sharedId);
  assert(tieLegacyItem, "legacy 平局记录必须可读回");
  assert.strictEqual(tieLegacyItem.name, "当前记录名", "本地×legacy 平局必须保持 current（primary）胜出的既有语义");
  app.globalData.userScope = "openid_merge";

  console.log("mergeById full-tie local-preference (outfit) & wardrobe non-regression tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
