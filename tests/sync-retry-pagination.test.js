const assert = require("assert");

const storage = new Map();
const app = { globalData: { userScope: "openid_sync", identityState: "confirmed" } };
const clothingDb = new Map();
const outfitDb = new Map();
const failNext = {};
const rejectBeforeCommit = {};
let remoteWardrobe = [];
let remoteOutfits = [];
const pageCalls = { wardrobe: 0, outfits: 0 };
const functionCalls = {};
const cloudWriteOrder = [];
let uploadReject = false;

function response(data) {
  return Promise.resolve({ result: { ok: true, data } });
}

function cursorPage(rows, request) {
  const pageSize = Number(request.pageSize) || 99;
  const sorted = rows.slice().sort((left, right) => String(left._id).localeCompare(String(right._id)));
  const lastId = request.cursor && request.cursor.lastId;
  const eligible = lastId ? sorted.filter((row) => String(row._id) > String(lastId)) : sorted;
  const consumed = eligible.slice(0, pageSize);
  return {
    items: consumed,
    pageSize,
    hasMore: eligible.length > pageSize,
    nextCursor: consumed.length ? { lastId: consumed[consumed.length - 1]._id } : null
  };
}

function maybeLoseResponse(name, commit, data) {
  commit();
  if (failNext[name]) {
    failNext[name] -= 1;
    return Promise.reject(new Error(`${name} injected response loss`));
  }
  return response(data);
}

global.getApp = () => app;
global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); },
  cloud: {
    uploadFile({ cloudPath }) {
      if (uploadReject) return Promise.reject(new Error("uploadFile injected rejection"));
      return Promise.resolve({ fileID: `cloud://env.bucket/${cloudPath}` });
    },
    callFunction({ name, data }) {
      functionCalls[name] = (functionCalls[name] || 0) + 1;
      if (rejectBeforeCommit[name]) {
        rejectBeforeCommit[name] -= 1;
        return Promise.reject(new Error(`${name} injected request rejection`));
      }
      if (name === "getUserIdentity") return response({ userId: "openid_sync" });
      if (name === "getWardrobe") {
        pageCalls.wardrobe += 1;
        return response(cursorPage(remoteWardrobe, data));
      }
      if (name === "getOutfitRecords") {
        pageCalls.outfits += 1;
        return response(cursorPage(remoteOutfits, data));
      }
      if (name === "saveClothing") {
        cloudWriteOrder.push(`${name}:${data.clientRecordId}`);
        const id = `cloud_${data.clientRecordId}`;
        return maybeLoseResponse(name, () => clothingDb.set(data.clientRecordId, { ...data, _id: id }), { id, _id: id });
      }
      if (name === "updateClothing") {
        return maybeLoseResponse(name, () => clothingDb.set(data.clientRecordId, { ...clothingDb.get(data.clientRecordId), ...data }), { id: data.id, _id: data.id });
      }
      if (name === "deleteClothing") {
        return maybeLoseResponse(name, () => {
          const entry = clothingDb.get(data.clientRecordId);
          if (entry) clothingDb.set(data.clientRecordId, { ...entry, isDeleted: true });
        }, { alreadyDeleted: false });
      }
      if (name === "saveOutfit") {
        cloudWriteOrder.push(`${name}:${data.clientRecordId}`);
        const id = `cloud_${data.clientRecordId}`;
        return maybeLoseResponse(name, () => outfitDb.set(data.clientRecordId, { ...data, _id: id }), { id, _id: id });
      }
      if (name === "updateSavedOutfit") {
        return maybeLoseResponse(name, () => outfitDb.set(data.clientRecordId, { ...outfitDb.get(data.clientRecordId), ...data }), { id: data.id, _id: data.id });
      }
      if (name === "deleteOutfitRecord") {
        return maybeLoseResponse(name, () => {
          const entry = outfitDb.get(data.clientRecordId);
          if (entry) outfitDb.set(data.clientRecordId, { ...entry, isDeleted: true });
        }, { alreadyDeleted: false });
      }
      return Promise.reject(new Error(`unexpected cloud function: ${name}`));
    }
  }
};

