"use strict";

// Round 2A-3.1：用成熟 pngjs 编解码 RGBA PNG。
// 裁剪 / 留白 / 缩放只操作原始像素，不扩展自制 PNG 编解码器。

const { PNG } = require("pngjs");

const PNG_DEFLATE_LEVEL = 1;

function extractAndPad(src, srcWidth, srcHeight, extract, padding) {
  const outWidth = extract.width + padding * 2;
  const outHeight = extract.height + padding * 2;
  const out = Buffer.alloc(outWidth * outHeight * 4);
  for (let y = 0; y < extract.height; y += 1) {
    const srcStart = ((extract.top + y) * srcWidth + extract.left) * 4;
    const dstStart = ((padding + y) * outWidth + padding) * 4;
    src.copy(out, dstStart, srcStart, srcStart + extract.width * 4);
  }
  return { data: out, width: outWidth, height: outHeight };
}

// 预乘 alpha 双线性缩放，避免半透明边缘缩放出黑边。
function resizeBilinear(src, srcWidth, srcHeight, dstWidth, dstHeight) {
  const out = Buffer.alloc(dstWidth * dstHeight * 4);
  const xRatio = srcWidth / dstWidth;
  const yRatio = srcHeight / dstHeight;
  const maxX = srcWidth - 1;
  const maxY = srcHeight - 1;
  for (let y = 0; y < dstHeight; y += 1) {
    const fy = (y + 0.5) * yRatio - 0.5;
    let y0 = fy | 0;
    if (y0 < 0) y0 = 0;
    else if (y0 > maxY) y0 = maxY;
    const y1 = y0 === maxY ? y0 : y0 + 1;
    const wy = fy < 0 ? 0 : (fy > maxY ? 1 : fy - y0);
    const row0 = y0 * srcWidth;
    const row1 = y1 * srcWidth;
    for (let x = 0; x < dstWidth; x += 1) {
      const fx = (x + 0.5) * xRatio - 0.5;
      let x0 = fx | 0;
      if (x0 < 0) x0 = 0;
      else if (x0 > maxX) x0 = maxX;
      const x1 = x0 === maxX ? x0 : x0 + 1;
      const wx = fx < 0 ? 0 : (fx > maxX ? 1 : fx - x0);
      const i00 = (row0 + x0) * 4;
      const i10 = (row0 + x1) * 4;
      const i01 = (row1 + x0) * 4;
      const i11 = (row1 + x1) * 4;
      const a00 = src[i00 + 3];
      const a10 = src[i10 + 3];
      const a01 = src[i01 + 3];
      const a11 = src[i11 + 3];
      const topA = a00 + (a10 - a00) * wx;
      const botA = a01 + (a11 - a01) * wx;
      const alpha = topA + (botA - topA) * wy;
      const dest = (y * dstWidth + x) * 4;
      if (alpha < 0.5) {
        out[dest] = 0;
        out[dest + 1] = 0;
        out[dest + 2] = 0;
        out[dest + 3] = 0;
      } else {
        const inv = 1 / alpha;
        const mix = (channel) => {
          const t = src[i00 + channel] * a00 + (src[i10 + channel] * a10 - src[i00 + channel] * a00) * wx;
          const b = src[i01 + channel] * a01 + (src[i11 + channel] * a11 - src[i01 + channel] * a01) * wx;
          return (t + (b - t) * wy) * inv;
        };
        let r = mix(0) + 0.5 | 0;
        let g = mix(1) + 0.5 | 0;
        let b = mix(2) + 0.5 | 0;
        if (r > 255) r = 255; else if (r < 0) r = 0;
        if (g > 255) g = 255; else if (g < 0) g = 0;
        if (b > 255) b = 255; else if (b < 0) b = 0;
        out[dest] = r;
        out[dest + 1] = g;
        out[dest + 2] = b;
        out[dest + 3] = alpha + 0.5 | 0;
      }
    }
  }
  return out;
}

function encodeRgbaPng(data, width, height) {
  const output = new PNG({ width, height, colorType: 6, inputHasAlpha: true });
  data.copy(output.data);
  return PNG.sync.write(output, { colorType: 6, deflateLevel: PNG_DEFLATE_LEVEL });
}

function finishProcessed(data, width, height) {
  return {
    buffer: encodeRgbaPng(data, width, height),
    width,
    height,
    stats: countAlphaPixels(data)
  };
}

function processFromRgba(src, srcWidth, srcHeight, plan) {
  if (plan.resized) {
    const scale = plan.scale;
    const innerWidth = Math.max(1, Math.round(plan.extract.width * scale));
    const innerHeight = Math.max(1, Math.round(plan.extract.height * scale));
    const padX = Math.max(0, Math.round((plan.targetWidth - innerWidth) / 2));
    const padY = Math.max(0, Math.round((plan.targetHeight - innerHeight) / 2));
    const extracted = extractAndPad(src, srcWidth, srcHeight, plan.extract, 0);
    const resized = resizeBilinear(extracted.data, extracted.width, extracted.height, innerWidth, innerHeight);
    const canvas = Buffer.alloc(plan.targetWidth * plan.targetHeight * 4);
    for (let y = 0; y < innerHeight; y += 1) {
      const destY = Math.min(plan.targetHeight - 1, padY + y);
      const srcStart = y * innerWidth * 4;
      const dstStart = (destY * plan.targetWidth + padX) * 4;
      const copyWidth = Math.min(innerWidth, plan.targetWidth - padX);
      resized.copy(canvas, dstStart, srcStart, srcStart + copyWidth * 4);
    }
    return finishProcessed(canvas, plan.targetWidth, plan.targetHeight);
  }
  const padded = extractAndPad(src, srcWidth, srcHeight, plan.extract, plan.padding);
  return finishProcessed(padded.data, padded.width, padded.height);
}

function processStandardizedPng(inputBuffer, plan) {
  const source = decodeRgba(inputBuffer);
  if (!source || !Buffer.isBuffer(source.data) || source.width < 1 || source.height < 1) {
    throw new Error("PNGJS_READ_FAILED");
  }
  return processFromRgba(source.data, source.width, source.height, plan).buffer;
}

function countAlphaPixels(rgba) {
  let transparent = 0;
  let foreground = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const alpha = rgba[i];
    if (alpha < 255) transparent += 1;
    if (alpha >= 128) foreground += 1;
  }
  return {
    hasAlpha: transparent > 0,
    transparentPixelCount: transparent,
    foregroundPixelCount: foreground
  };
}

function decodeRgba(inputBuffer) {
  const source = PNG.sync.read(inputBuffer);
  return { width: source.width, height: source.height, data: source.data };
}

module.exports = {
  PNG_DEFLATE_LEVEL,
  extractAndPad,
  resizeBilinear,
  processFromRgba,
  processStandardizedPng,
  decodeRgba,
  countAlphaPixels
};
