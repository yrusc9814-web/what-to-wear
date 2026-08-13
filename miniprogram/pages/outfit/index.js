const appService = require('../../services/app-service')
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
    styleOptions: STYLES
  },

  onLoad() {
    this.hasLoaded = false
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
      this.setData({ wardrobe, draft, state: 'ready' })
      this.refreshPresentation()
      if (storedDraft) appService.persistOutfitDraft(draft)
      this.hasLoaded = true
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
    const missingSlotLabels = SLOT_ORDER
      .filter((slot) => draft.slots[slot] && draft.slots[slot].missing)
      .map((slot) => CATEGORIES.find((item) => item.value === slot).label)
    const style = draft.style || this.inferStyle(draft.slots)
    this.setData({
      groups,
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
