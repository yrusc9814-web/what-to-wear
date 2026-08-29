const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

const userA = "openid_reference_A";
const userB = "openid_reference_B";
const imageA = `cloud://env.bucket/wardrobe/${userA}/ref.jpg`;
const imageB = `cloud://env.bucket/wardrobe/${userB}/ref.jpg`;
const fake = createFakeCloud({ outfit_references: [] }, userA, {
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

const saveReference = load("cloudfunctions/saveOutfitReference/index.js");
const updateReference = load("cloudfunctions/updateOutfitReference/index.js");
const deleteReference = load("cloudfunctions/deleteOutfitReference/index.js");

function reference(overrides = {}) {
  return {
    clientRecordId: "reference_A",
    name: "博主夏季参考",
    seasons: ["summer"],
    styles: ["casual"],
    occasion: "通勤",
    note: "值得借鉴",
    source: "web",
    imageFileId: imageA,
    mutationVersion: 1,
    userScope: userB,
    ...overrides
  };
}

function stored(clientRecordId) {
  return fake.collections.outfit_references.find((row) => row.clientRecordId === clientRecordId);
}

(async () => {
  fake.setCurrentOpenId(userA);
  const first = await saveReference.main(reference());
  assert.strictEqual(first.ok, true);
  const storedFirst = stored("reference_A");
  assert.strictEqual(storedFirst.openid, userA,
    "正式身份必须来自调用时 WXContext.OPENID，不能由 event.userScope 指定");
  assert.strictEqual(storedFirst.source, "web");
  assert.deepStrictEqual(storedFirst.seasons, ["summer"]);
  assert.deepStrictEqual(storedFirst.styles, ["casual"]);

  const missingVersionEvent = reference({ clientRecordId: "missing_version" });
  delete missingVersionEvent.mutationVersion;
  const missingVersion = await saveReference.main(missingVersionEvent);
  assert.strictEqual(missingVersion.errorCode, "MUTATION_VERSION_REQUIRED");

  const missingSource = await saveReference.main(reference({ clientRecordId: "bad_source", source: "magazine" }));
  assert.strictEqual(missingSource.errorCode, "OUTFIT_REFERENCE_REQUIRED",
    "source 必须属于 self/web/other");

  const missingFields = await saveReference.main(reference({
    clientRecordId: "missing_fields",
    seasons: [],
    styles: ["casual"]
  }));
  assert.strictEqual(missingFields.errorCode, "OUTFIT_REFERENCE_REQUIRED");

  const retry = await saveReference.main(reference());
  assert.strictEqual(retry.ok, true, "相同 mutationVersion 和相同 payload 应幂等成功");
  assert.strictEqual(retry.data.mutationStatus, "IDEMPOTENT");
  assert.strictEqual(stored("reference_A").name, "博主夏季参考");

  const conflict = await saveReference.main(reference({ name: "同版本不同 payload" }));
  assert.strictEqual(conflict.errorCode, "VERSION_REUSE_CONFLICT");
  assert.strictEqual(stored("reference_A").name, "博主夏季参考");

  const second = await saveReference.main(reference({ name: "v2 参考", mutationVersion: 2 }));
  assert.strictEqual(second.ok, true);
  assert.strictEqual(stored("reference_A").mutationVersion, 2);
  assert.strictEqual(stored("reference_A").name, "v2 参考");

  const stale = await saveReference.main(reference({ name: "迟到 v1", mutationVersion: 1 }));
  assert(stale.errorCode === "STALE" || stale.ok && stale.data.mutationStatus === "STALE");
  assert.strictEqual(stored("reference_A").name, "v2 参考");

  const wxfile = await updateReference.main({
    id: first.data.id,
    clientRecordId: "reference_A",
    name: "旧 wxfile 编辑",
    seasons: ["summer"],
    styles: ["casual"],
    source: "other",
    imageFileId: "wxfile://saved/legacy.jpg",
    mutationVersion: 3,
    userScope: userB
  });
  assert.strictEqual(wxfile.errorCode, "IMAGE_FILE_INVALID");

  const forged = await saveReference.main(reference({
    clientRecordId: "forged_ref",
    imageFileId: `cloud://env.bucket/wardrobe/${userA}/forged-but-unreachable.jpg`,
    mutationVersion: 1
  }));
  assert.strictEqual(forged.errorCode, "IMAGE_FILE_INVALID");

  fake.setCurrentOpenId(userB);
  const bRecord = await saveReference.main(reference({
    clientRecordId: "reference_B",
    name: "B 的参考",
    imageFileId: imageB
  }));
  assert.strictEqual(bRecord.ok, true);
  assert.strictEqual(stored("reference_B").openid, userB,
    "event.userScope 伪装成 A 也不能跨用户写入");

  fake.setCurrentOpenId(userA);
  const crossUser = await updateReference.main({
    id: bRecord.data.id,
    clientRecordId: "reference_B",
    name: "越权改名",
    seasons: ["summer"],
    styles: ["casual"],
    source: "self",
    imageFileId: imageA,
    mutationVersion: 2
  });
  assert.strictEqual(crossUser.ok, false, "A 不得编辑 B 的参考");
  assert(crossUser.errorCode === "RECORD_NOT_FOUND" || crossUser.errorCode === "MUTATION_FAILED");
  assert.strictEqual(stored("reference_B").name, "B 的参考");

  const deleted = await deleteReference.main({
    id: first.data.id,
    clientRecordId: "reference_A",
    mutationVersion: 4,
    userScope: userB
  });
  assert.strictEqual(deleted.ok, true);
  const tombstone = stored("reference_A");
  assert.strictEqual(tombstone.isDeleted, true);
  assert.strictEqual(tombstone.mutationVersion, 4);
  assert.ok(tombstone.deletedAt, "tombstone 必须带 deletedAt");

  const delayedV3 = await saveReference.main(reference({ name: "延迟 v3", mutationVersion: 3 }));
  assert(
    delayedV3.errorCode === "TOMBSTONED" || delayedV3.data && delayedV3.data.mutationStatus === "STALE",
    "删除后的低版本 mutation 必须保持 tombstone 且不能覆盖当前状态"
  );
  const delayedV5 = await saveReference.main(reference({ name: "延迟 v5", mutationVersion: 5 }));
  assert.strictEqual(delayedV5.errorCode, "TOMBSTONED");
  const finalRecord = stored("reference_A");
  assert.strictEqual(finalRecord.isDeleted, true, "普通 save/update 永远不能复活 tombstone");
  assert.strictEqual(finalRecord.name, "v2 参考");

  const missingDelete = await deleteReference.main({ clientRecordId: "never_existed", mutationVersion: 1 });
  assert.strictEqual(missingDelete.ok, true, "删除不存在的记录应幂等成功");
  assert.strictEqual(missingDelete.data.mutationStatus, "ALREADY_DELETED");

  const raceBase = await saveReference.main(reference({
    clientRecordId: "race_reference",
    name: "竞态参考",
    imageFileId: imageA,
    mutationVersion: 1
  }));
  assert.strictEqual(raceBase.ok, true);

  const sameVersionRaces = await Promise.all([
    deleteReference.main({ id: raceBase.data.id, clientRecordId: "race_reference", mutationVersion: 2 }),
    deleteReference.main({ id: raceBase.data.id, clientRecordId: "race_reference", mutationVersion: 2 })
  ]);
  assert.strictEqual(sameVersionRaces[0].ok, true);
  assert.strictEqual(sameVersionRaces[1].ok, true);
  const raceTombstone = stored("race_reference");
  assert.strictEqual(raceTombstone.isDeleted, true, "并发 delete 后必须是 tombstone");
  assert.strictEqual(raceTombstone.mutationVersion, 2);

  const raceRecreate = await saveReference.main(reference({
    clientRecordId: "race_reference_2",
    name: "竞态参考 2",
    imageFileId: imageA,
    mutationVersion: 1
  }));
  assert.strictEqual(raceRecreate.ok, true);
  const versionRace = await Promise.all([
    deleteReference.main({ id: raceRecreate.data.id, clientRecordId: "race_reference_2", mutationVersion: 5 }),
    deleteReference.main({ id: raceRecreate.data.id, clientRecordId: "race_reference_2", mutationVersion: 6 })
  ]);
  assert.strictEqual(versionRace[0].ok, true);
  assert.strictEqual(versionRace[1].ok, true);
  const versionRaceTombstone = stored("race_reference_2");
  assert.strictEqual(versionRaceTombstone.isDeleted, true);
  assert.strictEqual(versionRaceTombstone.mutationVersion, 6, "并发 delete 后取最高版本");

  assert(fake.metrics.transactionCalls >= 10,
    "正式 mutation 必须经过 fake runtime 可观测的 CloudBase transaction");

  console.log("final outfit reference identity, mutation, tombstone and race tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
