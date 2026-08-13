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
    uploadState: 'idle',
    aiState: 'idle',
    aiMessage: '',
    saving: false,
    dirtyByUser: false,
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
        this.setData({
          localImagePath: file.tempFilePath,
          imageUrl: '',
          fileId: '',
          uploadState: 'idle',
          aiState: 'idle',
          aiMessage: '',
          step: 1
        })
        this.uploadAndRecognize()
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

  async uploadAndRecognize() {
    if (!this.data.localImagePath) return
    this.setData({ uploadState: 'uploading', aiState: 'loading', aiMessage: '', step: 2 })
    try {
      const uploaded = await appService.uploadImage(this.data.localImagePath)
      if (uploaded.uploadState !== 'success' || !uploaded.fileId) {
        throw new Error('图片上传失败，已保留本地预览，请重试')
      }
      this.setData({
        imageUrl: uploaded.imageUrl || this.data.localImagePath,
        fileId: uploaded.fileId || '',
        uploadState: 'success'
      })
      await this.recognize(false)
    } catch (error) {
      this.setData({
        uploadState: 'error',
        aiState: 'error',
        aiMessage: (error && error.message) || '图片上传失败，可重试或先保留图片'
      })
    }
  },

  retryUpload() {
    this.uploadAndRecognize()
  },

  async recognize(askBeforeOverwrite) {
    const execute = async () => {
      this.setData({ aiState: 'loading', aiMessage: '' })
      try {
        const result = await appService.recognizeWardrobeItem({
          imageUrl: this.data.fileId || this.data.imageUrl || this.data.localImagePath,
          fileId: this.data.fileId,
          name: this.data.form.name
        })
        const nextForm = Object.assign({}, this.data.form, {
          name: result.name || '',
          category: result.category || '',
          seasons: Array.isArray(result.seasons) ? result.seasons : [],
          styles: Array.isArray(result.styles) ? result.styles : [],
          primaryColor: result.primaryColor || '',
          thickness: result.thickness || '',
          aiDescription: result.aiDescription || ''
        })
        this.setData({
          form: nextForm,
          selectedSeasons: this.toSelectionMap(nextForm.seasons),
          selectedStyles: this.toSelectionMap(nextForm.styles),
          imageUrl: result.imageUrl || this.data.imageUrl,
          fileId: result.fileId || this.data.fileId,
          aiState: 'success',
          aiMessage: '',
          dirtyByUser: false,
          step: 2
        })
      } catch (error) {
        this.setData({
          aiState: 'error',
          aiMessage: (error && error.message) || 'AI 识别失败，请手动填写后继续',
          step: 2
        })
      }
    }

    if (askBeforeOverwrite && this.data.dirtyByUser) {
      wx.showModal({
        title: '重新识别',
        content: '新的 AI 建议将替换你已修改的识别字段，购买信息、尺码和备注不会改变。',
        confirmText: '继续识别',
        success: ({ confirm }) => { if (confirm) execute() }
      })
      return
    }
    return execute()
  },

  reRecognize() {
    this.recognize(true)
  },

  continueManually() {
    this.setData({ aiState: 'manual', step: 2 })
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: event.detail.value, dirtyByUser: true })
  },

  onSingleSelect(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: readValue(event), dirtyByUser: true })
  },

  onMultiSelect(event) {
    const field = event.currentTarget.dataset.field
    const values = this.data.form[field] || []
    const nextValues = toggleValue(values, readValue(event))
    const selectedField = field === 'seasons' ? 'selectedSeasons' : 'selectedStyles'
    this.setData({
      [`form.${field}`]: nextValues,
      [selectedField]: this.toSelectionMap(nextValues),
      dirtyByUser: true
    })
  },

  toSelectionMap(values) {
    return (values || []).reduce((result, value) => {
      result[value] = true
      return result
    }, {})
  },

  onDateChange(event) {
    this.setData({ 'form.purchaseDate': event.detail.value, dirtyByUser: true })
  },

  async regenerateDescription() {
    this.recognize(true)
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
      if (this.data.uploadState !== 'success') {
        const uploaded = await appService.uploadImage(this.data.localImagePath)
        imageUrl = uploaded.imageUrl || this.data.localImagePath
        fileId = uploaded.fileId || ''
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

  cancel() {
    wx.showModal({
      title: '放弃上传？',
      content: '当前已选图片和填写的信息将不会保存。',
      confirmText: '放弃',
      confirmColor: '#d85d70',
      success: ({ confirm }) => { if (confirm) wx.navigateBack() }
    })
  }
})
