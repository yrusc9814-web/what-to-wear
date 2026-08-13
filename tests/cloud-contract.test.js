const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

const openid = "user_123";
const stable = (name) => `cloud://env.bucket/wardrobe/${openid}/${name}.jpg`;
const wardrobe = [
  { _id: "cloud_top", clientRecordId: "item_top", openid, category: "top", type: "top", name: "上衣", imageFileId: stable("top"), seasons: ["summer"], styles: ["casual"], createdAt: 300 },
  { _id: "cloud_bottom", clientRecordId: "item_bottom", openid, category: "bottom", type: "bottom", name: "下装", imageFileId: stable("bottom"), seasons: ["summer"], styles: ["casual"], isDeleted: false, createdAt: 299 },
  { _id: "cloud_shoes", clientRecordId: "item_shoes", openid, category: "shoes", type: "shoes", name: "鞋子", imageFileId: stable("shoes"), seasons: ["summer"], styles: ["casual"], isDeleted: false, createdAt: 298 },
  { _id: "legacy_image", clientRecordId: "legacy_image", openid, category: "top", type: "top", name: "旧图上衣", imageFileId: stable("legacy"), seasons: ["summer"], styles: ["casual"], createdAt: 297 },
  ...Array.from({ length: 101 }, (_, index) => ({
    _id: `extra_${index}`,
    clientRecordId: `extra_${index}`,
    openid,
    category: "top",
    type: "top",
    name: `额外单品 ${index}`,
    imageFileId: stable(`extra-${index}`),
    seasons: ["summer"],
    styles: ["casual"],
    isDeleted: index === 50 ? true : undefined,
    createdAt: 200 - index
  }))
];
const fake = createFakeCloud({ clothing_items: wardrobe, outfit_records: [] }, openid);

function loadCloudFunction(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  delete require.cache[filename];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return fake.cloud;
    if (request === "@cloudbase/node-sdk") return fake.cloudbase;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(filename);
  } finally {
    Module._load = originalLoad;
  }
}

const saveClothing = loadCloudFunction("cloudfunctions/saveClothing/index.js");
const updateClothing = loadCloudFunction("cloudfunctions/updateClothing/index.js");
const deleteClothing = loadCloudFunction("cloudfunctions/deleteClothing/index.js");
const getWardrobe = loadCloudFunction("cloudfunctions/getWardrobe/index.js");
const saveOutfit = loadCloudFunction("cloudfunctions/saveOutfit/index.js");
const updateOutfit = loadCloudFunction("cloudfunctions/updateSavedOutfit/index.js");
const deleteOutfit = loadCloudFunction("cloudfunctions/deleteOutfitRecord/index.js");
const getOutfits = loadCloudFunction("cloudfunctions/getOutfitRecords/index.js");

function slot(itemId, category, imageFileId = stable(category)) {
  return { itemId, snapshot: { name: category, category, imageUrl: imageFileId, imageFileId } };
}

