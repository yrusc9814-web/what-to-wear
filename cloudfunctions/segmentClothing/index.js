const cloud = require("wx-server-sdk");
const https = require("https");
const http = require("http");
const { Readable } = require("stream");
const { decodePngAlpha, isPngSignature } = require("./png-alpha");

const ImagesegModule = require("@alicloud/imageseg20191230");
const OpenApiModule = require("@alicloud/openapi-client");
const TeaUtilModule = require("@alicloud/tea-util");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const INPUT_MAX_BYTES = 3 * 1024 * 1024;
const RESULT_MAX_BYTES = 20 * 1024 * 1024;
const FILE_ID_MAX_LENGTH = 512;
const INPUT_DOWNLOAD_TIMEOUT_MS = 10 * 1000;
const SEGMENT_CONNECT_TIMEOUT_MS = 10 * 1000;
const SEGMENT_READ_TIMEOUT_MS = 45 * 1000;
const RESULT_DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const RESULT_HTTP_TIMEOUT_MS = 25 * 1000;
const SEGMENT_ENDPOINT = "imageseg.cn-shanghai.aliyuncs.com";
const CLOTH_CLASSES = new Set(["tops", "coat", "skirt", "pants", "bag", "shoes", "hat"]);

const ERROR_MESSAGES = {
  CONFIG_MISSING: "服务端未配置阿里云访问凭证，请联系开发者。",
  AUTH_REQUIRED: "缺少用户身份，请重新进入页面后再试。",
  TEMP_FILE_FORBIDDEN: "仅支持处理当前用户上传到临时目录的图片。",
  INPUT_UNAVAILABLE: "临时图片读取失败，请重新上传后再试。",
  INPUT_INVALID: "图片大小不符合要求（不超过 3MB 且内容非空）。",
  INPUT_TYPE_UNSUPPORTED: "仅支持 PNG / JPEG / BMP 格式图片。",
  SEGMENT_TIMEOUT: "抠图服务响应超时，请稍后重试。",
  SEGMENT_API_FAILED: "抠图服务调用失败，请稍后重试。",
  SEGMENT_RESULT_EMPTY: "抠图服务未返回可用结果，请稍后重试。",
  RESULT_DOWNLOAD_FAILED: "抠图结果下载失败，请稍后重试。",
  RESULT_DOWNLOAD_TIMEOUT: "抠图结果下载超时，请稍后重试。",
  RESULT_TOO_LARGE: "抠图结果超过大小限制。",
  RESULT_NOT_PNG: "抠图结果不是有效的透明 PNG。",
  RESULT_NO_ALPHA: "抠图结果没有透明像素，可能未识别出服饰主体。",
  RESULT_NO_FOREGROUND: "抠图结果没有可见的服饰主体，请换一张更清晰的单品图片再试。",
  RESULT_UPLOAD_FAILED: "抠图结果保存失败，请稍后重试。"
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

function taggedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function detectImageKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (isPngSignature(buffer)) return "png";
  if (buffer.toString("ascii", 0, 2) === "BM") return "bmp";
  return "";
}

function isAllowedTempFileId(fileId, openid) {
  return typeof fileId === "string"
    && fileId.length > 0
    && fileId.length <= FILE_ID_MAX_LENGTH
    && /^cloud:\/\//.test(fileId)
    && typeof openid === "string"
    && openid.length > 0
    && fileId.includes(`/wardrobe/${openid}/tmp/`);
}

function pickClass(value) {
  return typeof value === "string" && CLOTH_CLASSES.has(value) ? value : null;
}

function bufferToReadable(buffer) {
  return new Readable({
    read() {
      this.push(buffer);
      this.push(null);
    }
  });
}

function resolveCredentials() {
  return {
    accessKeyId: String(process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || "").trim(),
    accessKeySecret: String(process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || "").trim()
  };
}

function buildSegmentClient({ accessKeyId, accessKeySecret }) {
  const ConfigClass = OpenApiModule.Config || (OpenApiModule.default && OpenApiModule.default.Config);
  const ClientClass = ImagesegModule.default || ImagesegModule;
  if (typeof ConfigClass !== "function" || typeof ClientClass !== "function") {
    throw taggedError("SDK_DEPENDENCY_MISSING");
  }
  const config = new ConfigClass({ accessKeyId, accessKeySecret });
  config.endpoint = SEGMENT_ENDPOINT;
  return new ClientClass(config);
}

// SDK 3.0.1 的 SegmentClothAdvanceRequest.clothClass 类型为 string[]，故包一层数组。
function buildAdvanceRequest(imageStream, clothClass) {
  const options = { imageURLObject: imageStream };
  if (clothClass) options.clothClass = [clothClass];
  const RequestClass = ImagesegModule.SegmentClothAdvanceRequest;
  if (typeof RequestClass === "function") return new RequestClass(options);
  return options;
}

function buildRuntimeOptions() {
  const RuntimeOptionsClass = TeaUtilModule.RuntimeOptions
    || (TeaUtilModule.default && TeaUtilModule.default.RuntimeOptions);
  if (typeof RuntimeOptionsClass !== "function") {
    throw taggedError("SDK_DEPENDENCY_MISSING");
  }
  return new RuntimeOptionsClass({
    connectTimeout: SEGMENT_CONNECT_TIMEOUT_MS,
    readTimeout: SEGMENT_READ_TIMEOUT_MS
  });
}

