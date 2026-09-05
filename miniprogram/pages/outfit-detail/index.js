const appService = require('../../services/app-service')
const { CATEGORIES, SEASON_MAP, STYLE_MAP } = require('../../utils/constants')

const SLOT_ORDER = ['hat', 'top', 'bottom', 'shoes', 'bag']

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDate(value) {
  let date
  if (typeof value === 'number') date = new Date(value)
  else if (value && typeof value === 'object' && typeof value.toDate === 'function') date = value.toDate()
  else date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return '日期未知'
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`
}

function snapshotOf(slot) {
  return slot && (slot.snapshot || slot)
}

function itemIdOf(slot) {
  return slot && String(slot.itemId || slot.id || '')
}

function presentOutfit(outfit, activeIds) {
  const items = outfit.items || outfit.slots || {}
  const layers = []
  const pieces = SLOT_ORDER.map((slot) => {
    const item = items[slot]
    const snapshot = snapshotOf(item)
    const imageUrl = snapshot && (snapshot.imageUrl || snapshot.imageFileId || '')
    const itemId = itemIdOf(item)
    const missing = Boolean(item && itemId && (!activeIds.has(itemId) || (snapshot.category && snapshot.category !== slot)))
    if (imageUrl) layers.push({ slot, imageUrl, missing })
    const category = CATEGORIES.find((option) => option.value === slot)
    return {
      slot,
      label: category ? category.label : slot,
      optional: slot === 'hat' || slot === 'bag',
      name: snapshot ? snapshot.name || '已保存单品' : '未选择',
      imageUrl,
      missing
    }
  })
  return {
    ...outfit,
    id: String(outfit.id || outfit._id || ''),
    title: outfit.title || outfit.name || '未命名穿搭',
    seasonLabel: SEASON_MAP[outfit.season] || '',
    styleLabel: STYLE_MAP[outfit.style] || '',
    savedDate: formatDate(outfit.savedAt || outfit.updatedAt || outfit.createdAt),
    pieces,
    layers,
    hasMissing: pieces.some((piece) => piece.missing)
  }
}

Page({
  data: {
    outfitId: '',
    state: 'loading',
    errorMessage: '',
    outfit: null,
    isToday: false,
    settingToday: false,
    deleting: false
  },

  onLoad(options) {
    this.setData({ outfitId: options.outfitId ? decodeURIComponent(options.outfitId) : '' })
  },

  onShow() {
    this.loadDetail()
  },

  async loadDetail() {
    if (!this.data.outfitId) {
      this.setData({ state: 'error', errorMessage: '缺少搭配信息' })
      return
    }
    this.setData({ state: 'loading', errorMessage: '' })
    try {
      await appService.listSavedOutfits()
      const [outfit, wardrobeResult, todayResult] = await Promise.all([
        appService.getSavedOutfit(this.data.outfitId),
        appService.listWardrobeItems({ includeDeleted: false }),
        appService.getTodayOutfit()
      ])
      if (!outfit) throw new Error('这套搭配已不存在')
      const wardrobe = Array.isArray(wardrobeResult) ? wardrobeResult : (wardrobeResult && wardrobeResult.items) || []
      const activeIds = new Set(wardrobe.filter((item) => !item.deletedAt).map((item) => String(item.id || item._id)))
      const assignment = todayResult && todayResult.assignment
      this.setData({
        outfit: presentOutfit(outfit, activeIds),
        isToday: Boolean(assignment && assignment.outfitId === this.data.outfitId),
        state: 'ready'
      })
    } catch (error) {
      this.setData({
        outfit: null,
        state: 'error',
        errorMessage: (error && error.message) || '穿搭详情加载失败'
      })
    }
  },

  setToday() {
    if (this.data.settingToday || !this.data.outfit) return
    wx.showModal({
      title: '设为今日穿搭？',
      content: `确定将“${this.data.outfit.title}”设为今天的穿搭吗？`,
      confirmText: '确定设置',
      confirmColor: '#ef5478',
      success: async ({ confirm }) => {
        if (!confirm) return
        this.setData({ settingToday: true })
        try {
          await appService.setTodayOutfit(this.data.outfitId)
          this.setData({ isToday: true, settingToday: false })
          wx.showToast({ title: '已设为今日穿搭', icon: 'success' })
        } catch (error) {
          this.setData({ settingToday: false })
          wx.showToast({ title: (error && error.message) || '设置失败', icon: 'none' })
        }
      }
    })
  },

  editOutfit() {
    if (!this.data.outfit) return
    const existingDraft = appService.getOutfitDraft()
    if (existingDraft && existingDraft.dirty) {
      wx.showModal({
        title: '替换未保存草稿？',
        content: '穿搭页还有未保存的修改。继续将用当前历史搭配替换它。',
        confirmText: '替换',
        confirmColor: '#ef5478',
        success: ({ confirm }) => {
          if (confirm) this.loadIntoEditor()
        }
      })
      return
    }
    this.loadIntoEditor()
  },

  loadIntoEditor() {
    const outfit = this.data.outfit
    appService.persistOutfitDraft({
      sourceOutfitId: outfit.id,
      slots: outfit.items || outfit.slots,
      // Round 2B-1：编辑 handoff 携带已保存 layout（与 sourceOutfitId/mode 一起），
      // 穿搭页据此恢复保存时的画布布局；legacy 无 layout 时穿搭页回退默认布局。
      layout: outfit.layout || null,
      title: outfit.title,
      season: outfit.season,
      style: outfit.style,
      mode: 'edit',
      dirty: false
    })
    wx.switchTab({ url: '/pages/outfit/index' })
  },

  deleteOutfit() {
    if (this.data.deleting || !this.data.outfit) return
    wx.showModal({
      title: '删除这套搭配？',
      content: '删除后无法在历史搭配中找回。',
      confirmText: '删除',
      confirmColor: '#d65b70',
      success: async ({ confirm }) => {
        if (!confirm) return
        this.setData({ deleting: true })
        wx.showLoading({ title: '删除中', mask: true })
        try {
          const result = await appService.deleteSavedOutfit(this.data.outfitId)
          wx.hideLoading()
          if (result.syncStatus === 'synced') {
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 450)
          } else {
            wx.showModal({
              title: '已从本机删除',
              content: '云端删除尚未同步，稍后会自动重试。',
              showCancel: false,
              success: () => wx.navigateBack()
            })
          }
        } catch (error) {
          wx.hideLoading()
          this.setData({ deleting: false })
          wx.showToast({ title: (error && error.message) || '删除失败', icon: 'none' })
        }
      }
    })
  }
})
