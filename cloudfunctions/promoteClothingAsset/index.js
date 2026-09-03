"use strict";

// Round 2A-4: 将 standardized staging PNG 提升为内容寻址正式服装资产。
// 职责：下载 standardized temp → 校验完整性 → 内容寻址 SHA256 → 幂等上传至 /clothing/。
// 绝不删除任何输入/源文件。

const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const { isPngSignature, decodePngAlpha } = require("./png-alpha");
const { decodeRgba, countAlphaPixels } = require("./image-process");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const INPUT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_SIDE = 1024;

const STANDARDIZED_RE = /^cloud:\/\/[A-Za-z0-9_.-]+\/wardrobe\/([^/]+)\/tmp\/standardized_[A-Za-z0-9._-]+\.png$/;

// getTempFileURL 存在性判定（Round 2A-4 修复）：
// 线上环境返回的 entry 有两种形状——带 code（"SUCCESS"/"FILE_NOT_FOUND"），或
// 无 code 字段、只有 status（0=存在 / 1=已删）+ tempFileURL（与 deleteWardrobeTemp
// 已上线可用逻辑一致的形状）。因此“文件是否存在”按以下兼容语义判定：
//   - tempFileURL 必须是非空字符串（文件实际可寻址）；
//   - 负向标记优先拒绝：code 明确非 SUCCESS，或 status===1（已删/不可用）；
//   - 正向：status===0，或 code==="SUCCESS"；无 code 且无负向 status 时，凭非空 URL 视为存在。
function isExistingTempUrlEntry(entry) {
  if (!entry || typeof entry.tempFileURL !== "string" || entry.tempFileURL.length === 0) return false;
  if (entry.code !== undefined && entry.code !== "SUCCESS") return false;
  if (Number.isFinite(Number(entry.status)) && Number(entry.status) !== 0) return false;
  if (Number(entry.status) === 0) return true;
  if (entry.code === "SUCCESS") return true;
  if (entry.code === undefined) return true;
  return false;
}

const ERROR_MESSAGES = {
  AUTH_REQUIRED: "缺少用户身份，请重新进入页面后再试。",
  INPUT_REQUIRED: "请提供待提升的 standardized 临时文件。",
  INPUT_FORBIDDEN: "仅支持提升当前用户 standardized 目录下的文件。",
  INPUT_UNAVAILABLE: "标准化结果读取失败，请重新标准化后再试。",
  INPUT_INVALID: "标准化结果内容无效。",
  NOT_PNG: "输入不是有效的 PNG 文件。",
  NO_ALPHA: "输入没有透明像素，无法作为服装正式图片。",
  NO_FOREGROUND: "输入没有可见的服饰主体，无法作为服装正式图片。",
  UPLOAD_FAILED: "正式图片保存失败，请稍后重试。",
  VERIFY_FAILED: "正式图片上传后验证失败。",
  FORMAL_ASSET_HASH_CONFLICT: "目标位置已存在不同内容的文件，拒绝覆盖。"
};

