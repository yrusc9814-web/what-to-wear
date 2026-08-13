const assert = require("assert");

const storage = new Map();
const app = { globalData: { userScope: "openid_order", identityState: "confirmed" } };
const calls = [];
let currentWxOpenId = "openid_order";
let firstItemId = "";
let initialFailure = true;

global.getApp = () => app;
global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); },
  cloud: {
    callFunction({ name, data }) {
      calls.push({ name, data: JSON.parse(JSON.stringify(data || {})), wxContextOpenId: currentWxOpenId });
      if (name === "saveClothing" && initialFailure) {
        initialFailure = false;
        firstItemId = data.clientRecordId;
        return Promise.reject(new Error("first mutation failed"));
      }
      if (name === "saveClothing" && data.clientRecordId === firstItemId) {
        return Promise.reject(new Error("retry of first mutation must stop this round"));
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

(async () => {
  const originalNow = Date.now;
  let clock = 9000;
  Date.now = () => clock++;
  try {
    const first = await service.createWardrobeItem({
      name: "先入队的上衣",
      category: "top",
      seasons: ["summer"],
      styles: ["casual"],
      imageUrl: "cloud://env.bucket/wardrobe/openid_order/first.jpg",
      imageFileId: "cloud://env.bucket/wardrobe/openid_order/first.jpg"
    });
    firstItemId = first.id;
    assert.strictEqual(first.syncStatus, "failed");

    clock = 100;
    const second = await service.createWardrobeItem({
      name: "后入队的下装",
      category: "bottom",
      seasons: ["summer"],
      styles: ["casual"],
      imageUrl: "cloud://env.bucket/wardrobe/openid_order/second.jpg",
      imageFileId: "cloud://env.bucket/wardrobe/openid_order/second.jpg"
    });
    assert(second && second.id);

    const pending = outboxFor("openid_order");
    assert.strictEqual(pending.length, 2,
      "首个失败后，后续任务不能在本轮被跳过或删除");
    assert.deepStrictEqual(
      pending.map((task) => task.queueSequence),
      [1, 2],
      "同一用户 outbox 的 queueSequence 必须严格递增"
    );
    const retryCalls = calls.slice(1).filter((call) => call.name === "saveClothing");
    assert.deepStrictEqual(
      retryCalls.map((call) => call.data.clientRecordId),
      [firstItemId],
      "worker 首个真正失败后必须停止本轮，不得继续调用第二个 mutation"
    );
    assert(retryCalls.every((call) => call.data.clientRecordId
      && Number.isInteger(call.data.mutationVersion)
      && call.data.mutationVersion >= 1),
    "每个正式 mutation 请求必须携带 clientRecordId 和 mutationVersion");
    assert.strictEqual(pending[0].status, "failed");
    assert.strictEqual(pending[1].status, "pending");

    console.log("final outbox queue ordering and fail-stop tests passed");
  } finally {
    Date.now = originalNow;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
