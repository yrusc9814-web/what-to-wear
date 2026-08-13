const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

const userA = "openid_mutation_A";
const userB = "openid_mutation_B";
const imageA = `cloud://env.bucket/wardrobe/${userA}/top.jpg`;
const imageB = `cloud://env.bucket/wardrobe/${userB}/top.jpg`;
const fake = createFakeCloud({ clothing_items: [], outfit_records: [] }, userA, {
  autoRegisterCloudFiles: false
});
fake.registerCloudFile(imageA);
fake.registerCloudFile(imageB);

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

const saveClothing = load("cloudfunctions/saveClothing/index.js");
const updateClothing = load("cloudfunctions/updateClothing/index.js");
const deleteClothing = load("cloudfunctions/deleteClothing/index.js");

function clothing(overrides = {}) {
  return {
    clientRecordId: "mutation_item_A",
    category: "top",
    name: "原始上衣",
    seasons: ["summer"],
    styles: ["casual"],
    primaryColor: "pink",
    imageFileId: imageA,
    mutationVersion: 1,
    userScope: userB,
    ...overrides
  };
}

(async () => {
  fake.setCurrentOpenId(userA);
  const first = await saveClothing.main(clothing());
  assert.strictEqual(first.ok, true);
  const storedFirst = fake.collections.clothing_items.find((row) => row.clientRecordId === "mutation_item_A");
  assert.strictEqual(storedFirst.openid, userA,
    "正式身份必须来自调用时 WXContext.OPENID，不能由 event.userScope 指定");

  const missingVersionEvent = clothing({ clientRecordId: "missing_version" });
  delete missingVersionEvent.mutationVersion;
  const missingVersion = await saveClothing.main(missingVersionEvent);
  assert.strictEqual(missingVersion.errorCode, "MUTATION_VERSION_REQUIRED");

  const retry = await saveClothing.main(clothing());
  assert.strictEqual(retry.ok, true, "相同 mutationVersion 和相同 payload 应幂等成功");
  assert.strictEqual(fake.collections.clothing_items.find((row) => row.clientRecordId === "mutation_item_A").name, "原始上衣");

  const conflict = await saveClothing.main(clothing({ name: "同版本不同 payload" }));
  assert.strictEqual(conflict.errorCode, "VERSION_REUSE_CONFLICT");
  assert.strictEqual(fake.collections.clothing_items.find((row) => row.clientRecordId === "mutation_item_A").name, "原始上衣");

  const second = await saveClothing.main(clothing({ name: "v2 上衣", mutationVersion: 2 }));
  assert.strictEqual(second.ok, true);
  const afterSecond = fake.collections.clothing_items.find((row) => row.clientRecordId === "mutation_item_A");
  assert.strictEqual(afterSecond.mutationVersion, 2);
  assert.strictEqual(afterSecond.name, "v2 上衣");

  const stale = await saveClothing.main(clothing({ name: "迟到 v1", mutationVersion: 1 }));
  assert(stale.errorCode === "STALE" || stale.ok && stale.data.mutationStatus === "STALE");
  assert.strictEqual(fake.collections.clothing_items.find((row) => row.clientRecordId === "mutation_item_A").name, "v2 上衣");

  const legacyImage = await updateClothing.main({
    id: first.data.id,
    clientRecordId: "mutation_item_A",
    category: "top",
    name: "旧 wxfile 编辑",
    seasons: ["summer"],
    styles: ["casual"],
    imageFileId: "wxfile://saved/legacy.jpg",
    mutationVersion: 3,
    userScope: userB
  });
  assert.strictEqual(legacyImage.errorCode, "IMAGE_FILE_INVALID");

  const forgedImage = await saveClothing.main(clothing({
    clientRecordId: "forged_image",
    imageFileId: `cloud://env.bucket/wardrobe/${userA}/forged-but-unreachable.jpg`,
    mutationVersion: 1
  }));
  assert.strictEqual(forgedImage.errorCode, "IMAGE_FILE_INVALID");

  fake.setCurrentOpenId(userB);
  const bRecord = await saveClothing.main({
    ...clothing({
      clientRecordId: "mutation_item_B",
      name: "B 的上衣",
      imageFileId: imageB
    }),
    userScope: userA
  });
  assert.strictEqual(bRecord.ok, true);
  assert.strictEqual(fake.collections.clothing_items.find((row) => row.clientRecordId === "mutation_item_B").openid, userB,
    "event.userScope 伪装成 A 也不能跨用户写入");

  fake.setCurrentOpenId(userA);
  const deleted = await deleteClothing.main({
    id: first.data.id,
    clientRecordId: "mutation_item_A",
    mutationVersion: 4,
    userScope: userB
  });
  assert.strictEqual(deleted.ok, true);
  const tombstone = fake.collections.clothing_items.find((row) => row.clientRecordId === "mutation_item_A");
  assert.strictEqual(tombstone.isDeleted, true);
  assert.strictEqual(tombstone.mutationVersion, 4);

  const delayedV3 = await saveClothing.main(clothing({ name: "延迟 v3", mutationVersion: 3 }));
  assert(
    delayedV3.errorCode === "TOMBSTONED" || delayedV3.data && delayedV3.data.mutationStatus === "STALE",
    "删除后的低版本 mutation 必须保持 tombstone 且不能覆盖当前状态"
  );
  const delayedV5 = await saveClothing.main(clothing({ name: "延迟 v5", mutationVersion: 5 }));
  assert.strictEqual(delayedV5.errorCode, "TOMBSTONED");
  const finalRecord = fake.collections.clothing_items.find((row) => row.clientRecordId === "mutation_item_A");
  assert.strictEqual(finalRecord.isDeleted, true, "普通 save/update 永远不能复活 tombstone");
  assert.strictEqual(finalRecord.name, "v2 上衣");
  assert(fake.metrics.transactionCalls >= 3,
    "正式 mutation 必须经过 fake runtime 可观测的 CloudBase transaction");

  console.log("final cloud identity, mutation, tombstone and image validation tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
