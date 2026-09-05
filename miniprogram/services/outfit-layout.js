/**
 * outfit-layout.js —— 穿搭画布布局模型（纯函数，无 wx 依赖，可独立单测）。
 *
 * 坐标系约定：
 *   以穿搭页 .composition 画布容器为基准，单位 rpx，原点为容器左上角。
 *   (x, y) 表示图层元素「中心点」相对容器左上角的偏移（rpx）。
 *   scale 为相对该槽位基尺寸（BASE_SIZES）的倍数，合法区间 [MIN_SCALE, MAX_SCALE] = [0.3, 3]。
 *   zIndex 为画布内堆叠次序：hat 8 > top 7 > shoes 6 > bottom 5，bag 10 侧挂最上层。
 *
 * 容器尺寸（Round 1.5.4）：
 *   屏幕宽恒为 750rpx；.page 左右 padding 各 24rpx → 内容宽 702rpx；
 *   栏间距 16rpx → 两栏合计 686rpx；
 *   左栏 326rpx（47.5%）+ 右栏 360rpx（52.5%），右侧比左侧多约 5 个百分点。
 *   点阵画布宽度随右栏 = 360rpx；高度吃满右栏剩余空间（与左栏实际高度对齐），
 *   不再写死 300rpx。模块内 CANVAS 默认 {360, 300} 作未测量前的回退；
 *   页面测量 .composition 后调用 setCanvasSize，clamp 使用实测值。
 *
 * 默认值校准（Round 1.5.3：帽-衣-裙-鞋一条穿搭主线，包在右侧）：
 *   画布图层 image 用 aspectFit（等比 contain letterbox）。BASE_SIZES 保持 1.5.1 竖版纵横比。
 *   1.5.2 把上衣停在裙子左侧，像商品并排；本轮收到同一主轴。
 *   画布只有 300 高：裙子基高 170 若 scale=1 会盖住整件上衣。故下装略缩小，
 *   让 T 恤躯干露在裙腰之上，鞋接在裙摆附近，帽子坐在上衣上方。
 *     hat:   90×58  @ (176, 38)  scale 1.15  渲染 103×67  z8
 *     top:   90×114 @ (180, 122) scale 1     z7
 *     bottom:134×170@(188, 216)  scale 0.78  渲染 105×133 z5
 *     shoes: 109×48 @ (186, 276) scale 1     z6
 *     bag:   80×92  @ (286, 150) scale 1     z10
 *   边距均不触发 clampToCanvas。成套感优先于主体宽度百分比。
 *
 * Round 2B-1 起 layout 正式持久化（顶层 layout schema，与 items 分离）：
 *   layout = {
 *     version: 1,                       // 固定 1，未来版本不兼容时整体按无效处理
 *     canvas: { width, height },        // 序列化时的画布基准（rpx），读取时按当前实测画布重映射
 *     slots: { hat, top, bottom, shoes, bag } // 固定五槽；槽位值为 {x,y,scale,zIndex} 或 null
 *   }
 *   - null 槽位表示该槽当前没有单品（删除/未选择），不残留旧 layout。
 *   - 全部字段经 sanitize（JSON-safe：有限数值、白名单字段、固定五槽），非法值回退该槽默认值。
 *   - 只在用户保存时写入正式 layout；legacy 记录只在运行时 materialize 默认布局，不自动回填。
 *   - width/height、selected、missing、手势状态等仍为运行时派生数据，不入 schema。
 */

const SLOT_ORDER = ['hat', 'top', 'bottom', 'shoes', 'bag']

const CANVAS = { width: 360, height: 300 }

const LAYOUT_VERSION = 1
const LAYOUT_SLOTS = ['hat', 'top', 'bottom', 'shoes', 'bag']
const MAX_CANVAS_DIMENSION = 10000
const MAX_COORDINATE = 100000
const MAX_Z_INDEX = 9999

/** 页面实测点阵画布后写入；仅更新正数宽高，供 clampToCanvas 使用。 */
function setCanvasSize(width, height) {
  if (typeof width === 'number' && width > 0) CANVAS.width = width
  if (typeof height === 'number' && height > 0) CANVAS.height = height
  return { width: CANVAS.width, height: CANVAS.height }
}

