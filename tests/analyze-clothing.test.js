const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "wx-server-sdk") {
    return {
      DYNAMIC_CURRENT_ENV: "test",
      init() {},
      getWXContext() { return { OPENID: "user_123" }; },
      downloadFile() { return Promise.reject(new Error("not used")); }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const analyzer = require("../cloudfunctions/analyzeClothing/index")._test;
Module._load = originalLoad;

assert.strictEqual(analyzer.detectMime(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
assert.strictEqual(analyzer.isAllowedFileId("cloud://env.bucket/wardrobe/user_123/a.jpg", "user_123"), true);
assert.strictEqual(analyzer.isAllowedFileId("cloud://env.bucket/wardrobe/other/a.jpg", "user_123"), false);

const valid = analyzer.validateCandidate({
  name: "粉色针织开衫",
  category: "top",
  primaryColor: "pink",
  seasons: ["spring", "autumn"],
  styles: ["sweet", "casual"],
  thickness: "medium",
  aiDescription: "粉色短款开衫，适合春秋日常搭配。"
});
assert(valid);
assert.strictEqual(valid.category, "top");

assert.strictEqual(analyzer.validateCandidate({ ...valid, brand: "不允许" }), null);
assert.strictEqual(analyzer.validateCandidate({ ...valid, category: "accessory" }), null);
assert.strictEqual(analyzer.validateCandidate({ ...valid, styles: ["all"] }), null);

console.log("analyze clothing validation tests passed");
