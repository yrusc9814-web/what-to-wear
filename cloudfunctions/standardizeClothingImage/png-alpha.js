"use strict";

// 自包含最小 PNG 解码器：只为验证抠图结果确实带 alpha 且存在透明像素。
// 支持全部 5 种 filter 类型（None/Sub/Up/Average/Paeth）、bitDepth 1/2/4/8/16、
// colorType 0/2/3/4/6（含 tRNS）、非隔行与 Adam7 隔行。
// 不做完整图像重建，只统计 alpha 信息与透明像素数量。

const zlib = require("zlib");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const BIT_DEPTHS_BY_COLOR_TYPE = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16]
};
const MAX_TOTAL_PIXELS = 50 * 1000 * 1000;
// 前景判定阈值：alpha >= 128（即不透明度过半）的像素计入前景。
// 取 128 可把抗锯齿半透明边缘计入主体，同时排除抠图结果中大面积低透明度噪声。
const FOREGROUND_ALPHA_THRESHOLD = 128;
const ADAM7_PASSES = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 }
];

function isPngSignature(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterRow(filterType, row, previous, bytesPerCompletePixel) {
  switch (filterType) {
    case 0:
      return;
    case 1:
      for (let i = bytesPerCompletePixel; i < row.length; i += 1) {
        row[i] = (row[i] + row[i - bytesPerCompletePixel]) & 0xff;
      }
      return;
    case 2:
      for (let i = 0; i < row.length; i += 1) {
        row[i] = (row[i] + previous[i]) & 0xff;
      }
      return;
    case 3:
      for (let i = 0; i < row.length; i += 1) {
        const left = i >= bytesPerCompletePixel ? row[i - bytesPerCompletePixel] : 0;
        row[i] = (row[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < row.length; i += 1) {
        const left = i >= bytesPerCompletePixel ? row[i - bytesPerCompletePixel] : 0;
        const up = previous[i];
        const upLeft = i >= bytesPerCompletePixel ? previous[i - bytesPerCompletePixel] : 0;
        row[i] = (row[i] + paethPredictor(left, up, upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`UNSUPPORTED_FILTER_${filterType}`);
  }
}

function readU16(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1];
}

function readSubByteValue(buffer, x, bitDepth) {
  const bitOffset = x * bitDepth;
  const byteIndex = bitOffset >> 3;
  const shift = 8 - bitDepth - (bitOffset & 7);
  const mask = (1 << bitDepth) - 1;
  return (buffer[byteIndex] >> shift) & mask;
}

// 返回归一化到 0..255 的 alpha（tRNS 命中即为 0，其余为 255）。
function sampleAlpha(row, x, header, trns) {
  const { colorType, bitDepth } = header;
  if (colorType === 6 || colorType === 4) {
    const channels = colorType === 6 ? 4 : 2;
    if (bitDepth === 8) return row[x * channels + (channels - 1)];
    return Math.round((readU16(row, (x * channels + channels - 1) * 2) * 255) / 65535);
  }
  if (colorType === 0) {
    if (!trns) return 255;
    if (bitDepth === 16) return readU16(row, x * 2) === readU16(trns, 0) ? 0 : 255;
    const value = bitDepth === 8 ? row[x] : readSubByteValue(row, x, bitDepth);
    return value === trns[0] ? 0 : 255;
  }
  if (colorType === 2) {
    if (!trns) return 255;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = bitDepth === 16
        ? readU16(row, (x * 3 + channel) * 2)
        : row[x * 3 + channel];
      const key = bitDepth === 16
        ? readU16(trns, channel * 2)
        : trns[channel];
      if (value !== key) return 255;
    }
    return 0;
  }
  if (colorType === 3) {
    if (!trns) return 255;
    const index = bitDepth === 8 ? row[x] : readSubByteValue(row, x, bitDepth);
    return index < trns.length ? trns[index] : 255;
  }
  return 255;
}

function parseHeaderData(data) {
  if (data.length < 13) throw new Error("IHDR_TOO_SHORT");
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colorType = data[9];
  const compression = data[10];
  const filterMethod = data[11];
  const interlace = data[12];
  if (width < 1 || height < 1) throw new Error("IHDR_DIMENSIONS");
  if (width * height > MAX_TOTAL_PIXELS) throw new Error("IMAGE_TOO_LARGE");
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels) throw new Error(`UNSUPPORTED_COLOR_TYPE_${colorType}`);
  if (!BIT_DEPTHS_BY_COLOR_TYPE[colorType].includes(bitDepth)) throw new Error(`UNSUPPORTED_BIT_DEPTH_${bitDepth}`);
  if (compression !== 0 || filterMethod !== 0) throw new Error("UNSUPPORTED_COMPRESSION_FILTER");
  if (interlace !== 0 && interlace !== 1) throw new Error("UNSUPPORTED_INTERLACE");
  return { width, height, bitDepth, colorType, channels, interlace };
}

function parseChunks(buffer) {
  const idatParts = [];
  let headerData = null;
  let trns = null;
  let sawIend = false;
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("TRUNCATED_CHUNK");
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      headerData = parseHeaderData(data);
    } else if (type === "tRNS") {
      trns = Buffer.from(data);
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      sawIend = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!headerData) throw new Error("IHDR_MISSING");
  if (idatParts.length === 0) throw new Error("IDAT_MISSING");
  void sawIend;
  return { headerData, trns, idat: Buffer.concat(idatParts) };
}

// 逐行扫描一段（非隔行整体 / Adam7 单个 pass），返回累计透明像素数与前景像素数；cursor 在各 pass 间连续。
function countPassAlpha(inflated, header, trns, pass, startCursor) {
  const { bitDepth, colorType, channels } = header;
  const passWidth = pass ? Math.ceil((header.width - pass.xStart) / pass.xStep) : header.width;
  const passHeight = pass ? Math.ceil((header.height - pass.yStart) / pass.yStep) : header.height;
  if (passWidth <= 0 || passHeight <= 0) return { cursor: startCursor, transparent: 0, foreground: 0 };
  const bitsPerPixel = channels * bitDepth;
  const bytesPerCompletePixel = Math.max(1, Math.floor((bitsPerPixel + 7) / 8));
  const stride = Math.floor((passWidth * bitsPerPixel + 7) / 8);
  let transparent = 0;
  let foreground = 0;
  let cursor = startCursor;
  let previousRow = new Uint8Array(stride);
  for (let y = 0; y < passHeight; y += 1) {
    if (cursor + 1 + stride > inflated.length) throw new Error("IDAT_SIZE_MISMATCH");
    const filterType = inflated[cursor];
    cursor += 1;
    const row = inflated.subarray(cursor, cursor + stride);
    cursor += stride;
    unfilterRow(filterType, row, previousRow, bytesPerCompletePixel);
    for (let x = 0; x < passWidth; x += 1) {
      const alpha = sampleAlpha(row, x, header, trns);
      if (alpha < 255) transparent += 1;
      if (alpha >= FOREGROUND_ALPHA_THRESHOLD) foreground += 1;
    }
    previousRow = row;
  }
  return { cursor, transparent, foreground };
}

function decodePngAlpha(buffer) {
  try {
    if (!isPngSignature(buffer)) return null;
    const { headerData, trns, idat } = parseChunks(buffer);
    const inflated = zlib.inflateSync(idat);
    const hasAlpha = headerData.colorType === 4 || headerData.colorType === 6 || trns !== null;
    const passList = headerData.interlace === 1 ? ADAM7_PASSES : [null];
    let transparentPixelCount = 0;
    let foregroundPixelCount = 0;
    let cursor = 0;
    passList.forEach((pass) => {
      const result = countPassAlpha(inflated, headerData, trns, pass, cursor);
      cursor = result.cursor;
      transparentPixelCount += result.transparent;
      foregroundPixelCount += result.foreground;
    });
    if (cursor !== inflated.length) throw new Error("IDAT_SIZE_MISMATCH");
    return {
      width: headerData.width,
      height: headerData.height,
      bitDepth: headerData.bitDepth,
      colorType: headerData.colorType,
      hasAlpha,
      transparentPixelCount,
      foregroundPixelCount
    };
  } catch (error) {
    return null;
  }
}

module.exports = {
  isPngSignature,
  decodePngAlpha
};
