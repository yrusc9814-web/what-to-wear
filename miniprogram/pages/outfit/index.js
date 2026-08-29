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
    dirty: false
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
    // 自由画布布局：仅页面内 data 状态，不入云、不进保存协议（V1.5 第二轮接云端持久化）
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
    this.hasLoadedLayout = false
    this.lastLayoutFingerprint = ''
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
    this.setData({ state: 'loading', errorMessage: '' })
    try {
      const wardrobeResult = await appService.listWardrobeItems({ includeDeleted: false })
      const wardrobe = (Array.isArray(wardrobeResult) ? wardrobeResult : (wardrobeResult && wardrobeResult.items) || [])
        .filter((item) => !item.deletedAt)
        .map(presentItem)
      const storedDraft = appService.getOutfitDraft()
      const draft = this.reconcileDraft(storedDraft || emptyDraft(), wardrobe)
      // 布局重建策略：仅在首次加载（尚未初始化）或 draft 内容指纹变化（套装内容
      // 真的变了）时重置 layouts；onShow 等场景保留用户已调整的布局。
      const fingerprint = SLOT_ORDER.map((slot) => itemId(draft.slots[slot])).join('|')
      const layoutsChanged = !this.hasLoadedLayout || fingerprint !== this.lastLayoutFingerprint
      const layouts = layoutsChanged
        ? outfitLayout.defaultLayouts()
        : (this.data.layouts || outfitLayout.defaultLayouts())
      const selectedSlot = layoutsChanged ? '' : this.data.selectedSlot
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
      if (storedDraft) appService.persistOutfitDraft(draft)
      this.hasLoaded = true
      this.measureCanvas()
    } catch (error) {
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
      dirty: Boolean(source.dirty)
    }
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
    this.setData({ draft })
    appService.persistOutfitDraft(draft)
    this.refreshPresentation()
  },

  onSelectItem(event) {
    const category = event.currentTarget.dataset.category
    const id = String(event.currentTarget.dataset.id || '')
    if (!SLOT_ORDER.includes(category)) return
    const selected = id ? this.data.wardrobe.find((item) => item.id === id) || null : null
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

  measureCanvas() {
    if (typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function') return
    const query = wx.createSelectorQuery()
    query.select('.composition').boundingClientRect((rect) => {
      if (!rect || !rect.width || !rect.height) return
      outfitLayout.setCanvasSize(rect.width * this.rpxPerPx, rect.height * this.rpxPerPx)
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
    const nextLayouts = outfitLayout.moveLayer(this.data.layouts, slot, delta)
    this.setData({
      selectedSlot: slot,
      layouts: nextLayouts,
      renderLayers: this.buildRenderLayers(nextLayouts, slot)
    })
  },

  onResetSlot() {
    const slot = this.data.selectedSlot
    if (!slot) return
    const nextLayouts = outfitLayout.resetSlot(this.data.layouts, slot)
    this.setData({
      layouts: nextLayouts,
      renderLayers: this.buildRenderLayers(nextLayouts, slot)
    })
  },

  onResetAll() {
    const nextLayouts = outfitLayout.defaultLayouts()
    this.setData({
      layouts: nextLayouts,
      renderLayers: this.buildRenderLayers(nextLayouts, this.data.selectedSlot)
    })
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

  // 保存协议本轮不变：payload 不携带画布 layout（layout 仅存页面 data 状态，
  // V1.5 第二轮接云端持久化）
  buildPayload() {
    const { draft } = this.data
    return {
      title: String(draft.title).trim(),
      season: draft.season,
      style: draft.style,
      items: draft.slots
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
    if (this.data.saving) return
    const message = this.validateForm()
    if (message) {
      wx.showToast({ title: message, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      let saved
      if (action === 'update') {
        saved = await appService.updateSavedOutfit(this.data.draft.sourceOutfitId, this.buildPayload())
      } else {
        saved = await appService.createSavedOutfit(this.buildPayload())
      }
      const isUpdate = action === 'update'
      const draft = {
        ...this.data.draft,
        sourceOutfitId: isUpdate ? saved.id : null,
        mode: isUpdate ? 'edit' : 'create',
        dirty: false
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
      this.setData({ saving: false })
      wx.showToast({ title: (error && error.message) || '保存失败，请重试', icon: 'none' })
    }
  },

  goSavedOutfits() {
    wx.navigateTo({ url: '/pages/saved-outfits/index' })
  },

  goWardrobe() {
    wx.switchTab({ url: '/pages/wardrobe/wardrobe' })
  }
})
