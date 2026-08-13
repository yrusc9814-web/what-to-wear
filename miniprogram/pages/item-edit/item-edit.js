const appService = require('../../services/app-service')
const {
  CATEGORIES,
  SEASONS,
  STYLES,
  PRIMARY_COLORS,
  THICKNESSES
} = require('../../utils/constants')

function toggleValue(values, value) {
  return values.includes(value) ? values.filter((item) => item !== value) : values.concat(value)
}

function todayString() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

Page({
  data: {
    itemId: '',
    focus: '',
    state: 'loading',
    errorMessage: '',
    saving: false,
    today: todayString(),
    imageUrl: '',
    fileId: '',
    imageChanged: false,
    form: {
      name: '', category: '', seasons: [], styles: [], primaryColor: '', thickness: '', size: '',
      purchasePrice: '', purchaseDate: '', purchaseChannel: '', aiDescription: '', note: ''
    },
    selectedSeasons: {},
    selectedStyles: {},
    categoryOptions: CATEGORIES,
    seasonOptions: SEASONS,
    styleOptions: STYLES,
    colorOptions: PRIMARY_COLORS,
    thicknessOptions: THICKNESSES
  },

  onLoad(options) {
    this.setData({
      itemId: decodeURIComponent(options.itemId || ''),
      focus: options.focus || ''
    })
    this.loadItem()
  },

  async loadItem() {
    this.setData({ state: 'loading', errorMessage: '' })
    try {
      const item = await appService.getWardrobeItem(this.data.itemId)
      if (!item || item.deletedAt) throw new Error('该单品不存在或已删除')
      this.setData({
        state: 'ready',
        imageUrl: item.imageUrl || item.imageFileId || item.fileId || '',
        fileId: item.fileId || item.imageFileId || '',
        form: {
          name: item.name || '',
          category: item.category || '',
          seasons: Array.isArray(item.seasons) ? item.seasons : [],
          styles: Array.isArray(item.styles) ? item.styles : [],
          primaryColor: item.primaryColor || '',
          thickness: item.thickness || '',
          size: item.size || '',
          purchasePrice: item.purchasePrice == null ? '' : String(item.purchasePrice),
          purchaseDate: item.purchaseDate || '',
          purchaseChannel: item.purchaseChannel || '',
          aiDescription: item.aiDescription || '',
          note: item.note || ''
        },
        selectedSeasons: this.toSelectionMap(item.seasons),
        selectedStyles: this.toSelectionMap(item.styles)
      })
      if (this.data.focus === 'category') {
        setTimeout(() => wx.pageScrollTo({ selector: '#category-field', duration: 300 }), 100)
      }
    } catch (error) {
      this.setData({ state: 'error', errorMessage: (error && error.message) || '加载失败' })
    }
  },

  changeImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: ({ tempFiles }) => {
        const file = tempFiles && tempFiles[0]
        if (file && file.tempFilePath) {
          this.setData({ imageUrl: file.tempFilePath, fileId: '', imageChanged: true })
        }
      },
      fail: (error) => {
        if (!error || !/cancel/i.test(error.errMsg || '')) {
          wx.showToast({ title: '无法选择图片，请检查权限', icon: 'none' })
        }
      }
    })
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: event.detail.value })
  },

  onSingleSelect(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: event.currentTarget.dataset.value })
  },

  onMultiSelect(event) {
    const field = event.currentTarget.dataset.field
    const value = event.currentTarget.dataset.value
    const nextValues = toggleValue(this.data.form[field] || [], value)
    const selectedField = field === 'seasons' ? 'selectedSeasons' : 'selectedStyles'
    this.setData({
      [`form.${field}`]: nextValues,
      [selectedField]: this.toSelectionMap(nextValues)
    })
  },

  toSelectionMap(values) {
    return (values || []).reduce((result, value) => {
      result[value] = true
      return result
    }, {})
  },

  onDateChange(event) {
    this.setData({ 'form.purchaseDate': event.detail.value })
  },

  async regenerateDescription() {
    if (!this.data.fileId) {
      wx.showToast({ title: '请先选择并上传图片', icon: 'none' })
      return
    }
    wx.showLoading({ title: '生成中', mask: true })
    try {
      const result = await appService.recognizeWardrobeItem({ imageUrl: this.data.fileId, fileId: this.data.fileId, name: this.data.form.name })
      this.setData({ 'form.aiDescription': result.aiDescription || '' })
    } catch (error) {
      wx.showToast({ title: (error && error.message) || '生成失败，可手动编辑', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  validate() {
    const form = this.data.form
    if (!this.data.imageUrl) return '请保留或重新选择单品图片'
    if (!form.name.trim()) return '请填写单品名称'
    if (!form.category) return '请选择分类'
    if (!form.seasons.length) return '请至少选择一个季节'
    if (!form.styles.length) return '请至少选择一个风格'
    if (form.purchasePrice && !/^\d+(\.\d{1,2})?$/.test(form.purchasePrice)) return '购买价格最多保留两位小数'
    return ''
  },

  async saveItem() {
    if (this.data.saving) return
    const message = this.validate()
    if (message) {
      wx.showToast({ title: message, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中', mask: true })
    try {
      let imageUrl = this.data.imageUrl
      let fileId = this.data.fileId
      if (this.data.imageChanged) {
        const uploaded = await appService.uploadImage(this.data.imageUrl)
        if (uploaded.uploadState !== 'success' || !uploaded.fileId) throw new Error('图片上传失败，已保留当前修改，请重试')
        imageUrl = uploaded.imageUrl || this.data.imageUrl
        fileId = uploaded.fileId || ''
      }
      const form = this.data.form
      const saved = await appService.updateWardrobeItem(this.data.itemId, {
        imageUrl,
        fileId,
        imageFileId: fileId,
        name: form.name.trim(),
        category: form.category,
        seasons: form.seasons,
        styles: form.styles,
        primaryColor: form.primaryColor,
        thickness: form.thickness,
        size: form.size.trim(),
        purchasePrice: form.purchasePrice === '' ? null : Number(form.purchasePrice),
        purchaseDate: form.purchaseDate,
        purchaseChannel: form.purchaseChannel.trim(),
        aiDescription: form.aiDescription.trim(),
        note: form.note.trim()
      })
      if (saved.syncStatus === 'synced') {
        wx.showToast({ title: '保存成功', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 500)
      } else {
        wx.showModal({
          title: '已保存到本机',
          content: saved.syncStatus === 'failed' ? '云端同步失败，稍后会自动重试。' : '云端同步待处理，稍后会自动重试。',
          showCancel: false,
          success: () => wx.navigateBack()
        })
      }
    } catch (error) {
      wx.showToast({ title: (error && error.message) || '保存失败', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ saving: false })
    }
  },

  cancel() {
    wx.navigateBack()
  }
})
