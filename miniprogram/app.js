App({
  onLaunch() {
    if (!wx.cloud) {
      console.warn("当前基础库不支持云开发");
      return;
    }

    wx.cloud.init({
      env: "cloud1-d1gjweewr2740aa1f",
      traceUser: true
    });
  }
});
