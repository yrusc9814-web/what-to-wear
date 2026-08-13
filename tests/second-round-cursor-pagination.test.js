const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

const openid = "cursor_user";
const rows = (prefix) => Array.from({ length: 105 }, (_, index) => ({
  _id: `${prefix}_${String(index).padStart(3, "0")}`,
  clientRecordId: `${prefix}_client_${index}`,
  openid,
  category: "top",
  type: "top",
  name: `${prefix}-${index}`,
  imageFileId: `cloud://env.bucket/wardrobe/${openid}/${prefix}-${index}.jpg`,
  seasons: ["summer"],
  styles: ["casual"],
  createdAt: 100,
  updatedAt: 100
}));
const fake = createFakeCloud({ clothing_items: rows("item"), outfit_records: rows("outfit").map((row) => ({ ...row, title: row.name, items: {} })) }, openid);
function load(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  delete require.cache[filename];
  const originalLoad = Module._load;
  Module._load = function loadModule(request, parent, isMain) {
    if (request === "wx-server-sdk") return fake.cloud;
    if (request === "@cloudbase/node-sdk") return fake.cloudbase;
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require(filename); } finally { Module._load = originalLoad; }
}
const getWardrobe = load("cloudfunctions/getWardrobe/index.js");
const getOutfits = load("cloudfunctions/getOutfitRecords/index.js");

(async () => {
  const first = await getWardrobe.main({ pageSize: 99 });
  assert.strictEqual(first.data.pageSize, 99);
  assert.strictEqual(first.data.items.length, 99);
  fake.collections.clothing_items.push({
    _id: "item_999", clientRecordId: "new_item", openid, category: "top", type: "top", name: "插入项",
    imageFileId: `cloud://env.bucket/wardrobe/${openid}/new.jpg`, seasons: ["summer"], styles: ["casual"], createdAt: 100
  });
  const second = await getWardrobe.main({ pageSize: 99, cursor: first.data.nextCursor });
  const ids = first.data.items.concat(second.data.items).map((item) => item.id);
  assert.strictEqual(new Set(ids).size, ids.length, "稳定游标分页不得重复记录");
  assert(ids.includes("item_client_104"), "lastId 边界记录不得漏项");
  assert(ids.includes("new_item"), "lastId cursor 应从公开游标之后继续读取记录");

  const outfitFirst = await getOutfits.main({ pageSize: 99 });
  assert.strictEqual(outfitFirst.data.pageSize, 99);
  assert.strictEqual(outfitFirst.data.items.length, 99);
  const outfitSecond = await getOutfits.main({ pageSize: 99, cursor: outfitFirst.data.nextCursor });
  const outfitIds = outfitFirst.data.items.concat(outfitSecond.data.items).map((item) => item.id);
  assert.strictEqual(new Set(outfitIds).size, outfitIds.length);
  assert(outfitIds.includes("outfit_client_104"));
  console.log("second-round cursor pagination tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
