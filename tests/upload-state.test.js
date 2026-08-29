const assert = require("assert");
const Module = require("module");

let definition;
global.Page = (value) => { definition = value; };
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "../../services/app-service") {
    return {
      uploadImage() {
        return Promise.resolve({
          imageUrl: "wxfile://saved/item.jpg",
          fileId: "",
          storage: "local",
          uploadState: "failed"
        });
      },
      persistLocalImage(path) {
        return Promise.resolve(path);
      },
      clearTempImage() {
        return Promise.resolve(true);
      },
      unregisterTempImage() {},
      sweepExpiredTempImages() {
        return Promise.resolve(0);
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
require("../miniprogram/pages/item-upload/item-upload");
Module._load = originalLoad;
delete global.Page;

(async () => {
  const page = {
    ...definition,
    data: { ...definition.data, localImagePath: "wxfile://tmp/item.jpg" },
    setData(patch) { Object.assign(this.data, patch); }
  };
  await page.uploadTempImage();
  assert.notStrictEqual(page.data.uploadState, "success");
  assert.strictEqual(page.data.uploadState, "error");
  console.log("upload failure state tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
