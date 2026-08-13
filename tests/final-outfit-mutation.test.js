const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

const openid = "openid_outfit_A";
const image = (slot) => `cloud://env.bucket/wardrobe/${openid}/${slot}.jpg`;
const clothing = ["top", "bottom", "shoes"].map((category) => ({
  _id: `cloud_${category}`,
  clientRecordId: `item_${category}`,
  openid,
  category,
  type: category,
  name: `真实${category}`,
  imageFileId: image(category),
  primaryColor: "pink",
  isDeleted: false,
  mutationVersion: 1
}));
const fake = createFakeCloud({ clothing_items: clothing, outfit_records: [] }, openid, {
  autoRegisterCloudFiles: false
});
["top", "bottom", "shoes"].forEach((slot) => fake.registerCloudFile(image(slot)));

function load(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  delete require.cache[filename];
  const originalLoad = Module._load;
  Module._load = function loadModule(request, parent, isMain) {
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

const saveOutfit = load("cloudfunctions/saveOutfit/index.js");
const updateOutfit = load("cloudfunctions/updateSavedOutfit/index.js");
const deleteOutfit = load("cloudfunctions/deleteOutfitRecord/index.js");

function outfit(overrides = {}) {
  return {
    clientRecordId: "outfit_A",
    date: "2026-08-13",
    title: "真实搭配",
    season: "summer",
    style: "casual",
    mutationVersion: 1,
    userScope: "openid_outfit_B",
    items: {
      top: { itemId: "item_top" },
      bottom: { itemId: "item_bottom" },
      shoes: { itemId: "item_shoes" }
    },
    ...overrides
  };
}

const legacySnapshotItems = {
  top: { itemId: "item_top", snapshot: { name: "上衣", category: "top", imageFileId: image("top") } },
  bottom: { itemId: "item_bottom", snapshot: { name: "下装", category: "bottom", imageFileId: image("bottom") } },
  shoes: { itemId: "item_shoes", snapshot: { name: "鞋子", category: "shoes", imageFileId: image("shoes") } }
};

(async () => {
  const missingVersionEvent = outfit({
    clientRecordId: "missing_outfit_version",
    items: legacySnapshotItems
  });
  delete missingVersionEvent.mutationVersion;
  const missingVersion = await saveOutfit.main(missingVersionEvent);
  assert.strictEqual(missingVersion.errorCode, "MUTATION_VERSION_REQUIRED");

  const first = await saveOutfit.main(outfit());
  assert.strictEqual(first.ok, true);
  const stored = fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_A");
  assert.strictEqual(stored.openid, openid,
    "搭配身份必须来自当前 WXContext，不能信任 event.userScope");
  assert.strictEqual(stored.items.top.snapshot.name, "真实top",
    "snapshot 必须从当前用户真实衣橱重建");
  assert.strictEqual(stored.items.top.snapshot.imageFileId, image("top"));

  const retry = await saveOutfit.main(outfit());
  assert.strictEqual(retry.ok, true);
  const sameVersionConflict = await saveOutfit.main(outfit({ title: "同版本冲突搭配" }));
  assert.strictEqual(sameVersionConflict.errorCode, "VERSION_REUSE_CONFLICT");
  assert.strictEqual(fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_A").title, "真实搭配");

  const updated = await updateOutfit.main({
    id: first.data.id,
    clientRecordId: "outfit_A",
    title: "v2 搭配",
    season: "summer",
    style: "casual",
    mutationVersion: 2,
    items: outfit().items,
    userScope: "openid_outfit_B"
  });
  assert.strictEqual(updated.ok, true);
  assert.strictEqual(fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_A").title, "v2 搭配");

  const deleted = await deleteOutfit.main({
    id: first.data.id,
    clientRecordId: "outfit_A",
    mutationVersion: 3,
    userScope: "openid_outfit_B"
  });
  assert.strictEqual(deleted.ok, true);
  const tombstone = fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_A");
  assert.strictEqual(tombstone.isDeleted, true);
  assert.strictEqual(tombstone.mutationVersion, 3);

  const delayedSave = await saveOutfit.main(outfit({ title: "迟到保存", mutationVersion: 4 }));
  assert.strictEqual(delayedSave.errorCode, "TOMBSTONED");
  assert.strictEqual(fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_A").isDeleted, true);
  assert(fake.metrics.transactionCalls >= 3,
    "衣橱 snapshot 重建、更新和删除也必须由真实 transaction 路径保护");

  console.log("final outfit snapshot, mutation and tombstone tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