const BASE_SIZES = {
  hat: { width: 90, height: 58 },
  top: { width: 90, height: 114 },
  bottom: { width: 134, height: 170 },
  shoes: { width: 109, height: 48 },
  bag: { width: 80, height: 92 }
}

const MIN_SCALE = 0.3
const MAX_SCALE = 3

const DEFAULT_LAYOUT = {
  hat: { x: 176, y: 38, scale: 1.15, zIndex: 8 },
  top: { x: 180, y: 122, scale: 1, zIndex: 7 },
  bottom: { x: 188, y: 216, scale: 0.78, zIndex: 5 },
  shoes: { x: 186, y: 276, scale: 1, zIndex: 6 },
  bag: { x: 286, y: 150, scale: 1, zIndex: 10 }
}

/** 取五槽默认布局的深拷贝（每次调用互不影响）。 */
function defaultLayouts() {
  const out = {}
  SLOT_ORDER.forEach((slot) => {
    out[slot] = { ...DEFAULT_LAYOUT[slot] }
  })
  return out
}

/** 缩放倍数限制到 [MIN_SCALE, MAX_SCALE]；非法输入回退 1。 */
function clampScale(scale) {
  if (typeof scale !== 'number' || Number.isNaN(scale)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/**
 * 拖出边界约束：以槽位基尺寸 × scale 的一半为半径，把 (x, y) 夹回画布内，
 * 保证图层整体不越出画布；当图元比画布还大时回退到画布中心。
 * canvas 可选（默认当前模块 CANVAS），供按指定画布基准夹取（重映射后物化）使用。
 * 返回新对象，不改动入参。仅夹取 x/y，不修改 scale/zIndex。
 */
function clampToCanvas(entry, slot, canvas) {
  const base = BASE_SIZES[slot] || { width: 0, height: 0 }
  const scale = clampScale(entry.scale)
  const bounds = sanitizeCanvasDimension(canvas) || CANVAS
  const halfW = (base.width * scale) / 2
  const halfH = (base.height * scale) / 2
  let minX = halfW
  let maxX = bounds.width - halfW
  let minY = halfH
  let maxY = bounds.height - halfH
  if (minX > maxX) {
    minX = maxX = bounds.width / 2
  }
  if (minY > maxY) {
    minY = maxY = bounds.height / 2
  }
  return {
    ...entry,
    scale,
    x: Math.min(maxX, Math.max(minX, entry.x)),
    y: Math.min(maxY, Math.max(minY, entry.y))
  }
}

/**
 * 层级互换：把 slot 的 zIndex 与相邻层（按当前 zIndex 升序）互换。
 * delta = +1 表示「上移一层」（向更高层级移动），delta = -1 表示「下移一层」。
 * 已在最上/最下层时原样返回。返回新对象，不改动入参。
 */
function moveLayer(layouts, slot, delta) {
  if (!layouts || !slot || !SLOT_ORDER.includes(slot)) return layouts
  if (delta !== 1 && delta !== -1) return layouts
  const sorted = SLOT_ORDER
    .map((s) => ({ slot: s, z: (layouts[s] && layouts[s].zIndex) || 0 }))
    .sort((a, b) => a.z - b.z)
  const index = sorted.findIndex((entry) => entry.slot === slot)
  const targetIndex = index + delta
  if (index === -1 || targetIndex < 0 || targetIndex >= sorted.length) return layouts
  const target = sorted[targetIndex].slot
  const next = {}
  SLOT_ORDER.forEach((s) => {
    next[s] = { ...layouts[s] }
  })
  const tmp = next[slot].zIndex
  next[slot].zIndex = next[target].zIndex
  next[target].zIndex = tmp
  return next
}

/** 重置当前槽位：恢复默认位置/缩放/层级。返回新对象，不改动入参。 */
function resetSlot(layouts, slot) {
  if (!layouts || !slot || !SLOT_ORDER.includes(slot)) return layouts
  const next = {}
  SLOT_ORDER.forEach((s) => {
    next[s] = { ...layouts[s] }
  })
  next[slot] = { ...DEFAULT_LAYOUT[slot] }
  return next
}

/** 重置整套：等价于 defaultLayouts()。 */
function resetAll() {
  return defaultLayouts()
}

/**
 * 渲染层派生（纯函数）：把 layout 转成渲染层数据。
 * width/height = 槽位基尺寸 × 限幅后 scale（四舍五入到整数 rpx），
 * scale 在此限幅，保证渲染尺寸与 clamp 边界一致（画布不越界）。
 * 返回新对象，不改动入参。
 */
function toRenderLayer(slot, layout) {
  const base = BASE_SIZES[slot] || { width: 0, height: 0 }
  const scale = clampScale(layout && layout.scale)
  const source = layout || {}
  return {
    x: typeof source.x === 'number' ? source.x : 0,
    y: typeof source.y === 'number' ? source.y : 0,
    width: Math.round(base.width * scale),
    height: Math.round(base.height * scale),
    scale,
    zIndex: typeof source.zIndex === 'number' ? source.zIndex : 2
  }
}

// ---- Round 2B-1：顶层 layout schema（JSON-safe，与 items 分离，固定五槽） ----

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** JSON-safe 数值：保留 2 位小数，消除浮点噪声（1.4142135 → 1.41）。 */
function round2(value) {
  return Math.round(value * 100) / 100
}

/** 校验画布基准：正有限数值且不超过上限；非法返回 null。 */
function sanitizeCanvasDimension(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const width = value.width
  const height = value.height
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (width <= 0 || height <= 0) return null
  if (width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION) return null
  // Round 2B-1 reviewer fix：极小正数（如 0.004）round2 后为 0，会产出非法画布基准；
  // round 后必须复验 > 0（0.004 这类输入判非法 → 调用方回退默认画布）。
  const roundedWidth = round2(width)
  const roundedHeight = round2(height)
  if (roundedWidth <= 0 || roundedHeight <= 0) return null
  return { width: roundedWidth, height: roundedHeight }
}

/**
 * 单槽 entry 白名单化：仅保留 {x, y, scale, zIndex}；
 * 非法字段回退该槽默认值（scale 非法走 clampScale → 1；zIndex 取整并限幅）。
 * x/y 超出合理数值边界（远超任何画布）时整槽回退默认，避免病态数据。
 */
function sanitizeSlotEntry(slot, value) {
  const base = DEFAULT_LAYOUT[slot] || { x: 0, y: 0, scale: 1, zIndex: 2 }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...base }
  }
  let x = base.x
  let y = base.y
  if (isFiniteNumber(value.x) && Math.abs(value.x) <= MAX_COORDINATE) x = round2(value.x)
  if (isFiniteNumber(value.y) && Math.abs(value.y) <= MAX_COORDINATE) y = round2(value.y)
  const scale = round2(clampScale(isFiniteNumber(value.scale) ? value.scale : base.scale))
  let zIndex = base.zIndex
  if (isFiniteNumber(value.zIndex)) {
    zIndex = Math.min(MAX_Z_INDEX, Math.max(-MAX_Z_INDEX, Math.round(value.zIndex)))
  }
  return { x, y, scale, zIndex }
}

