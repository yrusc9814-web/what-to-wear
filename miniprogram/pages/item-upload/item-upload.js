const appService = require('../../services/app-service')
const { canUseCloud, callFunction } = require('../../services/cloud')
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
    // Round 2A-2 staging：原图临时文件与抠图结果临时文件分开维护，绝不混用
    sourceTempFileId: '',
    cutoutTempFileId: '',
    standardizedTempFileId: '',
    stagingConfirmed: false,
    uploadState: 'idle',
    saving: false,
    cutoutState: 'idle',
    cutoutError: '',
    cutoutErrorCode: '',
    standardizeState: 'idle',
    standardizeError: '',
    standardizeErrorCode: '',
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
        // F2: chooseMedia 返回后第一时间递增 generation 并清理 staging（消除 stale 窗口）。
        // 快照在此之后取，后续所有异步结果以快照校验；较晚 pick 恒赢。
        this._imageGeneration = (this._imageGeneration || 0) + 1
        const generation = this._imageGeneration
        this._standardizing = null
        this.releaseStagingAssets()
        this.setData({
          localImagePath: '',
          imageUrl: '',
          fileId: '',
          sourceTempFileId: '',
          cutoutTempFileId: '',
          standardizedTempFileId: '',
          stagingConfirmed: false,
          uploadState: 'idle',
          step: 1,
          cutoutState: 'idle',
          cutoutError: '',
          cutoutErrorCode: '',
          standardizeState: 'idle',
          standardizeError: '',
          standardizeErrorCode: ''
        })
        const imageHeader = await readImageHeader(file.tempFilePath)
        if (generation !== (this._imageGeneration || 0)) return
        if (!detectSupportedImageFormat(imageHeader)) {
          wx.showModal({
            title: '暂不支持此图片格式',
            content: '请选择 JPG、PNG 或 WebP 图片。HEIC 暂不支持，可先在系统相册中导出为 JPG 后重试。',
            showCancel: false
          })
          return
        }
        const stablePath = await appService.persistLocalImage(file.tempFilePath)
        if (generation !== (this._imageGeneration || 0)) return
        this.setData({
          localImagePath: stablePath,
          step: 1
        })
        this.uploadTempImage(generation)
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

  async uploadTempImage(generation = this._imageGeneration || 0) {
    const localPath = this.data.localImagePath
    if (!localPath) return
    if (this._uploadingGeneration === generation) return
    this._uploadingGeneration = generation
    // 重选图片：先释放旧 staging（服务端删除旧原图与旧抠图结果），失败不阻塞（TTL 兜底）
    this.releaseStagingAssets()
    this.setData({ uploadState: 'uploading', step: 2 })
    try {
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
        sourceTempFileId: uploaded.fileId || '',
        uploadState: 'success',
        step: 2
      })
      await this.startCutout()
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

  // ---- 抠图（正式流程）：temp 上传成功后自动执行，成功展示透明背景预览 ----
  async startCutout() {
    const sourceTempFileId = this.data.sourceTempFileId
    if (!sourceTempFileId || this.data.cutoutState === 'loading') return
    const generation = this._imageGeneration || 0
    if (!canUseCloud()) {
      this.setData({
        cutoutState: 'error',
        cutoutError: '当前环境不支持云开发，请检查网络后重试。',
        cutoutErrorCode: 'CLOUD_UNAVAILABLE'
      })
      return
    }
    this.setData({ cutoutState: 'loading', cutoutError: '', cutoutErrorCode: '', cutoutTempFileId: '' })
    try {
      const data = await callFunction('segmentClothing', { tempFileId: sourceTempFileId })
      if (!data || !data.resultFileId) {
        throw new Error('抠图结果为空，请稍后重试')
      }
      if (generation !== (this._imageGeneration || 0)) {
        // 过代际的抠图结果：立即回收，不写入 UI
        appService.clearTempImage(data.resultFileId)
        return
      }
      appService.registerTempImage(data.resultFileId)
      this.setData({ cutoutState: 'success', cutoutTempFileId: data.resultFileId })
    } catch (error) {
      if (generation !== (this._imageGeneration || 0)) return
      this.setData({
        cutoutState: 'error',
        cutoutError: (error && error.message) || '抠图失败，请稍后重试',
        cutoutErrorCode: (error && error.code) || 'CALL_FAILED'
      })
    }
  },

  retryCutout() {
    return this.startCutout()
  },

  // 「确认使用」触发抠图结果标准化，成功后才进入属性填写
  async confirmCutout() {
    if (this.data.cutoutState !== 'success' || !this.data.cutoutTempFileId) return
    // 幂等：已确认/已成功时重复调用直接返回，避免覆盖 standardizedTempFileId 且不清理旧 standardized
    if (this.data.stagingConfirmed === true || this.data.standardizeState === 'success') return
    if (this.data.standardizeState === 'loading' || (this._standardizing !== null && this._standardizing === (this._imageGeneration || 0))) return
    const generation = this._imageGeneration || 0
    const cutoutId = this.data.cutoutTempFileId
    this._standardizing = generation
    this.setData({ standardizeState: 'loading', standardizeError: '', standardizeErrorCode: '' })
    try {
      const result = await appService.standardizeCutoutImage(cutoutId)
      if ((this._imageGeneration || 0) !== generation || this.data.cutoutTempFileId !== cutoutId) {
        if (result && result.standardizedTempFileId) {
          Promise.resolve(appService.clearTempImage(result.standardizedTempFileId)).catch(() => {})
        }
        return
      }
      this.setData({
        standardizedTempFileId: result.standardizedTempFileId,
        standardizeState: 'success',
        stagingConfirmed: true,
        step: 2,
        imageUrl: result.standardizedTempFileId
      })
      wx.pageScrollTo({ scrollTop: 0, duration: 250 })
    } catch (error) {
      if ((this._imageGeneration || 0) !== generation || this.data.cutoutTempFileId !== cutoutId) return
      this.setData({
        standardizeState: 'error',
        standardizeError: (error && error.message) || '图片处理失败，请稍后重试',
        standardizeErrorCode: (error && error.code) || ''
      })
    } finally {
      if (this._standardizing === generation) this._standardizing = null
    }
  },

  // 重新选择：立即释放当前 staging（语义等价 cleanupStaging 但留在本页不 navigateBack），
  // 避免 pending standardize 返回时把旧结果写回 UI
  rechooseImage() {
    this.cleanupStaging()
    this.setData({ step: 1 })
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

  // 释放当前 staging 的服务端临时文件（原图 + 抠图结果 + 标准化结果）。
  // 仅处理 wardrobe/{openid}/tmp/ 前缀的 staging 字段；删除失败不阻塞（TTL 兜底重试）。
  // 释放的同时清空页面引用，避免旧 cloud fileId 残留在新 staging 中。
  releaseStagingAssets() {
    const ids = [...new Set([
      this.data.sourceTempFileId,
      this.data.cutoutTempFileId,
      this.data.standardizedTempFileId
    ].filter(Boolean))]
    ids.forEach((fileId) => {
      Promise.resolve(appService.clearTempImage(fileId)).catch(() => {})
    })
    this.setData({
      sourceTempFileId: '',
      cutoutTempFileId: '',
      standardizedTempFileId: '',
      stagingConfirmed: false,
      standardizeState: 'idle',
      standardizeError: '',
      standardizeErrorCode: ''
    })
    return ids
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
    // Round 2A-2：抠图 staging 状态下保存尚未开放（裁剪标准化在下一轮），
    // 明确提示而不是静默失败，更不能假装保存成功。
    if (this.data.sourceTempFileId || this.data.cutoutTempFileId || this.data.standardizedTempFileId) {
      wx.showModal({
        title: '保存暂未开放',
        content: '正式保存暂未开放，将在后续版本提供，本轮不会写入任何数据。',
        showCancel: false
      })
      return
    }
    const message = this.validate()
    if (message) {
      wx.showToast({ title: message, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中', mask: true })
    this._imageGeneration = (this._imageGeneration || 0) + 1
    const sourceTempFileId = this.data.sourceTempFileId || ''
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
      if (sourceTempFileId && sourceTempFileId !== fileId) {
        appService.clearTempImage(sourceTempFileId)
        this.setData({ sourceTempFileId: '' })
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

  // 清理 staging（取消 / 离开页面，未转正式前）：删除原图与抠图结果并复位状态
  cleanupStaging() {
    this._imageGeneration = (this._imageGeneration || 0) + 1
    this._standardizing = null
    this.releaseStagingAssets()
    this.setData({
      sourceTempFileId: '',
      cutoutTempFileId: '',
      standardizedTempFileId: '',
      stagingConfirmed: false,
      uploadState: 'idle',
      fileId: '',
      imageUrl: '',
      cutoutState: 'idle',
      cutoutError: '',
      cutoutErrorCode: '',
      standardizeState: 'idle',
      standardizeError: '',
      standardizeErrorCode: ''
    })
  },

  cancel() {
    wx.showModal({
      title: '放弃上传？',
      content: '当前已选图片和填写的信息将不会保存。',
      confirmText: '放弃',
      confirmColor: '#d85d70',
      success: ({ confirm }) => {
        if (confirm) {
          this.cleanupStaging()
          wx.navigateBack()
        }
      }
    })
  },

  onUnload() {
    if (this._saved) return
    this.cleanupStaging()
  }
})
