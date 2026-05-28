const { DEFAULT_TEMP_RANGES, COLOR_GROUPS } = require("../constants/recommendation");

const REQUIRED_TYPES = ["top", "bottom", "shoes"];

function getCurrentSeason(date = new Date()) {
  const month = date.getMonth() + 1;
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

function getDefaultTemperature(season) {
  const range = DEFAULT_TEMP_RANGES[season] || DEFAULT_TEMP_RANGES.all;
  return Math.round((range.min + range.max) / 2);
}

function parseTempRange(value, season) {
  if (value && typeof value === "object") {
    const min = Number(value.min);
    const max = Number(value.max);
    if (Number.isFinite(min) && Number.isFinite(max)) return { min, max };
  }

  if (typeof value === "string") {
    const matched = value.match(/(-?\d+)\D+(-?\d+)/);
    if (matched) return { min: Number(matched[1]), max: Number(matched[2]) };
  }

  return DEFAULT_TEMP_RANGES[season] || DEFAULT_TEMP_RANGES.all;
}

function normalizeTags(tags, style) {
  const fromTags = Array.isArray(tags) ? tags : String(tags || "").split(/[,\s，、/]+/);
  const fromStyle = String(style || "").split(/[,\s，、/]+/);
  return [...fromTags, ...fromStyle]
    .map((tag) => String(tag || "").trim())
    .filter(Boolean);
}

function normalizeItem(item) {
  const season = item.season || "all";
  const mainColor = item.mainColor || item.color || "";
  return {
    ...item,
    season,
    tempRange: parseTempRange(item.tempRange, season),
    mainColor,
    tags: normalizeTags(item.tags, item.style)
  };
}

function colorGroup(color) {
  const text = String(color || "");
  const matched = Object.keys(COLOR_GROUPS).find((group) => (
    COLOR_GROUPS[group].some((keyword) => text.includes(keyword))
  ));
  return matched || "unknown";
}

function scoreItem(item, context) {
  let score = 0;
  const reasons = [];
  const range = item.tempRange;

  if (context.temperature >= range.min && context.temperature <= range.max) {
    score += 30;
    reasons.push("温度适配");
  } else {
    const distance = Math.min(
      Math.abs(context.temperature - range.min),
      Math.abs(context.temperature - range.max)
    );
    score -= Math.min(24, distance * 2);
  }

  if (item.season === "all" || item.season === context.season) {
    score += 20;
    reasons.push(item.season === "all" ? "四季可穿" : "季节适配");
  }

  const styleMatches = item.tags.filter((tag) => context.preferredTags.includes(tag));
  if (styleMatches.length) {
    score += styleMatches.length * 10;
    reasons.push(`风格匹配：${styleMatches.join("、")}`);
  }

  return {
    item,
    score,
    reasons
  };
}

function scoreColors(parts) {
  const groups = parts.map((part) => colorGroup(part.mainColor)).filter((group) => group !== "unknown");
  if (!groups.length) return { score: 0, reason: "" };

  const uniqueGroups = Array.from(new Set(groups));
  if (uniqueGroups.length === 1) {
    return { score: 18, reason: "主色同属一个色系" };
  }

  if (groups.includes("neutral")) {
    return { score: 14, reason: "中性色提升搭配稳定度" };
  }

  if (uniqueGroups.length <= 2) {
    return { score: 8, reason: "主色数量控制在两类以内" };
  }

  return { score: -8, reason: "主色较多，协调度降低" };
}

function combineCandidates(grouped, seedOffset) {
  const maxLength = Math.max(
    grouped.top.length,
    grouped.bottom.length,
    grouped.shoes.length,
    grouped.accessory.length,
    1
  );

  return Array.from({ length: Math.min(maxLength, 12) }).map((_, idx) => ({
    top: grouped.top[(idx + seedOffset) % Math.max(grouped.top.length, 1)] || null,
    bottom: grouped.bottom[(idx + seedOffset * 2) % Math.max(grouped.bottom.length, 1)] || null,
    shoes: grouped.shoes[(idx + seedOffset * 3) % Math.max(grouped.shoes.length, 1)] || null,
    accessory: grouped.accessory[(idx + seedOffset) % Math.max(grouped.accessory.length, 1)] || null
  }));
}

function createReason(combo, colorResult, context) {
  const missing = REQUIRED_TYPES
    .filter((type) => !combo[type])
    .map((type) => ({ top: "上衣", bottom: "下装", shoes: "鞋子" }[type]));
  const parts = [combo.top, combo.bottom, combo.shoes, combo.accessory].filter(Boolean);
  const styleTags = Array.from(new Set(parts.flatMap((part) => part.tags || [])))
    .filter((tag) => context.preferredTags.includes(tag));
  const reasonParts = [];

  if (missing.length) {
    reasonParts.push(`衣橱数据较少，缺少${missing.join("、")}，已优先保证现有品类适配`);
  } else {
    reasonParts.push("上衣、下装和鞋子品类完整");
  }

  reasonParts.push(`${context.temperature}℃下优先选择温度和季节适配的单品`);

  if (styleTags.length) {
    reasonParts.push(`风格标签匹配${styleTags.join("、")}`);
  }

  if (colorResult.reason) {
    reasonParts.push(colorResult.reason);
  }

  return `${reasonParts.join("，")}。`;
}

function buildContext(context = {}) {
  const season = context.season || getCurrentSeason();
  const temperature = Number.isFinite(Number(context.temperature))
    ? Number(context.temperature)
    : getDefaultTemperature(season);
  return {
    season,
    temperature,
    preferredTags: normalizeTags(context.preferredTags || ["日常", "简约", "通勤"])
  };
}

function generateRecommendations(items, context = {}, options = {}) {
  const normalizedContext = buildContext(context);
  const seedOffset = Number(options.seedOffset) || 0;
  const scored = (items || []).map(normalizeItem).map((item) => scoreItem(item, normalizedContext));
  const grouped = {
    top: scored.filter((entry) => entry.item.type === "top").sort((a, b) => b.score - a.score).map((entry) => entry.item),
    bottom: scored.filter((entry) => entry.item.type === "bottom").sort((a, b) => b.score - a.score).map((entry) => entry.item),
    shoes: scored.filter((entry) => entry.item.type === "shoes").sort((a, b) => b.score - a.score).map((entry) => entry.item),
    accessory: scored.filter((entry) => entry.item.type === "accessory").sort((a, b) => b.score - a.score).map((entry) => entry.item)
  };

  return combineCandidates(grouped, seedOffset)
    .map((combo, idx) => {
      const parts = [combo.top, combo.bottom, combo.shoes, combo.accessory].filter(Boolean);
      const colorResult = scoreColors(parts);
      const itemScore = parts.reduce((sum, part) => {
        const matched = scored.find((entry) => entry.item.id === part.id);
        return sum + (matched ? matched.score : 0);
      }, 0);
      const completenessScore = REQUIRED_TYPES.every((type) => combo[type]) ? 30 : 0;
      const score = itemScore + colorResult.score + completenessScore;

      return {
        id: `rec_${Date.now()}_${seedOffset}_${idx}`,
        top: combo.top,
        bottom: combo.bottom,
        shoes: combo.shoes,
        accessory: combo.accessory,
        tag: parts.flatMap((part) => part.tags || []).find((tag) => normalizedContext.preferredTags.includes(tag)) || "规则推荐",
        reason: createReason(combo, colorResult, normalizedContext),
        score
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

module.exports = {
  buildContext,
  generateRecommendations,
  normalizeItem,
  scoreColors
};
