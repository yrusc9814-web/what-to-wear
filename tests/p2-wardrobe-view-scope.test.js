const assert = require("assert");
const path = require("path");

const SERVICE_PATH = path.resolve(__dirname, "../miniprogram/services/app-service.js");
const storage = new Map();
const app = { globalData: {} };

global.getApp = () => app;
global.wx = {
  getStorageSync(key) { return storage.has(key) ? storage.get(key) : ""; },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
  removeStorageSync(key) { storage.delete(key); }
};

delete require.cache[SERVICE_PATH];
const service = require(SERVICE_PATH);

// Identity is not confirmed: UI may use an in-memory default/preference only.
assert.strictEqual(service.getWardrobeView(), "grid");
assert.strictEqual(storage.has(service.STORAGE.wardrobeView), false, "未确认身份不得写公共持久化偏好");

service.resolveUserScope("p2_view_user_a");
assert.strictEqual(service.getWardrobeView(), "grid", "A 首次确认身份时应使用默认 grid");
service.setWardrobeView("list");
assert.strictEqual(service.getWardrobeView(), "list");

service.resolveUserScope("p2_view_user_b");
assert.strictEqual(service.getWardrobeView(), "grid", "B 不得继承 A 的 list 偏好");
service.setWardrobeView("grid");

service.resolveUserScope("p2_view_user_a");
assert.strictEqual(service.getWardrobeView(), "list", "A 切回后必须恢复自己的 list 偏好");
assert.strictEqual(storage.get(`${service.STORAGE.wardrobeView}:p2_view_user_a`), "list");
assert.strictEqual(storage.get(`${service.STORAGE.wardrobeView}:p2_view_user_b`), "grid");
assert.strictEqual(storage.has(service.STORAGE.wardrobeView), false, "不得存在无用户作用域的 wardrobeView");

console.log("p2 wardrobeView A/B/A scope isolation tests passed");
delete require.cache[SERVICE_PATH];
