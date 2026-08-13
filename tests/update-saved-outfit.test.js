const assert = require("assert");
const Module = require("module");
const { createFakeCloud } = require("./helpers/fake-cloud");

const openid = "user_123";
const image = (slot) => `cloud://env.bucket/wardrobe/${openid}/${slot}.jpg`;
const fake = createFakeCloud({
  clothing_items: ["top", "bottom", "shoes"].map((slot) => ({
    _id: `cloud_${slot}`,
    clientRecordId: `item_${slot}`,
    openid,
    category: slot,
    name: `测试${slot}`,
    imageFileId: image(slot),
    isDeleted: false
  })),
  outfit_records: [{
    _id: "outfit_1",
    clientRecordId: "outfit_1",
    openid,
    isDeleted: false,
    mutationVersion: 1,
    title: "原搭配"
  }]
}, openid);

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "wx-server-sdk") return fake.cloud;
  if (request === "@cloudbase/node-sdk") return fake.cloudbase;
  return originalLoad.call(this, request, parent, isMain);
};
const updateSavedOutfit = require("../cloudfunctions/updateSavedOutfit/index");
Module._load = originalLoad;

(async () => {
  const validSlot = (slot) => ({
    itemId: `item_${slot}`,
    snapshot: {
      name: `测试${slot}`,
      category: slot,
      imageUrl: image(slot),
      imageFileId: image(slot),
      primaryColor: "pink",
      unexpected: "must not persist"
    },
    unexpected: "must not persist"
  });
  const updateEvent = {
    id: "outfit_1",
    clientRecordId: "outfit_1",
    title: "安全更新",
    season: "summer",
    style: "casual",
    mutationVersion: 2,
    items: {
      top: validSlot("top"),
      bottom: validSlot("bottom"),
      shoes: validSlot("shoes")
    }
  };
  const result = await updateSavedOutfit.main(updateEvent);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.mutationVersion, 2);
  assert.strictEqual((await updateSavedOutfit.main(updateEvent)).data.mutationStatus, "IDEMPOTENT");
  assert.strictEqual((await updateSavedOutfit.main({ ...updateEvent, title: "同版本冲突更新" })).errorCode, "VERSION_REUSE_CONFLICT");
  const updated = fake.collections.outfit_records.find((item) => item._id === "outfit_1");
  assert.deepStrictEqual(Object.keys(updated.items.top).sort(), ["itemId", "snapshot"]);
  assert.deepStrictEqual(Object.keys(updated.items.top.snapshot).sort(), [
    "category", "imageFileId", "imageUrl", "name", "primaryColor"
  ]);
  assert.strictEqual(updated.items.top.snapshot.unexpected, undefined);
  console.log("update saved outfit validation tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
