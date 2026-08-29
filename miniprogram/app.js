App({
  globalData: {
    pendingOutfitEdit: null,
    identityState: "loading"
  },

  onLaunch() {
    if (!wx.cloud) {
      this.globalData.identityState = "unconfirmed";
      this.globalData.identityError = "当前基础库不支持云开发";
      console.warn("当前基础库不支持云开发");
      return;
    }

    wx.cloud.init({
      env: "cloud1-d1gjweewr2740aa1f",
      traceUser: true
    });
    this.initializeUserScope();
    this.validateTodayOutfit();
    try {
      require("./services/app-service").sweepExpiredTempImages().catch((err) => {
        console.warn("temp image sweep failed", err);
      });
    } catch (err) {
      console.warn("temp image sweep unavailable", err);
    }
  },

  onShow() {
    this.validateTodayOutfit();
  },

  validateTodayOutfit() {
    try {
      const service = require("./services/app-service");
      service.getValidTodayAssignment();
    } catch (err) {
      console.warn("today outfit validation failed", err);
    }
  },

  initializeUserScope() {
    const service = require("./services/app-service");
    service.ensureUserScope().then((userId) => {
      if (!userId) return;
      service.getCurrentUser().catch((err) => {
        console.warn("local user data migration failed", err);
      });
      this.validateTodayOutfit();
    }).catch((err) => {
      service.markIdentityUnconfirmed(err);
      console.warn("user identity unavailable; cloud data remains scoped by cloud functions", err);
    });
  }
});
