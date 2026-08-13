const assert = require("assert");

const storage = new Map();
const app = { globalData: { userScope: "openid_reread", identityState: "confirmed" } };
const calls = [];
let releaseCreate;

global.getApp = () => app;
global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); },
  cloud: {
    callFunction({ name, data }) {
      calls.push({ name, data: JSON.parse(JSON.stringify(data || {})) });
      if (name === "saveClothing" && !releaseCreate) {
        return new Promise((resolve) => { releaseCreate = resolve; });
      }
      return Promise.resolve({
        result: {
          ok: true,
          data: { id: `cloud_${data.clientRecordId}`, _id: `cloud_${data.clientRecordId}` }
        }
      });
    }
  }
};

const service = require("../miniprogram/services/app-service");

function outboxFor(scope) {
  const raw = storage.get(`${service.STORAGE.syncOutbox}:${scope}`);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.tasks)) return raw.tasks;
  if (raw && Array.isArray(raw.entries)) return raw.entries;
  return [];
}

function waitUntil(predicate) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = () => {
      if (predicate()) return resolve();
      attempts += 1;
      if (attempts > 100) return reject(new Error("timed out waiting for outbox"));
      setTimeout(tick, 0);
    };
    tick();
  });
}

(async () => {
  const createPromise = service.createWardrobeItem({
    name: "运行中新增的上衣",
    category: "top",
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: "cloud://env.bucket/wardrobe/openid_reread/item.jpg",
    imageFileId: "cloud://env.bucket/wardrobe/openid_reread/item.jpg"
  });
  await waitUntil(() => calls.length === 1);
  const item = storage.get(`${service.STORAGE.wardrobe}:openid_reread`)[0];
  const updatePromise = service.updateWardrobeItem(item.id, { name: "运行中更新的上衣" });
  await waitUntil(() => outboxFor("openid_reread").length === 2);
  releaseCreate({ result: { ok: true, data: { id: `cloud_${item.id}`, _id: `cloud_${item.id}` } } });
  await Promise.all([createPromise, updatePromise]);

  assert.deepStrictEqual(
    calls.map((call) => [call.name, call.data.clientRecordId]),
    [["saveClothing", item.id], ["updateClothing", item.id]],
    "worker 每完成一项后必须重新读取 outbox，处理运行中新增的任务"
  );
  assert.strictEqual(outboxFor("openid_reread").length, 0);
  console.log("final outbox reread-after-mutation tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
