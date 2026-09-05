const appService = require('../../services/app-service')
const outfitLayout = require('../../services/outfit-layout')
const {
  CATEGORIES,
  SEASONS,
  STYLES,
  SEASON_MAP,
  STYLE_MAP,
  getCurrentSeason
} = require('../../utils/constants')

const REQUIRED_SLOTS = ['top', 'bottom', 'shoes']
const SLOT_ORDER = ['hat', 'top', 'bottom', 'shoes', 'bag']
const SCENE_BY_STYLE = {
  casual: '适合日常、出游',
  commute: '适合通勤、会面',
  sweet: '适合约会、逛街',
  cool: '适合聚会、街头'
}

function emptySlots() {
  return { hat: null, top: null, bottom: null, shoes: null, bag: null }
}

function emptyDraft() {
  return {
    sourceOutfitId: null,
    slots: emptySlots(),
    title: '',
    season: null,
    style: null,
    mode: 'create',
    dirty: false,
    // Round 2B-1：layout 顶层 schema 快照（与 items 分离）。仅随 draft 持久化，
    // 用于中断后恢复画布；legacy（null）一律由运行时 materialize 默认布局，不自动回填。
    layout: null
  }
}

function itemId(item) {
  return item && String(item.id || item.itemId || '')
}

function presentItem(item) {
  if (!item) return null
  const snapshot = item.snapshot || item
  return {
    ...item,
    id: itemId(item),
    itemId: itemId(item),
    name: snapshot.name || item.name || '已保存单品',
    initial: String(snapshot.name || item.name || '衣').slice(0, 1),
    category: snapshot.category || item.category || item.type,
    imageUrl: snapshot.imageUrl || snapshot.imageFileId || item.imageUrl || item.imageFileId || '',
    imageFileId: snapshot.imageFileId || item.imageFileId || '',
    primaryColor: snapshot.primaryColor || item.primaryColor || '',
    seasons: Array.isArray(item.seasons) ? item.seasons : (item.season && item.season !== 'all' ? [item.season] : []),
    styles: Array.isArray(item.styles) ? item.styles : (item.style ? [item.style] : []),
    missing: Boolean(item.missing)
  }
}

function randomFrom(items) {
  return items[Math.floor(Math.random() * items.length)] || null
}

