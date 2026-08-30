const assert = require("assert");
const Module = require("module");
const path = require("path");

const OPENID = "user_123";
const OTHER_OPENID = "other_user";
const ENTRY = path.resolve(__dirname, "../cloudfunctions/deleteWardrobeTemp/index.js");

const TMP_ID = `cloud://env.bucket/wardrobe/${OPENID}/tmp/100_abc.jpg`;
const TMP_ID_2 = `cloud://env.bucket/wardrobe/${OPENID}/tmp/100_def.png`;
const OTHER_TMP_ID = `cloud://env.bucket/wardrobe/${OTHER_OPENID}/tmp/100_abc.jpg`;
const FORMAL_ID = `cloud://env.bucket/wardrobe/${OPENID}/formal.jpg`;
const REFERENCE_ID = `cloud://env.bucket/wardrobe/${OPENID}/references/ref.jpg`;

// ============ 云函数加载 harness（Module._load 劫持 wx-server-sdk） ============

function createFakes(options = {}) {
  const state = { deleteCalls: [], probeCalls: [] };
  const wxServerSdk = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    getWXContext() { return { OPENID: options.openid === undefined ? OPENID : options.openid }; },
    deleteFile({ fileList }) {
      const ids = (fileList || []).map(String);
      state.deleteCalls.push(ids);
      if (options.deleteImpl) return options.deleteImpl(ids);
      return Promise.resolve({ fileList: ids.map((fileID) => ({ fileID, status: 0 })) });
    },
    getTempFileURL({ fileList }) {
      const ids = (fileList || []).map(String);
      state.probeCalls.push(ids);
      if (options.probeImpl) return Promise.resolve(options.probeImpl(ids));
      return Promise.resolve({ fileList: ids.map((fileID) => ({ fileID, tempFileURL: `https://tmp.example.test/${fileID}` })) });
    }
  };
  return { state, options, wxServerSdk };
}

function loadModule(fakes) {
  delete require.cache[ENTRY];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return fakes.wxServerSdk;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(ENTRY);
  } finally {
    Module._load = originalLoad;
  }
}

