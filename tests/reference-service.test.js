const assert = require("assert");
const path = require("path");

const storage = new Map();
const tempScope = { userId: "openid_reference_service" };
global.getApp = () => ({ globalData: { userScope: tempScope.userId, identityState: "confirmed" } });
global.wx = {
  getStorageSync(key) {
    const scoped = storage.get(key);
    return scoped && Object.prototype.hasOwnProperty.call(scoped, tempScope.userId)
      ? scoped[tempScope.userId]
      : "";
  },
  setStorageSync(key, value) {
    const scoped = storage.get(key) || {};
    scoped[tempScope.userId] = value;
    storage.set(key, scoped);
  },
  removeStorageSync(key) { storage.delete(key); }
};

const service = require("../miniprogram/services/reference-service");

(async () => {
  const created = service.saveReference({
    name: "通勤参考",
    seasons: ["summer", "spring"],
    styles: ["commute", "casual"],
    occasion: "面试",
    note: "博主穿搭",
    source: "web",
    imageFileId: "cloud://env.bucket/wardrobe/openid_reference_service/ref.jpg"
  });
  assert(created.id, "saveReference 必须生成本地 id");
  assert.strictEqual(created.mutationVersion, 1);
  assert.strictEqual(created.syncStatus, "pending");
  assert.strictEqual(created.source, "web");
  assert.deepStrictEqual(created.seasons, ["summer", "spring"]);
  assert.deepStrictEqual(created.styles, ["commute", "casual"]);

  const outboxAfterCreate = service.readReferenceOutbox();
  assert.strictEqual(outboxAfterCreate.length, 1);
  assert.strictEqual(outboxAfterCreate[0].entity, "outfitReference");
  assert.strictEqual(outboxAfterCreate[0].action, "create");
  assert.strictEqual(outboxAfterCreate[0].clientRecordId, created.id);
  assert.strictEqual(outboxAfterCreate[0].mutationVersion, 1);
  assert.strictEqual(outboxAfterCreate[0].userScope, tempScope.userId);

  const listed = service.listReferences();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].name, "通勤参考");

  const updated = service.updateReference(created.id, {
    name: "通勤参考 v2",
    seasons: ["winter"],
    styles: ["cool"],
    source: "self"
  });
  assert.strictEqual(updated.mutationVersion, 2);
  assert.strictEqual(updated.syncStatus, "pending");
  assert.strictEqual(updated.name, "通勤参考 v2");
  assert.deepStrictEqual(updated.seasons, ["winter"]);

  const outboxAfterUpdate = service.readReferenceOutbox();
  assert.strictEqual(outboxAfterUpdate.length, 2);
  assert.strictEqual(outboxAfterUpdate[1].action, "update");
  assert.strictEqual(outboxAfterUpdate[1].mutationVersion, 2);
  assert.strictEqual(outboxAfterUpdate[1].queueSequence, 2);
  assert.strictEqual(outboxAfterUpdate[1].entityKey, `outfitReference:${created.id}`);

  const removed = service.removeReference(created.id);
  assert.strictEqual(removed.mutationVersion, 3);
  assert.ok(removed.deletedAt, "remove 必须写 deletedAt tombstone");
  const outboxAfterRemove = service.readReferenceOutbox();
  assert.strictEqual(outboxAfterRemove.length, 3);
  assert.strictEqual(outboxAfterRemove[2].action, "delete");
  assert.strictEqual(outboxAfterRemove[2].mutationVersion, 3);

  const filtered = service.listReferences({ includeDeleted: false });
  assert.strictEqual(filtered.length, 0, "默认列表不得包含已删除参考");
  assert.strictEqual(service.listReferences({ includeDeleted: true }).length, 1);
  const storedAfterRemove = service.getReference(created.id);
  assert.ok(storedAfterRemove && storedAfterRemove.deletedAt, "本地删除记录必须保留 deletedAt tombstone");

  assert.throws(() => service.updateReference("no_such_id", { name: "不存在", source: "self" }), /不存在|已被删除/, "更新不存在的参考必须抛错");

  console.log("reference-service local CRUD and outbox tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
