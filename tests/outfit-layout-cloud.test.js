const assert = require("assert");
const Module = require("module");
const path = require("path");
const { createFakeCloud } = require("./helpers/fake-cloud");

const openid = "openid_layout_cloud";
const image = (slot) => `cloud://env.bucket/wardrobe/${openid}/${slot}.jpg`;

const clothing = ["top", "bottom", "shoes"].map((category) => ({
  _id: `cloud_${category}`,
  clientRecordId: `item_${category}`,
  openid,
  category,
  type: category,
  name: `单品${category}`,
  imageFileId: image(category),
  primaryColor: "pink",
  isDeleted: false,
  mutationVersion: 1
}));

const fake = createFakeCloud({ clothing_items: clothing, outfit_records: [] }, openid, {
  autoRegisterCloudFiles: false
});
["top", "bottom", "shoes"].forEach((slot) => fake.registerCloudFile(image(slot)));

function load(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  delete require.cache[filename];
  const originalLoad = Module._load;
  Module._load = function loadModule(request, parent, isMain) {
    if (request === "wx-server-sdk") return fake.cloud;
    if (request === "@cloudbase/node-sdk") return fake.cloudbase;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(filename);
  } finally {
    Module._load = originalLoad;
  }
}

const saveOutfit = load("cloudfunctions/saveOutfit/index.js");
const updateOutfit = load("cloudfunctions/updateSavedOutfit/index.js");
const getOutfits = load("cloudfunctions/getOutfitRecords/index.js");

const DEFAULT_TOP = { x: 180, y: 122, scale: 1, zIndex: 7 };
const DEFAULT_BOTTOM = { x: 188, y: 216, scale: 0.78, zIndex: 5 };
const DEFAULT_SHOES = { x: 186, y: 276, scale: 1, zIndex: 6 };
const DEFAULT_HAT = { x: 176, y: 38, scale: 1.15, zIndex: 8 };

function slotRef(itemId) {
  return { itemId };
}

function baseEvent(clientRecordId, overrides = {}) {
  return {
    clientRecordId,
    mutationVersion: 1,
    date: "2026-09-01",
    title: "布局搭配",
    season: "summer",
    style: "casual",
    items: {
      top: slotRef("item_top"),
      bottom: slotRef("item_bottom"),
      shoes: slotRef("item_shoes")
    },
    ...overrides
  };
}

function fullLayout(overrides = {}) {
  return {
    version: 1,
    canvas: { width: 360, height: 300 },
    slots: {
      top: { x: 250, y: 130, scale: 1.7, zIndex: 7 },
      bottom: { x: 200, y: 240, scale: 0.9, zIndex: 5 },
      shoes: { x: 190, y: 280, scale: 1.2, zIndex: 6 },
      hat: null,
      bag: null
    },
    ...overrides
  };
}

