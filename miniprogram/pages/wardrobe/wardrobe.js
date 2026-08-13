const appService = require('../../services/app-service')
const {
  CATEGORIES,
  SEASONS,
  STYLES,
  PRIMARY_COLORS,
  THICKNESSES
} = require('../../utils/constants')

function valueOf(event) {
  return event.currentTarget.dataset.value
}

function labelOf(options, value) {
  const option = (options || []).find((item) => item.value === value)
  return option ? option.label : (value || '')
}

function unwrapItems(result) {
  if (Array.isArray(result)) return result
  return result && Array.isArray(result.items) ? result.items : []
}

function arrayValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (!value || value === 'all') return []
  return String(value).split(/[,\s，、/]+/).filter(Boolean)
}

function normalizeCategory(value, name) {
  if (CATEGORIES.some((item) => item.value === value)) return value
  if (value === 'accessory') return /帽|cap|hat/i.test(name || '') ? 'hat' : 'bag'
  return value || 'top'
}

Page({
  data: {
    state: 'loading',
    errorMessage: '',
    items: [],
    visibleItems: [],
    searchText: '',
    activeCategory: 'all',
    viewMode: 'grid',
    filterOpen: false,
    appliedFilters: { season: '', style: '', primaryColor: '', thickness: '' },
    tempFilters: { season: '', style: '', primaryColor: '', thickness: '' },
    hasActiveFilters: false,
    categoryOptions: [{ value: 'all', label: '全部' }].concat(CATEGORIES),
    seasonOptions: [{ value: '', label: '不限' }].concat(SEASONS),
    styleOptions: [{ value: '', label: '不限' }].concat(STYLES),
    colorOptions: [{ value: '', label: '不限' }].concat(PRIMARY_COLORS),
    thicknessOptions: [{ value: '', label: '不限' }].concat(THICKNESSES)
  },

  onLoad() {
    let viewMode = 'grid'
    try {
      const remembered = appService.getWardrobeView()
      if (remembered === 'list') viewMode = 'list'
    } catch (error) {
      // Storage failure should not block the wardrobe.
    }
    this.setData({ viewMode })
  },

  onShow() {
    this.loadItems()
  },

  onPullDownRefresh() {
    this.loadItems().finally(() => wx.stopPullDownRefresh())
  },

  async loadItems() {
    this.setData({ state: 'loading', errorMessage: '' })
    try {
      const result = await appService.listWardrobeItems({ includeDeleted: false })
      const items = unwrapItems(result)
        .filter((item) => !item.deletedAt)
        .map((item) => this.presentItem(item))
      this.setData({ items, state: 'ready' })
      this.applyFilters()
    } catch (error) {
      this.setData({
        state: 'error',
        errorMessage: (error && error.message) || '衣橱加载失败，请稍后重试'
      })
    }
  },

  presentItem(item) {
    const category = normalizeCategory(item.category || item.type, item.name)
    const seasons = arrayValue(item.seasons || item.season).map((value) => value === 'fall' ? 'autumn' : value)
    const styles = arrayValue(item.styles || item.style || item.tags).map((value) => {
      if (STYLES.some((option) => option.value === value)) return value
      const byLabel = STYLES.find((option) => option.label === value)
      return byLabel ? byLabel.value : value
    })
    const primaryColor = item.primaryColor || item.mainColor || item.color || ''
    const categoryLabel = labelOf(CATEGORIES, category)
    const seasonLabels = seasons.map((value) => labelOf(SEASONS, value)).filter(Boolean)
    const styleLabels = styles.map((value) => labelOf(STYLES, value)).filter(Boolean)
    return Object.assign({}, item, {
      id: item.id || item._id,
      category,
      seasons,
      styles,
      primaryColor,
      imageUrl: item.imageUrl || item.imageFileId || item.tempFileURL || '',
      categoryLabel,
      primaryColorLabel: labelOf(PRIMARY_COLORS, primaryColor),
      seasonStyleText: seasonLabels.concat(styleLabels).join(' · ')
    })
  },

  onSearchInput(event) {
    const searchText = event.detail.value || ''
    this.setData({ searchText })
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => this.applyFilters(), 300)
  },

  onCategoryTap(event) {
    this.setData({ activeCategory: valueOf(event) })
    this.applyFilters()
  },

  toggleView() {
    const viewMode = this.data.viewMode === 'grid' ? 'list' : 'grid'
    this.setData({ viewMode })
    try {
      appService.setWardrobeView(viewMode)
    } catch (error) {
      wx.showToast({ title: '视图偏好暂未记住', icon: 'none' })
    }
  },

  openFilters() {
    this.setData({
      filterOpen: true,
      tempFilters: Object.assign({}, this.data.appliedFilters)
    })
  },

  closeFilters() {
    this.setData({ filterOpen: false })
  },

  stopPropagation() {},

  onFilterSelect(event) {
    const field = event.currentTarget.dataset.field
    const value = valueOf(event)
    this.setData({ [`tempFilters.${field}`]: value })
  },

  resetFilters() {
    this.setData({
      tempFilters: { season: '', style: '', primaryColor: '', thickness: '' }
    })
  },

  confirmFilters() {
    const appliedFilters = Object.assign({}, this.data.tempFilters)
    const hasActiveFilters = Object.keys(appliedFilters).some((key) => Boolean(appliedFilters[key]))
    this.setData({ appliedFilters, hasActiveFilters, filterOpen: false })
    this.applyFilters()
  },

  applyFilters() {
    const keyword = (this.data.searchText || '').trim().toLowerCase()
    const category = this.data.activeCategory
    const filters = this.data.appliedFilters
    const visibleItems = this.data.items.filter((item) => {
      if (category !== 'all' && item.category !== category) return false
      if (filters.season && !(item.seasons || []).includes(filters.season)) return false
      if (filters.style && !(item.styles || []).includes(filters.style)) return false
      if (filters.primaryColor && item.primaryColor !== filters.primaryColor) return false
      if (filters.thickness && item.thickness !== filters.thickness) return false
      if (!keyword) return true
      const searchable = [
        item.name,
        item.category,
        item.categoryLabel,
        item.primaryColor,
        item.primaryColorLabel,
        item.note,
        ...(item.styles || []),
        ...((item.styles || []).map((value) => labelOf(STYLES, value)))
      ].filter(Boolean).join(' ').toLowerCase()
      return searchable.includes(keyword)
    })
    this.setData({ visibleItems })
  },

  navigateToUpload() {
    wx.navigateTo({ url: '/pages/item-upload/item-upload' })
  },

  navigateToProfile() {
    wx.navigateTo({ url: '/pages/profile/index' })
  },

  openItem(event) {
    const itemId = event.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/item-detail/item-detail?itemId=${encodeURIComponent(itemId)}` })
  },

  openMore(event) {
    const itemId = event.currentTarget.dataset.id
    const item = this.data.items.find((candidate) => candidate.id === itemId)
    if (!item) return
    wx.showActionSheet({
      itemList: ['查看详情', '编辑信息', '修改分类', '删除'],
      success: ({ tapIndex }) => {
        if (tapIndex === 0) this.goToDetail(item.id)
        if (tapIndex === 1) this.goToEdit(item.id)
        if (tapIndex === 2) this.goToEdit(item.id, true)
        if (tapIndex === 3) this.confirmDelete(item)
      }
    })
  },

  goToDetail(itemId) {
    wx.navigateTo({ url: `/pages/item-detail/item-detail?itemId=${encodeURIComponent(itemId)}` })
  },

  goToEdit(itemId, categoryOnly) {
    const suffix = categoryOnly ? '&focus=category' : ''
    wx.navigateTo({ url: `/pages/item-edit/item-edit?itemId=${encodeURIComponent(itemId)}${suffix}` })
  },

  confirmDelete(item) {
    wx.showModal({
      title: '确认删除这件单品？',
      content: '删除后将不再出现在衣橱和新搭配中，历史穿搭仍保留原来的图片快照。',
      confirmText: '删除',
      confirmColor: '#d85d70',
      success: async ({ confirm }) => {
        if (!confirm) return
        wx.showLoading({ title: '删除中', mask: true })
        try {
          const result = await appService.deleteWardrobeItem(item.id)
          if (result.syncStatus === 'synced') wx.showToast({ title: '已从衣橱删除', icon: 'success' })
          else wx.showToast({ title: '本机已删除，云端待同步', icon: 'none' })
          await this.loadItems()
        } catch (error) {
          wx.showToast({ title: (error && error.message) || '删除失败', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      }
    })
  }
})