async function run() {
  // ---- 0. 纯函数：classifyTempFileId 白名单矩阵 ----
  {
    const mod = loadModule(createFakes({}));
    const classify = mod._test.classifyTempFileId;
    assert.strictEqual(classify(TMP_ID, OPENID), "ok", "本人 tmp 文件必须放行");
    assert.strictEqual(classify(TMP_ID_2, OPENID), "ok");

    assert.strictEqual(classify(OTHER_TMP_ID, OPENID), "forbidden", "他人 tmp 文件必须拒绝");
    assert.strictEqual(classify(`cloud://env.bucket/wardrobe/${OTHER_OPENID}/references/ref.jpg`, OPENID), "forbidden", "他人 references 必须拒绝");
    assert.strictEqual(classify(FORMAL_ID, OPENID), "forbidden", "本人正式路径（无 /tmp/ 段）必须拒绝");
    assert.strictEqual(classify(REFERENCE_ID, OPENID), "forbidden", "本人 references 路径必须拒绝");
    assert.strictEqual(classify(`cloud://env.bucket/wardrobe/${OPENID}/tmp`, OPENID), "forbidden", "tmp 目录本身不是文件");
    assert.strictEqual(classify(`cloud://env.bucket/wardrobe/${OPENID}/tmp/a/b.png`, OPENID), "forbidden", "tmp 下嵌套路径必须拒绝");

    assert.strictEqual(classify("https://evil.example/wardrobe/user_123/tmp/1.jpg", OPENID), "invalid", "非 cloud:// 协议必须拒绝");
    assert.strictEqual(classify("cloud://env.bucket/collection/doc", OPENID), "invalid", "非 wardrobe 资产必须拒绝");
    assert.strictEqual(classify("cloud://env.bucket", OPENID), "invalid");
    assert.strictEqual(classify("", OPENID), "invalid");
    assert.strictEqual(classify("   ", OPENID), "invalid");
    assert.strictEqual(classify(12345, OPENID), "invalid");
    assert.strictEqual(classify(null, OPENID), "invalid");
    assert.strictEqual(classify(`cloud://env.bucket/wardrobe/${OPENID}/tmp/../formal.jpg`, OPENID), "invalid", "路径穿越必须拒绝");
    assert.strictEqual(classify(`cloud://env.bucket/wardrobe//tmp/x.jpg`, OPENID), "invalid", "空 openid 段必须拒绝");
    assert.strictEqual(classify(`cloud://env.bucket/wardrobe/${OPENID}/tmp/x.jpg`.padEnd(600, "a"), OPENID), "invalid", "超长 fileId 必须拒绝");

    assert.strictEqual(mod._test.maskFileId(`cloud://env.bucket/wardrobe/${OPENID}/tmp/1.jpg`), "cloud://env.bucket/wardrobe/***/tmp/1.jpg", "日志脱敏必须隐藏 openid 段");
    assert.deepStrictEqual(mod._test.parseRequestedIds({ tempFileId: TMP_ID }), { ids: [TMP_ID] }, "tempFileId 支持单个字符串");
    assert.deepStrictEqual(mod._test.parseRequestedIds({ tempFileId: [TMP_ID, TMP_ID_2] }), { ids: [TMP_ID, TMP_ID_2] }, "tempFileId 支持数组");
    assert.deepStrictEqual(mod._test.parseRequestedIds({ tempFileIds: [TMP_ID] }), { ids: [TMP_ID] }, "tempFileIds 别名可用");
    assert.deepStrictEqual(mod._test.parseRequestedIds({ tempFileId: [TMP_ID, TMP_ID, "  ", TMP_ID_2] }), { ids: [TMP_ID, TMP_ID_2] }, "入参必须去重并跳过空串");
    assert.strictEqual(mod._test.parseRequestedIds({ tempFileId: new Array(11).fill(TMP_ID) }).error, "TEMP_DELETE_INVALID", "批量上限 10");
    assert.strictEqual(mod._test.parseRequestedIds({ tempFileId: [] }).error, "TEMP_DELETE_INVALID", "空批量必须拒绝");
    assert.strictEqual(mod._test.parseRequestedIds({}).error, "TEMP_DELETE_INVALID", "缺参必须拒绝");
    assert.strictEqual(mod._test.parseRequestedIds({ tempFileId: 42 }).error, "TEMP_DELETE_INVALID");
  }

  // ---- 1. 缺少身份被拒 ----
  {
    const fakes = createFakes({ openid: "" });
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TMP_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "AUTH_REQUIRED");
    assert.strictEqual(fakes.state.deleteCalls.length, 0);
  }

  // ---- 2. 本人 tmp 删除成功（含信封明细） ----
  {
    const fakes = createFakes({});
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TMP_ID });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.deepStrictEqual(result.data.details, [{ fileId: TMP_ID, status: "deleted" }]);
    assert.deepStrictEqual(fakes.state.deleteCalls, [[TMP_ID]], "必须且只能删除白名单文件");

    const batch = await mod.main({ tempFileId: [TMP_ID, TMP_ID_2] });
    assert.strictEqual(batch.ok, true);
    assert.deepStrictEqual(batch.data.details, [
      { fileId: TMP_ID, status: "deleted" },
      { fileId: TMP_ID_2, status: "deleted" }
    ]);
  }

  // ---- 3. 非本人 tmp 文件删除被拒 ----
  {
    const fakes = createFakes({});
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: OTHER_TMP_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "TEMP_DELETE_FORBIDDEN");
    assert.strictEqual(result.details[0].status, "forbidden");
    assert.strictEqual(fakes.state.deleteCalls.length, 0, "被拒文件绝不能触发删除调用");
  }

  // ---- 4. 本人正式路径删除被拒 ----
  {
    const fakes = createFakes({});
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: FORMAL_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "TEMP_DELETE_FORBIDDEN");
    assert.strictEqual(fakes.state.deleteCalls.length, 0, "正式资产绝不能被删除");
  }

  // ---- 5. references 路径删除被拒 ----
  {
    const fakes = createFakes({});
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: REFERENCE_ID });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "TEMP_DELETE_FORBIDDEN");
    assert.strictEqual(fakes.state.deleteCalls.length, 0);
  }

  // ---- 6. 结构非法入参整体拒绝 ----
  {
    const fakes = createFakes({});
    const mod = loadModule(fakes);
    const garbage = await mod.main({ tempFileId: "not-a-cloud-id" });
    assert.strictEqual(garbage.ok, false);
    assert.strictEqual(garbage.errorCode, "TEMP_DELETE_INVALID");
    assert.strictEqual(garbage.details === undefined, false, "拒绝时也必须返回明细");
    const missing = await mod.main({});
    assert.strictEqual(missing.errorCode, "TEMP_DELETE_INVALID");
    const oversized = await mod.main({ tempFileId: new Array(11).fill(TMP_ID) });
    assert.strictEqual(oversized.errorCode, "TEMP_DELETE_INVALID");
    assert.strictEqual(fakes.state.deleteCalls.length, 0);
  }

  // ---- 7. 删除不存在文件幂等可接受（deleteFile 抛错 + 探测确认不存在 → notFound，整体成功） ----
  {
    const fakes = createFakes({
      deleteImpl: () => Promise.reject(Object.assign(new Error("storage error"), { errMsg: "FILE_NOT_EXIST" })),
      probeImpl: (ids) => ({ fileList: ids.map((fileID) => ({ fileID, status: -1 })) })
    });
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TMP_ID });
    assert.strictEqual(result.ok, true, "删除不存在文件必须按幂等成功处理");
    assert.deepStrictEqual(result.data.details, [{ fileId: TMP_ID, status: "notFound" }]);
  }

  // ---- 8. 服务端删除失败 → per-file failed，整体 ok:true + 明细 ----
  {
    const fakes = createFakes({
      deleteImpl: () => Promise.reject(new Error("internal storage error")),
      probeImpl: (ids) => ({ fileList: ids.map((fileID) => ({ fileID, tempFileURL: "https://tmp.example.test/live" })) })
    });
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: TMP_ID });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.data.details, [{ fileId: TMP_ID, status: "failed" }], "失败必须逐文件回报而非整体崩溃");
  }

  // ---- 9. 混合批次：只处理合法部分，拒绝项逐文件回报 ----
  {
    const fakes = createFakes({});
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: [TMP_ID, OTHER_TMP_ID, FORMAL_ID] });
    assert.strictEqual(result.ok, true, "混合批次不得整体拒绝");
    assert.deepStrictEqual(result.data.details, [
      { fileId: TMP_ID, status: "deleted" },
      { fileId: OTHER_TMP_ID, status: "forbidden" },
      { fileId: FORMAL_ID, status: "forbidden" }
    ]);
    assert.deepStrictEqual(fakes.state.deleteCalls, [[TMP_ID]], "只允许删除白名单命中的文件");
  }

  // ---- 10. 全部参数非法才整体拒绝 ----
  {
    const fakes = createFakes({});
    const mod = loadModule(fakes);
    const result = await mod.main({ tempFileId: [OTHER_TMP_ID, FORMAL_ID] });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "TEMP_DELETE_FORBIDDEN");
    assert.strictEqual(result.details.length, 2);
    assert.strictEqual(fakes.state.deleteCalls.length, 0);

    const invalidBatch = await mod.main({ tempFileId: ["garbage", 42] });
    assert.strictEqual(invalidBatch.ok, false);
    assert.strictEqual(invalidBatch.errorCode, "TEMP_DELETE_INVALID");
  }

  // ---- 11. 信封契约：ok/errorCode/errorMessage 结构 ----
  {
    const fakes = createFakes({});
    const mod = loadModule(fakes);
    const forbidden = await mod.main({ tempFileId: OTHER_TMP_ID });
    assert.strictEqual(typeof forbidden.errorMessage, "string", "errorMessage 必须是字符串");
    assert(forbidden.errorMessage.length > 0);
    assert.deepStrictEqual(Object.keys(forbidden).sort(), ["details", "errorCode", "errorMessage", "ok"], "失败信封字段固定");
    const ok = await mod.main({ tempFileId: TMP_ID });
    assert.deepStrictEqual(Object.keys(ok).sort(), ["data", "ok"], "成功信封字段固定");
    assert.deepStrictEqual(Object.keys(ok.data).sort(), ["details"], "成功 data 只包含逐文件明细");
  }

  console.log("delete wardrobe temp cloud function tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
