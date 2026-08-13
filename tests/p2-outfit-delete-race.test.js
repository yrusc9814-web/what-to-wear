const assert = require("assert");
const Module = require("module");
const { createFakeCloud } = require("./helpers/fake-cloud");

const openid = "p2_race_user";
const image = (slot) => `cloud://env.bucket/wardrobe/${openid}/${slot}.jpg`;
const fake = createFakeCloud({
  clothing_items: ["top", "bottom", "shoes"].map((slot) => ({
    _id: `cloud_${slot}`,
    clientRecordId: `item_${slot}`,
    openid,
    category: slot,
    name: `竞态测试${slot}`,
    imageFileId: image(slot),
    isDeleted: false,
    mutationVersion: 1
  })),
  outfit_records: []
}, openid);

// This test-local wrapper reproduces the real interleaving without changing the
// shared fake-cloud helper: trusted slots are read first, then the wardrobe row
// is tombstoned immediately before the outfit transaction starts.
const baseCloudbase = fake.cloudbase;
const hookedCloudbase = {
  ...baseCloudbase,
  init() {
    const app = baseCloudbase.init();
    return {
      ...app,
      database() {
        const db = app.database();
        return {
          ...db,
          async runTransaction(callback) {
            const top = fake.collections.clothing_items.find((row) => row.clientRecordId === "item_top");
            assert(top && top.isDeleted !== true, "hook 必须在 buildTrustedSlots 已读取有效单品后执行");
            top.isDeleted = true;
            top.deletedAt = new Date().toISOString();
            top.mutationVersion += 1;
            return db.runTransaction(callback);
          }
        };
      }
    };
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "wx-server-sdk") return fake.cloud;
  if (request === "@cloudbase/node-sdk") return hookedCloudbase;
  return originalLoad.call(this, request, parent, isMain);
};
const saveOutfit = require("../cloudfunctions/saveOutfit/index");
Module._load = originalLoad;

function slotReference(slot) {
  return {
    itemId: `item_${slot}`,
    snapshot: { category: slot }
  };
}

(async () => {
  const result = await saveOutfit.main({
    clientRecordId: "p2_race_outfit",
    mutationVersion: 1,
    title: "不应保存的竞态搭配",
    date: "2026-08-13",
    season: "summer",
    style: "casual",
    items: {
      top: slotReference("top"),
      bottom: slotReference("bottom"),
      shoes: slotReference("shoes")
    }
  });

  assert.strictEqual(
    result.ok,
    false,
    "buildTrustedSlots 读取后单品被 tombstone 时，新搭配事务必须拒绝提交"
  );
  assert.strictEqual(result.errorCode, "INVALID_SLOTS", "失败必须来自事务内槽位复核");
  assert.strictEqual(fake.metrics.transactionCalls, 1, "测试必须实际进入 outfit transaction");
  assert.strictEqual(fake.metrics.transactionCommits, 0, "事务内复核失败不得提交");
  assert.strictEqual(fake.metrics.transactionRollbacks, 1, "事务内复核失败必须回滚 outfit 写入");
  assert.strictEqual(
    fake.collections.outfit_records.length,
    0,
    "已删除单品不得形成新的 outfit snapshot"
  );
  console.log("p2 outfit/delete transaction race test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
