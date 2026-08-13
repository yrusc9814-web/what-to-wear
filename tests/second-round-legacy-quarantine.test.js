const assert = require("assert");

const storage = new Map();
const calls = [];
const app = { globalData: {} };
global.getApp = () => app;
global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); },
  cloud: {
    callFunction({ name }) {
      calls.push(name);
      if (name === "getUserIdentity") return Promise.resolve({ result: { ok: true, data: { userId: "openid_B" } } });
      return Promise.resolve({ result: { ok: true, data: {} } });
    }
  }
};

const service = require("../miniprogram/services/app-service");
const oldOutbox = [{ id: "outfit:old", entity: "outfit", action: "delete", clientRecordId: "old" }];
storage.set(service.STORAGE.wardrobe, [{ id: "A-top", category: "top" }]);
storage.set(`${service.STORAGE.wardrobe}:current_wechat_user`, [{ id: "A-public-top", category: "top" }]);
storage.set(service.STORAGE.syncOutbox, oldOutbox);
storage.set(service.STORAGE.draft, { dirty: true, title: "A 草稿" });
storage.set(service.STORAGE.today, { date: "2026-08-13", outfitId: "A-outfit" });
storage.set(service.STORAGE.location, { cityName: "上海", source: "manual" });

service.resolveUserScope("openid_B");

(async () => {
  assert.deepStrictEqual(await service.listWardrobeItems({ includeDeleted: true }), [], "旧公共衣橱不得归属 B");
  assert.strictEqual(service.getOutfitDraft(), null, "旧公共草稿不得归属 B");
  assert.strictEqual(service.getLocation().cityName, "未选择城市", "旧公共城市不得归属 B");
  assert.strictEqual(service.getValidTodayAssignment(), null, "旧公共今日穿搭不得归属 B");
  assert.deepStrictEqual(await service.reconcilePendingSync(), [], "旧公共 outbox 不得以 B 执行");
  assert(!calls.includes("deleteOutfitRecord"), "旧公共 outbox 不得触发云端删除");
  const quarantine = storage.get(service.STORAGE.legacyQuarantine) || [];
  assert(quarantine.some((entry) => entry.key === service.STORAGE.wardrobe));
  assert(quarantine.some((entry) => entry.key === service.STORAGE.syncOutbox));
  assert.strictEqual(storage.has(`${service.STORAGE.wardrobe}:openid_B`), true);
  service.markIdentityUnconfirmed(new Error("re-parse identity"));
  await service.createWardrobeItem({
    name: "未确认期间单品", category: "top", seasons: ["summer"], styles: ["casual"], imageUrl: "cloud://temporary"
  });
  assert.strictEqual(await service.ensureUserScope(), "openid_B");
  assert.strictEqual((await service.listWardrobeItems({ includeDeleted: true })).length, 0, "重新解析身份不得继承旧 session 内存业务数据");
  console.log("second-round legacy quarantine tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
