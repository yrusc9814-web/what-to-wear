const assert = require("assert");
const path = require("path");

const SERVICE_PATH = path.resolve(__dirname, "../miniprogram/services/app-service.js");
const scope = "p2_sequence_user";
const outboxKey = `xiaoyichu_v14_sync_outbox:${scope}`;
const storage = new Map([[
  outboxKey,
  { nextQueueSequence: Number.MAX_SAFE_INTEGER, tasks: [] }
]]);
const app = { globalData: { userScope: scope, identityState: "confirmed" } };

global.getApp = () => app;
global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); }
};

delete require.cache[SERVICE_PATH];
const service = require(SERVICE_PATH);

(async () => {
  for (const name of ["安全序列 A", "安全序列 B", "安全序列 C"]) {
    await service.createWardrobeItem({
      name,
      category: "top",
      seasons: ["summer"],
      styles: ["casual"],
      imageUrl: `wxfile://${name}`
    });
  }

  const state = storage.get(outboxKey);
  const sequences = state.tasks.map((task) => task.queueSequence);
  assert(sequences.every(Number.isSafeInteger), `queueSequence 必须始终是安全整数，实际为 ${JSON.stringify(sequences)}`);
  assert(Number.isSafeInteger(state.nextQueueSequence), `nextQueueSequence 必须始终是安全整数，实际为 ${state.nextQueueSequence}`);
  assert.strictEqual(new Set(sequences).size, sequences.length, `queueSequence 不得因精度丢失而重复，实际为 ${JSON.stringify(sequences)}`);
  for (let index = 1; index < sequences.length; index += 1) {
    assert(sequences[index] > sequences[index - 1], "queueSequence 必须严格递增");
  }
  assert.deepStrictEqual(
    state.tasks.slice().sort((left, right) => left.queueSequence - right.queueSequence).map((task) => task.taskId),
    state.tasks.map((task) => task.taskId),
    "按 queueSequence 排序不得改变真实入队顺序"
  );

  // Non-empty recovery: existing queued work must be renumbered safely in its
  // true array/enqueue order, and the new task must remain strictly at the tail.
  const existingIds = state.tasks.map((task) => task.taskId);
  const nearLimitTasks = state.tasks.map((task, index) => ({
    ...task,
    queueSequence: Number.MAX_SAFE_INTEGER - state.tasks.length + index,
    sequence: Number.MAX_SAFE_INTEGER - state.tasks.length + index,
    version: Number.MAX_SAFE_INTEGER - state.tasks.length + index
  }));
  storage.set(outboxKey, {
    nextQueueSequence: Number.MAX_SAFE_INTEGER,
    tasks: nearLimitTasks
  });
  await service.createWardrobeItem({
    name: "非空队列安全重编号",
    category: "top",
    seasons: ["summer"],
    styles: ["casual"],
    imageUrl: "wxfile://non-empty-resequence"
  });
  const recovered = storage.get(outboxKey);
  assert.deepStrictEqual(
    recovered.tasks.slice(0, -1).map((task) => task.taskId),
    existingIds,
    "非空 outbox 重编号不得改变既有任务的真实数组/入队顺序"
  );
  assert.deepStrictEqual(
    recovered.tasks.map((task) => task.queueSequence),
    [1, 2, 3, 4],
    "非空 outbox 必须安全重编号，并把新任务严格追加到尾部"
  );
  assert(recovered.tasks.every((task) => Number.isSafeInteger(task.queueSequence)), "重编号后的所有 sequence 必须安全");
  assert(Number.isSafeInteger(recovered.nextQueueSequence), "重编号后的 nextQueueSequence 必须安全");
  assert.strictEqual(recovered.nextQueueSequence, 5);
  console.log("p2 queueSequence safe-integer tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  delete require.cache[SERVICE_PATH];
});
