const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

const openid = "openid_pagination";
function rows(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    _id: `${prefix}_${String(index).padStart(3, "0")}`,
    clientRecordId: `${prefix}_client_${index}`,
    openid,
    category: "top",
    type: "top",
    name: `${prefix}-${index}`,
    imageFileId: `cloud://env.bucket/wardrobe/${openid}/${prefix}-${index}.jpg`,
    seasons: ["summer"],
    styles: ["casual"],
    isDeleted: index % 11 === 0,
    updatedAt: 1000 - index
  }));
}

const fake = createFakeCloud({
  clothing_items: rows("item", 250),
  outfit_records: rows("outfit", 250).map((row) => ({ ...row, title: row.name, items: {} }))
}, openid);

function load(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  delete require.cache[filename];
  const originalLoad = Module._load;
  Module._load = function loadModule(request, parent, isMain) {
    if (request === "wx-server-sdk") return fake.cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(filename);
  } finally {
    Module._load = originalLoad;
  }
}

const getWardrobe = load("cloudfunctions/getWardrobe/index.js");
const getOutfits = load("cloudfunctions/getOutfitRecords/index.js");

async function collectPages(handler) {
  const all = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await handler({ pageSize: 99, ...(cursor ? { cursor } : {}) });
    assert.strictEqual(result.ok, true);
    const data = result.data;
    all.push(...data.items);
    if (!data.hasMore) return all;
    assert(data.nextCursor && data.nextCursor.lastId, "hasMore=true 必须返回稳定 lastId 游标");
    const cursorKey = JSON.stringify(data.nextCursor);
    assert(!seenCursors.has(cursorKey), "服务端 cursor 不得重复");
    seenCursors.add(cursorKey);
    cursor = data.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

(async () => {
  const wardrobe = await collectPages((event) => getWardrobe.main(event));
  const outfits = await collectPages((event) => getOutfits.main(event));
  for (const [name, items, expectedPrefix] of [
    ["wardrobe", wardrobe, "item_client_"],
    ["outfits", outfits, "outfit_client_"]
  ]) {
    assert.strictEqual(new Set(items.map((item) => item.id)).size, items.length, `${name} 分页不得重复`);
    assert(items.length > 200, `${name} 应遍历所有未删除 raw 记录`);
    assert(items.every((item) => item.id.startsWith(expectedPrefix)));
  }

  fake.collections.clothing_items.splice(0, fake.collections.clothing_items.length, ...Array.from({ length: 100 }, (_, index) => ({
    _id: `full_${String(index).padStart(3, "0")}`,
    clientRecordId: `full_client_${index}`,
    openid,
    category: "top",
    type: "top",
    name: `满页-${index}`,
    imageFileId: `cloud://env.bucket/wardrobe/${openid}/full-${index}.jpg`
  })));
  const fullFirst = await getWardrobe.main({ pageSize: 99 });
  assert.strictEqual(fullFirst.data.items.length, 99);
  assert.strictEqual(fullFirst.data.hasMore, true, "恰好跨过 99 条时必须准确报告还有 raw 记录");
  const fullSecond = await getWardrobe.main({ pageSize: 99, cursor: fullFirst.data.nextCursor });
  assert.strictEqual(fullSecond.data.items.length, 1);
  assert.strictEqual(fullSecond.data.hasMore, false);

  fake.collections.clothing_items.splice(0, fake.collections.clothing_items.length,
    {
      _id: "raw_deleted_001", clientRecordId: "raw_deleted_001", openid,
      category: "top", type: "top", name: "已删除 raw", isDeleted: true
    },
    {
      _id: "raw_live_002", clientRecordId: "raw_live_002", openid,
      category: "top", type: "top", name: "删除之后的有效记录",
      imageFileId: `cloud://env.bucket/wardrobe/${openid}/raw-live.jpg`
    }
  );
  const rawPage = await getWardrobe.main({ pageSize: 1 });
  assert.deepStrictEqual(rawPage.data.items.map((item) => item.id), [],
    "已删除 raw 记录可以被过滤，但必须仍然推进 raw cursor");
  assert.strictEqual(rawPage.data.hasMore, true);
  const rawSecondPage = await getWardrobe.main({ pageSize: 1, cursor: rawPage.data.nextCursor });
  assert.deepStrictEqual(rawSecondPage.data.items.map((item) => item.id), ["raw_live_002"]);
  assert.strictEqual(rawSecondPage.data.hasMore, false);

  let calls = 0;
  global.getApp = () => ({ globalData: { userScope: "openid_cursor_guard", identityState: "confirmed" } });
  global.wx = {
    getStorageSync() { return ""; },
    setStorageSync() {},
    removeStorageSync() {},
    cloud: {
      callFunction() {
        calls += 1;
        if (calls > 3) {
          const error = new Error("CURSOR_NOT_ADVANCING");
          error.code = "CURSOR_NOT_ADVANCING";
          return Promise.reject(error);
        }
        return Promise.resolve({ result: {
          ok: true,
          data: {
            items: [{ id: `same-${calls}`, clientRecordId: `same-${calls}`, category: "top", imageFileId: "cloud://same" }],
            hasMore: true,
            nextCursor: { lastId: "same-cursor" }
          }
        } });
      }
    }
  };
  const service = require("../miniprogram/services/app-service");
  await assert.rejects(
    () => service.listWardrobeItems({ includeDeleted: false }),
    (error) => error && error.code === "CURSOR_NOT_ADVANCING",
    "客户端遇到重复 cursor 必须显式停止并返回 CURSOR_NOT_ADVANCING"
  );
  assert(calls <= 2, "cursor 防护应在下一次重复游标出现时停止，不得无限请求");

  console.log("final raw-cursor, full-page, deleted-record and cursor-guard tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