const service = require("../miniprogram/services/app-service");
const stable = (name) => `cloud://env.bucket/wardrobe/openid_sync/${name}.jpg`;

(async () => {
  rejectBeforeCommit.saveClothing = 1;
  let rejectedTop = await service.createWardrobeItem({
    name: "普通失败上衣", category: "top", seasons: ["summer"], styles: ["casual"], imageUrl: stable("rejected-top"), imageFileId: stable("rejected-top")
  });
  assert.strictEqual(rejectedTop.syncStatus, "failed");
  assert.strictEqual(clothingDb.has(rejectedTop.id), false, "普通 reject 不应模拟服务端提交");
  await service.reconcilePendingSync();
  rejectedTop = await service.getWardrobeItem(rejectedTop.id);
  assert.strictEqual(rejectedTop.syncStatus, "synced");

  failNext.saveClothing = 1;
  let top = await service.createWardrobeItem({
    name: "上衣", category: "top", seasons: ["summer"], styles: ["casual"], imageUrl: stable("top"), imageFileId: stable("top")
  });
  assert.strictEqual(top.syncStatus, "failed");
  assert.strictEqual(clothingDb.has(top.id), true, "响应丢失前服务端已提交一次");
  const clothingCountAfterLostResponse = clothingDb.size;
  await service.reconcilePendingSync();
  top = await service.getWardrobeItem(top.id);
  assert.strictEqual(top.syncStatus, "synced");
  assert.strictEqual(clothingDb.size, clothingCountAfterLostResponse, "幂等重试不得产生第二条单品");

  const bottom = await service.createWardrobeItem({
    name: "下装", category: "bottom", seasons: ["summer"], styles: ["casual"], imageUrl: stable("bottom"), imageFileId: stable("bottom")
  });
  const shoes = await service.createWardrobeItem({
    name: "鞋子", category: "shoes", seasons: ["summer"], styles: ["casual"], imageUrl: stable("shoes"), imageFileId: stable("shoes")
  });

  rejectBeforeCommit.saveOutfit = 1;
  let rejectedOutfit = await service.createSavedOutfit({
    title: "普通失败搭配", season: "summer", style: "casual", items: { top, bottom, shoes }
  });
  assert.strictEqual(rejectedOutfit.syncStatus, "failed");
  assert.strictEqual(outfitDb.has(rejectedOutfit.id), false);
  await service.reconcilePendingSync();
  rejectedOutfit = await service.getSavedOutfit(rejectedOutfit.id);
  assert.strictEqual(rejectedOutfit.syncStatus, "synced");

  failNext.saveOutfit = 1;
  let outfit = await service.createSavedOutfit({
    title: "同步测试", season: "summer", style: "casual", items: { top, bottom, shoes }
  });
  assert.strictEqual(outfit.syncStatus, "failed");
  assert.strictEqual(outfitDb.has(outfit.id), true);
  const outfitCountAfterLostResponse = outfitDb.size;
  await service.reconcilePendingSync();
  outfit = await service.getSavedOutfit(outfit.id);
  assert.strictEqual(outfit.syncStatus, "synced");
  assert.strictEqual(outfitDb.size, outfitCountAfterLostResponse, "搭配响应丢失后的重试不得重复创建");

  rejectBeforeCommit.updateClothing = 1;
  top = await service.updateWardrobeItem(top.id, { name: "更新后的上衣" });
  assert.strictEqual(top.syncStatus, "failed");
  await service.reconcilePendingSync();
  assert.strictEqual((await service.getWardrobeItem(top.id)).syncStatus, "synced");

  rejectBeforeCommit.updateSavedOutfit = 1;
  outfit = await service.updateSavedOutfit(outfit.id, {
    title: "更新后的搭配", season: "summer", style: "casual", items: { top: await service.getWardrobeItem(top.id), bottom, shoes }
  });
  assert.strictEqual(outfit.syncStatus, "failed");
  await service.reconcilePendingSync();
  assert.strictEqual((await service.getSavedOutfit(outfit.id)).syncStatus, "synced");

  rejectBeforeCommit.deleteOutfitRecord = 1;
  const deletedOutfit = await service.deleteSavedOutfit(outfit.id);
  assert.strictEqual(deletedOutfit.syncStatus, "failed");
  await service.reconcilePendingSync();
  assert.strictEqual(outfitDb.get(outfit.id).isDeleted, true);

  rejectBeforeCommit.deleteClothing = 1;
  const deletedTop = await service.deleteWardrobeItem(top.id);
  assert.strictEqual(deletedTop.syncStatus, "failed");
  await service.reconcilePendingSync();
  assert.strictEqual(clothingDb.get(top.id).isDeleted, true);

  uploadReject = true;
  let localImageTop = await service.createWardrobeItem({
    name: "待补传上衣",
    category: "top",
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: "wxfile://saved/local-top.jpg",
    imageFileId: ""
  });
  assert.strictEqual(localImageTop.syncStatus, "failed");
  const saveOutfitCallsBefore = functionCalls.saveOutfit || 0;
  let localImageOutfit = await service.createSavedOutfit({
    title: "待补传图片搭配",
    season: "summer",
    style: "casual",
    items: { top: localImageTop, bottom, shoes }
  });
  assert.strictEqual(localImageOutfit.syncStatus, "pending",
    "前一项图片同步失败时，outbox 必须 fail-stop，后续搭配不能伪装成已失败的云调用");
  assert.strictEqual(functionCalls.saveOutfit || 0, saveOutfitCallsBefore, "图片补传失败时不得调用 saveOutfit");

  uploadReject = false;
  const orderStart = cloudWriteOrder.length;
  await service.reconcilePendingSync();
  localImageTop = await service.getWardrobeItem(localImageTop.id);
  localImageOutfit = await service.getSavedOutfit(localImageOutfit.id);
  assert.strictEqual(localImageTop.syncStatus, "synced");
  assert.strictEqual(localImageOutfit.syncStatus, "synced");
  assert(/^cloud:\/\//.test(localImageTop.imageFileId));
  assert.deepStrictEqual(cloudWriteOrder.slice(orderStart), [
    `saveClothing:${localImageTop.id}`,
    `saveOutfit:${localImageOutfit.id}`
  ], "恢复后必须先同步衣橱图片，再同步搭配");
  const syncedCloudOutfit = outfitDb.get(localImageOutfit.id);
  assert(/^cloud:\/\//.test(syncedCloudOutfit.items.top.snapshot.imageFileId));
  assert(!JSON.stringify(syncedCloudOutfit.items).includes("wxfile://"), "云记录清空本地缓存后仍必须只依赖稳定图片引用");

  remoteWardrobe = Array.from({ length: 101 }, (_, index) => ({
    _id: `remote_item_${index}`, clientRecordId: `remote_item_${index}`, cloudId: `remote_item_${index}`,
    name: `远端单品 ${index}`, category: "top", seasons: ["summer"], styles: ["casual"], imageFileId: stable(`remote-${index}`),
    createdAt: 1000 - index, updatedAt: 1000 - index
  }));
  const allWardrobe = await service.listWardrobeItems({ includeDeleted: false });
  assert(allWardrobe.some((item) => item.id === "remote_item_100"));
  assert(pageCalls.wardrobe >= 2);

  remoteOutfits = Array.from({ length: 101 }, (_, index) => ({
    _id: `remote_outfit_${index}`, clientRecordId: `remote_outfit_${index}`, cloudId: `remote_outfit_${index}`,
    title: `远端搭配 ${index}`, season: "summer", style: "casual", items: {},
    createdAt: 1000 - index, updatedAt: 1000 - index, savedAt: 1000 - index
  }));
  const allOutfits = await service.listSavedOutfits({ season: "summer", style: "casual" });
  assert(allOutfits.some((item) => item.id === "remote_outfit_100"));
  assert(pageCalls.outfits >= 2);

  const outbox = storage.get(`${service.STORAGE.syncOutbox}:openid_sync`) || { tasks: [] };
  const outboxTasks = Array.isArray(outbox) ? outbox : outbox.tasks || [];
  assert.strictEqual(outboxTasks.length, 0, "reconcile 成功后 pending 状态必须清理");
  console.log("sync failure, response loss, retry and client pagination tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
