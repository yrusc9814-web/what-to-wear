const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MINI_ROOT = path.join(ROOT, "miniprogram");
const appJson = JSON.parse(fs.readFileSync(path.join(MINI_ROOT, "app.json"), "utf8"));
const entries = [
  path.join(MINI_ROOT, "app.js"),
  ...appJson.pages.map((page) => path.join(MINI_ROOT, `${page}.js`))
];
const reachable = new Set();

function resolveLocalModule(fromFile, request) {
  if (!request.startsWith(".")) return null;
  const target = path.resolve(path.dirname(fromFile), request);
  for (const candidate of [target, `${target}.js`, path.join(target, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function visit(file) {
  if (reachable.has(file)) return;
  reachable.add(file);
  const source = fs.readFileSync(file, "utf8");
  const requirePattern = /require\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = requirePattern.exec(source))) {
    const dependency = resolveLocalModule(file, match[1]);
    if (dependency) visit(dependency);
  }
}

entries.forEach((entry) => {
  assert(fs.existsSync(entry), `正式 app.json 页面缺少脚本：${path.relative(ROOT, entry)}`);
  visit(entry);
});

const relativeReachable = [...reachable].map((file) => path.relative(ROOT, file).replace(/\\/g, "/"));
const forbiddenModules = [
  "miniprogram/constants/recommendation.js",
  "miniprogram/services/recommendation-engine.js",
  "miniprogram/services/wardrobe-service.js",
  "miniprogram/services/outfit-service.js",
  "miniprogram/utils/outfit-store.js",
  "miniprogram/pages/recommendation/recommendation.js",
  "miniprogram/pages/index/index.js"
];
forbiddenModules.forEach((file) => {
  assert(!relativeReachable.includes(file), `正式 active flow 不得加载 legacy 模块：${file}`);
});

const activeSource = [...reachable].map((file) => fs.readFileSync(file, "utf8")).join("\n");
assert(!/local_fallback/.test(activeSource), "正式 active flow 不得加载 local fake AI fallback");
assert(!/constants\/recommendation|recommendation-engine|generateRecommendations/.test(activeSource), "正式 active flow 不得加载旧 recommendation 枚举/引擎");

const constants = require("../miniprogram/utils/constants");
assert.deepStrictEqual(constants.CATEGORIES.map((entry) => entry.value), ["hat", "top", "bottom", "shoes", "bag"]);
assert(!constants.CATEGORIES.some((entry) => entry.value === "accessory"), "正式分类不得暴露 accessory");
console.log("p2 active-flow legacy-unreachable tests passed");
