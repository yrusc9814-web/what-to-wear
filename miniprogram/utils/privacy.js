function ensurePrivacyAuthorized() {
  return new Promise((resolve, reject) => {
    if (!wx.getPrivacySetting) {
      resolve();
      return;
    }

    wx.getPrivacySetting({
      success: (setting) => {
        if (!setting.needAuthorization) {
          resolve();
          return;
        }

        if (wx.requirePrivacyAuthorize) {
          wx.requirePrivacyAuthorize({
            success: resolve,
            fail: () => reject(new Error("PRIVACY_REJECTED"))
          });
          return;
        }

        wx.showModal({
          title: "隐私授权",
          content: "使用自动天气前，需要先阅读并同意隐私政策。",
          confirmText: "查看协议",
          success: (res) => {
            if (!res.confirm || !wx.openPrivacyContract) {
              reject(new Error("PRIVACY_REJECTED"));
              return;
            }
            wx.openPrivacyContract({
              success: () => reject(new Error("PRIVACY_RETRY_REQUIRED")),
              fail: () => reject(new Error("PRIVACY_REJECTED"))
            });
          }
        });
      },
      fail: resolve
    });
  });
}

module.exports = {
  ensurePrivacyAuthorized
};
