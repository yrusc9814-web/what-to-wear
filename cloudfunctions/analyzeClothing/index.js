const cloud = require("wx-server-sdk");
const https = require("https");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MODEL_TIMEOUT_MS = 12000;
const API_URL = process.env.QWEN_API_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const API_KEY = process.env.DASHSCOPE_API_KEY || process.env.QWEN_VL_API_KEY;
const MODEL = process.env.QWEN_VL_MODEL || "qwen-vl-plus";

const CATEGORIES = new Set(["hat", "top", "bottom", "shoes", "bag"]);
const COLORS = new Set(["pink", "white", "black", "beige", "gray", "blue", "brown", "green", "red", "yellow", "purple", "multicolor", "other"]);
const SEASONS = new Set(["spring", "summer", "autumn", "winter"]);
const STYLES = new Set(["casual", "commute", "sweet", "cool"]);
const THICKNESSES = new Set(["thin", "medium", "thick"]);
const ALLOWED_KEYS = ["name", "category", "primaryColor", "seasons", "styles", "thickness", "aiDescription"];

function manual(reason) {
  return { ok: true, data: { status: "manual_required", reason, source: "manual", data: null } };
}

function detectMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

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

function postJson(urlString, body, timeoutMs) {
  const url = new URL(urlString);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 2 * 1024 * 1024) request.destroy(new Error("RESPONSE_TOO_LARGE"));
      });
      response.on("end", () => resolve({ statusCode: response.statusCode, raw }));
    });
    request.on("timeout", () => {
      const error = new Error("MODEL_TIMEOUT");
      error.code = "MODEL_TIMEOUT";
      request.destroy(error);
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function uniqueEnumArray(value, allowed, maxLength) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxLength) return null;
  if (!value.every((entry) => typeof entry === "string" && allowed.has(entry))) return null;
  return [...new Set(value)];
}

function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const keys = Object.keys(candidate);
  if (keys.length !== ALLOWED_KEYS.length || !keys.every((key) => ALLOWED_KEYS.includes(key))) return null;
  const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 20) : "";
  const aiDescription = typeof candidate.aiDescription === "string" ? candidate.aiDescription.trim().slice(0, 300) : "";
  const seasons = uniqueEnumArray(candidate.seasons, SEASONS, 4);
  const styles = uniqueEnumArray(candidate.styles, STYLES, 4);
  if (!name || !aiDescription || !CATEGORIES.has(candidate.category) || !COLORS.has(candidate.primaryColor) || !THICKNESSES.has(candidate.thickness) || !seasons || !styles) return null;
  return {
    name,
    category: candidate.category,
    primaryColor: candidate.primaryColor,
    seasons,
    styles,
    thickness: candidate.thickness,
    aiDescription
  };
}

function buildRequest(imageDataUrl) {
  const prompt = [
    "你是小衣橱的服装图片识别器，只能根据图片中可见信息返回 JSON。",
    `字段必须且只能包含：${ALLOWED_KEYS.join(", ")}。`,
    "category 只能是 hat/top/bottom/shoes/bag。",
    `primaryColor 只能是 ${[...COLORS].join("/")}。`,
    `seasons 只能从 ${[...SEASONS].join("/")} 中选择至少一项。`,
    `styles 只能从 ${[...STYLES].join("/")} 中选择至少一项。`,
    "thickness 只能是 thin/medium/thick。",
    "严禁输出或推测购买价格、购买日期、购买渠道、尺码、品牌、真实材质成分。",
    "不输出 Markdown，不输出解释，不增加任何字段。"
  ].join("\n");
  return {
    model: MODEL,
    messages: [
      { role: "system", content: "你只返回严格 JSON，不编造不可见事实。" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl } },
          { type: "text", text: prompt }
        ]
      }
    ],
    response_format: { type: "json_object" },
    temperature: 0.1
  };
}

function isAllowedFileId(fileId, openid) {
  return typeof fileId === "string" && /^cloud:\/\//.test(fileId) && fileId.includes(`/wardrobe/${openid}/`) && fileId.length <= 512;
}

exports.main = async (event = {}) => {
  if (!API_KEY) return manual("CONFIG_MISSING");
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return manual("AUTH_REQUIRED");
  const imageFileId = String(event.imageFileId || event.fileId || "").trim();
  if (!isAllowedFileId(imageFileId, openid)) return manual("IMAGE_FORBIDDEN");

  let fileContent;
  try {
    const downloaded = await withTimeout(cloud.downloadFile({ fileID: imageFileId }), 5000);
    fileContent = downloaded && downloaded.fileContent;
  } catch (error) {
    console.warn("analyzeClothing image unavailable", error && error.code);
    return manual("IMAGE_UNAVAILABLE");
  }

  if (!Buffer.isBuffer(fileContent) || fileContent.length === 0 || fileContent.length > MAX_IMAGE_BYTES) return manual("IMAGE_INVALID");
  const mime = detectMime(fileContent);
  if (!mime) return manual("IMAGE_INVALID");
  const imageDataUrl = `data:${mime};base64,${fileContent.toString("base64")}`;

  let response;
  try {
    response = await postJson(API_URL, buildRequest(imageDataUrl), MODEL_TIMEOUT_MS);
  } catch (error) {
    console.warn("analyzeClothing model request failed", error && error.code);
    return manual(error && (error.code === "MODEL_TIMEOUT" || error.code === "TIMEOUT") ? "MODEL_TIMEOUT" : "MODEL_ERROR");
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    console.warn("analyzeClothing model http failed", response.statusCode);
    return manual("MODEL_ERROR");
  }

  let envelope;
  let candidate;
  try {
    envelope = JSON.parse(response.raw);
    const content = envelope && envelope.choices && envelope.choices[0] && envelope.choices[0].message && envelope.choices[0].message.content;
    if (typeof content !== "string") return manual("MODEL_INVALID_JSON");
    candidate = JSON.parse(content);
  } catch (error) {
    return manual("MODEL_INVALID_JSON");
  }

  const data = validateCandidate(candidate);
  if (!data) return manual("SCHEMA_INVALID");
  return { ok: true, data: { status: "success", source: "ai", data } };
};

exports._test = { detectMime, validateCandidate, isAllowedFileId };