function extractAliCode(error) {
  if (!error || typeof error !== "object") return "";
  if (typeof error.code === "string" && error.code) return error.code;
  if (error.data && typeof error.data.Code === "string" && error.data.Code) return error.data.Code;
  if (Number.isFinite(error.statusCode)) return `HTTP_${error.statusCode}`;
  return "";
}

function mapSegmentError(error) {
  if (error && error.code === "TIMEOUT") return { errorCode: "SEGMENT_TIMEOUT", aliCode: "" };
  if (error && error.code === "SDK_DEPENDENCY_MISSING") return { errorCode: "CONFIG_MISSING", aliCode: "" };
  return { errorCode: "SEGMENT_API_FAILED", aliCode: extractAliCode(error) };
}

// 诊断摘要：把底层错误摘要透传到失败 envelope（不含凭证/签名），便于验收定位。
// 注意：阿里云错误 message 可能内嵌 AccessKeyId（如 NotPurchase 类错误），必须脱敏。
function describeSdkError(error, credentials) {
  if (!error || typeof error !== "object") return "";
  const parts = [];
  if (Number.isFinite(error.statusCode)) parts.push(`statusCode=${error.statusCode}`);
  if (error.message) {
    let message = String(error.message).slice(0, 300);
    if (credentials && credentials.accessKeyId) message = message.split(credentials.accessKeyId).join("***AK***");
    if (credentials && credentials.accessKeySecret) message = message.split(credentials.accessKeySecret).join("***SK***");
    message = message.replace(/LTAI[0-9A-Za-z]{4,}/g, "***AK***");
    parts.push(`message=${message}`);
  }
  if (error.data && typeof error.data === "object" && error.data.Code) parts.push(`dataCode=${error.data.Code}`);
  return parts.join(" | ");
}

// 返回解析：resp.body.data.elements[0].imageURL（30 分钟有效的临时 URL）。
function extractResultImageURL(response) {
  const body = response && response.body;
  const elements = body && body.data && body.data.elements;
  if (!Array.isArray(elements)) return null;
  for (const element of elements) {
    const url = element && element.imageURL;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function downloadViaHttp(urlString, { timeoutMs = RESULT_HTTP_TIMEOUT_MS, maxBytes = RESULT_MAX_BYTES, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let redirectsLeft = maxRedirects;
    const attempt = (target) => {
      let url;
      try {
        url = new URL(target);
      } catch (error) {
        reject(taggedError("RESULT_URL_INVALID"));
        return;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        reject(taggedError("RESULT_URL_PROTOCOL"));
        return;
      }
      const transport = url.protocol === "http:" ? http : https;
      const request = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Accept: "image/png,image/*;q=0.8,*/*;q=0.5" },
        timeout: timeoutMs
      }, (response) => {
        const status = Number(response.statusCode);
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
          redirectsLeft -= 1;
          response.resume();
          try {
            attempt(new URL(location, url).toString());
          } catch (error) {
            reject(taggedError("RESULT_URL_INVALID"));
          }
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(taggedError("RESULT_HTTP_STATUS"));
          return;
        }
        const declaredLength = Number(response.headers["content-length"] || 0);
        if (declaredLength > maxBytes) {
          response.resume();
          reject(taggedError("RESULT_TOO_LARGE"));
          return;
        }
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            request.destroy(taggedError("RESULT_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            statusCode: status,
            contentType: String(response.headers["content-type"] || ""),
            buffer: Buffer.concat(chunks)
          });
        });
      });
      request.on("timeout", () => {
        request.destroy(taggedError("RESULT_DOWNLOAD_TIMEOUT"));
      });
      request.on("error", (error) => reject(error && error.code ? error : taggedError("RESULT_DOWNLOAD_FAILED")));
      request.end();
    };
    attempt(String(urlString || ""));
  });
}

// 测试注入点：替换结果下载实现（fake https）。
let resultDownloader = downloadViaHttp;

function buildResultCloudPath(openid) {
  const stamp = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `wardrobe/${openid}/tmp/cutout_${stamp}.png`;
}

