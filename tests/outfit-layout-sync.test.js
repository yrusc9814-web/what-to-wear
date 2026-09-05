const assert = require("assert");

const storage = new Map();
const app = { globalData: { userScope: "openid_l", identityState: "confirmed" } };
const clothingDb = new Map();
const outfitDb = new Map();
let remoteOutfits = [];
const functionCalls = {};

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
      functionCalls[name] = (functionCalls[name] || 0) + 1;
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
      if (name === "deleteOutfitRecord") {
        const entry = outfitDb.get(data.clientRecordId);
        if (entry) outfitDb.set(data.clientRecordId, { ...entry, isDeleted: true });
        return response({ alreadyDeleted: false });
      }
      if (name === "getOutfitRecords") {
        const rows = Array.isArray(remoteOutfits) ? remoteOutfits : [...outfitDb.values()];
        return response({ items: rows, pageSize: 99, hasMore: false, nextCursor: null });
      }
      if (name === "getWardrobe") {
        return response({ items: [...clothingDb.values()].filter((item) => item.isDeleted !== true), pageSize: 99, hasMore: false, nextCursor: null });
      }
      return Promise.reject(new Error(`unexpected cloud function: ${name}`));
    }
  }
};

const service = require("../miniprogram/services/app-service");
const stable = (name) => `cloud://env.bucket/wardrobe/openid_l/${name}.jpg`;

function assertSlotShape(slotValue, label) {
  assert(slotValue, `${label} 槽位必须存在`);
  assert.deepStrictEqual(Object.keys(slotValue).sort(), ["itemId", "snapshot"], `${label} 槽位只允许 itemId+snapshot 白名单字段`);
  assert.deepStrictEqual(Object.keys(slotValue.snapshot).sort(), [
    "category", "imageFileId", "imageUrl", "name", "primaryColor"
  ], `${label} snapshot 只允许五个白名单字段`);
  assert.strictEqual(slotValue.snapshot.unexpected, undefined);
}

function localOutfitRows() {
  return storage.get(`${service.STORAGE.outfits}:openid_l`) || [];
}

