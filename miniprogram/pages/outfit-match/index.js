const appService = require('../../services/app-service')
const {
  SEASON_MAP,
  STYLE_MAP,
  getCurrentSeason
} = require('../../utils/constants')

const ROUTES = {
  detail: '/pages/outfit-detail/index',
  outfitTab: '/pages/outfit/index'
}

function timestamp(value) {
  if (!value) return 0
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    return value.toDate().getTime()
  }
  if (typeof value === 'object' && Number.isFinite(value.$date)) {
    return value.$date
  }
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDate(value) {
  const time = timestamp(value)
  if (!time) return ''
  const date = new Date(time)
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
}

function getSlotImage(slot) {
  if (!slot) return ''
  const snapshot = slot.snapshot || slot
  return snapshot.imageUrl || snapshot.imagePath || snapshot.tempFileURL || snapshot.fileUrl || ''
}

function getPreviewItems(outfit) {
  const slots = outfit && (outfit.items || outfit.slots || {
    top: outfit.top,
    bottom: outfit.bottom,
    shoes: outfit.shoes,
    bag: outfit.bag || outfit.accessory
  })
  if (!slots) return []
  return ['hat', 'top', 'bottom', 'shoes', 'bag']
    .map((slot) => ({ slot, imageUrl: getSlotImage(slots[slot]) }))
    .filter((item) => item.imageUrl)
}

function normalizeOutfit(outfit) {
  if (!outfit) return null
  const season = outfit.season || ''
  const style = outfit.style || ''
  const date = outfit.savedAt || outfit.updatedAt || outfit.createdAt
  return {
    id: outfit.id || outfit._id || '',
    title: outfit.title || outfit.name || '未命名穿搭',
    season,
    style,
    seasonLabel: SEASON_MAP[season] || '',
    styleLabel: STYLE_MAP[style] || '',
    savedDate: formatDate(date),
    sortTime: timestamp(date),
    previewImageUrl: outfit.previewImageUrl || outfit.previewUrl || '',
    previewItems: getPreviewItems(outfit)
  }
}

Page({
  data: {
    season: '',
    style: 'all',
    seasonLabel: '',
    styleLabel: '不限',
    state: 'loading',
    results: [],
    errorMessage: ''
  },

  onLoad(options) {
    const season = SEASON_MAP[options.season] ? options.season : getCurrentSeason()
    const style = options.style === 'all' || STYLE_MAP[options.style] ? options.style : 'all'
    this.setData({
      season,
      style,
      seasonLabel: SEASON_MAP[season],
      styleLabel: style === 'all' ? '不限' : STYLE_MAP[style]
    })
    this.loadMatches()
  },

  onPullDownRefresh() {
    this.loadMatches().finally(() => wx.stopPullDownRefresh())
  },

  async loadMatches() {
    this.setData({ state: 'loading', errorMessage: '' })
    try {
      const response = await appService.listSavedOutfits({
        season: this.data.season,
        style: this.data.style,
        order: 'desc'
      })
      const list = Array.isArray(response) ? response : (response && response.items) || []
      const results = list
        .map(normalizeOutfit)
        .filter((item) => item && item.id)
        .sort((a, b) => b.sortTime - a.sortTime)
      this.setData({ results, state: 'ready' })
    } catch (error) {
      this.setData({
        state: 'error',
        results: [],
        errorMessage: (error && error.message) || '匹配穿搭加载失败，请稍后重试'
      })
    }
  },

  onRetry() {
    this.loadMatches()
  },

  onOutfitTap(event) {
    const outfitId = event.currentTarget.dataset.id
    if (!outfitId) return
    wx.navigateTo({
      url: `${ROUTES.detail}?outfitId=${encodeURIComponent(outfitId)}`
    })
  },

  onAdjustFilters() {
    wx.navigateBack()
  },

  onGoOutfitTab() {
    wx.switchTab({ url: ROUTES.outfitTab })
  }
})
