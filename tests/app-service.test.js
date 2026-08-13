const assert = require("assert");

const storage = new Map();

global.wx = {
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : "";
  },
  setStorageSync(key, value) {
    storage.set(key, JSON.parse(JSON.stringify(value)));
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  saveFile({ tempFilePath, success }) {
    success({ savedFilePath: `wxfile://saved/${tempFilePath.split('/').pop()}` });
  }
};

const constants = require("../miniprogram/utils/constants");
const service = require("../miniprogram/services/app-service");

async function run() {
  assert.strictEqual(constants.getCurrentSeason(new Date(2026, 3, 1)), "spring");
  assert.strictEqual(constants.getCurrentSeason(new Date(2026, 6, 1)), "summer");
  assert.strictEqual(constants.getCurrentSeason(new Date(2026, 9, 1)), "autumn");
  assert.strictEqual(constants.getCurrentSeason(new Date(2026, 0, 1)), "winter");
  assert.strictEqual(constants.CATEGORIES.length, 5);
  assert(!constants.CATEGORIES.some((item) => item.value === "accessory"));

  const localUpload = await service.uploadImage("http://tmp/example.jpg");
  assert.strictEqual(localUpload.imageUrl, "wxfile://saved/example.jpg");
  assert.strictEqual(localUpload.storage, "local");

  let top = await service.createWardrobeItem({
    name: "测试上衣",
    category: "top",
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: "cloud://top"
  });
  const bottom = await service.createWardrobeItem({
    name: "测试下装",
    category: "bottom",
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: "cloud://bottom"
  });
  const shoes = await service.createWardrobeItem({
    name: "测试鞋子",
    category: "shoes",
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: "cloud://shoes"
  });

  assert.strictEqual((await service.listWardrobeItems({ category: "top" })).length, 1);

  top = await service.updateWardrobeItem(top.id, { name: "更新后的上衣名称" });

  const reclassified = await service.createWardrobeItem({
    name: "测试帽子",
    category: "hat",
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: "cloud://hat"
  });
  assert.strictEqual((await service.listWardrobeItems({ category: "hat" })).length, 1);
  await service.updateWardrobeItem(reclassified.id, { category: "bag" });
  assert.strictEqual((await service.listWardrobeItems({ category: "hat" })).length, 0);
  assert.strictEqual((await service.listWardrobeItems({ category: "bag" })).length, 1);

  const outfit = await service.createSavedOutfit({
    title: "联调穿搭",
    season: "summer",
    style: "casual",
    items: { top, bottom, shoes, hat: null, bag: null }
  });
  assert.strictEqual((await service.listSavedOutfits({ season: "summer", style: "casual" })).length, 1);

  await service.deleteWardrobeItem(top.id);
  assert.strictEqual((await service.listWardrobeItems({ category: "top" })).length, 0);
  const history = await service.getSavedOutfit(outfit.id);
  assert.strictEqual(history.items.top.snapshot.name, "更新后的上衣名称");
  assert.strictEqual(history.items.top.snapshot.imageUrl, "cloud://top");

  await service.setTodayOutfit(outfit.id, new Date(2026, 7, 13));
  assert((await service.getTodayOutfit(new Date(2026, 7, 13))).outfit);
  assert.strictEqual((await service.getTodayOutfit(new Date(2026, 7, 14))).outfit, null);

  await assert.rejects(() => service.updateSavedOutfit(outfit.id, {
    title: "更新后的穿搭",
    season: "summer",
    style: "commute",
    items: history.items
  }), /已失效/);
  const replacementTop = await service.createWardrobeItem({
    name: "替换上衣",
    category: "top",
    seasons: ["summer"],
    styles: ["commute"],
    imageUrl: "cloud://replacement-top"
  });
  const validItems = { ...history.items, top: replacementTop };
  const updated = await service.updateSavedOutfit(outfit.id, {
    title: "更新后的穿搭",
    season: "summer",
    style: "commute",
    items: validItems
  });
  assert.strictEqual(updated.id, outfit.id);
  assert.strictEqual(updated.title, "更新后的穿搭");
  const copied = await service.createSavedOutfit({
    title: "另存的穿搭",
    season: "summer",
    style: "commute",
    items: validItems
  });
  assert.notStrictEqual(copied.id, outfit.id);
  assert.strictEqual((await service.listSavedOutfits({ limit: 1 }))[0].id, copied.id);
  await service.deleteSavedOutfit(copied.id);
  assert.strictEqual(await service.getSavedOutfit(copied.id), null);

  const originalNow = Date.now;
  let fakeNow = 2000000000000;
  Date.now = () => fakeNow++;
  const recentIds = [];
  for (let index = 0; index < 5; index += 1) {
    const recent = await service.createSavedOutfit({
      title: `排序测试 ${index}`,
      season: "summer",
      style: "commute",
      items: validItems
    });
    recentIds.push(recent.id);
    fakeNow += 100;
  }
  fakeNow += 100;
  await service.updateSavedOutfit(recentIds[0], {
    title: "最旧搭配再次保存",
    season: "summer",
    style: "commute",
    items: validItems
  });
  const recentFour = await service.listSavedOutfits({ limit: 4 });
  assert.strictEqual(recentFour[0].id, recentIds[0]);
  assert.deepStrictEqual(recentFour.slice(1).map((entry) => entry.id), recentIds.slice(2).reverse());
  Date.now = originalNow;

  await service.updateWardrobeItem(replacementTop.id, { category: "bottom" });
  await assert.rejects(() => service.updateSavedOutfit(outfit.id, {
    title: "分类污染测试",
    season: "summer",
    style: "commute",
    items: validItems
  }), /已失效/);

  const draft = { dirty: true, slots: { top, bottom, shoes } };
  service.persistOutfitDraft(draft);
  assert.strictEqual(service.getOutfitDraft().dirty, true);
  service.clearOutfitDraft();
  assert.strictEqual(service.getOutfitDraft(), null);

  await assert.rejects(() => service.createWardrobeItem({}), /图片/);
  await assert.rejects(() => service.createSavedOutfit({}), /名称、季节和风格/);

  const cloudDate = { toDate: () => new Date(2026, 7, 13, 12, 0, 0) };
  const normalizedCloudItem = service.normalizeWardrobeItem({
    id: "cloud_item",
    name: "云端日期单品",
    category: "top",
    createdAt: cloudDate,
    updatedAt: cloudDate
  });
  assert.strictEqual(normalizedCloudItem.createdAt, cloudDate.toDate().getTime());

  console.log("app-service integration tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
