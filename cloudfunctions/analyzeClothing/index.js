const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const AI_KEY = process.env.DASHSCOPE_API_KEY || process.env.QWEN_VL_API_KEY;

function normalizeString(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function inferTypeByName(name) {
  const text = normalizeString(name, 60);
  if (/鞋|靴|sneaker|shoe/i.test(text)) return "shoes";
  if (/裤|裙|short|jean|skirt/i.test(text)) return "bottom";
  if (/帽|包|围巾|配饰|accessory/i.test(text)) return "accessory";
  return "top";
}

exports.main = async (event = {}) => {
  const imageFileId = normalizeString(event.imageFileId, 256);
  const originalName = normalizeString(event.originalName, 60);

  if (!imageFileId) {
    return { ok: false, errorCode: "IMAGE_REQUIRED", errorMessage: "请先上传衣物图片。" };
  }

  if (!AI_KEY) {
    return {
      ok: true,
      data: {
        type: inferTypeByName(originalName),
        name: originalName || "未命名衣物",
        color: "",
        style: "",
        tags: [],
        confidence: 0,
        source: "fallback"
      }
    };
  }

  // API provider wiring is intentionally isolated here. Production can replace
  // this fallback with the selected VL provider without touching page logic.
  return {
    ok: true,
    data: {
      type: inferTypeByName(originalName),
      name: originalName || "待分析衣物",
      color: "",
      style: "",
      tags: [],
      confidence: 0,
      source: "configured_placeholder"
    }
  };
};
