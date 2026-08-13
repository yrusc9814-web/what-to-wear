const assert = require("assert");

const storage = new Map();
const app = { globalData: { userScope: "openid_A", identityState: "confirmed" } };
const calls = [];
let currentWxOpenId = "openid_A";
let releaseA;
let aRequestStarted = false;
let bFailureCount = 0;

global.getApp = () => app;
global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); },
  cloud: {
    callFunction({ name, data }) {
      const wxContextOpenId = currentWxOpenId;
      const call = { name, data: JSON.parse(JSON.stringify(data || {})), wxContextOpenId };
      calls.push(call);
      if (name === "saveClothing" && wxContextOpenId === "openid_A" && !aRequestStarted) {
        aRequestStarted = true;
        return new Promise((resolve) => { releaseA = resolve; });
      }
      if (name === "saveClothing" && wxContextOpenId === "openid_B" && bFailureCount < 2) {
        bFailureCount += 1;
        return Promise.reject(new Error("B 首个 mutation 失败"));
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
  return [];
}

function waitUntil(predicate) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = () => {
      if (predicate()) return resolve();
      attempts += 1;
      if (attempts > 100) return reject(new Error("timed out waiting for outbox state"));
      setTimeout(tick, 0);
    };
    tick();
  });
}

function item(category, scope) {
  const cloudScope = scope.startsWith("openid_") ? scope : `openid_${scope}`;
  return {
    name: `${scope}-${category}`,
    category,
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: `cloud://env.bucket/wardrobe/${cloudScope}/${category}.jpg`,
    imageFileId: `cloud://env.bucket/wardrobe/${cloudScope}/${category}.jpg`
  };
}

(async () => {
  const createA = service.createWardrobeItem(item("top", "A"));
  await waitUntil(() => calls.length === 1);
  const aItem = storage.get(`${service.STORAGE.wardrobe}:openid_A`)[0];
  assert(aItem && aItem.id);
  const updateA = service.updateWardrobeItem(aItem.id, { name: "A 更新后的上衣" });
  await waitUntil(() => outboxFor("openid_A").length === 2);

  const aPending = outboxFor("openid_A");
  assert.deepStrictEqual(aPending.map((task) => task.queueSequence), [1, 2],
    "同一用户 outbox 必须严格按 queueSequence 入队");

  currentWxOpenId = "openid_B";
  service.resolveUserScope("openid_B");
  releaseA({ result: { ok: true, data: { id: `cloud_${aItem.id}`, _id: `cloud_${aItem.id}` } } });
  await Promise.all([createA, updateA]);

  const aCalls = calls.filter((call) => call.wxContextOpenId === "openid_A");
  assert.strictEqual(aCalls.length, 1,
    "身份切换后旧 worker 不得再发起旧用户的后续调用");
  assert(aCalls.every((call) => call.data.userScope === "openid_A"));
  assert(aCalls.every((call) => Number.isInteger(call.data.mutationVersion) && call.data.mutationVersion >= 1));
  assert(aCalls.every((call) => call.data.clientRecordId));
  assert.strictEqual(outboxFor("openid_A").length, 1,
    "旧用户未处理的任务必须留在旧 outbox");
  assert.strictEqual(outboxFor("openid_A")[0].queueSequence, 2);
  assert.strictEqual(outboxFor("openid_B").length, 0);

  const firstB = await service.createWardrobeItem(item("top", "B"));
  assert.strictEqual(firstB.syncStatus, "failed");
  const secondB = await service.createWardrobeItem(item("bottom", "B"));
  assert(secondB && secondB.id);

  const bPending = outboxFor("openid_B");
  assert.deepStrictEqual(bPending.map((task) => task.queueSequence), [1, 2],
    "B outbox 也必须使用严格递增的 queueSequence");
  assert.strictEqual(bPending[0].status, "failed");
  assert.strictEqual(bPending[1].status, "pending");
  const bCalls = calls.filter((call) => call.wxContextOpenId === "openid_B" && call.name === "saveClothing");
  assert.deepStrictEqual(bCalls.map((call) => call.data.clientRecordId), [firstB.id, firstB.id],
    "首个 mutation 失败后本轮必须 fail-stop，不得调用第二个 mutation");
  assert(bCalls.every((call) => call.data.userScope === "openid_B"));
  assert(bCalls.every((call) => Number.isInteger(call.data.mutationVersion) && call.data.mutationVersion >= 1));

  console.log("second-round outbox queueSequence, fail-stop and WXContext tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
