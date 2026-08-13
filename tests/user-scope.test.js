const assert = require("assert");

const storage = new Map();
const app = { globalData: {} };

global.getApp = () => app;
global.wx = {
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : "";
  },
  setStorageSync(key, value) {
    storage.set(key, JSON.parse(JSON.stringify(value)));
  },
  removeStorageSync(key) {
    storage.delete(key);
  }
};

const service = require("../miniprogram/services/app-service");

(async () => {
  const transient = await service.createWardrobeItem({
    name: "待绑定用户的上衣",
    category: "top",
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: "cloud://top"
  });
  assert.strictEqual([...storage.keys()].some((key) => key.includes("current_wechat_user")), false);
  assert.strictEqual(storage.has(service.STORAGE.wardrobe), false);

  service.resolveUserScope("openid_user_a");
  const userAItems = await service.listWardrobeItems({ includeDeleted: false });
  assert.strictEqual(userAItems.length, 1);
  assert.strictEqual(userAItems[0].id, transient.id);
  assert.strictEqual(storage.has(`${service.STORAGE.wardrobe}:current_wechat_user`), false);
  assert.strictEqual(storage.has(`${service.STORAGE.wardrobe}:openid_user_a`), true);

  service.persistOutfitDraft({ dirty: true, title: "A 的草稿" });
  app.globalData.userScope = "openid_user_b";
  assert.strictEqual((await service.listWardrobeItems({ includeDeleted: false })).length, 0);
  assert.strictEqual(service.getOutfitDraft(), null);

  app.globalData.userScope = "openid_user_a";
  assert.strictEqual((await service.listWardrobeItems({ includeDeleted: false })).length, 1);
  assert.strictEqual(service.getOutfitDraft().title, "A 的草稿");

  service.markIdentityUnconfirmed(new Error("identity failed"));
  assert.strictEqual((await service.listWardrobeItems({ includeDeleted: false })).length, 0);
  assert.strictEqual(service.getOutfitDraft(), null);
  assert.strictEqual([...storage.keys()].some((key) => key.includes("current_wechat_user")), false);

  service.resolveUserScope("openid_user_b");
  assert.strictEqual((await service.listWardrobeItems({ includeDeleted: false })).length, 0);
  service.resolveUserScope("openid_user_a");
  assert.strictEqual((await service.listWardrobeItems({ includeDeleted: false })).length, 1);

  service.markIdentityUnconfirmed(new Error("temporary identity outage"));
  await service.createWardrobeItem({
    name: "身份恢复后的临时上衣",
    category: "top",
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: "cloud://temporary-top"
  });
  service.resolveUserScope("openid_user_a");
  assert.strictEqual((await service.listWardrobeItems({ includeDeleted: false })).length, 2, "身份恢复后内存态应归入已确认 OpenID");

  console.log("user scope isolation tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
