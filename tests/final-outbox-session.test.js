const assert = require("assert");

const storage = new Map();
const app = { globalData: { userScope: "openid_A", identityState: "confirmed" } };
const calls = [];
let currentWxOpenId = "openid_A";
let releaseFirstSave;

global.getApp = () => app;
global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); },
  cloud: {
    callFunction({ name, data }) {
      const call = {
        name,
        data: JSON.parse(JSON.stringify(data || {})),
        wxContextOpenId: currentWxOpenId
      };
      calls.push(call);
      if (name === "getUserIdentity") {
        return Promise.resolve({ result: { ok: true, data: { userId: currentWxOpenId } } });
      }
      if (name === "saveClothing" && !releaseFirstSave) {
        return new Promise((resolve) => { releaseFirstSave = resolve; });
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

function outboxFor(scope) {
  const raw = storage.get(`${service.STORAGE.syncOutbox}:${scope}`);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.tasks)) return raw.tasks;
  if (raw && Array.isArray(raw.entries)) return raw.entries;
  return [];
}

(async () => {
  const originalNow = Date.now;
  let clock = 2000;
  Date.now = () => clock++;
  try {
    const createPromise = service.createWardrobeItem({
      name: "A 的上衣",
      category: "top",
      seasons: ["summer"],
      styles: ["casual"],
      imageUrl: "cloud://env.bucket/wardrobe/openid_A/top.jpg",
      imageFileId: "cloud://env.bucket/wardrobe/openid_A/top.jpg"
    });
    await waitUntil(() => calls.some((call) => call.name === "saveClothing"));

    const aItem = storage.get(`${service.STORAGE.wardrobe}:openid_A`)[0];
    assert(aItem && aItem.id, "A 的本地 mutation 应先入 outbox 再发云请求");

    clock = 100;
    const updatePromise = service.updateWardrobeItem(aItem.id, { name: "A 的更新上衣" });
    await waitUntil(() => outboxFor("openid_A").length >= 2);
    const pendingBeforeSwitch = outboxFor("openid_A");
    assert.deepStrictEqual(
      pendingBeforeSwitch.map((task) => task.queueSequence),
      [1, 2],
      "queueSequence 必须独立于 createdAt 单调递增"
    );
    currentWxOpenId = "openid_B";
    service.resolveUserScope("openid_B");
    releaseFirstSave({
      result: {
        ok: true,
        data: { id: `cloud_${aItem.id}`, _id: `cloud_${aItem.id}` }
      }
    });
    await Promise.all([createPromise, updatePromise]);

    const postSwitchCalls = calls.filter((call) => call.name !== "getUserIdentity");
    assert.strictEqual(postSwitchCalls.length, 1,
      "A 请求返回后切换身份，旧 worker 不得再发起 A 的后续调用");
    assert.strictEqual(postSwitchCalls[0].wxContextOpenId, "openid_A",
      "fake runtime 必须记录调用发起瞬间的 WXContext.OPENID");
    assert.strictEqual(postSwitchCalls[0].data.userScope, "openid_A",
      "A 已发出的请求只能携带 A 的业务作用域");
    assert(postSwitchCalls.every((call) => call.data.clientRecordId
      && Number.isInteger(call.data.mutationVersion)
      && call.data.mutationVersion >= 1),
    "每个正式 mutation 请求必须携带 clientRecordId 和 mutationVersion");

    const aRemaining = outboxFor("openid_A");
    assert.strictEqual(aRemaining.length, 1, "A 的剩余任务必须保留在 A outbox");
    assert.strictEqual(aRemaining[0].queueSequence, 2);
    assert.strictEqual(outboxFor("openid_B").length, 0,
      "切换用户不得把 A 的任务搬入 B outbox");

    await service.createWardrobeItem({
      name: "B 的上衣",
      category: "top",
      seasons: ["summer"],
      styles: ["casual"],
      imageUrl: "cloud://env.bucket/wardrobe/openid_B/top.jpg",
      imageFileId: "cloud://env.bucket/wardrobe/openid_B/top.jpg"
    });
    assert.strictEqual(outboxFor("openid_B").length, 0,
      "B worker 只能处理 B 自己的 outbox");
    assert.strictEqual(outboxFor("openid_A").length, 1,
      "B reconcile 不得消费 A 的剩余任务");
    assert(calls.filter((call) => call.wxContextOpenId === "openid_B")
      .every((call) => call.data.userScope === "openid_B"),
    "每次云调用都必须以 fake runtime 当前身份为准，而非 event.userScope");

    console.log("final outbox identity-session and scope tests passed");
  } finally {
    Date.now = originalNow;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
