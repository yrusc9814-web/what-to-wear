const assert = require("assert");
const outfitLayout = require("../miniprogram/services/outfit-layout");

const { defaultLayouts, clampScale, clampToCanvas, moveLayer, resetSlot, resetAll, DEFAULT_LAYOUT, SLOT_ORDER, toRenderLayer, BASE_SIZES, CANVAS, setCanvasSize } = outfitLayout;

// Round 1.5.4：默认回退画布 360×300（左栏 326rpx ≈47.5% + 栏间距 16rpx + 右栏 360rpx ≈52.5%）。
// 页面实测点阵高度后 setCanvasSize 覆盖 height；各槽基尺寸仍按竖版校准。
// 1. 默认 layout：五槽完备且与新几何一致
{
  const defaults = defaultLayouts();
  assert.deepStrictEqual(Object.keys(defaults).sort(), ["bag", "bottom", "hat", "shoes", "top"]);
  assert.deepStrictEqual(defaults, DEFAULT_LAYOUT, "默认 layout 必须精确等于常量表");
  assert.deepStrictEqual(defaults.hat, { x: 176, y: 38, scale: 1.15, zIndex: 8 });
  assert.deepStrictEqual(defaults.top, { x: 180, y: 122, scale: 1, zIndex: 7 });
  assert.deepStrictEqual(defaults.bottom, { x: 188, y: 216, scale: 0.78, zIndex: 5 });
  assert.deepStrictEqual(defaults.shoes, { x: 186, y: 276, scale: 1, zIndex: 6 });
  assert.deepStrictEqual(defaults.bag, { x: 286, y: 150, scale: 1, zIndex: 10 });
  assert.strictEqual(defaults.shoes.zIndex, 6, "shoes 应默认位于 bottom 之上、top 之下");
}

// 1b. defaultLayouts 每次返回深拷贝，互不影响
{
  const a = defaultLayouts();
  const b = defaultLayouts();
  a.top.x = 999;
  assert.strictEqual(b.top.x, 180, "修改一份拷贝不得影响另一份");
}

// 1c. Round 1.5.1 比例规范：五槽大小关系与画布占比（§十/§三十一/§三十七）
{
  assert.deepStrictEqual(CANVAS, { width: 360, height: 300 }, "默认回退画布应为 360×300");
  // hat 明显小于 top；bag 不得大于 bottom（裤子）；shoes 最小但不是小点
  assert.ok(BASE_SIZES.hat.width * BASE_SIZES.hat.height < BASE_SIZES.top.width * BASE_SIZES.top.height * 0.6, "帽子面积应明显小于上衣(<60%)");
  assert.ok(BASE_SIZES.hat.height < BASE_SIZES.top.height * 0.55, "帽子高度应明显小于上衣(<55%)")
  assert.ok(BASE_SIZES.bag.width < BASE_SIZES.bottom.width, "包不得比裤子大");
  assert.ok(BASE_SIZES.shoes.height < BASE_SIZES.top.height * 0.5, "鞋子应明显小");
  assert.ok(BASE_SIZES.top.width <= CANVAS.width / 2, "上衣默认宽不得超过画布一半");
  // 整套主体高度参考 70-85%；宽度不再硬卡百分比（纵向成套会收窄主体并集）
  // contain letterbox 可见尺寸：min(boxW, boxH*aspect) —— fixture 实测纵横比
  const FIXTURE_ASPECT = { top: 318/400, bottom: 315/400, shoes: 400/176 };
  const visible = (slot) => ({
    w: Math.min(BASE_SIZES[slot].width, BASE_SIZES[slot].height * FIXTURE_ASPECT[slot]),
    h: Math.min(BASE_SIZES[slot].height, BASE_SIZES[slot].width / FIXTURE_ASPECT[slot])
  });
  const bodySlots = ['top', 'bottom', 'shoes'];
  const vis = bodySlots.map(slot => visible(slot));
  const bodyTop = Math.min(...bodySlots.map((s, i) => DEFAULT_LAYOUT[s].y - vis[i].h / 2));
  const bodyBottom = Math.max(...bodySlots.map((s, i) => DEFAULT_LAYOUT[s].y + vis[i].h / 2));
  const bodyLeft = Math.min(...bodySlots.map((s, i) => DEFAULT_LAYOUT[s].x - vis[i].w / 2));
  const bodyRight = Math.max(...bodySlots.map((s, i) => DEFAULT_LAYOUT[s].x + vis[i].w / 2));
  const bodyHeight = bodyBottom - bodyTop;
  const bodyWidth = bodyRight - bodyLeft;
  assert.ok(bodyHeight / CANVAS.height >= 0.7 && bodyHeight / CANVAS.height <= 0.85, `主体高占比应 70-85%，实际 ${(bodyHeight / CANVAS.height * 100).toFixed(1)}%`);
  assert.ok(bodyWidth / CANVAS.width >= 0.30 && bodyWidth / CANVAS.width <= 0.75, `主体宽占比应有存在感且不铺满，实际 ${(bodyWidth / CANVAS.width * 100).toFixed(1)}%`);
  // 五槽默认全部位于画布内（默认即不被 clamp；hat 默认 scale 1.15）
  const defaults = defaultLayouts();
  SLOT_ORDER.forEach((slot) => {
    const scale = typeof defaults[slot].scale === "number" ? defaults[slot].scale : 1;
    const halfW = (BASE_SIZES[slot].width * scale) / 2;
    const halfH = (BASE_SIZES[slot].height * scale) / 2;
    assert.ok(defaults[slot].x - halfW >= 0 && defaults[slot].x + halfW <= CANVAS.width, `${slot} 默认 x 应整体在画布内`);
    assert.ok(defaults[slot].y - halfH >= 0 && defaults[slot].y + halfH <= CANVAS.height, `${slot} 默认 y 应整体在画布内`);
  });
}

