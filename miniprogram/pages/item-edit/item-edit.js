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
    tempFileId: '',
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
    appService.sweepExpiredTempImages()
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
      success: async ({ tempFiles }) => {
        const file = tempFiles && tempFiles[0]
        if (!file || !file.tempFilePath) return
        const stablePath = await appService.persistLocalImage(file.tempFilePath)
        const previousTemp = this.data.tempFileId || ''
        this._imageGeneration = (this._imageGeneration || 0) + 1
        this.setData({ imageUrl: stablePath, fileId: '', imageChanged: true, tempFileId: '' })
        if (previousTemp) appService.clearTempImage(previousTemp)
        this.uploadTempImage()
      },
      fail: (error) => {
        if (!error || !/cancel/i.test(error.errMsg || '')) {
          wx.showToast({ title: '无法选择图片，请检查权限', icon: 'none' })
        }
      }
    })
  },

  async uploadTempImage() {
    if (!this.data.imageChanged || !this.data.imageUrl) return
    const localPath = this.data.imageUrl
    const generation = this._imageGeneration || 0
    if (this._uploadingGeneration === generation) return
    this._uploadingGeneration = generation
    try {
      const uploaded = await appService.uploadImage(localPath, undefined, undefined, 'temp')
      if (generation !== (this._imageGeneration || 0)) {
        if (uploaded && uploaded.uploadState === 'success' && uploaded.fileId) {
          appService.clearTempImage(uploaded.fileId)
        }
        return
      }
      if (uploaded && uploaded.uploadState === 'success' && uploaded.fileId) {
        this.setData({ tempFileId: uploaded.fileId })
      }
    } catch (error) {
      // 临时图上传失败不阻塞编辑，保存时会再次上传
    } finally {
      if (this._uploadingGeneration === generation) this._uploadingGeneration = 0
    }
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

  async resolveFormalImage(localPath) {
    let uploaded = null
    try {
      uploaded = await appService.uploadImage(localPath, undefined, undefined, 'clothing')
    } catch (error) {
      uploaded = null
    }
    if (uploaded) {
      if (uploaded.storage === 'cloud' && uploaded.fileId) {
        return { imageUrl: uploaded.imageUrl || localPath, fileId: uploaded.fileId }
      }
      if (uploaded.uploadState === 'failed' || uploaded.errorCode === 'UPLOAD_FAILED') {
        const error = new Error('图片上传失败，请重试')
        error.code = uploaded.errorCode
        throw error
      }
      // 离线 / 身份未确认：恢复 V1.4 语义，本地路径 + 空 fileId 继续保存
      return { imageUrl: uploaded.imageUrl || localPath, fileId: '' }
    }
    // 在线上传异常：不引用 tmp 路径，抛错提示重试
    throw new Error('图片上传失败，请重试')
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
    this._imageGeneration = (this._imageGeneration || 0) + 1
    const tempFileId = this.data.tempFileId || ''
    try {
      let imageUrl = this.data.imageUrl
      let fileId = this.data.fileId
      if (this.data.imageChanged) {
        const resolved = await this.resolveFormalImage(this.data.imageUrl)
        imageUrl = resolved.imageUrl
        fileId = resolved.fileId
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
      this._saved = true
      appService.unregisterTempImage(fileId)
      if (tempFileId && tempFileId !== fileId) {
        appService.clearTempImage(tempFileId)
        this.setData({ tempFileId: '' })
      }
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

  cleanupTempImage() {
    const tempFileId = this.data.tempFileId || ''
    if (!tempFileId) return
    appService.clearTempImage(tempFileId)
    this.setData({ tempFileId: '' })
  },

  cancel() {
    this.cleanupTempImage()
    wx.navigateBack()
  },

  onUnload() {
    if (!this._saved) this.cleanupTempImage()
  }
})
