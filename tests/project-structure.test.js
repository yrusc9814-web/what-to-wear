const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appJson = JSON.parse(fs.readFileSync(path.join(root, "miniprogram/app.json"), "utf8"));

assert.strictEqual(appJson.tabBar.list.length, 3, "V1 只能有三个 Tab");
assert.deepStrictEqual(appJson.tabBar.list.map((item) => item.text), ["首页", "衣橱", "穿搭"]);
assert.deepStrictEqual(appJson.pages.slice(0, 3), [
  "pages/home/index",
  "pages/wardrobe/wardrobe",
  "pages/outfit/index"
]);
appJson.pages.slice(0, 3).forEach((pagePath) => {
  const pageJson = JSON.parse(fs.readFileSync(path.join(root, "miniprogram", `${pagePath}.json`), "utf8"));
  assert.strictEqual(pageJson.navigationStyle, "custom", `主 Tab 不应显示重复原生标题：${pagePath}`);
});

appJson.pages.forEach((pagePath) => {
  ["js", "json", "wxml", "wxss"].forEach((extension) => {
    assert(fs.existsSync(path.join(root, "miniprogram", `${pagePath}.${extension}`)), `页面缺少文件：${pagePath}.${extension}`);
  });
});

const sourceFiles = [];
function walk(directory) {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (/\.(js|wxml)$/.test(entry.name)) sourceFiles.push(target);
  });
}
walk(path.join(root, "miniprogram"));
sourceFiles.forEach((filename) => {
  const source = fs.readFileSync(filename, "utf8");
  assert(!/\bdocument\b|\bwindow\b|localStorage/.test(source), `发现 Web API：${filename}`);
});

const activePages = appJson.pages.map((pagePath) => path.join(root, "miniprogram", pagePath));
activePages.forEach((pageRoot) => {
  const pageJs = fs.readFileSync(`${pageRoot}.js`, "utf8");
  const wxml = fs.readFileSync(`${pageRoot}.wxml`, "utf8");
  const handlers = [...wxml.matchAll(/(?:bind|catch)(?:tap|input|change|confirm|scrolltolower)="([A-Za-z_$][\w$]*)"/g)]
    .map((match) => match[1]);
  handlers.forEach((handler) => {
    assert(new RegExp(`\\b${handler}\\s*\\(`).test(pageJs), `事件函数不存在：${pageRoot} -> ${handler}`);
  });
});

const wardrobeWxss = fs.readFileSync(path.join(root, "miniprogram/pages/wardrobe/wardrobe.wxss"), "utf8");
assert(/grid-template-columns:\s*repeat\(2,/.test(wardrobeWxss), "衣橱默认网格必须为两列");

const homeWxml = fs.readFileSync(path.join(root, "miniprogram/pages/home/index.wxml"), "utf8");
const homeSectionOrder = ["hero-card", "weather-card", "最近保存穿搭", "smart-card"].map((marker) => homeWxml.indexOf(marker));
assert(homeSectionOrder.every((index) => index >= 0), "首页四个业务模块必须完整");
assert(homeSectionOrder.every((index, position) => position === 0 || index > homeSectionOrder[position - 1]), "首页四个业务模块顺序不正确");

const homeJs = fs.readFileSync(path.join(root, "miniprogram/pages/home/index.js"), "utf8");
assert(homeJs.includes("/pages/profile/index"), "首页头像必须进入个人中心独立页");
assert(homeJs.includes("/pages/outfit-history/index?source=home"), "首页快速开始必须进入历史搭配选择");

const outfitWxml = fs.readFileSync(path.join(root, "miniprogram/pages/outfit/index.wxml"), "utf8");
["layer-hat", "layer-top", "layer-bottom", "layer-shoes", "layer-bag"].forEach((layer) => {
  assert(outfitWxml.includes(layer), `穿搭叠穿预览缺少槽位：${layer}`);
});
assert(outfitWxml.includes("更新原搭配") && outfitWxml.includes("另存为新搭配") && outfitWxml.includes(">取消</button>"), "编辑保存必须同时提供更新、另存和取消");

const detailJs = fs.readFileSync(path.join(root, "miniprogram/pages/outfit-detail/index.js"), "utf8");
assert(detailJs.includes("setTodayOutfit"), "穿搭详情必须提供设为今日穿搭入口");
["outfit-match", "outfit-history", "saved-outfits"].forEach((page) => {
  const pageJs = fs.readFileSync(path.join(root, `miniprogram/pages/${page}/index.js`), "utf8");
  assert(!pageJs.includes("setTodayOutfit"), `${page} 列表不得直接设置今日穿搭`);
});

console.log("project structure tests passed");
