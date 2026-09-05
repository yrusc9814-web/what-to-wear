const assert = require("assert");
const layout = require("../miniprogram/services/outfit-layout");

const {
  LAYOUT_VERSION,
  LAYOUT_SLOTS,
  sanitizeLayout,
  sanitizeCanvasDimension,
  sanitizeSlotEntry,
  serializeLayout,
  materializeLayout,
  alignLayoutToItems,
  defaultLayouts,
  DEFAULT_LAYOUT,
  CANVAS,
  setCanvasSize
} = layout;

function jsonSafeWalk(value) {
  if (value === null) return; // null 槽位是 schema 合法叶子
  if (typeof value !== "object") {
    assert.strictEqual(typeof value, "number", `schema 只能含 number/null/object 叶子, 遇到 ${typeof value}`);
    assert(Number.isFinite(value), `schema 数值必须有限: ${value}`);
    return;
  }
  if (Array.isArray(value)) throw new Error("schema 不允许数组");
  Object.values(value).forEach(jsonSafeWalk);
}

function deepFreezeSchema(value) {
  return JSON.parse(JSON.stringify(value));
}

(async () => {
  // ---- 1. 顶层 schema JSON-safe：任何输入输出都可安全 JSON 序列化 ----
  {
    const poisons = [
      { version: 1, canvas: { width: Infinity, height: 360 }, slots: { top: { x: NaN, y: 10, scale: "big", zIndex: 1e9 } } },
      { version: 1, slots: { top: { x: 1e9, y: -1e9, scale: 999, zIndex: "high" } } },
      { version: 1, slots: { top: { x: 10.333333, y: 7.777, scale: 1.4142135, zIndex: 3.9 } } },
      "junk",
      42,
      null,
      undefined,
      [{ x: 1 }]
    ];
    poisons.forEach((value) => {
      const clean = sanitizeLayout(value);
      if (clean === null) return;
      jsonSafeWalk(clean);
    });
    // 显式冒烟：含 Infinity/NaN 的输入序列化后仍是干净 schema（无 null 泄漏、无限值）
    const serialized = JSON.stringify(sanitizeLayout({
      version: 1,
      canvas: { width: 360, height: 300 },
      slots: { top: { x: NaN, y: Infinity, scale: Infinity, zIndex: 1e9 } }
    }));
    assert(!/Infinity|NaN/.test(serialized), "schema 不得包含 Infinity/NaN");
    const parsed = JSON.parse(serialized);
    assert.strictEqual(parsed.slots.top.scale, 1, "非法 scale 回退默认");
    assert.strictEqual(parsed.slots.top.zIndex, 9999, "zIndex 越界限幅");
    jsonSafeWalk(parsed);
  }

  // ---- 2. sanitizeLayout：非法输入回退 null ----
  {
    assert.strictEqual(sanitizeLayout(null), null);
    assert.strictEqual(sanitizeLayout(undefined), null);
    assert.strictEqual(sanitizeLayout("layout"), null);
    assert.strictEqual(sanitizeLayout(7), null);
    assert.strictEqual(sanitizeLayout([]), null);
    assert.strictEqual(sanitizeLayout({ version: 2, slots: {} }), null, "未知 version 必须整体按无效处理");
    assert.strictEqual(sanitizeLayout({ version: "x", slots: {} }), null, "非数值 version 必须整体按无效处理");
  }

  // ---- 2b. Round 2B-1 reviewer fix：version 必须严格为数值 1（字符串 "1" 整体判无效 → runtime fallback）----
  {
    assert.strictEqual(sanitizeLayout({ version: "1", slots: {} }), null, "字符串 \"1\" 必须按未知版本整体判无效");
    assert.strictEqual(sanitizeLayout({ version: 1.0, slots: {} }).version, 1, "数值 1.0 与 1 是同一数值，正常通过");
    assert.strictEqual(sanitizeLayout({ version: "1.0", slots: {} }), null);
    assert.strictEqual(sanitizeLayout({ version: new Number(1), slots: {} }), null, "包装对象 version 必须无效");
    assert.strictEqual(sanitizeLayout({ version: true, slots: {} }), null);
    // 数值 1 正常通过
    const numeric = sanitizeLayout({ version: 1, canvas: { width: 360, height: 300 }, slots: {} });
    assert.strictEqual(numeric.version, 1);
    // 运行时形状（无 version）不受影响
    const runtime = sanitizeLayout({ top: { x: 1, y: 1, scale: 1, zIndex: 1 } });
    assert.strictEqual(runtime.version, 1);
    // 非法 version 的输入即使携带合法 slots 也整体判无效（不吞掉变默认画布 schema）
    const invalid = sanitizeLayout({ version: "1", canvas: { width: 360, height: 300 }, slots: { top: { x: 50, y: 50, scale: 1, zIndex: 1 } } });
    assert.strictEqual(invalid, null, "version=字符串时不得以默认布局 schema 兜底，必须让调用方走 legacy fallback");
  }

  // ---- 5b. Round 2B-1 reviewer fix：极小正数 round 后为 0 → 判非法 ----
  {
    assert.strictEqual(sanitizeCanvasDimension({ width: 0.004, height: 300 }), null, "round2 后为 0 的极小宽必须判非法");
    assert.strictEqual(sanitizeCanvasDimension({ width: 360, height: 0.004 }), null, "round2 后为 0 的极小高必须判非法");
    assert.deepStrictEqual(sanitizeCanvasDimension({ width: 0.006, height: 300 }), { width: 0.01, height: 300 }, "0.006 round 到 0.01 仍为正数，正常通过");
    assert.deepStrictEqual(sanitizeCanvasDimension({ width: 0.01, height: 300 }), { width: 0.01, height: 300 }, "round2 后仍为正数的合法输入正常通过");
    // 经 sanitizeLayout 的整体效果：非法画布回退默认基准
    const fallback = sanitizeLayout({ version: 1, canvas: { width: 0.004, height: 300 }, slots: {} });
    assert.deepStrictEqual(fallback.canvas, { width: 360, height: 300 }, "极小正数画布按非法处理，回退默认基准");
  }

  // ---- 3. 固定五槽白名单：非法/未知槽位不进 schema ----
  {
    const clean = sanitizeLayout({
      version: 1,
      canvas: { width: 360, height: 300 },
      slots: { top: { x: 1, y: 2, scale: 1, zIndex: 7 }, pants: { x: 1, y: 2, scale: 1, zIndex: 1 } }
    });
    assert.deepStrictEqual(Object.keys(clean.slots).sort(), LAYOUT_SLOTS.slice().sort(), "槽位必须固定五槽白名单");
    assert.strictEqual(clean.slots.pants, undefined, "未知槽位不得泄漏");
    assert.strictEqual(clean.version, LAYOUT_VERSION);
  }

  // ---- 4. 数值/字段收口：有限数值 + 白名单字段 + 限幅 ----
  {
    const entry = sanitizeSlotEntry("top", {
      x: 10.333333,
      y: 7.777,
      scale: 1.4142135,
      zIndex: 3.9,
      width: 9999,
      selected: true,
      missing: true
    });
    assert.deepStrictEqual(entry, { x: 10.33, y: 7.78, scale: 1.41, zIndex: 4 }, "只保留 x/y/scale/zIndex 并 round2/取整");
    const clamped = sanitizeSlotEntry("top", { x: 50, y: 60, scale: 9, zIndex: 1e9 });
    assert.strictEqual(clamped.scale, 3, "scale 必须限幅");
    assert.strictEqual(clamped.zIndex, 9999, "zIndex 必须限幅");
    const tooBig = sanitizeSlotEntry("top", { x: 1e9, y: 60, scale: 1, zIndex: 1 });
    assert.strictEqual(tooBig.x, DEFAULT_LAYOUT.top.x, "远超合理坐标必须整槽回退默认");
    assert.strictEqual(tooBig.scale, 1);
    const junk = sanitizeSlotEntry("top", "bad");
    assert.deepStrictEqual(junk, { ...DEFAULT_LAYOUT.top }, "非对象 entry 回退该槽默认值");
  }

  // ---- 5. 画布基准校验 ----
  {
    assert.deepStrictEqual(sanitizeCanvasDimension({ width: 360, height: 300.1234 }), { width: 360, height: 300.12 });
    assert.strictEqual(sanitizeCanvasDimension({ width: 0, height: 300 }), null);
    assert.strictEqual(sanitizeCanvasDimension({ width: -1, height: 300 }), null);
    assert.strictEqual(sanitizeCanvasDimension({ width: 1e9, height: 300 }), null);
    assert.strictEqual(sanitizeCanvasDimension({ width: "360", height: 300 }), null);
    assert.strictEqual(sanitizeCanvasDimension(null), null);
    // 非法画布回退默认基准
    const fallback = sanitizeLayout({ version: 1, canvas: null, slots: { top: { x: 1, y: 1, scale: 1, zIndex: 1 } } });
    assert.deepStrictEqual(fallback.canvas, { width: 360, height: 300 });
  }

  // ---- 6. schema 形状：null/缺失槽位保持 null（无单品），其余收口 ----
  {
    const clean = sanitizeLayout({
      version: 1,
      canvas: { width: 360, height: 300 },
      slots: { top: { x: 100, y: 50, scale: 1.2, zIndex: 7 }, bag: null, hat: undefined }
    });
    assert.strictEqual(clean.slots.bag, null);
    assert.strictEqual(clean.slots.hat, null);
    assert.strictEqual(clean.slots.top.x, 100);
    // 缺失 slots 容器（仅部分槽键）按运行时形状兼容
    const runtimeShape = sanitizeLayout({ top: { x: 99, y: 12, scale: 1, zIndex: 7 } });
    assert.strictEqual(runtimeShape.slots.top.x, 99);
    assert.strictEqual(runtimeShape.slots.bottom, null, "缺失槽位保持 null");
  }

  // ---- 7. serializeLayout：filledSlots 决定哪些槽写入（删除不残留）----
  {
    const layouts = defaultLayouts();
    layouts.top = { x: 250, y: 130, scale: 1.7, zIndex: 7 };
    const schema = serializeLayout(layouts, {
      canvas: { width: 360, height: 300 },
      filledSlots: ["top", "bottom", "shoes"]
    });
    assert.strictEqual(schema.version, LAYOUT_VERSION);
    assert.strictEqual(schema.slots.top.x, 250);
    assert.strictEqual(schema.slots.hat, null, "未占用槽位必须序列化为 null，不残留旧布局");
    assert.strictEqual(schema.slots.bag, null);
    assert.notStrictEqual(schema.slots.bottom, null, "占用槽位必须写入");
    jsonSafeWalk(schema);
  }

  // ---- 8. materializeLayout：legacy/null → 全默认；等比重映射；null 槽回退默认 ----
  {
    const prevCanvas = { ...CANVAS };
    setCanvasSize(360, 300);
    // legacy
    const legacy = materializeLayout(null, { canvas: { width: 360, height: 300 } });
    assert.deepStrictEqual(legacy, defaultLayouts(), "legacy 无 layout 必须回退默认布局");
    const garbage = materializeLayout({ version: 2 }, { canvas: { width: 360, height: 300 } });
    assert.deepStrictEqual(garbage, defaultLayouts(), "未知版本必须回退默认布局");

    // 保存 360×300，在 720×600 上读回 → 等比 2x
    const saved = {
      version: 1,
      canvas: { width: 360, height: 300 },
      slots: {
        top: { x: 180, y: 122, scale: 1, zIndex: 7 },
        hat: { x: 176, y: 38, scale: 1.15, zIndex: 8 },
        bottom: null
      }
    };
    const remapped = materializeLayout(saved, { canvas: { width: 720, height: 600 } });
    assert.strictEqual(remapped.top.x, 360);
    assert.strictEqual(remapped.top.y, 244);
    assert.strictEqual(remapped.top.scale, 2);
    assert.strictEqual(remapped.hat.x, 352);
    assert.strictEqual(remapped.bottom.x, DEFAULT_LAYOUT.bottom.x, "schema null 槽读回时回退默认槽位布局");
    assert.strictEqual(remapped.hat.scale, 2.3);
    setCanvasSize(prevCanvas.width, prevCanvas.height);
  }

  // ---- 9. serialize → materialize 同画布往返一致 ----
  {
    const layouts = defaultLayouts();
    layouts.top = { x: 250, y: 130, scale: 1.7, zIndex: 7 };
    layouts.bag = { x: 300, y: 80, scale: 1, zIndex: 10 };
    const schema = serializeLayout(layouts, { canvas: { width: 360, height: 300 } });
    const restored = materializeLayout(schema, { canvas: { width: 360, height: 300 } });
    assert.strictEqual(restored.top.x, 250);
    assert.strictEqual(restored.top.scale, 1.7);
    assert.strictEqual(restored.bag.x, 300);
  }

  // ---- 10. alignLayoutToItems：与 items 对齐（无单品槽 → null；有单品缺 entry → 默认）----
  {
    const items = {
      top: { itemId: "item_top", snapshot: { name: "上衣", category: "top" } },
      bottom: { itemId: "item_bottom", snapshot: { name: "下装", category: "bottom" } },
      shoes: null,
      hat: null,
      bag: null
    };
    // legacy null → 有单品槽位生成默认 entry，无单品槽位 null
    const fromNull = alignLayoutToItems(null, items);
    assert.strictEqual(fromNull.version, LAYOUT_VERSION);
    assert.deepStrictEqual(fromNull.slots.top, { ...DEFAULT_LAYOUT.top }, "legacy 保存时仅对有单品槽生成默认 entry");
    assert.strictEqual(fromNull.slots.shoes, null, "无单品槽位不残留");
    // 有 schema：保留已有 entry，缺槽补默认，删除槽清 null
    const aligned = alignLayoutToItems({
      version: 1,
      canvas: { width: 360, height: 300 },
      slots: {
        top: { x: 250, y: 130, scale: 1.7, zIndex: 7 },
        bottom: null,
        shoes: { x: 5, y: 5, scale: 1, zIndex: 1 },
        hat: null,
        bag: { x: 9, y: 9, scale: 1, zIndex: 1 }
      }
    }, items);
    assert.strictEqual(aligned.slots.top.x, 250, "保留仍占用槽位的已保存 entry");
    assert.deepStrictEqual(aligned.slots.bottom, { ...DEFAULT_LAYOUT.bottom }, "有单品缺 entry → 默认布局");
    assert.strictEqual(aligned.slots.shoes, null, "schema 里有、items 里已删除的槽 → null，不残留");
    assert.strictEqual(aligned.slots.bag, null);
    assert.strictEqual(aligned.slots.hat, null);
  }

  // ---- 11. JSON 往返：整 schema 可 JSON 序列化且不丢值 ----
  {
    const layouts = defaultLayouts();
    layouts.top = { x: 250.125, y: 130, scale: 1.666666, zIndex: 7 };
    const schema = serializeLayout(layouts, { canvas: { width: 360, height: 300 }, filledSlots: LAYOUT_SLOTS });
    const roundTrip = JSON.parse(JSON.stringify(schema));
    const restored = materializeLayout(roundTrip, { canvas: { width: 360, height: 300 } });
    assert.strictEqual(restored.top.x, 250.13, "round2 后经 JSON 往返不漂移");
    assert.strictEqual(restored.top.scale, 1.67);
    // 入云层（cloudfunctions）可引用同语义函数：等价性由部署结构测试覆盖副本一致
    assert(deepFreezeSchema(schema).version === 1);
  }

  console.log("outfit layout schema (round 2B-1 json-safe) tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
