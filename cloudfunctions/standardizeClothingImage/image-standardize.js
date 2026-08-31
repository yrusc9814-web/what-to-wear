"use strict";

// Round 2A-3.1 技术标准化几何：纯函数，不依赖 sharp。
// png-alpha.js 只负责 PNG 校验 / alpha 统计，不在这里做编解码或缩放。
// 以下常量是 V1 默认技术参数（经真实云端门禁验证），不是永久视觉规范；
// 后续仍允许基于五类真实服饰素材重新校准。

const FILE_ID_MAX_LENGTH = 512;
const BBOX_ALPHA_THRESHOLD = 8;
const PAD_RATIO = 0.04;
const PAD_MIN = 8;
const PAD_MAX = 48;
const MAX_SIDE = 1024;
const CUTOUT_FILENAME = /^cutout_[A-Za-z0-9._-]+\.png$/;

function classifyCutoutFileId(fileId, openid) {
  if (typeof fileId !== "string") return "invalid";
  const id = fileId.trim();
  if (!id || id.length > FILE_ID_MAX_LENGTH) return "invalid";
  if (!id.startsWith("cloud://")) return "invalid";
  const withoutScheme = id.slice("cloud://".length);
  const firstSlash = withoutScheme.indexOf("/");
  if (firstSlash <= 0) return "invalid";
  const storagePath = withoutScheme.slice(firstSlash + 1);
  const segments = storagePath.split("/");
  if (segments[0] !== "wardrobe") return "invalid";
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "invalid";
  if (typeof openid !== "string" || !openid || segments[1] !== openid) return "forbidden";
  if (segments.length !== 4 || segments[2] !== "tmp") return "forbidden";
  if (!CUTOUT_FILENAME.test(segments[3])) return "forbidden";
  return "ok";
}

function maskFileId(fileId) {
  return String(fileId || "").replace(/(wardrobe\/)[^/]+(\/)/, "$1***$2");
}

function clampPadding(value) {
  if (!Number.isFinite(value)) return PAD_MIN;
  return Math.min(PAD_MAX, Math.max(PAD_MIN, Math.round(value)));
}

function computeForegroundBBox(rgba, width, height, threshold = BBOX_ALPHA_THRESHOLD) {
  if (!rgba || width < 1 || height < 1) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function computeTrim(bbox, imageWidth, imageHeight) {
  return {
    left: bbox.minX,
    top: bbox.minY,
    right: imageWidth - 1 - bbox.maxX,
    bottom: imageHeight - 1 - bbox.maxY
  };
}

function computePadding(bbox) {
  const longEdge = Math.max(bbox.width, bbox.height);
  return clampPadding(longEdge * PAD_RATIO);
}

function computePaddedSize(bbox, padding) {
  return {
    width: bbox.width + padding * 2,
    height: bbox.height + padding * 2
  };
}

function computeTargetSize(width, height, maxSide = MAX_SIDE) {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxSide) {
    return { width, height, resized: false, scale: 1 };
  }
  const scale = maxSide / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
    scale
  };
}

function planStandardize(rgba, imageWidth, imageHeight, options = {}) {
  const threshold = options.bboxThreshold == null ? BBOX_ALPHA_THRESHOLD : options.bboxThreshold;
  const maxSide = options.maxSide == null ? MAX_SIDE : options.maxSide;
  const bbox = computeForegroundBBox(rgba, imageWidth, imageHeight, threshold);
  if (!bbox) return { ok: false, errorCode: "RESULT_NO_FOREGROUND" };
  const padding = computePadding(bbox);
  const padded = computePaddedSize(bbox, padding);
  const target = computeTargetSize(padded.width, padded.height, maxSide);
  return {
    ok: true,
    bbox,
    trim: computeTrim(bbox, imageWidth, imageHeight),
    padding,
    paddedWidth: padded.width,
    paddedHeight: padded.height,
    targetWidth: target.width,
    targetHeight: target.height,
    resized: target.resized,
    scale: target.scale,
    extract: {
      left: bbox.minX,
      top: bbox.minY,
      width: bbox.width,
      height: bbox.height
    }
  };
}

function aspectRatio(width, height) {
  return height === 0 ? 0 : width / height;
}

module.exports = {
  FILE_ID_MAX_LENGTH,
  BBOX_ALPHA_THRESHOLD,
  PAD_RATIO,
  PAD_MIN,
  PAD_MAX,
  MAX_SIDE,
  CUTOUT_FILENAME,
  classifyCutoutFileId,
  maskFileId,
  clampPadding,
  computeForegroundBBox,
  computeTrim,
  computePadding,
  computePaddedSize,
  computeTargetSize,
  planStandardize,
  aspectRatio
};
