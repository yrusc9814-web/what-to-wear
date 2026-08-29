const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

const openid = "openid_reference_pagination";
function rows(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    _id: `${prefix}_${String(index).padStart(3, "0")}`,
    clientRecordId: `${prefix}_client_${index}`,
    openid,
    name: `${prefix}-${index}`,
    imageFileId: `cloud://env.bucket/wardrobe/${openid}/${prefix}-${index}.jpg`,
    seasons: ["summer"],
    styles: ["casual"],
    occasion: "通勤",
    note: "",
    source: index % 5 === 0 ? "self" : "web",
    isDeleted: index % 11 === 0,
    updatedAt: 1000 - index
  }));
}

const fake = createFakeCloud({
  outfit_references: rows("ref", 250)
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

const getReferences = load("cloudfunctions/getOutfitReferences/index.js");

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
  const references = await collectPages((event) => getReferences.main(event));
  assert.strictEqual(new Set(references.map((item) => item.id)).size, references.length, "分页不得重复");
  assert(references.length > 200, "应遍历所有未删除 raw 记录");
  assert(references.every((item) => item.id.startsWith("ref_client_")));
  assert(references.every((item) => ["self", "web", "other"].includes(item.source)));

  const authRequired = await getReferences.main({});
  fake.setCurrentOpenId("");
  assert.strictEqual(authRequired.ok, true, "当前用户必须可见分页数据");
  fake.setCurrentOpenId("openid_other_user");
  const otherUser = await getReferences.main({ pageSize: 99 });
  assert.strictEqual(otherUser.data.items.length, 0, "openid 隔离：其他用户看不到本用户的参考");
  fake.setCurrentOpenId(openid);

  fake.collections.outfit_references.splice(0, fake.collections.outfit_references.length,
    ...Array.from({ length: 100 }, (_, index) => ({
      _id: `full_${String(index).padStart(3, "0")}`,
      clientRecordId: `full_client_${index}`,
      openid,
      name: `满页-${index}`,
      imageFileId: `cloud://env.bucket/wardrobe/${openid}/full-${index}.jpg`,
      seasons: ["winter"],
      styles: ["cool"],
      source: "other"
    })));
  const fullFirst = await getReferences.main({ pageSize: 99 });
  assert.strictEqual(fullFirst.data.items.length, 99);
  assert.strictEqual(fullFirst.data.hasMore, true, "恰好跨过 99 条时必须准确报告还有 raw 记录");
  const fullSecond = await getReferences.main({ pageSize: 99, cursor: fullFirst.data.nextCursor });
  assert.strictEqual(fullSecond.data.items.length, 1);
  assert.strictEqual(fullSecond.data.hasMore, false);

  fake.collections.outfit_references.splice(0, fake.collections.outfit_references.length,
    {
      _id: "raw_deleted_001", clientRecordId: "raw_deleted_001", openid,
      name: "已删除 raw", isDeleted: true,
      imageFileId: `cloud://env.bucket/wardrobe/${openid}/raw-deleted.jpg`
    },
    {
      _id: "raw_live_002", clientRecordId: "raw_live_002", openid,
      name: "删除之后的有效记录",
      imageFileId: `cloud://env.bucket/wardrobe/${openid}/raw-live.jpg`
    }
  );
  const rawPage = await getReferences.main({ pageSize: 1 });
  assert.deepStrictEqual(rawPage.data.items.map((item) => item.id), [],
    "已删除 raw 记录可以被过滤，但必须仍然推进 raw cursor");
  assert.strictEqual(rawPage.data.hasMore, true);
  const rawSecondPage = await getReferences.main({ pageSize: 1, cursor: rawPage.data.nextCursor });
  assert.deepStrictEqual(rawSecondPage.data.items.map((item) => item.id), ["raw_live_002"]);
  assert.strictEqual(rawSecondPage.data.hasMore, false);

  console.log("final outfit reference cursor pagination and openid isolation tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