(async () => {
  // ---- 0. Clothing 回归：先建衣橱三件套，逐字段白名单不受 layout 影响 ----
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

  // ---- 1. createSavedOutfit 携带 layout：本地记录 layout 对齐 + items 回归 ----
  const layoutIn = {
    version: 1,
    canvas: { width: 360, height: 300 },
    slots: {
      top: { x: 240, y: 120, scale: 1.6, zIndex: 7 },
      bottom: { x: 188, y: 216, scale: 0.78, zIndex: 5 },
      shoes: { x: 186, y: 276, scale: 1, zIndex: 6 },
      hat: null,
      bag: null
    }
  };
  const outfit = await service.createSavedOutfit({
    title: "本地布局搭配", season: "summer", style: "casual",
    items: { top, bottom, shoes }, layout: layoutIn
  });
  assert.strictEqual(outfit.syncStatus, "synced");
  assert.strictEqual(outfit.layout.version, 1);
  assert.strictEqual(outfit.layout.slots.top.x, 240, "create 返回记录必须保留序列化 layout");
  assert.strictEqual(outfit.layout.slots.hat, null);
  // items 回归：槽位对象只含 itemId + whitelist snapshot
  assertSlotShape(outfit.items.top, "top");
  assertSlotShape(outfit.items.bottom, "bottom");
  assert.strictEqual(outfit.items.top.snapshot.name, "白T");
  const local = localOutfitRows().find((row) => row.id === outfit.id);
  assert(local, "本地必须持久化 outfit 记录");
  assert.strictEqual(local.layout.slots.top.x, 240);
  // 入云 payload 也带 layout
  const remoteStored = outfitDb.get(outfit.id);
  assert(remoteStored, "云端必须有记录");
  assert.strictEqual(remoteStored.layout.slots.top.x, 240, "云端持久化必须携带 layout");
  assert.strictEqual(remoteStored.layout.slots.bottom.scale, 0.78);

  // ---- 2. update 旧客户端（payload 不带 layout）：沿用已保存 layout 对齐 ----
  const oldClientUpdate = await service.updateSavedOutfit(outfit.id, {
    title: "旧客户端改名", season: "summer", style: "commute", items: { top, bottom, shoes }
  });
  assert.strictEqual(oldClientUpdate.title, "旧客户端改名");
  assert.strictEqual(oldClientUpdate.layout.slots.top.x, 240, "旧客户端更新不得丢已保存 layout");
  assert.strictEqual(outfitDb.get(outfit.id).layout.slots.top.x, 240, "云端也不得丢 layout");

  // ---- 3. update 新客户端携带新 layout：覆盖并重新对齐 ----
  const updated = await service.updateSavedOutfit(outfit.id, {
    title: "新布局", season: "summer", style: "commute",
    items: { top, bottom, shoes },
    layout: {
      version: 1,
      canvas: { width: 360, height: 300 },
      slots: {
        top: { x: 300, y: 80, scale: 1.2, zIndex: 7 },
        bottom: { x: 200, y: 240, scale: 0.9, zIndex: 5 },
        shoes: { x: 190, y: 280, scale: 1.2, zIndex: 6 },
        hat: null,
        bag: null
      }
    }
  });
  assert.strictEqual(updated.layout.slots.top.x, 300);
  assertSlotShape(updated.items.bottom, "updated bottom");
  assertSlotShape(updated.items.top, "updated top");

  // ---- 4. 云端编辑另一布局 + legacy 记录：hydrate 双向、legacy 不自动回填 ----
  remoteOutfits = [
    { ...outfitDb.get(outfit.id) },
    {
      _id: "remote_layout_outfit",
      clientRecordId: "remote_layout_outfit",
      openid: "openid_l",
      cloudId: "remote_layout_outfit",
      title: "别处编辑的搭配",
      season: "summer",
      style: "casual",
      items: { top: { itemId: top.id, snapshot: { name: "白T", category: "top", imageUrl: stable("top"), imageFileId: stable("top"), primaryColor: "white" } }, bottom: null, shoes: null, hat: null, bag: null },
      layout: {
        version: 1,
        canvas: { width: 360, height: 300 },
        slots: { top: { x: 310, y: 60, scale: 1.9, zIndex: 7 }, bottom: null, shoes: null, hat: null, bag: null }
      },
      mutationVersion: 1,
      savedAt: 2000000000100,
      createdAt: 2000000000100,
      updatedAt: 2000000000100
    },
    {
      _id: "legacy_remote_outfit",
      clientRecordId: "legacy_remote_outfit",
      openid: "openid_l",
      cloudId: "legacy_remote_outfit",
      title: "远端旧搭配",
      season: "summer",
      style: "casual",
      items: { top: { itemId: top.id, snapshot: { name: "白T", category: "top", imageUrl: stable("top"), imageFileId: stable("top"), primaryColor: "white" } }, bottom: { itemId: bottom.id, snapshot: { name: "牛仔裙", category: "bottom", imageUrl: stable("bottom"), imageFileId: stable("bottom"), primaryColor: "blue" } }, shoes: { itemId: shoes.id, snapshot: { name: "帆布鞋", category: "shoes", imageUrl: stable("shoes"), imageFileId: stable("shoes"), primaryColor: "beige" } }, hat: null, bag: null },
      mutationVersion: 1,
      savedAt: 2000000000200,
      createdAt: 2000000000200,
      updatedAt: 2000000000200
    }
  ];
  await service.listSavedOutfits({}); // 触发 hydrate
  const hydratedLayout = await service.getSavedOutfit("remote_layout_outfit");
  assert(hydratedLayout, "hydrate 必须拉取远端带 layout 记录");
  assert.strictEqual(hydratedLayout.layout.slots.top.x, 310, "云端 layout 必须本地化");
  assert.strictEqual(hydratedLayout.layout.slots.top.scale, 1.9);
  assert.strictEqual(hydratedLayout.items.top.snapshot.name, "白T", "hydrate 后 items 完整");
  const legacyHydrated = await service.getSavedOutfit("legacy_remote_outfit");
  assert(legacyHydrated, "legacy 远端记录必须可读");
  assert.strictEqual(legacyHydrated.layout, null, "legacy 无 layout 记录 hydrate 后 layout 为 null");
  assert.strictEqual(legacyHydrated.items.bottom.snapshot.category, "bottom", "legacy items 完整");
  // 不自动回填：远端 legacy 行不得被客户端补上 layout
  assert(!Object.prototype.hasOwnProperty.call(remoteOutfits.find((row) => row.clientRecordId === "legacy_remote_outfit"), "layout"), "hydrate 不得向 legacy 云端记录写回 layout");
  assertSlotShape(localOutfitRows().find((row) => row.id === "legacy_remote_outfit").items.top, "legacy hydrated top");

  // ---- 5. normalizeOutfit：legacy/脏 layout 不报错、sanitize 保底 ----
  {
    const legacyNormalized = service.normalizeOutfit({
      clientRecordId: "raw_legacy",
      title: "旧",
      season: "summer",
      style: "casual",
      items: { top: { itemId: "t", snapshot: { name: "T", category: "top", imageUrl: "cloud://x", imageFileId: "cloud://x" } } }
    });
    assert.strictEqual(legacyNormalized.layout, null);
    assert.strictEqual(legacyNormalized.items.top.itemId, "t");
    const dirtyNormalized = service.normalizeOutfit({
      clientRecordId: "raw_dirty",
      layout: { version: 2, slots: { top: { x: 1 } } }
    });
    assert.strictEqual(dirtyNormalized.layout, null, "未知版本 layout 按无效处理且不报错");
  }

  // ---- 6. Clothing 回归收尾：衣橱单品字段与删除掩码不受影响 ----
  const liveTop = await service.getWardrobeItem(top.id);
  assert.strictEqual(liveTop.syncStatus, "synced");
  assert(liveTop.cloudId, "衣橱单品必须带云端 id");
  assert.strictEqual(liveTop.category, "top");
  assert.strictEqual(liveTop.imageFileId, stable("top"));
  assert.strictEqual(functionCalls.saveOutfit, 1, "create 触发一次 saveOutfit");
  assert.strictEqual(functionCalls.updateSavedOutfit, 2, "旧客户端/新客户端两次 update 各触发一次 updateSavedOutfit");
  assert((functionCalls.getOutfitRecords || 0) >= 1, "hydrate 触发分页读取");

  console.log("outfit layout client sync hydrate / legacy / items regression tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
