function canUseCloud() {
  return Boolean(wx.cloud && wx.cloud.callFunction);
}

function createCloudError(result, fallbackMessage) {
  const err = new Error((result && result.errorMessage) || fallbackMessage || "云函数调用失败");
  err.code = result && result.errorCode;
  return err;
}

function callFunction(name, data) {
  if (!canUseCloud()) {
    return Promise.reject(createCloudError(null, "当前环境不支持云开发"));
  }

  return wx.cloud.callFunction({ name, data }).then(({ result }) => {
    if (!result || !result.ok) {
      throw createCloudError(result, "云函数调用失败");
    }
    return result.data;
  });
}

module.exports = {
  canUseCloud,
  callFunction
};