function failure(errorCode, extra) {
  return {
    ok: false,
    errorCode,
    errorMessage: ERROR_MESSAGES[errorCode] || "提升正式图片失败，请稍后重试。",
    ...(extra || {})
  };
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext && wxContext.OPENID;
  if (!openid) return failure("AUTH_REQUIRED");

  const standardizedTempFileId = typeof event.standardizedTempFileId === "string"
    ? event.standardizedTempFileId.trim()
    : "";
  if (!standardizedTempFileId) return failure("INPUT_REQUIRED");

  // 严格路径校验：仅接受本人 standardized temp
  const match = standardizedTempFileId.match(STANDARDIZED_RE);
  if (!match || match[1] !== openid) return failure("INPUT_FORBIDDEN");

  // 下载源文件
  let fileContent;
  try {
    const downloaded = await cloud.downloadFile({ fileID: standardizedTempFileId });
    fileContent = downloaded && downloaded.fileContent;
  } catch (error) {
    console.warn("promoteClothingAsset download failed", (error && error.code) || "");
    return failure("INPUT_UNAVAILABLE");
  }
  if (!Buffer.isBuffer(fileContent) || fileContent.length === 0 || fileContent.length > INPUT_MAX_BYTES) {
    return failure("INPUT_INVALID");
  }
  if (!isPngSignature(fileContent)) return failure("NOT_PNG");

  // PNG 解码验证
  let raw;
  try {
    raw = decodeRgba(fileContent);
  } catch (error) {
    console.warn("promoteClothingAsset decode failed", String((error && error.message) || error).slice(0, 120));
    return failure("NOT_PNG");
  }
  if (!Buffer.isBuffer(raw.data) || raw.width < 1 || raw.height < 1) {
    return failure("NOT_PNG");
  }
  if (Math.max(raw.width, raw.height) > MAX_SIDE) {
    return failure("INPUT_INVALID");
  }

  // alpha 校验
  const stats = countAlphaPixels(raw.data);
  if (!stats.hasAlpha || stats.transparentPixelCount < 1) return failure("NO_ALPHA");
  if (stats.foregroundPixelCount < 1) return failure("NO_FOREGROUND");

  // 计算内容寻址
  const sha256 = crypto.createHash("sha256").update(fileContent).digest("hex");
  const formalPath = `wardrobe/${openid}/clothing/${sha256}.png`;
  const env = wxContext.ENV || cloud.DYNAMIC_CURRENT_ENV || "env";
  const formalImageFileId = `cloud://${env}/${formalPath}`;

  // 幂等探测：检查目标路径是否已存在
  try {
    const probeResult = await cloud.getTempFileURL({ fileList: [formalImageFileId] });
    const probeEntry = probeResult && Array.isArray(probeResult.fileList) ? probeResult.fileList[0] : null;
    if (isExistingTempUrlEntry(probeEntry)) {
      // 已存在：下载并比较 SHA
      let existingBuffer;
      try {
        const existingDownload = await cloud.downloadFile({ fileID: formalImageFileId });
        existingBuffer = existingDownload && existingDownload.fileContent;
      } catch (error) {
        console.warn("promoteClothingAsset existing file download failed", (error && error.code) || "");
        return failure("FORMAL_ASSET_HASH_CONFLICT");
      }
      if (!Buffer.isBuffer(existingBuffer)) return failure("FORMAL_ASSET_HASH_CONFLICT");

      const existingSha256 = crypto.createHash("sha256").update(existingBuffer).digest("hex");
      if (existingSha256 === sha256) {
        // 内容一致 → IDEMPOTENT
        return {
          ok: true,
          data: {
            status: "IDEMPOTENT",
            formalImageFileId,
            sha256,
            width: raw.width,
            height: raw.height,
            bytes: fileContent.length
          }
        };
      }
      // 内容不一致 → 冲突
      return failure("FORMAL_ASSET_HASH_CONFLICT");
    }
  } catch (error) {
    // 探测失败可能是文件不存在或其他错误，继续上传
    console.warn("promoteClothingAsset probe failed", (error && error.code) || "");
  }

  // 不存在 → 上传
  let uploadResult;
  try {
    uploadResult = await cloud.uploadFile({ cloudPath: formalPath, fileContent });
  } catch (error) {
    console.warn("promoteClothingAsset upload failed", (error && error.code) || "");
    return failure("UPLOAD_FAILED");
  }
  const uploadedFileId = uploadResult && uploadResult.fileID;
  if (typeof uploadedFileId !== "string" || !/^cloud:\/\//.test(uploadedFileId)) {
    return failure("UPLOAD_FAILED");
  }

  // 上传后复核
  try {
    const verifyResult = await cloud.getTempFileURL({ fileList: [uploadedFileId] });
    const verifyEntry = verifyResult && Array.isArray(verifyResult.fileList) ? verifyResult.fileList[0] : null;
    if (!isExistingTempUrlEntry(verifyEntry)) {
      console.warn("promoteClothingAsset verify failed after upload");
      return failure("VERIFY_FAILED");
    }
  } catch (error) {
    console.warn("promoteClothingAsset verify exception after upload", (error && error.code) || "");
    return failure("VERIFY_FAILED");
  }

  console.log("promoteClothingAsset done", {
    openid: "***",
    sha256: sha256.slice(0, 16),
    dimensions: `${raw.width}x${raw.height}`,
    bytes: fileContent.length,
    status: "PROMOTED"
  });

  return {
    ok: true,
    data: {
      status: "PROMOTED",
      formalImageFileId: uploadedFileId,
      sha256,
      width: raw.width,
      height: raw.height,
      bytes: fileContent.length
    }
  };
};

exports._test = {
  STANDARDIZED_RE,
  ERROR_MESSAGES,
  INPUT_MAX_BYTES,
  MAX_SIDE,
  isExistingTempUrlEntry
};