const appService = require('../../services/app-service')
const {
  CATEGORIES,
  SEASONS,
  STYLES,
  PRIMARY_COLORS,
  THICKNESSES
} = require('../../utils/constants')

function labelOf(options, value) {
  const option = options.find((item) => item.value === value)
  return option ? option.label : (value || '未填写')
}

function listLabels(options, values) {
  return (values || []).map((value) => labelOf(options, value)).join('、') || '未填写'
}

function formatDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

Page({
  data: {
    itemId: '',
    state: 'loading',
    errorMessage: '',
    item: null
  },

  onLoad(options) {
    this.setData({ itemId: decodeURIComponent(options.itemId || '') })
  },

  onShow() {
    if (this.data.itemId) this.loadItem()
  },

  onPullDownRefresh() {
    this.loadItem().finally(() => wx.stopPullDownRefresh())
  },

  async loadItem() {
    this.setData({ state: 'loading', errorMessage: '' })
    try {
      const raw = await appService.getWardrobeItem(this.data.itemId)
      if (!raw || raw.deletedAt) throw new Error('该单品不存在或已从衣橱删除')
      const item = Object.assign({}, raw, {
        imageUrl: raw.imageUrl || raw.imageFileId || raw.fileId || '',
        categoryLabel: labelOf(CATEGORIES, raw.category),
        seasonText: listLabels(SEASONS, raw.seasons),
        styleText: listLabels(STYLES, raw.styles),
        primaryColorLabel: labelOf(PRIMARY_COLORS, raw.primaryColor),
        thicknessLabel: labelOf(THICKNESSES, raw.thickness),
        purchasePriceText: raw.purchasePrice == null || raw.purchasePrice === '' ? '未填写' : `¥${Number(raw.purchasePrice).toFixed(2)}`,
        createdDateText: formatDateTime(raw.createdAt)
      })
      this.setData({ item, state: 'ready' })
    } catch (error) {
      this.setData({
        state: 'error',
        errorMessage: (error && error.message) || '单品详情加载失败'
      })
    }
  },

  editItem() {
    wx.navigateTo({ url: `/pages/item-edit/item-edit?itemId=${encodeURIComponent(this.data.itemId)}` })
  },

  deleteItem() {
    wx.showModal({
      title: '确认删除这件单品？',
      content: '删除后将不再出现在衣橱和新搭配中，但历史穿搭仍保留当时的图片快照。',
      confirmText: '删除',
      confirmColor: '#d85d70',
      success: async ({ confirm }) => {
        if (!confirm) return
        wx.showLoading({ title: '删除中', mask: true })
        try {
          const result = await appService.deleteWardrobeItem(this.data.itemId)
          if (result.syncStatus === 'synced') {
            wx.showToast({ title: '已从衣橱删除', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 500)
          } else {
            wx.showModal({
              title: '已从本机衣橱删除',
              content: '云端删除尚未同步，稍后会自动重试。',
              showCancel: false,
              success: () => wx.navigateBack()
            })
          }
        } catch (error) {
          wx.showToast({ title: (error && error.message) || '删除失败', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      }
    })
  }
})
