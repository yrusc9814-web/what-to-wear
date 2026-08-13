const appService = require('../../services/app-service')
const { SEASON_MAP, STYLE_MAP } = require('../../utils/constants')

const SLOT_ORDER = ['hat', 'top', 'bottom', 'shoes', 'bag']

function pad(value) {
  return String(value).padStart(2, '0')
}

function toDate(value) {
  if (typeof value === 'number') return new Date(value)
  if (value && typeof value === 'object' && typeof value.toDate === 'function') return value.toDate()
  return new Date(value)
}

function formatDate(value) {
  if (!value) return ''
  const date = toDate(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
}

function slotImage(slot) {
  if (!slot) return ''
  const snapshot = slot.snapshot || slot
  return snapshot.imageUrl || snapshot.imageFileId || ''
}

function presentOutfit(outfit) {
  const items = outfit.items || outfit.slots || {}
  return {
    ...outfit,
    id: String(outfit.id || outfit._id || ''),
    title: outfit.title || outfit.name || '未命名穿搭',
    seasonLabel: SEASON_MAP[outfit.season] || '',
    styleLabel: STYLE_MAP[outfit.style] || '',
    savedDate: formatDate(outfit.savedAt || outfit.updatedAt || outfit.createdAt),
    layers: SLOT_ORDER.map((slot) => ({ slot, imageUrl: slotImage(items[slot]) })).filter((item) => item.imageUrl)
  }
}

Page({
  data: {
    state: 'loading',
    errorMessage: '',
    loadingCards: [1, 2, 3, 4],
    outfits: [],
    subtitleText: '查看和管理你保存的搭配'
  },

  onShow() {
    this.loadOutfits()
  },

  onPullDownRefresh() {
    this.loadOutfits().finally(() => wx.stopPullDownRefresh())
  },

  async loadOutfits() {
    this.setData({ state: 'loading', errorMessage: '' })
    try {
      const result = await appService.listSavedOutfits({ order: 'desc' })
      const list = Array.isArray(result) ? result : (result && result.items) || []
      this.setData({
        outfits: list.map(presentOutfit).filter((item) => item.id),
        subtitleText: `已保存 ${list.length} 套`,
        state: 'ready'
      })
    } catch (error) {
      this.setData({
        outfits: [],
        subtitleText: '查看和管理你保存的搭配',
        state: 'error',
        errorMessage: (error && error.message) || '搭配加载失败'
      })
    }
  },

  openOutfit(event) {
    const outfitId = event.currentTarget.dataset.id
    if (!outfitId) return
    wx.navigateTo({ url: `/pages/outfit-detail/index?outfitId=${encodeURIComponent(outfitId)}` })
  },

  goOutfit() {
    wx.switchTab({ url: '/pages/outfit/index' })
  }
})