(async () => {
  // ---- 1. create 持久化 layout：与槽位对齐、数值 JSON-safe、固定五槽 ----
  const createEvent = baseEvent("outfit_layout_A", { layout: fullLayout() });
  const created = await saveOutfit.main(createEvent);
  assert.strictEqual(created.ok, true);
  const storedA = fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_A");
  assert.strictEqual(storedA.layout.version, 1);
  assert.deepStrictEqual(storedA.layout.slots.top, { x: 250, y: 130, scale: 1.7, zIndex: 7 });
  assert.deepStrictEqual(storedA.layout.slots.bottom, { x: 200, y: 240, scale: 0.9, zIndex: 5 });
  assert.deepStrictEqual(storedA.layout.slots.shoes, { x: 190, y: 280, scale: 1.2, zIndex: 6 });
  assert.strictEqual(storedA.layout.slots.hat, null, "无单品槽位不得写入 entry");
  assert.strictEqual(storedA.layout.slots.bag, null);
  assert.strictEqual(storedA.layout.canvas.width, 360);
  assert.strictEqual(storedA.items.top.itemId, "item_top", "items 不受 layout 影响");

  // ---- 2. 幂等 retry：IDEMPOTENT，layout 不被改写 ----
  const retry = await saveOutfit.main(createEvent);
  assert.strictEqual(retry.data.mutationStatus, "IDEMPOTENT");
  assert.strictEqual(fake.collections.outfit_records.filter((row) => row.clientRecordId === "outfit_layout_A").length, 1);
  assert.deepStrictEqual(fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_A").layout.slots.top, { x: 250, y: 130, scale: 1.7, zIndex: 7 });

  // ---- 3. 同版本不同 layout → VERSION_REUSE_CONFLICT，记录不变 ----
  const conflict = await saveOutfit.main(baseEvent("outfit_layout_A", { title: "冲突", layout: fullLayout({ slots: { top: { x: 5, y: 5, scale: 1, zIndex: 1 } } }) }));
  assert.strictEqual(conflict.errorCode, "VERSION_REUSE_CONFLICT");

  // ---- 4. 服务端 sanitize：注入病态数值/字段被收口 ----
  const poison = baseEvent("outfit_layout_poison", {
    layout: {
      version: 1,
      canvas: { width: "360", height: Infinity },
      slots: {
        top: { x: "bad", y: 1e9, scale: 999, zIndex: 1e9, width: 777, selected: true },
        bottom: null,
        shoes: { x: 10.333333, y: 20.666666, scale: 1.4142135, zIndex: 1 },
        hat: { itemId: "ghost", snapshot: {} },
        bag: "junk"
      }
    }
  });
  const poisonResult = await saveOutfit.main(poison);
  assert.strictEqual(poisonResult.ok, true);
  const storedPoison = fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_poison");
  const pSlots = storedPoison.layout.slots;
  assert.strictEqual(pSlots.top.scale, 3, "scale 越界被限幅");
  assert.strictEqual(pSlots.top.zIndex, 9999, "zIndex 越界被限幅");
  assert.strictEqual(pSlots.top.width, undefined, "白名单外字段不持久化");
  assert.deepStrictEqual(pSlots.bottom, DEFAULT_BOTTOM, "缺失 entry 的有单品槽回退默认");
  assert.deepStrictEqual(pSlots.shoes, { x: 10.33, y: 20.67, scale: 1.41, zIndex: 1 }, "浮点噪声 round2");
  assert.strictEqual(pSlots.hat, null, "无单品槽的伪造 entry 被清 null");
  assert.strictEqual(pSlots.bag, null);
  assert.strictEqual(storedPoison.layout.canvas.width, 360, "非法画布回退默认基准");
  assert.strictEqual(storedPoison.layout.canvas.height, 300);
  assert(!JSON.stringify(storedPoison.layout).includes("width:777"), "serialize 后无多余字段");
  const json = JSON.parse(JSON.stringify(storedPoison.layout));
  assert(Number.isFinite(json.canvas.width) && Number.isFinite(json.canvas.height), "JSON 往返保持有限数值");

  // ---- 5. getOutfitRecords 返回 layout ----
  const readA = await getOutfits.main({ pageSize: 99 });
  const remoteA = readA.data.items.find((item) => item.id === "outfit_layout_A");
  assert(remoteA, "新记录可读回");
  assert.deepStrictEqual(remoteA.layout.slots.top, { x: 250, y: 130, scale: 1.7, zIndex: 7 }, "layout 随记录读回");
  assert.strictEqual(remoteA.layout.version, 1);

  // ---- 6. legacy（无 layout 字段）读回 layout:null 且服务端不写回（不自动 backfill）----
  fake.collections.outfit_records.push({
    _id: "legacy_no_layout",
    clientRecordId: "legacy_no_layout",
    openid,
    date: "2026-08-01",
    title: "旧搭配",
    season: "summer",
    style: "casual",
    items: { top: { itemId: "item_top" }, bottom: { itemId: "item_bottom" }, shoes: { itemId: "item_shoes" } },
    isDeleted: false
  });
  const readLegacy = await getOutfits.main({ pageSize: 99 });
  const remoteLegacy = readLegacy.data.items.find((item) => item.id === "legacy_no_layout");
  assert.strictEqual(remoteLegacy.layout, null, "legacy 记录 layout 读回 null");
  const rawLegacy = fake.collections.outfit_records.find((row) => row.clientRecordId === "legacy_no_layout");
  assert(!Object.prototype.hasOwnProperty.call(rawLegacy, "layout"), "getOutfitRecords 只读，不得给 legacy 回填 layout");

  // ---- 7. update 显式携带 layout（编辑保存）：更新布局 ----
  const updateV2 = await updateOutfit.main({
    ...createEvent,
    id: created.data.id,
    mutationVersion: 2,
    title: "v2 布局",
    items: {
      top: slotRef("item_top"),
      bottom: slotRef("item_bottom"),
      shoes: slotRef("item_shoes")
    },
    layout: fullLayout({
      slots: {
        top: { x: 300, y: 80, scale: 1.2, zIndex: 7 },
        bottom: { x: 200, y: 240, scale: 0.9, zIndex: 5 },
        shoes: { x: 190, y: 280, scale: 1.2, zIndex: 6 },
        hat: null,
        bag: null
      }
    })
  });
  assert.strictEqual(updateV2.ok, true);
  const storedV2 = fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_A");
  assert.deepStrictEqual(storedV2.layout.slots.top, { x: 300, y: 80, scale: 1.2, zIndex: 7 });
  assert.strictEqual(storedV2.items.top.snapshot.category, "top", "服务端以真实单品重建分类");

  // ---- 8. 槽位删除不残留 layout：update 移除 hat/bag 槽 → slots.hat/bag = null ----
  // 需要真实的 hat/bag clothing_items 供可选槽位使用
  ["hat", "bag"].forEach((slot) => {
    fake.collections.clothing_items.push({
      _id: `cloud_${slot}`,
      clientRecordId: `item_${slot}`,
      openid,
      category: slot,
      type: slot,
      name: `单品${slot}`,
      imageFileId: image(slot),
      isDeleted: false,
      mutationVersion: 1
    });
    fake.registerCloudFile(image(slot));
  });
  const withOptionalEvent = {
    clientRecordId: "outfit_layout_optional",
    mutationVersion: 1,
    date: "2026-09-01",
    title: "带帽包",
    season: "summer",
    style: "casual",
    items: {
      top: slotRef("item_top"),
      bottom: slotRef("item_bottom"),
      shoes: slotRef("item_shoes"),
      hat: slotRef("item_hat"),
      bag: slotRef("item_bag")
    },
    layout: fullLayout({
      slots: {
        top: { x: 100, y: 100, scale: 1, zIndex: 7 },
        bottom: { x: 150, y: 200, scale: 0.8, zIndex: 5 },
        shoes: { x: 160, y: 270, scale: 1, zIndex: 6 },
        hat: { x: 176, y: 38, scale: 1.15, zIndex: 8 },
        bag: { x: 286, y: 150, scale: 1, zIndex: 10 }
      }
    })
  };
  const createdOptional = await saveOutfit.main(withOptionalEvent);
  assert.strictEqual(createdOptional.ok, true);
  assert.deepStrictEqual(fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_optional").layout.slots.hat, DEFAULT_HAT, "hat 占用槽位写入");

  const dropHatBag = await updateOutfit.main({
    ...withOptionalEvent,
    id: createdOptional.data.id,
    mutationVersion: 2,
    title: "去掉帽包",
    items: {
      top: slotRef("item_top"),
      bottom: slotRef("item_bottom"),
      shoes: slotRef("item_shoes")
    },
    layout: fullLayout({
      slots: {
        top: { x: 100, y: 100, scale: 1, zIndex: 7 },
        bottom: { x: 150, y: 200, scale: 0.8, zIndex: 5 },
        shoes: { x: 160, y: 270, scale: 1, zIndex: 6 },
        hat: null,
        bag: null
      }
    })
  });
  assert.strictEqual(dropHatBag.ok, true);
  const storedOptional = fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_optional");
  assert.strictEqual(storedOptional.items.hat, null);
  assert.strictEqual(storedOptional.layout.slots.hat, null, "删除槽位后 layout 必须清 null，不残留");
  assert.strictEqual(storedOptional.layout.slots.bag, null);
  assert.strictEqual(storedOptional.layout.slots.top.x, 100, "仍在的槽位布局保留");

  // ---- 9. 旧客户端 update 不带 layout 字段：沿用 current layout 对齐，不丢 ----
  const legacyUpdate = await updateOutfit.main({
    id: created.data.id,
    clientRecordId: "outfit_layout_A",
    mutationVersion: 3,
    title: "旧客户端更新",
    season: "summer",
    style: "casual",
    items: { top: slotRef("item_top"), bottom: slotRef("item_bottom"), shoes: slotRef("item_shoes") }
  });
  assert.strictEqual(legacyUpdate.ok, true);
  const storedKeep = fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_A");
  assert.deepStrictEqual(storedKeep.layout.slots.top, { x: 300, y: 80, scale: 1.2, zIndex: 7 }, "旧客户端更新必须沿用已保存 layout");
  assert.strictEqual(storedKeep.title, "旧客户端更新");

  // ---- 10. 旧客户端 update legacy 记录（无 layout、payload 也无 layout）：自然补默认 entry（保存即写入），仍不报错 ----
  const legacyUp = await updateOutfit.main({
    id: "legacy_no_layout",
    clientRecordId: "legacy_no_layout",
    mutationVersion: 1,
    title: "旧搭配更新",
    season: "summer",
    style: "casual",
    items: { top: slotRef("item_top"), bottom: slotRef("item_bottom"), shoes: slotRef("item_shoes") }
  });
  assert.strictEqual(legacyUp.ok, true);
  const storedLegacyUp = fake.collections.outfit_records.find((row) => row.clientRecordId === "legacy_no_layout");
  assert.strictEqual(storedLegacyUp.layout.version, 1, "legacy 记录一旦被更新保存，会写入带默认 entry 的 layout");
  assert.deepStrictEqual(storedLegacyUp.layout.slots.top, DEFAULT_TOP);

  // ---- 11. stale 保护：旧 mutationVersion 的更新不得覆盖新 layout ----
  const stale = await updateOutfit.main({
    id: created.data.id,
    clientRecordId: "outfit_layout_A",
    mutationVersion: 2,
    title: "迟到覆盖",
    season: "summer",
    style: "casual",
    items: { top: slotRef("item_top"), bottom: slotRef("item_bottom"), shoes: slotRef("item_shoes") },
    layout: fullLayout({ slots: { top: { x: 1, y: 1, scale: 1, zIndex: 1 } } })
  });
  assert.strictEqual(stale.data.mutationStatus, "STALE");
  assert.strictEqual(fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_A").title, "旧客户端更新", "stale 不得覆盖业务字段");
  assert.deepStrictEqual(fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_A").layout.slots.top, { x: 300, y: 80, scale: 1.2, zIndex: 7 }, "stale 不得覆盖 layout");

  // ---- 12. 并发同 mutation：单条记录，layout 一致（不重复创建）----
  const concurrent = { ...createEvent, clientRecordId: "outfit_layout_concurrent" };
  const results = await Promise.all([saveOutfit.main(concurrent), saveOutfit.main(concurrent)]);
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[1].ok, true);
  assert.strictEqual(results[0].data.id, results[1].data.id);
  assert.strictEqual(fake.collections.outfit_records.filter((row) => row.clientRecordId === "outfit_layout_concurrent").length, 1);
  assert.deepStrictEqual(fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_concurrent").layout.slots.top, { x: 250, y: 130, scale: 1.7, zIndex: 7 });

  // ---- 13. 服务端写侧严格 version：字符串 "1" 按未知版本整体判无效 → 仅保留有单品槽的默认 entry ----
  const stringVersionEvent = baseEvent("outfit_layout_version_string", {
    layout: {
      version: "1",
      canvas: { width: 360, height: 300 },
      slots: {
        top: { x: 1, y: 1, scale: 0.3, zIndex: 1 },
        bottom: { x: 9, y: 9, scale: 1, zIndex: 1 },
        shoes: { x: 5, y: 5, scale: 1, zIndex: 1 }
      }
    }
  });
  const stringVersionResult = await saveOutfit.main(stringVersionEvent);
  assert.strictEqual(stringVersionResult.ok, true);
  const storedStringVersion = fake.collections.outfit_records.find((row) => row.clientRecordId === "outfit_layout_version_string");
  assert.strictEqual(storedStringVersion.layout.version, 1, "存储 version 恒为数值 1");
  assert.deepStrictEqual(storedStringVersion.layout.canvas, { width: 360, height: 300 }, "非法（字符串 version）画布整体回退默认基准");
  assert.deepStrictEqual(storedStringVersion.layout.slots.top, DEFAULT_TOP, "字符串 version 的 entry 不得透传，有单品槽回退默认布局");
  assert.deepStrictEqual(storedStringVersion.layout.slots.bottom, DEFAULT_BOTTOM);

  console.log("outfit layout cloud create/update/read/legacy/stale persistence tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