function failure(errorCode, extra) {
  return {
    ok: false,
    errorCode,
    errorMessage: ERROR_MESSAGES[errorCode] || "抠图失败，请稍后重试。",
    ...(extra || {})
  };
}

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const { accessKeyId, accessKeySecret } = resolveCredentials();
  if (!accessKeyId || !accessKeySecret) return failure("CONFIG_MISSING");

  const wxContext = cloud.getWXContext();
  const openid = wxContext && wxContext.OPENID;
  if (!openid) return failure("AUTH_REQUIRED");

  const tempFileId = typeof event.tempFileId === "string" ? event.tempFileId.trim() : "";
  if (!isAllowedTempFileId(tempFileId, openid)) return failure("TEMP_FILE_FORBIDDEN");
  const clothClass = pickClass(event.clothClass);

  let fileContent;
  try {
    const downloaded = await withTimeout(cloud.downloadFile({ fileID: tempFileId }), INPUT_DOWNLOAD_TIMEOUT_MS);
    fileContent = downloaded && downloaded.fileContent;
  } catch (error) {
    console.warn("segmentClothing input unavailable", (error && error.code) || "");
    return failure("INPUT_UNAVAILABLE");
  }
  if (!Buffer.isBuffer(fileContent) || fileContent.length === 0 || fileContent.length > INPUT_MAX_BYTES) {
    return failure("INPUT_INVALID");
  }
  const inputKind = detectImageKind(fileContent);
  if (!inputKind) return failure("INPUT_TYPE_UNSUPPORTED");
  console.log("segmentClothing input ready", { bytes: fileContent.length, kind: inputKind, clothClass: clothClass || "" });

  let response;
  try {
    const client = buildSegmentClient({ accessKeyId, accessKeySecret });
    const advanceRequest = buildAdvanceRequest(bufferToReadable(fileContent), clothClass);
    response = await client.segmentClothAdvance(advanceRequest, buildRuntimeOptions());
  } catch (error) {
    const mapped = mapSegmentError(error);
    const detail = describeSdkError(error, resolveCredentials());
    console.warn("segmentClothing api failed", { aliCode: mapped.aliCode, detail });
    const extra = mapped.aliCode ? { aliCode: mapped.aliCode } : undefined;
    return failure(mapped.errorCode, { ...(extra || {}), ...(detail ? { aliMessage: detail } : {}) });
  }

  const resultUrl = extractResultImageURL(response);
  if (!resultUrl) return failure("SEGMENT_RESULT_EMPTY");

  let downloaded;
  try {
    downloaded = await withTimeout(
      resultDownloader(resultUrl, { timeoutMs: RESULT_HTTP_TIMEOUT_MS, maxBytes: RESULT_MAX_BYTES }),
      RESULT_DOWNLOAD_TIMEOUT_MS
    );
  } catch (error) {
    const code = error && error.code;
    const errorCode = code === "RESULT_DOWNLOAD_TIMEOUT" || code === "TIMEOUT"
      ? "RESULT_DOWNLOAD_TIMEOUT"
      : code === "RESULT_TOO_LARGE" ? "RESULT_TOO_LARGE" : "RESULT_DOWNLOAD_FAILED";
    console.warn("segmentClothing result download failed", { errorCode });
    return failure(errorCode);
  }
  if (!downloaded
    || !(Number(downloaded.statusCode) >= 200 && Number(downloaded.statusCode) < 300)
    || !Buffer.isBuffer(downloaded.buffer)
    || downloaded.buffer.length === 0) {
    return failure("RESULT_DOWNLOAD_FAILED");
  }
  if (downloaded.buffer.length > RESULT_MAX_BYTES) return failure("RESULT_TOO_LARGE");
  if (!isPngSignature(downloaded.buffer) && !/image\/png/i.test(String(downloaded.contentType || ""))) {
    return failure("RESULT_NOT_PNG");
  }
  const png = decodePngAlpha(downloaded.buffer);
  if (!png) return failure("RESULT_NOT_PNG");
  if (!png.hasAlpha || png.transparentPixelCount < 1) return failure("RESULT_NO_ALPHA");
  // Round 2A-2：全透明（没有任何 alpha>=128 的像素）说明未抠出可见主体，拒绝以免用户拿到空白图。
  if (png.foregroundPixelCount < 1) return failure("RESULT_NO_FOREGROUND");
  console.log("segmentClothing alpha verified", {
    width: png.width,
    height: png.height,
    transparentPixelCount: png.transparentPixelCount,
    foregroundPixelCount: png.foregroundPixelCount,
    bytes: downloaded.buffer.length
  });

  const cloudPath = buildResultCloudPath(openid);
  let uploadResult;
  try {
    uploadResult = await cloud.uploadFile({ cloudPath, fileContent: downloaded.buffer });
  } catch (error) {
    console.warn("segmentClothing result upload failed", (error && error.code) || "");
    return failure("RESULT_UPLOAD_FAILED");
  }
  const resultFileId = uploadResult && uploadResult.fileID;
  if (typeof resultFileId !== "string" || !/^cloud:\/\//.test(resultFileId)) {
    return failure("RESULT_UPLOAD_FAILED");
  }

  return {
    ok: true,
    data: {
      resultFileId,
      width: png.width,
      height: png.height,
      hasAlpha: true,
      transparentPixelCount: png.transparentPixelCount,
      foregroundPixelCount: png.foregroundPixelCount,
      elapsedMs: Date.now() - startedAt
    }
  };
};

exports._test = {
  detectImageKind,
  isAllowedTempFileId,
  pickClass,
  bufferToReadable,
  buildAdvanceRequest,
  buildResultCloudPath,
  extractAliCode,
  mapSegmentError,
  extractResultImageURL,
  downloadViaHttp,
  decodePngAlpha,
  isPngSignature,
  ERROR_MESSAGES,
  setResultDownloader(fn) {
    resultDownloader = typeof fn === "function" ? fn : downloadViaHttp;
  }
};