// 2. clampScale：限幅 0.3–3，非法值回退 1
{
  assert.strictEqual(clampScale(1), 1);
  assert.strictEqual(clampScale(0.1), 0.3);
  assert.strictEqual(clampScale(5), 3);
  assert.strictEqual(clampScale(-2), 0.3);
  assert.strictEqual(clampScale(NaN), 1);
  assert.strictEqual(clampScale("big"), 1);
}

// 3. clampToCanvas：拖出边界约束（默认回退画布 360×300）
{
  const defaults = defaultLayouts();
  // 默认位置本就合法，clamp 后不变
  SLOT_ORDER.forEach((slot) => {
    const clamped = clampToCanvas(defaults[slot], slot);
    assert.deepStrictEqual(clamped, defaults[slot], `${slot} 默认位置应保持在画布内`);
  });

  // hat 拖出左边界：x 回收到左缘 = 45（90/2），y 不变
  const hat = clampToCanvas({ x: -200, y: 48, scale: 1, zIndex: 8 }, "hat");
  assert.strictEqual(hat.x, 45);
  assert.strictEqual(hat.y, 48);

  // top 拖出右边界：x = 360 - 45 = 315
  const top = clampToCanvas({ x: 900, y: 112, scale: 1, zIndex: 7 }, "top");
  assert.strictEqual(top.x, 315);

  // shoes 拖出下边界：y = 300 - 24 = 276
  const shoes = clampToCanvas({ x: 172, y: 999, scale: 1, zIndex: 6 }, "shoes");
  assert.strictEqual(shoes.y, 276);

  // 图元放大后仅高度超画布（top scale3 高 342>300）：x 不被 clamp 半宽压回
  const huge = clampToCanvas({ x: 0, y: 0, scale: 3, zIndex: 7 }, "top");
  assert.strictEqual(huge.x, 135);
  assert.strictEqual(huge.y, 150);

  // scale 越界会在 clamp 内被修正
  const overscaled = clampToCanvas({ x: 500, y: 300, scale: 9, zIndex: 7 }, "top");
  assert.strictEqual(overscaled.scale, 3);

  // 纯函数：不改动入参
  const original = { x: -200, y: 48, scale: 1, zIndex: 8 };
  const snapshot = { ...original };
  clampToCanvas(original, "hat");
  assert.deepStrictEqual(original, snapshot, "clampToCanvas 不得修改入参对象");

  // setCanvasSize 后 clamp 使用实测高度
  const prev = { width: CANVAS.width, height: CANVAS.height };
  setCanvasSize(360, 720);
  const shoesTall = clampToCanvas({ x: 186, y: 999, scale: 1, zIndex: 6 }, "shoes");
  assert.strictEqual(shoesTall.y, 696, "720 高画布下鞋子下缘应夹到 720-24");
  setCanvasSize(prev.width, prev.height);
}

