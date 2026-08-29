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
 * 注意：layout 本轮只存在于穿搭编辑页内存 data 中，不入云、不随保存协议传输；
 * 云持久化在 V1.5 第二轮接入。
 */

const SLOT_ORDER = ['hat', 'top', 'bottom', 'shoes', 'bag']

const CANVAS = { width: 360, height: 300 }

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
 * 返回新对象，不改动入参。仅夹取 x/y，不修改 scale/zIndex。
 */
function clampToCanvas(entry, slot) {
  const base = BASE_SIZES[slot] || { width: 0, height: 0 }
  const scale = clampScale(entry.scale)
  const halfW = (base.width * scale) / 2
  const halfH = (base.height * scale) / 2
  let minX = halfW
  let maxX = CANVAS.width - halfW
  let minY = halfH
  let maxY = CANVAS.height - halfH
  if (minX > maxX) {
    minX = maxX = CANVAS.width / 2
  }
  if (minY > maxY) {
    minY = maxY = CANVAS.height / 2
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
  toRenderLayer
}
