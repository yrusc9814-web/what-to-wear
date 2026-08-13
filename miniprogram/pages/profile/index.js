const appService = require('../../services/app-service')

Page({
  data: {
    state: 'loading',
    avatarUrl: '',
    errorMessage: ''
  },

  onLoad() {
    this.loadProfile()
  },

  async loadProfile() {
    this.setData({ state: 'loading', errorMessage: '' })
    try {
      const user = await appService.getCurrentUser()
      this.setData({
        avatarUrl: user && user.avatarUrl ? user.avatarUrl : '',
        state: 'ready'
      })
    } catch (error) {
      this.setData({
        state: 'error',
        errorMessage: (error && error.message) || '个人信息暂时无法加载'
      })
    }
  }
})
