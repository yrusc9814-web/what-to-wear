const cloud = require("wx-server-sdk");
const { isPngSignature } = require("./png-alpha");
const {
  classifyCutoutFileId,
  maskFileId,
  planStandardize,
  aspectRatio,
  BBOX_ALPHA_THRESHOLD,
  PAD_RATIO,
  PAD_MIN,
  PAD_MAX,
  MAX_SIDE
} = require("./image-standardize");
const { processFromRgba, decodeRgba, countAlphaPixels, PNG_DEFLATE_LEVEL } = require("./image-process");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const INPUT_MAX_BYTES = 20 * 1024 * 1024;
const INPUT_DOWNLOAD_TIMEOUT_MS = 15 * 1000;

const ERROR_MESSAGES = {
  AUTH_REQUIRED: "缺少用户身份，请重新进入页面后再试。",
  TEMP_FILE_FORBIDDEN: "仅支持处理当前用户临时目录下的抠图结果。",
  INPUT_UNAVAILABLE: "抠图结果读取失败，请重新抠图后再试。",
  INPUT_INVALID: "抠图结果大小不符合要求。",
  RESULT_NOT_PNG: "输入不是有效的透明 PNG。",
  RESULT_NO_ALPHA: "输入没有透明像素，无法标准化。",
  RESULT_NO_FOREGROUND: "输入没有可见的服饰主体，无法标准化。",
  PROCESS_FAILED: "图片标准化失败，请稍后重试。",
  RESULT_UPLOAD_FAILED: "标准化结果保存失败，请稍后重试。"
};

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("TIMEOUT");
      error.code = "TIMEOUT";
      reject(error);
    }, timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function failure(errorCode, extra) {
  return {
    ok: false,
    errorCode,
    errorMessage: ERROR_MESSAGES[errorCode] || "图片标准化失败，请稍后重试。",
    ...(extra || {})
  };
}

function buildResultCloudPath(openid) {
  const stamp = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `wardrobe/${openid}/tmp/standardized_${stamp}.png`;
}

function ratiosClose(a, b, epsilon = 0.01) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return false;
  return Math.abs(a - b) / b <= epsilon;
}

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const wxContext = cloud.getWXContext();
  const openid = wxContext && wxContext.OPENID;
  if (!openid) return failure("AUTH_REQUIRED");

  const cutoutTempFileId = typeof event.cutoutTempFileId === "string" ? event.cutoutTempFileId.trim() : "";
  const verdict = classifyCutoutFileId(cutoutTempFileId, openid);
  if (verdict !== "ok") return failure("TEMP_FILE_FORBIDDEN");

  let fileContent;
  try {
    const downloaded = await withTimeout(cloud.downloadFile({ fileID: cutoutTempFileId }), INPUT_DOWNLOAD_TIMEOUT_MS);
    fileContent = downloaded && downloaded.fileContent;
  } catch (error) {
    console.warn("standardizeClothingImage input unavailable", (error && error.code) || "");
    return failure("INPUT_UNAVAILABLE");
  }
  if (!Buffer.isBuffer(fileContent) || fileContent.length === 0 || fileContent.length > INPUT_MAX_BYTES) {
    return failure("INPUT_INVALID");
  }
  if (!isPngSignature(fileContent)) return failure("RESULT_NOT_PNG");

  let raw;
  try {
    raw = decodeRgba(fileContent);
  } catch (error) {
    console.warn("standardizeClothingImage decode failed", String((error && error.message) || error).slice(0, 120));
    return failure("RESULT_NOT_PNG");
  }
  const inputStats = countAlphaPixels(raw.data);
  if (!inputStats.hasAlpha || inputStats.transparentPixelCount < 1) return failure("RESULT_NO_ALPHA");
  if (inputStats.foregroundPixelCount < 1) return failure("RESULT_NO_FOREGROUND");

  const plan = planStandardize(raw.data, raw.width, raw.height);
  if (!plan.ok) return failure(plan.errorCode);

  let processed;
  try {
    processed = processFromRgba(raw.data, raw.width, raw.height, plan);
  } catch (error) {
    console.warn("standardizeClothingImage process failed", String((error && error.message) || error).slice(0, 120));
    return failure("PROCESS_FAILED");
  }
  const outputBuffer = processed.buffer;
  const outputStats = processed.stats;
  if (!outputStats.hasAlpha || outputStats.transparentPixelCount < 1) return failure("RESULT_NO_ALPHA");
  if (outputStats.foregroundPixelCount < 1) return failure("RESULT_NO_FOREGROUND");
  if (processed.width !== plan.targetWidth || processed.height !== plan.targetHeight) {
    console.warn("standardizeClothingImage size mismatch", {
      expected: { width: plan.targetWidth, height: plan.targetHeight },
      actual: { width: processed.width, height: processed.height }
    });
    return failure("PROCESS_FAILED");
  }
  const inputRatio = aspectRatio(plan.paddedWidth, plan.paddedHeight);
  const outputRatio = aspectRatio(processed.width, processed.height);
  if (!ratiosClose(outputRatio, inputRatio)) return failure("PROCESS_FAILED");

  const cloudPath = buildResultCloudPath(openid);
  let uploadResult;
  try {
    uploadResult = await cloud.uploadFile({ cloudPath, fileContent: outputBuffer });
  } catch (error) {
    console.warn("standardizeClothingImage result upload failed", (error && error.code) || "");
    return failure("RESULT_UPLOAD_FAILED");
  }
  const standardizedTempFileId = uploadResult && uploadResult.fileID;
  if (typeof standardizedTempFileId !== "string" || !/^cloud:\/\//.test(standardizedTempFileId)) {
    return failure("RESULT_UPLOAD_FAILED");
  }

  const elapsedMs = Date.now() - startedAt;
  console.log("standardizeClothingImage done", {
    openid: "***",
    input: { width: raw.width, height: raw.height, bytes: fileContent.length },
    output: { width: processed.width, height: processed.height, bytes: outputBuffer.length },
    trim: plan.trim,
    padding: plan.padding,
    resized: plan.resized,
    elapsedMs,
    fileId: maskFileId(standardizedTempFileId)
  });

  return {
    ok: true,
    data: {
      standardizedTempFileId,
      width: processed.width,
      height: processed.height,
      bytes: outputBuffer.length,
      hasAlpha: true,
      transparentPixelCount: outputStats.transparentPixelCount,
      foregroundPixelCount: outputStats.foregroundPixelCount,
      bbox: plan.bbox,
      trim: plan.trim,
      padding: plan.padding,
      resized: plan.resized,
      inputWidth: raw.width,
      inputHeight: raw.height,
      inputBytes: fileContent.length,
      elapsedMs
    }
  };
};

exports._test = {
  classifyCutoutFileId,
  maskFileId,
  planStandardize,
  processFromRgba,
  processStandardizedPng: require("./image-process").processStandardizedPng,
  buildResultCloudPath,
  ERROR_MESSAGES,
  BBOX_ALPHA_THRESHOLD,
  PAD_RATIO,
  PAD_MIN,
  PAD_MAX,
  MAX_SIDE,
  PNG_DEFLATE_LEVEL
};
