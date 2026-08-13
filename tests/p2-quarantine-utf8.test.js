const assert = require("assert");
const path = require("path");

const SERVICE_PATH = path.resolve(__dirname, "../miniprogram/services/app-service.js");
const CAPACITY = 200 * 1024;
const FIXED_NOW = 2000000000000;
const WARDROBE_KEY = "xiaoyichu_v14_wardrobe";
const QUARANTINE_KEY = "xiaoyichu_v14_legacy_quarantine";

function serializedEntry(character, count) {
  const value = { payload: character.repeat(count) };
  return [{
    key: WARDROBE_KEY,
    source: WARDROBE_KEY,
    hash: JSON.stringify(value),
    value,
    quarantinedAt: FIXED_NOW
  }];
}

function utf8Size(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundaryCount(character) {
  let low = 0;
  let high = CAPACITY;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Size(serializedEntry(character, middle)) <= CAPACITY) low = middle;
    else high = middle - 1;
  }
  return low;
}

function quarantine(character, count) {
  const storage = new Map([[WARDROBE_KEY, { payload: character.repeat(count) }]]);
  const app = { globalData: {} };
  global.getApp = () => app;
  global.wx = {
    getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
    setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
    removeStorageSync(key) { storage.delete(key); }
  };
  delete require.cache[SERVICE_PATH];
  const service = require(SERVICE_PATH);
  service.resolveUserScope("p2_utf8_user");
  return storage.get(QUARANTINE_KEY) || [];
}

const originalNow = Date.now;
Date.now = () => FIXED_NOW;
try {
  const failures = [];
  for (const [label, character] of [["ASCII", "a"], ["中文", "衣"], ["emoji", "👗"]]) {
    try {
      const atLimit = boundaryCount(character);
      const retained = quarantine(character, atLimit);
      assert.strictEqual(retained.length, 1, `${label} 的真实 UTF-8 容量内数据应保留`);
      assert(utf8Size(retained) <= CAPACITY, `${label} quarantine 不得超过 200 KiB`);

      const overLimit = quarantine(character, atLimit + 1);
      assert.strictEqual(overLimit.length, 0, `${label} 超过真实 UTF-8 容量后必须逐出`);
      assert(utf8Size(overLimit) <= CAPACITY, `${label} 逐出后仍须满足容量上限`);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }
  assert.deepStrictEqual(failures, [], failures.join("\n"));
  console.log("p2 quarantine UTF-8 byte-boundary tests passed");
} finally {
  Date.now = originalNow;
  delete require.cache[SERVICE_PATH];
}
