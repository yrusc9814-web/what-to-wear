const assert = require("assert");

const servicePath = require.resolve("../miniprogram/services/app-service");

function waitUntil(predicate) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = () => {
      if (predicate()) return resolve();
      attempts += 1;
      if (attempts > 200) return reject(new Error("timed out waiting for identity worker"));
      setTimeout(tick, 0);
    };
    tick();
  });
}

function itemPayload(name, openid) {
  const image = `cloud://env.bucket/wardrobe/${openid}/${name}.jpg`;
  return {
    name,
    category: "top",
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: image,
    imageFileId: image
  };
}

function outboxFor(storage, service, scope) {
  const raw = storage.get(`${service.STORAGE.syncOutbox}:${scope}`);
  return raw && Array.isArray(raw.tasks) ? raw.tasks : Array.isArray(raw) ? raw : [];
}

function loadCase({ firstCall }) {
  const storage = new Map();
  const calls = [];
  const app = { globalData: { userScope: "openid_A", identityState: "confirmed" } };
  let currentWxOpenId = "openid_A";
  let firstSaveResolve;
  let firstSavePending = false;

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
        if (name === "saveClothing") {
          if (!firstSavePending) {
            firstSavePending = true;
            return new Promise((resolve) => { firstSaveResolve = resolve; });
          }
          if (firstCall.retryResult) return Promise.resolve(firstCall.retryResult(data));
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

  delete require.cache[servicePath];
  const service = require(servicePath);
  return {
    storage,
    calls,
    app,
    service,
    setWxOpenId(value) { currentWxOpenId = value; },
    releaseFirstSave(data) {
      assert(firstSaveResolve, "first save must be pending before release");
      firstSaveResolve({ result: { ok: true, data } });
    }
  };
}

async function startAThenSwitchBack(caseState, clock) {
  const { service, calls, app } = caseState;
  const firstCreate = service.createWardrobeItem(itemPayload("first", "openid_A"));
  await waitUntil(() => calls.some((call) => call.name === "saveClothing"));
  const firstCall = calls.find((call) => call.name === "saveClothing");
  const oldWorker = service.reconcilePendingSync();
  const firstItem = caseState.storage.get(`${service.STORAGE.wardrobe}:openid_A`)[0];

  const updatePromise = service.updateWardrobeItem(firstItem.id, { name: "second" });
  await waitUntil(() => outboxFor(caseState.storage, service, "openid_A").length === 2);

  caseState.setWxOpenId("openid_B");
  service.resolveUserScope("openid_B");
  caseState.setWxOpenId("openid_A");
  service.resolveUserScope("openid_A");
  if (clock) Date.now = () => clock.value;

  const newWorker = service.reconcilePendingSync();
  assert.notStrictEqual(newWorker, oldWorker, "A/session2 必须建立独立 worker Promise");
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { firstCreate, updatePromise, oldWorker, newWorker, firstCall, app };
}

async function case1() {
  const originalNow = Date.now;
  const clock = { value: 2000 };
  Date.now = () => clock.value;
  const state = loadCase({ firstCall: {} });
  try {
    const started = await startAThenSwitchBack(state, clock);
    const mutationCallsBeforeRelease = state.calls.filter((call) => call.name !== "getUserIdentity");
    assert.deepStrictEqual(mutationCallsBeforeRelease.map((call) => call.data.queueSequence), [1], "seq2 不得越过旧 session 的队头");

    state.releaseFirstSave({ id: `cloud_${started.firstCall.data.clientRecordId}`, _id: `cloud_${started.firstCall.data.clientRecordId}` });
    await Promise.all([started.firstCreate, started.updatePromise, started.oldWorker, started.newWorker]);

    const mutationCalls = state.calls.filter((call) => call.name !== "getUserIdentity");
    assert.deepStrictEqual(mutationCalls.map((call) => call.data.queueSequence), [1, 2]);
    assert.strictEqual(outboxFor(state.storage, state.service, "openid_A").length, 0, "seq1 完成后 session2 必须继续清空 outbox");
    assert(mutationCalls[1].data.identitySessionId !== mutationCalls[0].data.identitySessionId, "重试/后续调用必须使用当前 identity session");
    console.log("identity worker CASE 1 passed");
  } finally {
    Date.now = originalNow;
  }
}

async function case2And3() {
  const originalNow = Date.now;
  const clock = { value: 10000 };
  Date.now = () => clock.value;
  const firstCall = {};
  const state = loadCase({ firstCall });
  try {
    const started = await startAThenSwitchBack(state, clock);
    const seq1 = started.firstCall.data.clientRecordId;
    const beforeLease = state.calls.filter((call) => call.name !== "getUserIdentity");
    assert.deepStrictEqual(beforeLease.map((call) => call.data.clientRecordId), [seq1], "lease 未过期不得重复 seq1 或调用 seq2");

    clock.value += state.service.SYNC_LEASE_MS + 1;
    firstCall.retryResult = (data) => ({
      result: { ok: true, data: { id: `cloud_${data.clientRecordId}`, _id: `cloud_${data.clientRecordId}` } }
    });
    await waitUntil(() => state.calls.filter((call) => call.name === "saveClothing").length === 2);
    await started.newWorker;

    const afterRetry = state.calls.filter((call) => call.name !== "getUserIdentity");
    assert.deepStrictEqual(afterRetry.map((call) => call.data.queueSequence), [1, 1, 2], "lease 过期后必须重试 seq1，再执行 seq2");
    assert.strictEqual(outboxFor(state.storage, state.service, "openid_A").length, 0);

    const currentItem = state.storage.get(`${state.service.STORAGE.wardrobe}:openid_A`)[0];
    assert.strictEqual(currentItem.name, "second", "新 mutation 的本地状态必须保留");
    assert.strictEqual(currentItem.mutationVersion, 2);
    assert.strictEqual(currentItem.syncStatus, "synced");

    state.releaseFirstSave({ id: `cloud_${seq1}`, _id: `cloud_${seq1}` });
    await started.oldWorker;
    const afterStale = state.storage.get(`${state.service.STORAGE.wardrobe}:openid_A`)[0];
    assert.strictEqual(afterStale.name, "second", "旧响应不能覆盖较新的本地状态");
    assert.strictEqual(afterStale.mutationVersion, 2);
    assert.strictEqual(afterStale.syncStatus, "synced", "旧响应不能改写较新的 syncStatus");
    assert.strictEqual(outboxFor(state.storage, state.service, "openid_A").length, 0, "旧响应不能删除 seq2 以外的任务");
    console.log("identity worker CASE 2 and CASE 3 passed");
  } finally {
    Date.now = originalNow;
  }
}

(async () => {
  await case1();
  await case2And3();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