// 4. moveLayer：层级互换语义
{
  const defaults = defaultLayouts();
  // 默认 z 排序：bottom(5) < shoes(6) < top(7) < hat(8) < bag(10)
  // top 上移一层 → 与 hat(8) 互换
  const upTop = moveLayer(defaults, "top", 1);
  assert.strictEqual(upTop.top.zIndex, 8);
  assert.strictEqual(upTop.hat.zIndex, 7);
  assert.strictEqual(upTop.bottom.zIndex, 5, "无关槽位不受影响");
  assert.strictEqual(upTop.bag.zIndex, 10, "最上层 bag 不受影响");

  // shoes 上移一层 → 与 top(7) 互换
  const upShoes = moveLayer(defaults, "shoes", 1);
  assert.strictEqual(upShoes.shoes.zIndex, 7);
  assert.strictEqual(upShoes.top.zIndex, 6);

  // bottom 下移一层（已在最底层）→ 原样
  const downBottom = moveLayer(defaults, "bottom", -1);
  assert.strictEqual(downBottom, defaults, "已在最底层时不应变化");

  // bag 上移一层（已在最顶层）→ 原样
  const upBag = moveLayer(defaults, "bag", 1);
  assert.strictEqual(upBag, defaults, "已在最顶层时不应变化");

  // 连续互换后应能回到原始 z 顺序
  const roundTrip = moveLayer(moveLayer(defaults, "top", 1), "top", -1);
  assert.strictEqual(roundTrip.top.zIndex, 7);
  assert.strictEqual(roundTrip.hat.zIndex, 8);

  // 非法参数：原样返回
  assert.strictEqual(moveLayer(defaults, "pants", 1), defaults, "非法槽位原样返回");
  assert.strictEqual(moveLayer(defaults, "top", 0), defaults, "非法 delta 原样返回");
  assert.strictEqual(moveLayer(defaults, "top", 2), defaults, "越界 delta 原样返回");
}

// 5. resetSlot / resetAll
{
  const layouts = defaultLayouts();
  layouts.top = { x: 500, y: 300, scale: 2.5, zIndex: 9 };
  const reset = resetSlot(layouts, "top");
  assert.deepStrictEqual(reset.top, DEFAULT_LAYOUT.top, "重置后恢复默认");
  assert.deepStrictEqual(reset.hat, layouts.hat, "其他槽位不受影响");

  const all = resetAll();
  assert.deepStrictEqual(all, DEFAULT_LAYOUT, "整套重置恢复默认");

  // 非法槽位原样返回
  const invalid = resetSlot(layouts, "pants");
  assert.strictEqual(invalid, layouts);
}

// 6. toRenderLayer：渲染尺寸 = 基尺寸 × 限幅后 scale（捏合缩放的视觉基础）
{
  // scale=1.5 时 top 渲染宽高 = 164×1.5 / 100×1.5
  const renderTop = toRenderLayer("top", { x: 100, y: 50, scale: 1.5, zIndex: 7 });
  assert.strictEqual(renderTop.width, Math.round(90 * 1.5), "scale=1.5 时渲染宽 = 基准×1.5");
  assert.strictEqual(renderTop.height, Math.round(114 * 1.5), "scale=1.5 时渲染高 = 基准×1.5");
  assert.strictEqual(renderTop.x, 100);
  assert.strictEqual(renderTop.y, 50);
  assert.strictEqual(renderTop.scale, 1.5);
  assert.strictEqual(renderTop.zIndex, 7);

  // scale clamp 后渲染尺寸随之限幅：scale=9 → 夹到 3
  const renderClamped = toRenderLayer("top", { x: 0, y: 0, scale: 9, zIndex: 7 });
  assert.strictEqual(renderClamped.scale, 3);
  assert.strictEqual(renderClamped.width, Math.round(90 * 3), "clamp 到 3 后渲染宽 = 基准×3");
  assert.strictEqual(renderClamped.height, Math.round(114 * 3));

  // scale=0.1 → 夹到 0.3
  const renderMin = toRenderLayer("top", { x: 0, y: 0, scale: 0.1, zIndex: 7 });
  assert.strictEqual(renderMin.scale, 0.3);
  assert.strictEqual(renderMin.width, Math.round(90 * 0.3));

  // 五槽默认：渲染尺寸 = 基准尺寸 × 默认 scale（hat 为 1.15，其余为 1）
  SLOT_ORDER.forEach((slot) => {
    const render = toRenderLayer(slot, DEFAULT_LAYOUT[slot]);
    const scale = DEFAULT_LAYOUT[slot].scale;
    assert.strictEqual(render.width, Math.round(BASE_SIZES[slot].width * scale), `${slot} 默认渲染宽 = 基准宽×scale`);
    assert.strictEqual(render.height, Math.round(BASE_SIZES[slot].height * scale), `${slot} 默认渲染高 = 基准高×scale`);
    assert.strictEqual(render.zIndex, DEFAULT_LAYOUT[slot].zIndex);
  });

  // 纯函数：不改动入参
  const layoutSnapshot = { x: 0, y: 0, scale: 1.5, zIndex: 7 };
  toRenderLayer("top", layoutSnapshot);
  assert.deepStrictEqual(layoutSnapshot, { x: 0, y: 0, scale: 1.5, zIndex: 7 }, "toRenderLayer 不得修改入参");
}

console.log("outfit layout tests passed");
