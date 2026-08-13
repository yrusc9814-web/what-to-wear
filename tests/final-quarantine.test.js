const assert = require("assert");

const storage = new Map();
const app = { globalData: {} };
let failQuarantineWrites = false;

global.getApp = () => app;
global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) {
    if (failQuarantineWrites && String(key).includes("legacy_quarantine")) {
      throw new Error("QUOTA_EXCEEDED");
    }
    storage.set(key, JSON.parse(JSON.stringify(value)));
  },
  removeStorageSync(key) { storage.delete(key); }
};

const service = require("../miniprogram/services/app-service");

function entries() {
  const raw = storage.get(service.STORAGE.legacyQuarantine);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.entries)) return raw.entries;
  if (raw && raw.entries && typeof raw.entries === "object") {
    return Object.entries(raw.entries).map(([key, value]) => ({ key, value }));
  }
  return [];
}

function putLegacy(value) {
  storage.set(service.STORAGE.wardrobe, value);
}

(async () => {
  const firstLegacy = [{ id: "legacy-top", category: "top", name: "旧数据" }];
  putLegacy(firstLegacy);
  assert.strictEqual(service.resolveUserScope("quarantine_A"), "quarantine_A");
  assert.strictEqual(entries().filter((entry) => (entry.key || entry.sourceKey) === service.STORAGE.wardrobe).length, 1);

  for (let index = 0; index < 8; index += 1) {
    putLegacy([{ id: "legacy-top", category: "top", name: `旧数据-${index}` }]);
    service.markIdentityUnconfirmed(new Error("identity refresh"));
    service.resolveUserScope(`quarantine_${index + 1}`);
  }
  const wardrobeEntries = entries().filter((entry) => (entry.key || entry.sourceKey) === service.STORAGE.wardrobe);
  assert.strictEqual(wardrobeEntries.length, 1,
    "相同 legacy source 只能保留一个隔离槽位，不得每次身份解析 append 整份业务数据");
  assert(entries().length <= 9, "quarantine 必须是有限隔离区，不得无界增长");

  putLegacy([{ id: "must-not-migrate", category: "top", name: "容量失败旧数据" }]);
  service.markIdentityUnconfirmed(new Error("identity unavailable"));
  failQuarantineWrites = true;
  let resolved;
  try {
    resolved = service.resolveUserScope("quarantine_after_quota_failure");
  } finally {
    failQuarantineWrites = false;
  }
  assert.strictEqual(resolved, "quarantine_after_quota_failure",
    "quarantine 写入失败不得阻断身份解析");
  assert.strictEqual(app.globalData.userScope, "quarantine_after_quota_failure");
  assert.strictEqual(
    storage.has(`${service.STORAGE.wardrobe}:quarantine_after_quota_failure`),
    false,
    "quarantine 写入失败时不得把不可信 legacy 数据迁移给当前用户"
  );

  console.log("final bounded, deduplicated and failure-safe quarantine tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
