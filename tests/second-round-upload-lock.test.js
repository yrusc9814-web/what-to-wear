const assert = require("assert");
const Module = require("module");

let resolveSave;
let createCalls = 0;
const appService = {
  uploadImage() { return Promise.resolve({ uploadState: "success", imageUrl: "cloud://env.bucket/item.jpg", fileId: "cloud://env.bucket/item.jpg" }); },
  createWardrobeItem() {
    createCalls += 1;
    return new Promise((resolve) => { resolveSave = resolve; });
  },
  persistLocalImage(path) { return Promise.resolve(path); },
  clearTempImage() { return Promise.resolve(true); },
  unregisterTempImage() {},
  sweepExpiredTempImages() { return Promise.resolve(0); }
};
let definition;
global.Page = (value) => { definition = value; };
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "../../services/app-service") return appService;
  return originalLoad.call(this, request, parent, isMain);
};
require("../miniprogram/pages/item-upload/item-upload");
Module._load = originalLoad;
delete global.Page;

global.wx = {
  showLoading() {},
  hideLoading() {},
  showToast() {},
  showModal() {},
  navigateBack() {}
};

(async () => {
  const page = {
    ...definition,
    data: {
      ...definition.data,
      localImagePath: "wxfile://tmp/item.jpg",
      imageUrl: "cloud://env.bucket/item.jpg",
      fileId: "cloud://env.bucket/item.jpg",
      uploadState: "success",
      form: {
        ...definition.data.form,
        name: "测试上衣",
        category: "top",
        seasons: ["summer"],
        styles: ["casual"]
      }
    },
    setData(patch) { Object.assign(this.data, patch); }
  };
  const first = page.saveItem();
  const second = page.saveItem();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(createCalls, 1, "saveItem 入口必须不可重入");
  resolveSave({ syncStatus: "synced", id: "item_1" });
  await Promise.all([first, second]);
  assert.strictEqual(page.data.saving, false, "保存完成后必须释放锁");
  console.log("second-round upload duplicate-submit lock tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
