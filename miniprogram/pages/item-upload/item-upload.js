const appService = require('../../services/app-service')
const {
  CATEGORIES,
  SEASONS,
  STYLES,
  PRIMARY_COLORS,
  THICKNESSES
} = require('../../utils/constants')

const EMPTY_FORM = {
  name: '',
  category: '',
  seasons: [],
  styles: [],
  primaryColor: '',
  thickness: '',
  size: '',
  purchasePrice: '',
  purchaseDate: '',
  purchaseChannel: '',
  aiDescription: '',
  note: ''
}

const IMAGE_HEADER_BYTES = 12

function detectSupportedImageFormat(data) {
  if (!(data instanceof ArrayBuffer)) return ''
  const bytes = new Uint8Array(data)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
  return ''
}

function readImageHeader(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().readFile({
      filePath,
      position: 0,
      length: IMAGE_HEADER_BYTES,
      success: ({ data }) => resolve(data),
      fail: () => resolve(null)
    })
  })
}

function readValue(event) {
  return event.currentTarget.dataset.value
}

function toggleValue(values, value) {
  return values.includes(value) ? values.filter((item) => item !== value) : values.concat(value)
}

function todayString() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

Page({
  data: {
    step: 1,
    localImagePath: '',
    imageUrl: '',
    fileId: '',
    tempFileId: '',
    uploadState: 'idle',
    saving: false,
    today: todayString(),
    form: Object.assign({}, EMPTY_FORM),
    selectedSeasons: {},
    selectedStyles: {},
    categoryOptions: CATEGORIES,
    seasonOptions: SEASONS,
    styleOptions: STYLES,
    colorOptions: PRIMARY_COLORS,
    thicknessOptions: THICKNESSES
  },

  onLoad() {
    appService.sweepExpiredTempImages()
  },

  chooseCamera() {
    this.chooseImage(['camera'])
  },

  chooseAlbum() {
    this.chooseImage(['album'])
  },

  chooseImage(sourceType) {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType,
      sizeType: ['compressed', 'original'],
      success: async ({ tempFiles }) => {
        const file = tempFiles && tempFiles[0]
        if (!file || !file.tempFilePath) return
        const imageHeader = await readImageHeader(file.tempFilePath)
        if (!detectSupportedImageFormat(imageHeader)) {
          wx.showModal({
            title: '暂不支持此图片格式',
            content: '请选择 JPG、PNG 或 WebP 图片。HEIC 暂不支持，可先在系统相册中导出为 JPG 后重试。',
            showCancel: false
          })
          return
        }
        const stablePath = await appService.persistLocalImage(file.tempFilePath)
        this._imageGeneration = (this._imageGeneration || 0) + 1
        this.setData({
          localImagePath: stablePath,
          imageUrl: '',
          fileId: '',
          uploadState: 'idle',
          step: 1
        })
        this.uploadTempImage()
      },
      fail: (error) => {
        if (error && /cancel/i.test(error.errMsg || '')) return
        wx.showModal({
          title: '暂时无法选择图片',
          content: '请检查相机或相册权限后重试。',
          showCancel: false
        })
      }
    })
  },

  async uploadTempImage() {
    const localPath = this.data.localImagePath
    if (!localPath) return
    const generation = this._imageGeneration || 0
    if (this._uploadingGeneration === generation) return
    this._uploadingGeneration = generation
    const previousTemp = this.data.tempFileId || ''
    this.setData({ uploadState: 'uploading', step: 2 })
    try {
      if (previousTemp) appService.clearTempImage(previousTemp)
      const uploaded = await appService.uploadImage(localPath, undefined, undefined, 'temp')
      if (generation !== (this._imageGeneration || 0)) {
        // 旧代际上传结果作废：若已生成临时云图，立即回收
        if (uploaded && uploaded.uploadState === 'success' && uploaded.fileId) {
          appService.clearTempImage(uploaded.fileId)
        }
        return
      }
      if (uploaded.uploadState !== 'success' || !uploaded.fileId) {
        throw new Error('图片上传失败，已保留本地预览，请重试')
      }
      this.setData({
        imageUrl: uploaded.imageUrl || localPath,
        fileId: uploaded.fileId || '',
        tempFileId: uploaded.fileId || '',
        uploadState: 'success',
        step: 2
      })
    } catch (error) {
      if (generation !== (this._imageGeneration || 0)) return
      this.setData({ uploadState: 'error', step: 2 })
    } finally {
      if (this._uploadingGeneration === generation) this._uploadingGeneration = 0
    }
  },

  retryUpload() {
    this.uploadTempImage()
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: event.detail.value })
  },

  onSingleSelect(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: readValue(event) })
  },

  onMultiSelect(event) {
    const field = event.currentTarget.dataset.field
    const values = this.data.form[field] || []
    const nextValues = toggleValue(values, readValue(event))
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

  goToConfirm() {
    const message = this.validate()
    if (message) {
      wx.showToast({ title: message, icon: 'none' })
      return
    }
    this.setData({ step: 3 })
    wx.pageScrollTo({ scrollTop: 0, duration: 250 })
  },

  backToEdit() {
    this.setData({ step: 2 })
  },

  validate() {
    const form = this.data.form
    if (!this.data.localImagePath && !this.data.imageUrl) return '请先上传单品图片'
    if (!form.name.trim()) return '请填写单品名称'
    if (!form.category) return '请选择分类'
    if (!form.seasons.length) return '请至少选择一个适用季节'
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
      if (this.data.localImagePath) {
        const resolved = await this.resolveFormalImage(this.data.localImagePath)
        imageUrl = resolved.imageUrl
        fileId = resolved.fileId
      }
      const form = this.data.form
      const saved = await appService.createWardrobeItem({
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
        note: form.note.trim(),
        deletedAt: null
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
          content: saved.syncStatus === 'failed' ? '云端同步失败，稍后会自动重试。' : '云端同步待处理，身份或网络恢复后会自动重试。',
          showCancel: false,
          success: () => wx.navigateBack()
        })
      }
    } catch (error) {
      wx.showToast({ title: (error && error.message) || '保存失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ saving: false })
    }
  },

  cleanupTempImage() {
    const tempFileId = this.data.tempFileId || ''
    if (!tempFileId) return
    appService.clearTempImage(tempFileId)
    this.setData({ tempFileId: '', uploadState: 'idle', fileId: '', imageUrl: '' })
  },

  cancel() {
    wx.showModal({
      title: '放弃上传？',
      content: '当前已选图片和填写的信息将不会保存。',
      confirmText: '放弃',
      confirmColor: '#d85d70',
      success: ({ confirm }) => {
        if (confirm) {
          this.cleanupTempImage()
          wx.navigateBack()
        }
      }
    })
  },

  onUnload() {
    if (this._saved) return
    this.cleanupTempImage()
  }
})
