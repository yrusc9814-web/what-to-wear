const appService = require('../../services/app-service')

function normalizeCity(item) {
  if (!item) return null
  if (typeof item === 'string') {
    return { cityName: item, source: 'manual' }
  }
  const cityName = item.cityName || item.name || item.fullName || ''
  if (!cityName) return null
  return {
    cityName,
    latitude: item.latitude === 0 || item.latitude ? item.latitude : item.lat,
    longitude: item.longitude === 0 || item.longitude ? item.longitude : item.lng,
    source: item.source || 'manual'
  }
}

Page({
  data: {
    currentLocation: null,
    currentState: 'loading',
    locating: false,
    keyword: '',
    searchState: 'idle',
    results: [],
    errorMessage: ''
  },

  onLoad() {
    this._unloaded = false
    this.locationRequestId = 0
    this.loadCurrentLocation()
  },

  onUnload() {
    this._unloaded = true
    this.locationRequestId = (this.locationRequestId || 0) + 1
    if (this.searchTimer) clearTimeout(this.searchTimer)
  },

  beginLocationOperation() {
    this.locationRequestId = (this.locationRequestId || 0) + 1
    return this.locationRequestId
  },

  isLocationOperationCurrent(token) {
    return !this._unloaded && token === this.locationRequestId
  },

  async loadCurrentLocation() {
    const token = this.beginLocationOperation()
    this.setData({ currentState: 'loading' })
    try {
      const location = normalizeCity(await appService.getLocation())
      if (!this.isLocationOperationCurrent(token)) return
      this.setData({ currentLocation: location, currentState: 'ready' })
    } catch (error) {
      if (!this.isLocationOperationCurrent(token)) return
      this.setData({ currentLocation: null, currentState: 'error' })
    }
  },

  onKeywordInput(event) {
    const keyword = (event.detail.value || '').trim()
    this.setData({ keyword, errorMessage: '' })
    if (this.searchTimer) clearTimeout(this.searchTimer)
    if (!keyword) {
      this.setData({ searchState: 'idle', results: [] })
      return
    }
    this.searchTimer = setTimeout(() => this.searchCities(keyword), 300)
  },

  onSearch() {
    const keyword = this.data.keyword.trim()
    if (!keyword) {
      wx.showToast({ title: '请输入城市名', icon: 'none' })
      return
    }
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchCities(keyword)
  },

  async searchCities(keyword) {
    if (keyword !== this.data.keyword.trim()) return
    const token = this.beginLocationOperation()
    this.setData({ searchState: 'loading', results: [], errorMessage: '' })
    try {
      const response = await appService.searchCities(keyword)
      if (!this.isLocationOperationCurrent(token) || keyword !== this.data.keyword.trim()) return
      const list = Array.isArray(response) ? response : (response && response.items) || []
      const results = list.map(normalizeCity).filter(Boolean)
      this.setData({ results, searchState: 'ready' })
    } catch (error) {
      if (!this.isLocationOperationCurrent(token) || keyword !== this.data.keyword.trim()) return
      this.setData({
        searchState: 'error',
        results: [],
        errorMessage: (error && error.message) || '城市搜索失败，请稍后重试'
      })
    }
  },

  async onRelocate() {
    if (this.data.locating) return
    const token = this.beginLocationOperation()
    this.setData({ locating: true, errorMessage: '' })
    try {
      const location = normalizeCity(await appService.locateCurrentCity())
      if (!this.isLocationOperationCurrent(token)) return
      if (!location) throw new Error('无法识别当前城市')
      await this.selectLocation({ ...location, source: 'device' }, true, token)
    } catch (error) {
      if (!this.isLocationOperationCurrent(token)) return
      this.setData({
        locating: false,
        errorMessage: (error && error.message) || '定位失败，可以手动搜索城市'
      })
    }
  },

  onCitySelect(event) {
    const index = Number(event.currentTarget.dataset.index)
    const location = this.data.results[index]
    if (!location) return
    const token = this.beginLocationOperation()
    this.selectLocation(location, false, token)
  },

  async selectLocation(location, weatherResolved = false, requestId) {
    const token = requestId || this.beginLocationOperation()
    wx.showLoading({ title: '正在切换', mask: true })
    try {
      let weatherError = null
      let resolvedLocation = location
      if (!weatherResolved) {
        try {
          const weather = await appService.getWeather(location)
          if (!this.isLocationOperationCurrent(token)) return
          resolvedLocation = {
            ...location,
            cityName: weather.cityName || location.cityName,
            latitude: weather.latitude,
            longitude: weather.longitude,
            source: weather.source || location.source
          }
        } catch (error) {
          if (!this.isLocationOperationCurrent(token)) return
          weatherError = error
        }
      }
      if (!this.isLocationOperationCurrent(token)) return
      await appService.saveLocation(resolvedLocation)
      if (!this.isLocationOperationCurrent(token)) return
      wx.hideLoading()
      this.setData({ locating: false })
      if (weatherError) {
        wx.showModal({
          title: '城市已保存',
          content: '天气暂时获取失败，返回首页后可以重试。',
          showCancel: false,
          confirmText: '返回首页',
          success: () => wx.navigateBack()
        })
        return
      }
      wx.showToast({ title: `已切换到${location.cityName}`, icon: 'success' })
      setTimeout(() => wx.navigateBack(), 350)
    } catch (error) {
      wx.hideLoading()
      this.setData({
        locating: false,
        errorMessage: (error && error.message) || '城市切换失败，请重试'
      })
    }
  },

  onRetrySearch() {
    this.onSearch()
  }
})