/**
 * sanitize 任意输入为顶层 layout schema。
 * 接受 schema 形状（value.slots）或运行时形状（value 自带五槽键）；
 * 非对象输入返回 null（调用方据此走 legacy 默认布局，不报错）。
 * 固定五槽：schema 形状缺失 slots 时按全 null 处理；null 槽位保持 null（无单品）。
 */
function sanitizeLayout(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  // Round 2B-1 reviewer fix：version 必须严格为数值 1（Number.isInteger 且 === 1）；
  // 字符串 "1"（乃至 "1.0" 等）一律按未知版本整体判无效，调用方走 legacy 默认布局回退。
  if (value.version !== undefined) {
    if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version !== LAYOUT_VERSION) return null
  }
  const rawSlots = value.slots && typeof value.slots === 'object' && !Array.isArray(value.slots)
    ? value.slots
    : (LAYOUT_SLOTS.some((slot) => value[slot] !== undefined) ? value : null)
  const canvas = sanitizeCanvasDimension(value.canvas) || { ...CANVAS }
  const slots = {}
  LAYOUT_SLOTS.forEach((slot) => {
    const raw = rawSlots ? rawSlots[slot] : undefined
    slots[slot] = raw === null || raw === undefined ? null : sanitizeSlotEntry(slot, raw)
  })
  return { version: LAYOUT_VERSION, canvas, slots }
}