Page({
  data: {
    state: 'loading',
    errorMessage: '',
    wardrobe: [],
    groups: [],
    draft: emptyDraft(),
    previewSlots: emptySlots(),
    previewStyle: '自由搭配',
    previewScene: '从你的衣橱里挑选单品',
    missingSlotLabels: [],
    missingSlotText: '',
    saveOpen: false,
    saving: false,
    seasonOptions: SEASONS,
    styleOptions: STYLES,
    // 自由画布布局：Round 2B-1 起布局正式持久化——保存时随协议入云、编辑时从已保存
    // layout（schema）物化恢复；页面 data 的 layouts/renderLayers 仍为运行时派生状态。
    layouts: null,
    // 派生渲染层：由 layouts 计算得到（width/height = 基尺寸 × scale），
    // 所有写 layouts 的入口统一经过 buildRenderLayers 刷新
    renderLayers: {},
    selectedSlot: '',
    selectedHint: '点击画布中的单品可选中，拖动调整位置，双指缩放大小',
    // 「可选入库衣物」筛选胶囊（仅视觉筛选，不改选择语义）
    activeFilter: 'all',
    filterOptions: [{ value: 'all', label: '全部' }].concat(CATEGORIES.map((item) => ({ value: item.value, label: item.label }))),
    // 左栏槽位卡与网格卡均为派生展示数据，由 refreshPresentation 维护
    slotList: [],
    isAllSlotsEmpty: true,
    selectedCount: 0,
    gridItems: [],
    gridEmpty: true
  },

  onLoad() {
    this.hasLoaded = false
    // 画布布局初始化状态：hasLoadedLayout 标记是否已建立布局；
    // lastLayoutFingerprint 记录最近一次建立/重建布局时的 draft 内容指纹，
    // 用于 onShow 时判断「draft 是否真的变化」，前后台切换不丢用户画布调整。
    // _pendingSchemaRemap 记录最近一次从已保存 schema 物化的布局，等待实测画布后重映射；
    // 任何用户布局编辑即失效（统一走 invalidatePendingSchemaRemap，见 measureCanvas 注释）。
    this.hasLoadedLayout = false
    this.lastLayoutFingerprint = ''
    this._pendingSchemaRemap = null
    this._saveInFlight = false
    // Round 2B-1 reviewer fix：load 请求代次 —— 每次 loadEditor 启动自增，异步回调（含 catch）
    // 先校验代次再落地；onShow(119) 与下拉刷新(122-124) 并发触发时，较旧响应的
    // wardrobe/draft/layout 均为过期快照，一律丢弃，避免旧数据覆盖较新的 draft/layout。
    // 保存侧采用「保存开始时刻 items+layout 同源快照」语义（见 commitSave），无需额外代次。
    this._loadToken = 0
    const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync()
    this.windowWidth = info.windowWidth || 375
    this.rpxPerPx = 750 / this.windowWidth
    this._gesture = null
  },

  onShow() {
    this.loadEditor()
  },

  onPullDownRefresh() {
    this.loadEditor().finally(() => wx.stopPullDownRefresh())
  },

  async loadEditor() {
    // 惰性取号：兼容未走 onLoad 直测 loadEditor 的测试夹具（_loadToken 初始为 undefined）。
    const token = (this._loadToken || 0) + 1
    this._loadToken = token
    this.setData({ state: 'loading', errorMessage: '' })
    try {
      const wardrobeResult = await appService.listWardrobeItems({ includeDeleted: false })
      // Round 2B-1 reviewer fix：load 代次校验 —— 期间有更新的 loadEditor 发起时，
      // 本响应已过期，直接丢弃（含错误分支统一在 catch 校验），避免旧数据覆盖新 draft/layout。
      if (token !== this._loadToken) return
      const wardrobe = (Array.isArray(wardrobeResult) ? wardrobeResult : (wardrobeResult && wardrobeResult.items) || [])
        .filter((item) => !item.deletedAt)
        .map(presentItem)
      const storedDraft = appService.getOutfitDraft()
      const draft = this.reconcileDraft(storedDraft || emptyDraft(), wardrobe)
      // Round 2B-1 布局恢复策略：
      //  - 指纹 = 五槽单品 + sourceOutfitId；仅首次加载或指纹变化时重建/物化布局，
      //    前后台切换与未变草稿保留用户已调整的画布；不同 sourceOutfitId 绝不串布局。
      //  - 指纹变化时优先物化 draft.layout（编辑 handoff 的已保存 schema / 中断前快照），
      //    无 schema（legacy、新建）回退默认布局；实测画布量测后再按 schema.canvas 重映射。
      const fingerprint = this.draftLayoutFingerprint(draft)
      const layoutsChanged = !this.hasLoadedLayout || fingerprint !== this.lastLayoutFingerprint
      const savedSchema = layoutsChanged ? outfitLayout.sanitizeLayout(draft.layout) : null
      this._pendingSchemaRemap = savedSchema
      const layouts = layoutsChanged
        ? (savedSchema ? outfitLayout.materializeLayout(savedSchema) : outfitLayout.defaultLayouts())
        : (this.data.layouts || outfitLayout.defaultLayouts())
      const selectedSlot = layoutsChanged ? '' : this.data.selectedSlot
      if (token !== this._loadToken) return
      this.lastLayoutFingerprint = fingerprint
      this.hasLoadedLayout = true
      this.setData({
        wardrobe,
        draft,
        layouts,
        renderLayers: this.buildRenderLayers(layouts, selectedSlot),
        selectedSlot,
        selectedHint: layoutsChanged ? '点击画布中的单品可选中，拖动调整位置，双指缩放大小' : this.data.selectedHint,
        state: 'ready'
      })
      this.refreshPresentation()
      // 保持最后一道落盘代次校验：当前流程在上一次 await 后是同步的，但这能避免未来在
      // presentation 链路加入异步工作时，已失效 load 仍把旧 draft 写入本地 storage。
      if (storedDraft && token === this._loadToken) appService.persistOutfitDraft(draft)
      this.hasLoaded = true
      // Round 2B-1 reviewer fix：量测附属于本次 load 代次 —— measureCanvas 异步回调
      // 落地前按该代次校验，过期测量整体丢弃（见 measureCanvas 内 requestToken 注释）。
      this.measureCanvas(token)
    } catch (error) {
      // Round 2B-1 reviewer fix：过期请求的错误同样不得覆盖较新加载的 ready/error 状态。
      if (token !== this._loadToken) return
      this.setData({
        state: 'error',
        errorMessage: (error && error.message) || '穿搭数据加载失败'
      })
    }
  },

  reconcileDraft(rawDraft, wardrobe) {
    const fallback = emptyDraft()
    const source = rawDraft && typeof rawDraft === 'object' ? rawDraft : fallback
    const liveById = new Map(wardrobe.map((item) => [item.id, item]))
    const slots = emptySlots()
    SLOT_ORDER.forEach((slot) => {
      const stored = source.slots && source.slots[slot]
      if (!stored) return
      const id = itemId(stored)
      const live = liveById.get(id)
      slots[slot] = live && live.category === slot
        ? live
        : { ...presentItem(stored), category: slot, missing: Boolean(id), invalidCategory: Boolean(live && live.category !== slot) }
    })
    return {
      sourceOutfitId: source.sourceOutfitId || null,
      slots,
      title: source.title || '',
      season: source.season || null,
      style: source.style || null,
      mode: source.mode === 'edit' && source.sourceOutfitId ? 'edit' : 'create',
      dirty: Boolean(source.dirty),
      // Round 2B-1：layout schema 随 draft 原样带过（legacy/null 由加载端 materialize 兜底）；
      // 物化对齐由 loadEditor 与保存链负责，不在这里改脏数据。
      layout: source.layout || null
    }
  },

  /** draft 内容指纹：纳入 sourceOutfitId 与五槽单品 id —— 不同来源/不同套装绝不串布局。 */
  draftLayoutFingerprint(draft) {
    return SLOT_ORDER.map((slot) => itemId(draft.slots[slot])).join('|') + '#' + String(draft.sourceOutfitId || '')
  },

  refreshPresentation() {
    const { wardrobe, draft } = this.data
    const groups = CATEGORIES.map((category) => ({
      ...category,
      optional: category.value === 'hat' || category.value === 'bag',
      items: wardrobe
        .filter((item) => item.category === category.value)
        .map((item) => ({ ...item, selected: item.id === itemId(draft.slots[category.value]) }))
    }))
    const slotList = SLOT_ORDER.map((slot) => {
      const category = CATEGORIES.find((item) => item.value === slot)
      const item = draft.slots[slot]
      return {
        slot,
        label: category ? category.label : slot,
        filled: Boolean(item),
        name: item ? item.name : '',
        imageUrl: item ? item.imageUrl || '' : '',
        initial: item ? item.initial : ''
      }
    })
    const isAllSlotsEmpty = slotList.every((entry) => !entry.filled)
    const selectedCount = slotList.filter((entry) => entry.filled).length
    const activeFilter = this.data.activeFilter || 'all'
    const filteredGroups = activeFilter === 'all' ? groups : groups.filter((item) => item.value === activeFilter)
    const gridItems = filteredGroups.reduce((list, group) => {
      group.items.forEach((piece) => list.push({ ...piece, category: group.value }))
      return list
    }, [])
    const missingSlotLabels = SLOT_ORDER
      .filter((slot) => draft.slots[slot] && draft.slots[slot].missing)
      .map((slot) => CATEGORIES.find((item) => item.value === slot).label)
    const style = draft.style || this.inferStyle(draft.slots)
    this.setData({
      groups,
      slotList,
      isAllSlotsEmpty,
      selectedCount,
      gridItems,
      gridEmpty: gridItems.length === 0,
      previewSlots: draft.slots,
      missingSlotLabels,
      missingSlotText: missingSlotLabels.join('、'),
      previewStyle: style ? `${STYLE_MAP[style] || '自由'}风` : '自由搭配',
      previewScene: style ? SCENE_BY_STYLE[style] : '从你的衣橱里挑选单品'
    })
  },

  inferStyle(slots) {
    const counts = {}
    SLOT_ORDER.forEach((slot) => {
      const item = slots[slot]
      const values = item && (item.styles || (item.style ? [item.style] : []))
      ;(values || []).forEach((value) => {
        if (STYLE_MAP[value]) counts[value] = (counts[value] || 0) + 1
      })
    })
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ''
  },

  persistDraft(patch) {
    const draft = { ...this.data.draft, ...patch }
    // Round 2B-1：每次草稿变更都把当前画布 layout 序列化进 draft，中断/重启后可恢复；
    // 仅含当前有单品的槽位（无单品槽 → null），删除/替换不残留旧布局。
    draft.layout = this.serializeSlotsLayout(draft.slots || emptySlots())
    this.setData({ draft })
    appService.persistOutfitDraft(draft)
    this.refreshPresentation()
  },

  serializeSlotsLayout(slots) {
    const filled = SLOT_ORDER.filter((slot) => slots[slot] && itemId(slots[slot]))
    const layouts = this.data.layouts || outfitLayout.defaultLayouts()
    return outfitLayout.serializeLayout(layouts, {
      canvas: { width: outfitLayout.CANVAS.width, height: outfitLayout.CANVAS.height },
      filledSlots: filled
    })
  },

  serializeCurrentLayout() {
    return this.serializeSlotsLayout(this.data.draft.slots)
  },

  onSelectItem(event) {
    const category = event.currentTarget.dataset.category
    const id = String(event.currentTarget.dataset.id || '')
    if (!SLOT_ORDER.includes(category)) return
    const selected = id ? this.data.wardrobe.find((item) => item.id === id) || null : null
    // Round 2B-1：槽位单品被替换/换新时该槽布局复位默认（新单品尺寸不同，不沿用旧图摆放），
    // 保证 serialize 不残留旧 layout；删除槽位本身由 serialize 的 filledSlots 置 null。
    // Round 2B-1 reviewer fix：槽位内容变更（换单品/移除）属用户布局编辑，先失效挂起
    // schema 重映射，量测回调不得再用旧 schema 覆盖画布。
    const previous = this.data.draft.slots[category]
    const slotChanged = itemId(previous) !== itemId(selected)
    if (slotChanged) this.invalidatePendingSchemaRemap()
    if (slotChanged && selected) {
      const layouts = this.data.layouts || outfitLayout.defaultLayouts()
      const nextLayouts = { ...layouts, [category]: { ...outfitLayout.DEFAULT_LAYOUT[category] } }
      this.setData({ layouts: nextLayouts, renderLayers: this.buildRenderLayers(nextLayouts, this.data.selectedSlot) })
    }
    const slots = { ...this.data.draft.slots, [category]: selected }
    this.persistDraft({ slots, dirty: true })
    if (this.data.selectedSlot === category && !selected) {
      this.deselectSlot()
    }
  },

  // ---- 顶部分段切换（试衣间 = 本页，滚动回顶；我的搭配 = 跳转 saved-outfits）----

  onModeSwitch(event) {
    const mode = event.currentTarget.dataset.mode
    if (mode === 'dressing') {
      wx.pageScrollTo({ scrollTop: 0, duration: 200 })
    } else if (mode === 'saved') {
      this.goSavedOutfits()
    }
  },

  // ---- 「可选入库衣物」筛选胶囊 ----

  onFilterTap(event) {
    const value = event.currentTarget.dataset.value
    if (!value || this.data.activeFilter === value) return
    this.setData({ activeFilter: value })
    this.refreshPresentation()
  },

  // ---- 左栏槽位卡点击：选中画布对应图元（与画布高亮双向联动）----

  onSlotCardTap(event) {
    const slot = event.currentTarget.dataset.slot
    if (!SLOT_ORDER.includes(slot)) return
    this.selectSlot(slot)
  },

  // ---- 自由画布：派生渲染层 ----

  buildRenderLayers(layouts, selectedSlot) {
    const renderLayers = {}
    outfitLayout.SLOT_ORDER.forEach((slot) => {
      renderLayers[slot] = {
        ...outfitLayout.toRenderLayer(slot, layouts && layouts[slot]),
        selected: slot === selectedSlot
      }
    })
    return renderLayers
  },

  refreshRenderLayers() {
    if (!this.data.layouts) return
    this.setData({ renderLayers: this.buildRenderLayers(this.data.layouts, this.data.selectedSlot) })
  },

  // ---- 自由画布：选中 ----

  selectSlot(slot) {
    if (!this.data.draft.slots[slot]) {
      this.deselectSlot()
      return
    }
    const category = CATEGORIES.find((item) => item.value === slot)
    this.setData({
      selectedSlot: slot,
      selectedHint: `${category ? category.label : slot} 已选中，可拖动、缩放，或用左侧卡片上的 ↑ ↓ × 调整层级或移除`
    })
    this.refreshRenderLayers()
  },

  deselectSlot() {
    this.setData({
      selectedSlot: '',
      selectedHint: '点击画布中的单品可选中，拖动调整位置，双指缩放大小'
    })
    this.refreshRenderLayers()
  },

  // ---- 自由画布：挂起 schema 重映射失效（用户布局 mutation 统一 helper）----
  // Round 2B-1 reviewer fix：loadEditor 指纹变化后会挂起 _pendingSchemaRemap，等待
  // boundingClientRect 实测回调把 schema 按实测画布重映射。该回调异步落地，若期间用户
  // 已发生任何布局编辑（拖动/捏合、层级上移下移、单槽/整套重置、换一套、槽位换单品/移除），
  // 且回调仍消费挂起 schema，就会用保存时的旧 schema 物化结果覆盖用户最新 runtime
  // layout（runtime 与已持久化 draft 分叉）。故所有用户布局 mutation 统一调用本 helper
  // 明确失效挂起重映射；失效后同代次量测回调仍正常写实测画布尺寸（clamp 基准），
  // 仅跳过 schema 重映射，未发生用户编辑的正常量测重映射不受影响。
  invalidatePendingSchemaRemap() {
    this._pendingSchemaRemap = null
  },

  measureCanvas(token) {
    if (typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function') return
    // Round 2B-1 reviewer fix：boundingClientRect 回调为异步落地，测量结果属于「发起时的
    // load 代次」。并发 load（onShow/下拉刷新）下旧 load 的测量回调可能在新 loadEditor 落地
    // 之后才返回，若直接执行会消费掉新代次写入的 _pendingSchemaRemap 并重映射/覆盖较新的
    // layouts。故发起时记录 requestToken（loadEditor 显式传本次 token），回调落地前先校验：
    // 过期测量整体丢弃 —— 含 setCanvasSize 模块副作用与 schema 重映射，一律不得触碰
    // 模块几何基准或页面 layouts（画布尺寸随后由最新一代 load 自己的测量回调写入，不丢失）。
    const requestToken = typeof token === 'number' ? token : this._loadToken
    const query = wx.createSelectorQuery()
    query.select('.composition').boundingClientRect((rect) => {
      if (requestToken !== this._loadToken) return
      if (!rect || !rect.width || !rect.height) return
      outfitLayout.setCanvasSize(rect.width * this.rpxPerPx, rect.height * this.rpxPerPx)
    // Round 2B-1：量测完成后再把已保存 schema 物化布局按「存储基准 → 实测画布」重映射一次，
    // 让不同屏幕尺寸恢复的摆放与保存时一致（此前仅用回退画布粗物化）。
    // 同代次内若用户已编辑布局，pending 已被 invalidatePendingSchemaRemap 失效，
    // 此处仅剩 setCanvasSize 生效，不再覆盖用户 layout。
      if (this._pendingSchemaRemap) {
        const schema = this._pendingSchemaRemap
        this._pendingSchemaRemap = null
        const current = this.data.layouts
        const nextLayouts = outfitLayout.materializeLayout(schema)
        if (JSON.stringify(current) !== JSON.stringify(nextLayouts)) {
          this.setData({
            layouts: nextLayouts,
            renderLayers: this.buildRenderLayers(nextLayouts, this.data.selectedSlot)
          })
        }
      }
    }).exec()
  },

  onCanvasTap() {
    this.deselectSlot()
  },

  // ---- 自由画布：单指拖动 / 双指捏合缩放 ----

  touchDistance(touches) {
    if (!touches || touches.length < 2) return 0
    const dx = touches[1].clientX - touches[0].clientX
    const dy = touches[1].clientY - touches[0].clientY
    return Math.sqrt(dx * dx + dy * dy)
  },

  onLayerTouchStart(event) {
    if (this.data.state !== 'ready' || !this.data.layouts) return
    const slot = event.currentTarget.dataset.slot
    if (!slot || !SLOT_ORDER.includes(slot) || !this.data.layouts[slot]) return
    const gesture = this._gesture
    if (gesture && gesture.active) {
      // 第二根手指落下（捏合开始），以当前间距为缩放基准
      if (event.touches.length >= 2) {
        gesture.pinchStartDist = this.touchDistance(event.touches)
        gesture.pinchStartScale = this.data.layouts[gesture.slot].scale
      }
      return
    }
    const touch = event.touches[0]
    this._gesture = {
      slot,
      active: true,
      moved: false,
      startX: touch.clientX,
      startY: touch.clientY,
      startLayout: { ...this.data.layouts[slot] },
      pinchStartDist: 0,
      pinchStartScale: 1
    }
    this.selectSlot(slot)
  },

  applyLayout(slot, patch, clamp) {
    const layouts = this.data.layouts
    const current = layouts && layouts[slot]
    if (!current) return
    // 拖动/捏合即用户布局编辑：失效挂起 schema 重映射（旧量测回调不得再用旧 schema 覆盖）
    this.invalidatePendingSchemaRemap()
    let next = { ...current, ...patch }
    if (clamp) next = outfitLayout.clampToCanvas(next, slot)
    const nextLayouts = { ...layouts, [slot]: next }
    this.setData({
      layouts: nextLayouts,
      renderLayers: this.buildRenderLayers(nextLayouts, this.data.selectedSlot)
    })
  },

  onLayerTouchMove(event) {
    const gesture = this._gesture
    if (!gesture || !gesture.active) return
    const layouts = this.data.layouts
    if (!layouts || !layouts[gesture.slot]) return
    if (event.touches.length >= 2) {
      // 双指捏合：按间距比例缩放，限幅 [0.3, 3]
      const dist = this.touchDistance(event.touches)
      if (!gesture.pinchStartDist) {
        gesture.pinchStartDist = dist
        gesture.pinchStartScale = layouts[gesture.slot].scale
      } else if (dist > 0) {
        const scale = outfitLayout.clampScale((gesture.pinchStartScale * dist) / gesture.pinchStartDist)
        this.applyLayout(gesture.slot, { scale }, true)
      }
      gesture.moved = true
      return
    }
    // 单指拖动：以手势起点为基准计算位移（rpx），避免累加漂移
    const touch = event.touches[0]
    const deltaX = (touch.clientX - gesture.startX) * this.rpxPerPx
    const deltaY = (touch.clientY - gesture.startY) * this.rpxPerPx
    if (Math.abs(deltaX) + Math.abs(deltaY) > 1) gesture.moved = true
    this.applyLayout(gesture.slot, {
      x: gesture.startLayout.x + deltaX,
      y: gesture.startLayout.y + deltaY
    }, true)
  },

  onLayerTouchEnd(event) {
    const gesture = this._gesture
    if (!gesture || !gesture.active) return
    if (event.touches && event.touches.length === 1) {
      // 捏合后剩一指：重新以剩余手指为拖拽基准
      gesture.startX = event.touches[0].clientX
      gesture.startY = event.touches[0].clientY
      const current = this.data.layouts && this.data.layouts[gesture.slot]
      if (current) gesture.startLayout = { ...current }
      gesture.pinchStartDist = 0
      return
    }
    this._gesture = null
    // Round 2B-1：拖动/捏合结束即落盘 layout 快照（含 dirty），中断后 reload/restart 可恢复。
    if (gesture.moved) this.persistDraft({ dirty: true })
  },

  // ---- 自由画布：图层与重置工具 ----
  // Round 1.5.1：上移/下移改绑到左栏槽位卡内的 ↑ ↓ 小按钮（data-slot 指向该卡槽位），
  // 未传事件时回退当前选中槽位；语义仍复用 outfitLayout.moveLayer，命令本身不变。

  onLayerUp(event) {
    this.moveSelectedLayer(1, event)
  },

  onLayerDown(event) {
    this.moveSelectedLayer(-1, event)
  },

  moveSelectedLayer(delta, event) {
    const slot = (event && event.currentTarget && event.currentTarget.dataset.slot) || this.data.selectedSlot
    if (!slot || !SLOT_ORDER.includes(slot)) return
    if (!this.data.draft.slots[slot]) return
    // 层级上移/下移即用户布局编辑：失效挂起 schema 重映射
    this.invalidatePendingSchemaRemap()
    const nextLayouts = outfitLayout.moveLayer(this.data.layouts, slot, delta)
    this.setData({
      selectedSlot: slot,
      layouts: nextLayouts,
      renderLayers: this.buildRenderLayers(nextLayouts, slot)
    })
    // Round 2B-1：层级调整落盘 layout 快照，保存/重启后可恢复。
    this.persistDraft({ dirty: true })
  },

  onResetSlot() {
    const slot = this.data.selectedSlot
    if (!slot) return
    // 单槽重置即用户布局编辑：失效挂起 schema 重映射
    this.invalidatePendingSchemaRemap()
    const nextLayouts = outfitLayout.resetSlot(this.data.layouts, slot)
    this.setData({
      layouts: nextLayouts,
      renderLayers: this.buildRenderLayers(nextLayouts, slot)
    })
    // Round 2B-1：重置落盘 layout 快照，保存/重启后可恢复。
    this.persistDraft({ dirty: true })
  },

  onResetAll() {
    // 整套重置即用户布局编辑：失效挂起 schema 重映射
    this.invalidatePendingSchemaRemap()
    const nextLayouts = outfitLayout.defaultLayouts()
    this.setData({
      layouts: nextLayouts,
      renderLayers: this.buildRenderLayers(nextLayouts, this.data.selectedSlot)
    })
    // Round 2B-1：整套重置落盘 layout 快照，保存/重启后可恢复。
    this.persistDraft({ dirty: true })
  },

  onShuffle() {
    const season = getCurrentSeason()
    const eligible = this.data.wardrobe.filter((item) => {
      const seasons = item.seasons || []
      return !seasons.length || seasons.includes(season)
    })
    const pools = {}
    SLOT_ORDER.forEach((slot) => {
      pools[slot] = eligible.filter((item) => item.category === slot)
    })
    const missing = REQUIRED_SLOTS.filter((slot) => !pools[slot].length)
    if (missing.length) {
      const labels = missing.map((slot) => CATEGORIES.find((item) => item.value === slot).label)
      wx.showModal({
        title: '当前季节单品不足',
        content: `还缺${labels.join('、')}，补充后才能换一套。`,
        confirmText: '去衣橱',
        success: ({ confirm }) => {
          if (confirm) this.goWardrobe()
        }
      })
      return
    }

    let nextSlots
    let attempts = 0
    do {
      nextSlots = {
        hat: pools.hat.length && Math.random() > 0.35 ? randomFrom(pools.hat) : null,
        top: randomFrom(pools.top),
        bottom: randomFrom(pools.bottom),
        shoes: randomFrom(pools.shoes),
        bag: pools.bag.length && Math.random() > 0.35 ? randomFrom(pools.bag) : null
      }
      attempts += 1
    } while (attempts < 6 && this.sameSlots(nextSlots, this.data.draft.slots))
    // Round 2B-1：换一套即整套槽位替换，旧画布摆放不再适用 —— 画布复位默认再落盘，
    // 避免把上一套的拖放/缩放/层级残留到随机新套装上。
    // 整套替换即用户布局编辑：失效挂起 schema 重映射。
    this.invalidatePendingSchemaRemap()
    const resetLayouts = outfitLayout.defaultLayouts()
    this.setData({ layouts: resetLayouts, renderLayers: this.buildRenderLayers(resetLayouts, this.data.selectedSlot) })
    this.persistDraft({ slots: nextSlots, dirty: true })
    wx.showToast({ title: `已按${SEASON_MAP[season]}季更换`, icon: 'none' })
  },

  sameSlots(left, right) {
    return SLOT_ORDER.every((slot) => itemId(left[slot]) === itemId(right[slot]))
  },

  onSaveTap() {
    const validation = this.validateSlots()
    if (validation) {
      wx.showToast({ title: validation, icon: 'none' })
      return
    }
    this.setData({ saveOpen: true })
  },

  validateSlots() {
    const { slots } = this.data.draft
    const missingDeleted = SLOT_ORDER.filter((slot) => slots[slot] && slots[slot].missing)
    if (missingDeleted.length) return '请先替换已删除或分类已变化的单品'
    const missing = REQUIRED_SLOTS.filter((slot) => !slots[slot])
    if (missing.length) {
      const labels = missing.map((slot) => CATEGORIES.find((item) => item.value === slot).label)
      return `请先选择${labels.join('、')}`
    }
    const mismatch = SLOT_ORDER.find((slot) => slots[slot] && slots[slot].category !== slot)
    if (mismatch) return '请重新选择分类不匹配的单品'
    return ''
  },

  closeSaveSheet() {
    if (!this.data.saving) this.setData({ saveOpen: false })
  },

  stopPropagation() {},

  onTitleInput(event) {
    this.persistDraft({ title: event.detail.value, dirty: true })
  },

  onSeasonSelect(event) {
    this.persistDraft({ season: event.currentTarget.dataset.value, dirty: true })
  },

  onStyleSelect(event) {
    this.persistDraft({ style: event.currentTarget.dataset.value, dirty: true })
  },

  validateForm() {
    const slotMessage = this.validateSlots()
    if (slotMessage) return slotMessage
    const { title, season, style } = this.data.draft
    if (!String(title || '').trim()) return '请填写搭配名称'
    if (!season) return '请选择季节'
    if (!style) return '请选择风格'
    return ''
  },

  // Round 2B-1：保存 payload 携带序列化 layout（schema，与 items 分离）；
  // app-service buildOutfit 的 alignLayoutToItems 负责与槽位单品最终对齐后持久化。
  buildPayload() {
    const { draft } = this.data
    return {
      title: String(draft.title).trim(),
      season: draft.season,
      style: draft.style,
      items: draft.slots,
      layout: this.serializeCurrentLayout()
    }
  },

  async onCreateSave() {
    await this.commitSave('create')
  },

  async onUpdateSave() {
    await this.commitSave('update')
  },

  async onSaveAsNew() {
    await this.commitSave('copy')
  },

  async commitSave(action) {
    // Round 2B-1：保存中防护 —— 重复点击/并行提交直接忽略，避免重复 create/update 记录。
    if (this._saveInFlight || this.data.saving) return
    const message = this.validateForm()
    if (message) {
      wx.showToast({ title: message, icon: 'none' })
      return
    }
    this._saveInFlight = true
    this.setData({ saving: true })
    // Round 2B-1 reviewer fix：保存「开始时刻」的 items + layout 同源快照。
    // 保存期间若发生并发 loadEditor（onShow/下拉刷新）替换 this.data.draft，
    // 完成回调一律基于本快照拼回草稿 —— 绝不把「保存结束时的 this.data.draft.items」
    // 与「旧 saved.layout」混写成新 draft（items 新、layout 旧交叉混写）。
    const snapshotDraft = { ...this.data.draft, slots: { ...this.data.draft.slots } }
    const snapshotLayout = this.serializeSlotsLayout(snapshotDraft.slots)
    try {
      let saved
      if (action === 'update') {
        saved = await appService.updateSavedOutfit(snapshotDraft.sourceOutfitId, {
          title: String(snapshotDraft.title).trim(),
          season: snapshotDraft.season,
          style: snapshotDraft.style,
          items: snapshotDraft.slots,
          layout: snapshotLayout
        })
      } else {
        saved = await appService.createSavedOutfit({
          title: String(snapshotDraft.title).trim(),
          season: snapshotDraft.season,
          style: snapshotDraft.style,
          items: snapshotDraft.slots,
          layout: snapshotLayout
        })
      }
      const isUpdate = action === 'update'
      const draft = {
        ...snapshotDraft,
        sourceOutfitId: isUpdate ? saved.id : null,
        mode: isUpdate ? 'edit' : 'create',
        dirty: false,
        // Round 2B-1：保存成功后把「实际入云的 layout」（align 后）写回 draft 快照，
        // 与云端/本地记录严格一致；快照兜底（saved.layout 缺失时）用保存开始时刻的
        // items+layout 同源序列化，保证 items 与 layout 永不交叉混写。
        layout: saved.layout || snapshotLayout
      }
      appService.persistOutfitDraft(draft)
      this.setData({ draft, saveOpen: false, saving: false })
      this.refreshPresentation()
      if (saved.syncStatus === 'synced') {
        wx.showToast({ title: isUpdate ? '已更新搭配' : '已保存搭配', icon: 'success' })
      } else {
        wx.showModal({
          title: isUpdate ? '已更新到本机' : '已保存到本机',
          content: saved.syncStatus === 'failed' ? '云端同步失败，稍后会自动重试。' : '云端同步待处理，身份或网络恢复后会自动重试。',
          showCancel: false
        })
      }
    } catch (error) {
      wx.showToast({ title: (error && error.message) || '保存失败，请重试', icon: 'none' })
    } finally {
      this._saveInFlight = false
      this.setData({ saving: false })
    }
  },

  goSavedOutfits() {
    wx.navigateTo({ url: '/pages/saved-outfits/index' })
  },

  goWardrobe() {
    wx.switchTab({ url: '/pages/wardrobe/wardrobe' })
  }
})