(async () => {
  assert.strictEqual((await saveClothing.main({})).ok, false, "空单品不得由默认值补齐");
  const clothingEvent = {
    clientRecordId: "client_new_top",
    mutationVersion: 1,
    type: "top",
    category: "top",
    name: "幂等上衣",
    imageFileId: stable("idempotent"),
    seasons: ["summer"],
    styles: ["casual"]
  };
  const firstClothing = await saveClothing.main(clothingEvent);
  const idempotentClothing = await saveClothing.main(clothingEvent);
  const conflictingClothing = await saveClothing.main({ ...clothingEvent, name: "同版本冲突上衣" });
  assert.strictEqual(firstClothing.ok, true);
  assert.strictEqual(idempotentClothing.data.id, firstClothing.data.id);
  assert.strictEqual(idempotentClothing.data.mutationStatus, "IDEMPOTENT");
  assert.strictEqual(conflictingClothing.errorCode, "VERSION_REUSE_CONFLICT");
  assert.strictEqual(fake.collections.clothing_items.filter((item) => item.clientRecordId === clothingEvent.clientRecordId).length, 1);
  const concurrentClothing = { ...clothingEvent, clientRecordId: "concurrent_clothing" };
  const concurrentClothingResults = await Promise.all([
    saveClothing.main(concurrentClothing),
    saveClothing.main(concurrentClothing)
  ]);
  assert.strictEqual(concurrentClothingResults[0].data.id, concurrentClothingResults[1].data.id);
  assert.strictEqual(fake.collections.clothing_items.filter((item) => item.clientRecordId === concurrentClothing.clientRecordId && item.isDeleted !== true).length, 1);

  const oldUpdate = await updateClothing.main({
    id: "legacy_image", clientRecordId: "legacy_image", mutationVersion: 1,
    type: "top", category: "top", name: "旧图仍可更新",
    imageFileId: stable("legacy"), seasons: ["summer"], styles: ["casual"]
  });
  assert.strictEqual(oldUpdate.ok, true, "旧记录未换图时应允许保留原 fileId");
  assert.strictEqual((await deleteClothing.main({ clientRecordId: "does_not_exist", mutationVersion: 1 })).ok, true, "删除重试应幂等成功");

  const pageOne = await getWardrobe.main({ pageSize: 99 });
  const pageTwo = await getWardrobe.main({ pageSize: 99, cursor: pageOne.data.nextCursor });
  assert.strictEqual(pageOne.data.pageSize, 99);
  assert.strictEqual(pageOne.data.items.length, 98, "公开 pageSize=99 后，首页应扣除其中的 tombstone");
  assert(pageTwo.data.items.length > 0, "第 101 条有效单品必须可读取");
  assert(!pageOne.data.items.concat(pageTwo.data.items).some((item) => item.id === "extra_50"));
  assert(pageOne.data.items.concat(pageTwo.data.items).some((item) => item.id === "item_top"), "缺 isDeleted 的旧单品应可读取");

  const outfitEvent = {
    clientRecordId: "client_outfit_1",
    mutationVersion: 1,
    date: "2026-08-13",
    title: "严格搭配",
    season: "summer",
    style: "casual",
    items: {
      top: slot("item_top", "top"),
      bottom: slot("item_bottom", "bottom"),
      shoes: slot("item_shoes", "shoes"),
      hat: null,
      bag: null
    }
  };
  assert.strictEqual((await saveOutfit.main({})).ok, false, "空搭配不得由默认值补齐");
  const firstOutfit = await saveOutfit.main(outfitEvent);
  const idempotentOutfit = await saveOutfit.main(outfitEvent);
  const conflictingOutfit = await saveOutfit.main({ ...outfitEvent, title: "同版本冲突搭配" });
  assert.strictEqual(firstOutfit.ok, true);
  assert.strictEqual(idempotentOutfit.data.id, firstOutfit.data.id);
  assert.strictEqual(idempotentOutfit.data.mutationStatus, "IDEMPOTENT");
  assert.strictEqual(conflictingOutfit.errorCode, "VERSION_REUSE_CONFLICT");
  assert.strictEqual(fake.collections.outfit_records.filter((item) => item.clientRecordId === outfitEvent.clientRecordId).length, 1);
  const concurrentOutfit = { ...outfitEvent, clientRecordId: "concurrent_outfit" };
  const concurrentOutfitResults = await Promise.all([
    saveOutfit.main(concurrentOutfit),
    saveOutfit.main(concurrentOutfit)
  ]);
  assert.strictEqual(concurrentOutfitResults[0].data.id, concurrentOutfitResults[1].data.id);
  assert.strictEqual(fake.collections.outfit_records.filter((item) => item.clientRecordId === concurrentOutfit.clientRecordId && item.isDeleted !== true).length, 1);

  const wxfile = JSON.parse(JSON.stringify(outfitEvent));
  wxfile.clientRecordId = "wxfile_outfit";
  wxfile.items.top.snapshot.imageFileId = "wxfile://tmp/top.jpg";
  wxfile.items.top.snapshot.imageUrl = "wxfile://tmp/top.jpg";
  const wxfileCanonicalized = await saveOutfit.main(wxfile);
  assert.strictEqual(wxfileCanonicalized.ok, true, "服务端必须以当前用户衣橱数据重建槽位图片");
  assert.strictEqual(fake.collections.outfit_records.find((item) => item.clientRecordId === "wxfile_outfit").items.top.snapshot.imageFileId, stable("top"));

  const malicious = JSON.parse(JSON.stringify(outfitEvent));
  malicious.clientRecordId = "malicious_outfit";
  malicious.items.top.snapshot.category = "bottom";
  const categoryCanonicalized = await saveOutfit.main(malicious);
  assert.strictEqual(categoryCanonicalized.ok, true, "服务端必须根据当前用户真实单品重建 snapshot 分类");
  assert.strictEqual(fake.collections.outfit_records.find((item) => item.clientRecordId === "malicious_outfit").items.top.snapshot.category, "top");

  const validUpdate = await updateOutfit.main({
    ...outfitEvent,
    id: firstOutfit.data.id,
    clientRecordId: outfitEvent.clientRecordId,
    mutationVersion: 2,
    title: "合法更新"
  });
  assert.strictEqual(validUpdate.ok, true);
  const invalidUpdate = JSON.parse(JSON.stringify(outfitEvent));
  invalidUpdate.id = firstOutfit.data.id;
  invalidUpdate.title = "非法更新";
  invalidUpdate.mutationVersion = 3;
  invalidUpdate.items.top.snapshot.imageFileId = "wxfile://tmp/top.jpg";
  invalidUpdate.items.top.snapshot.imageUrl = "wxfile://tmp/top.jpg";
  const sanitizedUpdate = await updateOutfit.main(invalidUpdate);
  assert.strictEqual(sanitizedUpdate.ok, true, "更新必须从当前用户衣橱重建真实图片引用");
  const sanitizedRecord = fake.collections.outfit_records.find((item) => item.clientRecordId === outfitEvent.clientRecordId);
  assert.strictEqual(sanitizedRecord.title, "非法更新");
  assert(!JSON.stringify(sanitizedRecord.items).includes("wxfile://"));

  fake.collections.outfit_records.push({
    _id: "legacy_outfit", clientRecordId: "legacy_outfit", openid, date: "2026-08-12", title: "旧搭配",
    season: "summer", style: "casual", items: outfitEvent.items, createdAt: 1, updatedAt: 1
  });
  fake.collections.outfit_records.push({
    _id: "active_outfit", clientRecordId: "active_outfit", openid, date: "2026-08-10", title: "显式有效",
    season: "summer", style: "casual", items: outfitEvent.items, isDeleted: false, createdAt: 3, updatedAt: 3
  });
  fake.collections.outfit_records.push({
    _id: "deleted_outfit", clientRecordId: "deleted_outfit", openid, date: "2026-08-11", title: "已删除",
    season: "summer", style: "casual", items: outfitEvent.items, isDeleted: true, createdAt: 2, updatedAt: 2
  });
  const outfits = await getOutfits.main({ pageSize: 99 });
  assert(outfits.data.items.some((item) => item.id === "legacy_outfit"));
  assert(outfits.data.items.some((item) => item.id === "active_outfit"));
  assert(!outfits.data.items.some((item) => item.id === "deleted_outfit"));
  const legacyUpdate = await updateOutfit.main({
    ...outfitEvent,
    id: "legacy_outfit",
    clientRecordId: "legacy_outfit",
    mutationVersion: 1,
    title: "旧搭配可更新"
  });
  assert.strictEqual(legacyUpdate.ok, true, "缺 isDeleted 的旧搭配应可更新");
  assert.strictEqual((await deleteOutfit.main({ id: "legacy_outfit", clientRecordId: "legacy_outfit", mutationVersion: 2 })).ok, true, "缺 isDeleted 的旧搭配应可删除");
  assert.strictEqual(fake.collections.outfit_records.find((item) => item._id === "legacy_outfit").isDeleted, true);
  assert.strictEqual((await deleteOutfit.main({ clientRecordId: "missing_outfit", mutationVersion: 1 })).ok, true);
  const legacyWardrobeDelete = await deleteClothing.main({ id: "legacy_image", clientRecordId: "legacy_image", mutationVersion: 2 });
  assert.strictEqual(legacyWardrobeDelete.ok, true, "缺 isDeleted 的旧单品应可删除");
  assert.strictEqual(fake.collections.clothing_items.find((item) => item._id === "legacy_image").isDeleted, true);

  console.log("cloud contract, idempotency, slot, pagination and legacy tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
