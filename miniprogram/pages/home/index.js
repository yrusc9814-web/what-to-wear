const appService = require('../../services/app-service')
const {
  SEASON_OPTIONS,
  STYLE_FILTER_OPTIONS,
  getCurrentSeason
} = require('../../utils/constants')

const ROUTES = {
  history: '/pages/outfit-history/index?source=home',
  detail: '/pages/outfit-detail/index',
  savedOutfits: '/pages/saved-outfits/index',
  citySelect: '/pages/city-select/index',
  profile: '/pages/profile/index',
  outfitTab: '/pages/outfit/index'
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDate(date) {
  const value = date || new Date()
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return `今天 · ${value.getMonth() + 1}月${value.getDate()}日 周${weekdays[value.getDay()]}`
}

function formatSavedDate(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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
  const savedAt = outfit.savedAt || outfit.updatedAt || outfit.createdAt
  return {
    id: outfit.id || outfit._id || '',
    title: outfit.title || outfit.name || '未命名穿搭',
    season: outfit.season || '',
    style: outfit.style || '',
    previewImageUrl: outfit.previewImageUrl || outfit.previewUrl || '',
    previewItems: getPreviewItems(outfit),
    savedDate: formatSavedDate(savedAt),
    sortTime: timestamp(savedAt)
  }
}

function normalizeWeather(weather) {
  const value = weather || {}
  const todayForecast = value.forecast && value.forecast[0] ? value.forecast[0] : {}
  const rawIcon = value.icon === 0 || value.icon ? String(value.icon) : ''
  const iconIsUrl = /^(https?:|cloud:|wxfile:|\/)/.test(rawIcon)
  const condition = value.condition || value.weatherText || ''
  const iconText = (() => {
    if (rawIcon && !iconIsUrl && !/^\d+$/.test(rawIcon)) return rawIcon
    if (/雨|雷/.test(condition)) return '☔'
    if (/雪/.test(condition)) return '❄'
    if (/阴|云|雾/.test(condition)) return '☁'
    return '☀'
  })()
  return {
    condition,
    currentTemp: value.currentTemp === 0 || value.currentTemp
      ? value.currentTemp
      : (value.temp === 0 || value.temp ? value.temp : null),
    minTemp: value.minTemp === 0 || value.minTemp
      ? value.minTemp
      : (todayForecast.tempMin === 0 || todayForecast.tempMin ? todayForecast.tempMin : null),
    maxTemp: value.maxTemp === 0 || value.maxTemp
      ? value.maxTemp
      : (todayForecast.tempMax === 0 || todayForecast.tempMax ? todayForecast.tempMax : null),
    iconUrl: iconIsUrl ? rawIcon : '',
    iconText: iconIsUrl ? '' : iconText,
    outfitAdvice: value.outfitAdvice || value.outfitSuggestion || value.advice || '暂无穿搭建议'
  }
}

Page({
  data: {
    dateText: '',
    user: { avatarUrl: '' },
    userState: 'loading',
    location: { cityName: '', source: 'manual' },
    weather: normalizeWeather(null),
    weatherState: 'loading',
    weatherError: '',
    todayOutfit: null,
    todayState: 'loading',
    recentOutfits: [],
    recentState: 'loading',
    loadingCards: [1, 2, 3, 4],
    seasonOptions: SEASON_OPTIONS,
    styleOptions: STYLE_FILTER_OPTIONS,
    filters: {
      season: getCurrentSeason(),
      style: 'all'
    }
  },

  onLoad() {
    this._unloaded = false
    this.setData({ dateText: formatDate(new Date()) })
  },

  onUnload() {
    this._unloaded = true
    this.weatherRequestId = (this.weatherRequestId || 0) + 1
  },

  onShow() {
    this.refreshHome()
  },

  onPullDownRefresh() {
    this.refreshHome().finally(() => wx.stopPullDownRefresh())
  },

  refreshHome() {
    return Promise.all([
      this.loadUser(),
      this.loadLocationAndWeather(),
      this.loadTodayOutfit(),
      this.loadRecentOutfits()
    ])
  },

  async loadUser() {
    this.setData({ userState: 'loading' })
    try {
      const user = await appService.getCurrentUser()
      this.setData({
        user: { avatarUrl: user && user.avatarUrl ? user.avatarUrl : '' },
        userState: 'ready'
      })
    } catch (error) {
      this.setData({ user: { avatarUrl: '' }, userState: 'error' })
    }
  },

  async loadLocationAndWeather() {
    const requestId = (this.weatherRequestId || 0) + 1
    this.weatherRequestId = requestId
    this.setData({ weatherState: 'loading', weatherError: '' })
    let location
    try {
      location = await appService.getLocation()
      if (this._unloaded || requestId !== this.weatherRequestId) return
      this.setData({ location: location || { cityName: '', source: 'manual' } })
    } catch (error) {
      if (this._unloaded || requestId !== this.weatherRequestId) return
      this.setData({
        weatherState: 'error',
        weatherError: '无法获取当前城市，请重新定位或手动选择'
      })
      return
    }

    if (!location || !location.cityName || location.cityName === '未选择城市') {
      this.setData({
        weatherState: 'error',
        weatherError: '还没有选择城市'
      })
      return
    }

    try {
      const weather = await appService.getWeather(location)
      if (this._unloaded || requestId !== this.weatherRequestId) return
      const resolvedLocation = {
        ...location,
        cityName: weather.cityName || location.cityName,
        latitude: weather.latitude,
        longitude: weather.longitude,
        source: weather.source || location.source
      }
      appService.saveLocation(resolvedLocation)
      this.setData({
        location: resolvedLocation,
        weather: normalizeWeather(weather),
        weatherState: 'ready'
      })
    } catch (error) {
      if (this._unloaded || requestId !== this.weatherRequestId) return
      this.setData({
        weatherState: 'error',
        weatherError: '天气获取失败，其他功能仍可正常使用'
      })
    }
  },

  async loadTodayOutfit() {
    this.setData({ todayState: 'loading' })
    try {
      const result = await appService.getTodayOutfit()
      const outfit = result && Object.prototype.hasOwnProperty.call(result, 'outfit')
        ? result.outfit
        : result
      this.setData({
        todayOutfit: normalizeOutfit(outfit),
        todayState: 'ready'
      })
    } catch (error) {
      this.setData({ todayOutfit: null, todayState: 'error' })
    }
  },

  async loadRecentOutfits() {
    this.setData({ recentState: 'loading' })
    try {
      const result = await appService.listSavedOutfits({ limit: 4, order: 'desc' })
      const list = Array.isArray(result) ? result : (result && result.items) || []
      const outfits = list
        .map(normalizeOutfit)
        .filter((item) => item && item.id)
        .sort((a, b) => b.sortTime - a.sortTime)
        .slice(0, 4)
      this.setData({ recentOutfits: outfits, recentState: 'ready' })
    } catch (error) {
      this.setData({ recentOutfits: [], recentState: 'error' })
    }
  },

  onAvatarTap() {
    wx.navigateTo({ url: ROUTES.profile })
  },

  onQuickStart() {
    wx.navigateTo({ url: ROUTES.history })
  },

  onCityTap() {
    wx.navigateTo({ url: ROUTES.citySelect })
  },

  onRetryWeather() {
    this.loadLocationAndWeather()
  },

  onRetryToday() {
    this.loadTodayOutfit()
  },

  onRetryRecent() {
    this.loadRecentOutfits()
  },

  onOutfitTap(event) {
    const outfitId = event.currentTarget.dataset.id
    if (!outfitId) return
    wx.navigateTo({
      url: `${ROUTES.detail}?outfitId=${encodeURIComponent(outfitId)}`
    })
  },

  onViewAll() {
    wx.navigateTo({ url: ROUTES.savedOutfits })
  },

  onSeasonSelect(event) {
    this.setData({ 'filters.season': event.currentTarget.dataset.value })
  },

  onStyleSelect(event) {
    this.setData({ 'filters.style': event.currentTarget.dataset.value })
  },

  onViewMatches() {
    const { season, style } = this.data.filters
    wx.navigateTo({
      url: `/pages/outfit-match/index?season=${encodeURIComponent(season)}&style=${encodeURIComponent(style)}`
    })
  },

  onGoOutfitTab() {
    wx.switchTab({ url: ROUTES.outfitTab })
  }
})
