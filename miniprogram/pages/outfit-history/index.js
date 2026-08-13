const appService = require('../../services/app-service')
const { SEASON_MAP, STYLE_MAP } = require('../../utils/constants')

const SLOT_ORDER = ['hat', 'top', 'bottom', 'shoes', 'bag']

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDate(value) {
  const date = typeof value === 'number' ? new Date(value) : new Date(value || '')
  if (Number.isNaN(date.getTime())) return ''
  return `${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
}

function imageOf(slot) {
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
    layers: SLOT_ORDER.map((slot) => ({ slot, imageUrl: imageOf(items[slot]) })).filter((item) => item.imageUrl)
  }
}

Page({
  data: {
    source: '',
    state: 'loading',
    errorMessage: '',
    loadingCards: [1, 2, 3],
    outfits: []
  },

  onLoad(options) {
    this.setData({ source: options.source || '' })
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
      this.setData({ outfits: list.map(presentOutfit).filter((item) => item.id), state: 'ready' })
    } catch (error) {
      this.setData({
        outfits: [],
        state: 'error',
        errorMessage: (error && error.message) || '历史搭配加载失败'
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
