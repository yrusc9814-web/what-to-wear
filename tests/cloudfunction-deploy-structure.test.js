const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const cloudfunctionsRoot = path.join(root, "cloudfunctions");
const canonicalShared = path.join(cloudfunctionsRoot, "shared");
const mutationFunctions = [
  "saveClothing",
  "updateClothing",
  "deleteClothing",
  "saveOutfit",
  "updateSavedOutfit",
  "deleteOutfitRecord"
];

function filesUnder(directory) {
  const files = [];
  function walk(current, relative = "") {
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const target = path.join(current, entry.name);
      const nextRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(target, nextRelative);
      else files.push(nextRelative);
    });
  }
  walk(directory);
  return files.sort();
}

function digest(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function loadIsolatedFunction(functionDirectory) {
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: "DYNAMIC_CURRENT_ENV",
    init() {},
    getWXContext() { return { OPENID: "test-openid" }; },
    database() { return {}; }
  };
  const fakeCloudbase = {
    SYMBOL_CURRENT_ENV: "SYMBOL_CURRENT_ENV",
    SYMBOL_DEFAULT_ENV: "SYMBOL_DEFAULT_ENV",
    init() { return { database() { return {}; } }; }
  };
  const entry = path.join(functionDirectory, "index.js");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return fakeCloud;
    if (request === "@cloudbase/node-sdk") return fakeCloudbase;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(entry)];
    return require(entry);
  } finally {
    Module._load = originalLoad;
  }
}

assert(fs.existsSync(canonicalShared), "canonical cloudfunctions/shared 必须存在");
const canonicalFiles = filesUnder(canonicalShared);
assert(canonicalFiles.length > 0, "canonical shared 不得为空");

for (const functionName of mutationFunctions) {
  const functionDirectory = path.join(cloudfunctionsRoot, functionName);
  const generatedShared = path.join(functionDirectory, "shared");
  assert(fs.existsSync(generatedShared), `${functionName} 必须包含 generated shared/`);
  assert.deepStrictEqual(filesUnder(generatedShared), canonicalFiles, `${functionName}/shared 文件集合必须与 canonical 一致`);
  canonicalFiles.forEach((relative) => {
    assert.strictEqual(
      digest(path.join(generatedShared, relative)),
      digest(path.join(canonicalShared, relative)),
      `${functionName}/shared/${relative} 必须与 canonical shared 内容一致`
    );
  });

  const source = fs.readFileSync(path.join(functionDirectory, "index.js"), "utf8");
  assert(!/require\(["']\.\.\/shared(?:\/|["'])/.test(source), `${functionName} 不得生产引用 ../shared`);

  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoyichu-cloudfunction-"));
  try {
    const isolatedFunction = path.join(isolatedRoot, functionName);
    fs.cpSync(functionDirectory, isolatedFunction, { recursive: true });
    assert.doesNotThrow(
      () => loadIsolatedFunction(isolatedFunction),
      `${functionName} 只携带自身目录部署时必须能解析内部 shared 模块`
    );
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

console.log("cloud function isolated deployment structure tests passed");
