const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

const openid = "user_123";
const stable = (slot) => `cloud://env.bucket/wardrobe/${openid}/${slot}.jpg`;
const slot = (category) => ({
  itemId: `item_${category}`,
  snapshot: { name: category, category, imageUrl: stable(category), imageFileId: stable(category) }
});
const fake = createFakeCloud({
  clothing_items: ["top", "bottom", "shoes"].map((category) => ({
    _id: `cloud_${category}`,
    clientRecordId: `item_${category}`,
    openid,
    category,
    type: category,
    name: category,
    imageFileId: stable(category),
    isDeleted: false
  })),
  outfit_records: []
}, openid);

function load(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  delete require.cache[filename];
  const originalLoad = Module._load;
  Module._load = function loadModule(request, parent, isMain) {
    if (request === "wx-server-sdk") return fake.cloud;
    if (request === "@cloudbase/node-sdk") return fake.cloudbase;
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require(filename); } finally { Module._load = originalLoad; }
}

const saveClothing = load("cloudfunctions/saveClothing/index.js");
const updateClothing = load("cloudfunctions/updateClothing/index.js");
const saveOutfit = load("cloudfunctions/saveOutfit/index.js");
const updateOutfit = load("cloudfunctions/updateSavedOutfit/index.js");

const clothingBase = {
  clientRecordId: "strict_item",
  mutationVersion: 1,
  type: "top",
  name: "严格上衣",
  imageFileId: stable("strict"),
  seasons: ["summer"],
  styles: ["casual"]
};

(async () => {
  assert.strictEqual((await saveClothing.main(clothingBase)).errorCode, "CLOTHING_REQUIRED");
  const firstClothing = await saveClothing.main({ ...clothingBase, category: "top" });
  assert.strictEqual(firstClothing.ok, true, "正式写入以 category 为准，不要求旧 type 字段");
  assert.strictEqual((await saveClothing.main({ ...clothingBase, category: "top" })).data.mutationStatus, "IDEMPOTENT");
  assert.strictEqual((await saveClothing.main({ ...clothingBase, category: "top", name: "同版本冲突" })).errorCode, "VERSION_REUSE_CONFLICT");
  assert.strictEqual((await saveClothing.main({ ...clothingBase, category: "top", seasons: ["summer", "INVALID"] })).errorCode, "CLOTHING_REQUIRED");
  assert.strictEqual((await saveClothing.main({ ...clothingBase, category: "top", styles: ["casual", "INVALID"] })).errorCode, "CLOTHING_REQUIRED");
  assert.strictEqual((await updateClothing.main({
    id: "cloud_top", clientRecordId: "item_top", mutationVersion: 1,
    type: "top", name: "严格更新", imageFileId: stable("top"), seasons: ["summer", "INVALID"], styles: ["casual"]
  })).errorCode, "CLOTHING_REQUIRED");
  assert.strictEqual((await updateClothing.main({
    id: "cloud_top", clientRecordId: "item_top", mutationVersion: 1,
    type: "top", category: "top", name: "严格更新", imageFileId: stable("top"), seasons: ["summer", "INVALID"], styles: ["casual"]
  })).errorCode, "CLOTHING_REQUIRED");
  assert.strictEqual((await updateClothing.main({
    id: "cloud_top", clientRecordId: "item_top", mutationVersion: 1,
    type: "top", category: "top", name: "严格更新", imageFileId: stable("top"), seasons: ["summer"], styles: ["casual", "INVALID"]
  })).errorCode, "CLOTHING_REQUIRED");

  const base = {
    clientRecordId: "versioned_outfit",
    date: "2026-08-13",
    title: "v1",
    season: "summer",
    style: "casual",
    mutationVersion: 1,
    items: { top: slot("top"), bottom: slot("bottom"), shoes: slot("shoes") }
  };
  const invalidPreview = await saveOutfit.main({ ...base, clientRecordId: "invalid_preview_outfit", previewImageUrl: "wxfile://tmp/preview.jpg" });
  assert.strictEqual(invalidPreview.ok, true, "失效 preview 只能被丢弃，不能阻止结构化搭配保存");
  assert.strictEqual(fake.collections.outfit_records.find((row) => row.clientRecordId === "invalid_preview_outfit").previewFileId, "");
  const canonicalized = await saveOutfit.main({
    ...base,
    clientRecordId: "canonical_snapshot",
    items: { ...base.items, top: { ...slot("top"), snapshot: { ...slot("top").snapshot, imageFileId: "http://tmp/top.jpg", imageUrl: "http://tmp/top.jpg" } } }
  });
  assert.strictEqual(canonicalized.ok, true, "服务端应从当前用户衣橱重建可信 snapshot");
  const canonicalRecord = fake.collections.outfit_records.find((row) => row.clientRecordId === "canonical_snapshot");
  assert.strictEqual(canonicalRecord.items.top.snapshot.imageFileId, stable("top"));
  assert(!JSON.stringify(canonicalRecord.items).includes("http://tmp/top.jpg"));

  const first = await saveOutfit.main(base);
  const firstRecord = fake.collections.outfit_records.find((row) => row.clientRecordId === "versioned_outfit");
  const firstSavedAt = firstRecord.savedAt;
  const retry = await saveOutfit.main({ ...base, title: "网络重试但不是新保存" });
  const retryRecord = fake.collections.outfit_records.find((row) => row.clientRecordId === "versioned_outfit");
  assert.strictEqual(retry.errorCode, "VERSION_REUSE_CONFLICT");
  assert.strictEqual(retryRecord.title, "v1");
  assert.strictEqual(retryRecord.savedAt, firstSavedAt);
  const idempotentRetry = await saveOutfit.main(base);
  assert.strictEqual(idempotentRetry.data.id, first.data.id);
  assert.strictEqual(idempotentRetry.data.mutationStatus, "IDEMPOTENT");

  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await saveOutfit.main({ ...base, title: "v2 用户再次保存", mutationVersion: 2 });
  const secondRecord = fake.collections.outfit_records.find((row) => row.clientRecordId === "versioned_outfit");
  assert.strictEqual(secondRecord.title, "v2 用户再次保存");
  assert.strictEqual(secondRecord.mutationVersion, 2);
  assert(secondRecord.savedAt > firstSavedAt, "更高版本必须更新时间 savedAt");
  assert(secondRecord.updatedAt > firstRecord.updatedAt, "更高版本必须更新时间 updatedAt");

  const updated = await updateOutfit.main({
    id: first.data.id,
    clientRecordId: "versioned_outfit",
    title: "合法 v3",
    season: "summer",
    style: "casual",
    mutationVersion: 3,
    items: base.items
  });
  assert.strictEqual(updated.ok, true);
  assert.strictEqual(fake.collections.outfit_records.find((row) => row.clientRecordId === "versioned_outfit").title, "合法 v3");
  console.log("second-round cloud validation and savedAt tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
