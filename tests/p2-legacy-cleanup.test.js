const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const miniRoot = path.join(root, "miniprogram");
const appJson = JSON.parse(fs.readFileSync(path.join(miniRoot, "app.json"), "utf8"));

const deletedLegacyPaths = [
  "constants/recommendation.js",
  "services/recommendation-engine.js",
  "services/wardrobe-service.js",
  "services/outfit-service.js",
  "utils/outfit-store.js",
  "utils/wardrobe-store.js",
  "pages/index/index.js",
  "pages/index/index.json",
  "pages/index/index.wxml",
  "pages/index/index.wxss",
  "pages/recommendation/recommendation.js",
  "pages/recommendation/recommendation.json",
  "pages/recommendation/recommendation.wxml",
  "pages/recommendation/recommendation.wxss"
];

deletedLegacyPaths.forEach((relativePath) => {
  assert.strictEqual(
    fs.existsSync(path.join(miniRoot, relativePath)),
    false,
    `已淘汰的推荐链路不得保留：${relativePath}`
  );
});

assert(!appJson.pages.some((pagePath) => /(^|\/)recommendation(?:\/|$)/.test(pagePath)),
  "app.json 不得注册旧 recommendation 页面");
assert(!appJson.pages.some((pagePath) => pagePath === "pages/index/index"),
  "app.json 不得注册旧首页");

function resolveLocalModule(fromFile, request) {
  if (!request.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [base, `${base}.js`, path.join(base, "index.js")];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function collectActiveModules() {
  const pending = [
    path.join(miniRoot, "app.js"),
    ...appJson.pages.map((pagePath) => path.join(miniRoot, `${pagePath}.js`))
  ];
  const visited = new Set();

  while (pending.length) {
    const filename = pending.pop();
    if (!filename || visited.has(filename)) continue;
    visited.add(filename);
    const source = fs.readFileSync(filename, "utf8");
    for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      const dependency = resolveLocalModule(filename, match[1]);
      if (dependency && dependency.startsWith(miniRoot)) pending.push(dependency);
    }
  }

  return visited;
}

const activeModules = collectActiveModules();
const activeRelativePaths = [...activeModules].map((filename) => path.relative(miniRoot, filename));
const forbiddenActiveModules = [
  "constants/recommendation.js",
  "services/recommendation-engine.js",
  "services/wardrobe-service.js",
  "services/outfit-service.js",
  "utils/outfit-store.js"
];

forbiddenActiveModules.forEach((relativePath) => {
  assert(!activeRelativePaths.includes(relativePath), `active flow 不得加载旧模块：${relativePath}`);
});

const activeSource = [...activeModules]
  .map((filename) => fs.readFileSync(filename, "utf8"))
  .join("\n");
assert(!/source\s*:\s*["']local_fallback["']/.test(activeSource),
  "active flow 不得返回 local_fallback AI 结果");
assert(!/fake\s*(?:ai\s*)?analy[sz]e/i.test(activeSource),
  "active flow 不得包含 local fake analyze");

const constants = require(path.join(miniRoot, "utils/constants.js"));
assert.deepStrictEqual(constants.CATEGORIES.map((item) => item.value), ["hat", "top", "bottom", "shoes", "bag"]);
assert.deepStrictEqual(constants.STYLES.map((item) => item.value), ["casual", "commute", "sweet", "cool"]);
assert(!constants.CATEGORIES.some((item) => item.value === "accessory"),
  "accessory 只能用于旧数据兼容，不能进入正式分类");
assert(!constants.STYLES.some((item) => ["all", "运动", "简约", "复古"].includes(item.value)),
  "筛选值或旧中文风格不得写入正式风格枚举");

console.log("P2 legacy cleanup tests passed");