/**
 * 运行时 layouts + 槽位占用 → 可持久化 schema。
 * filledSlots：当前有单品的槽位数组（未占用槽位序列化为 null，避免残留旧 layout）；
 * 省略时以运行时 entry 存在与否判断。canvas 缺省用当前实测画布基准。
 */
function serializeLayout(layouts, options = {}) {
  const canvas = sanitizeCanvasDimension(options.canvas) || { ...CANVAS }
  const filled = Array.isArray(options.filledSlots) ? new Set(options.filledSlots) : null
  const slots = {}
  LAYOUT_SLOTS.forEach((slot) => {
    const raw = layouts && typeof layouts === 'object' ? layouts[slot] : null
    const isFilled = filled ? filled.has(slot) : Boolean(raw)
    slots[slot] = isFilled && raw ? sanitizeSlotEntry(slot, raw) : null
  })
  return { version: LAYOUT_VERSION, canvas, slots }
}

/**
 * 运行时物化：把已保存 schema 物化成页面五槽运行时 layouts。
 * - 无 schema / 非法 schema（legacy、缺失、脏数据）→ 全默认布局，不报错。
 * - 有 schema 时按「存储画布基准 → 当前画布基准」等比重映射 x/y，
 *   scale 乘 min(宽比, 高比) 后限幅，再按当前画布 clamp，避免设备尺寸变化失真。
 * - null/缺失槽位回退默认槽位布局。
 * targetCanvas 缺省用当前模块 CANVAS。
 */
function materializeLayout(value, options = {}) {
  const schema = sanitizeLayout(value)
  const target = sanitizeCanvasDimension(options.canvas) || { ...CANVAS }
  const layouts = defaultLayouts()
  if (!schema) return layouts
  const ratioX = target.width / schema.canvas.width
  const ratioY = target.height / schema.canvas.height
  const ratioScale = Math.min(ratioX, ratioY)
  LAYOUT_SLOTS.forEach((slot) => {
    const entry = schema.slots[slot]
    if (!entry) return
    const remapped = {
      x: entry.x * ratioX,
      y: entry.y * ratioY,
      scale: entry.scale * ratioScale,
      zIndex: entry.zIndex
    }
    layouts[slot] = clampToCanvas(remapped, slot, target)
  })
  return layouts
}

/**
 * items 对齐：保证 schema 与五槽 items 一致。
 * - 无单品槽位 → null（删除/替换不残留旧 layout）。
 * - 有单品但缺 layout entry → 该槽默认布局。
 * layout 可为 null（legacy）→ 仅在有单品槽位上生成默认 entry，canvas 用当前基准。
 */
function alignLayoutToItems(layout, items) {
  const schema = sanitizeLayout(layout)
  const canvas = schema ? schema.canvas : { ...CANVAS }
  const slots = {}
  LAYOUT_SLOTS.forEach((slot) => {
    const item = items && typeof items === 'object' ? items[slot] : null
    const hasItem = Boolean(item && (item.itemId || item.id))
    if (!hasItem) {
      slots[slot] = null
      return
    }
    slots[slot] = (schema && schema.slots[slot]) || { ...DEFAULT_LAYOUT[slot] }
  })
  return { version: LAYOUT_VERSION, canvas, slots }
}

module.exports = {
  SLOT_ORDER,
  CANVAS,
  setCanvasSize,
  BASE_SIZES,
  MIN_SCALE,
  MAX_SCALE,
  DEFAULT_LAYOUT,
  defaultLayouts,
  clampScale,
  clampToCanvas,
  moveLayer,
  resetSlot,
  resetAll,
  toRenderLayer,
  LAYOUT_VERSION,
  LAYOUT_SLOTS,
  sanitizeCanvasDimension,
  sanitizeSlotEntry,
  sanitizeLayout,
  serializeLayout,
  materializeLayout,
  alignLayoutToItems
}
