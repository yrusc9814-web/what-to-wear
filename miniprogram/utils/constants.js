const CATEGORIES = [
  { value: "hat", label: "帽子", icon: "帽" },
  { value: "top", label: "上衣", icon: "衣" },
  { value: "bottom", label: "下装", icon: "裤" },
  { value: "shoes", label: "鞋子", icon: "鞋" },
  { value: "bag", label: "包包", icon: "包" }
];

const SEASONS = [
  { value: "spring", label: "春", icon: "🌸" },
  { value: "summer", label: "夏", icon: "☀️" },
  { value: "autumn", label: "秋", icon: "🍂" },
  { value: "winter", label: "冬", icon: "❄️" }
];

const STYLES = [
  { value: "casual", label: "休闲" },
  { value: "commute", label: "通勤" },
  { value: "sweet", label: "甜美" },
  { value: "cool", label: "潮酷" }
];

const STYLE_FILTER_OPTIONS = [{ value: "all", label: "不限" }, ...STYLES];

const PRIMARY_COLORS = [
  { value: "pink", label: "粉色", swatch: "#ff9bb5" },
  { value: "white", label: "白色", swatch: "#ffffff" },
  { value: "black", label: "黑色", swatch: "#2f2b2c" },
  { value: "beige", label: "米色", swatch: "#ead6b8" },
  { value: "gray", label: "灰色", swatch: "#a8a4a5" },
  { value: "blue", label: "蓝色", swatch: "#7fb3e8" },
  { value: "brown", label: "棕色", swatch: "#9b6b4a" },
  { value: "green", label: "绿色", swatch: "#74aa7d" },
  { value: "red", label: "红色", swatch: "#dc5a62" },
  { value: "yellow", label: "黄色", swatch: "#f4ce63" },
  { value: "purple", label: "紫色", swatch: "#a88bd1" },
  { value: "multicolor", label: "多色", swatch: "multicolor" },
  { value: "other", label: "其他", swatch: "#d8d0cd" }
];

const THICKNESSES = [
  { value: "thin", label: "薄" },
  { value: "medium", label: "适中" },
  { value: "thick", label: "厚" }
];

const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((item) => [item.value, item.label]));
const SEASON_MAP = Object.fromEntries(SEASONS.map((item) => [item.value, item.label]));
const STYLE_MAP = Object.fromEntries(STYLES.map((item) => [item.value, item.label]));
const COLOR_MAP = Object.fromEntries(PRIMARY_COLORS.map((item) => [item.value, item.label]));
const THICKNESS_MAP = Object.fromEntries(THICKNESSES.map((item) => [item.value, item.label]));

function getCurrentSeason(date = new Date()) {
  const month = date.getMonth() + 1;
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeCategory(value, name = "") {
  if (CATEGORY_MAP[value]) return value;
  if (value === "accessory") return /帽|cap|hat/i.test(name) ? "hat" : "bag";
  return "top";
}

function normalizeSeason(value) {
  if (value === "fall") return "autumn";
  return SEASON_MAP[value] ? value : getCurrentSeason();
}

function normalizeStyle(value) {
  if (STYLE_MAP[value]) return value;
  const text = String(value || "");
  if (/通勤|职场/.test(text)) return "commute";
  if (/甜美|可爱/.test(text)) return "sweet";
  if (/潮酷|街头|酷/.test(text)) return "cool";
  return "casual";
}

module.exports = {
  CATEGORIES,
  SEASONS,
  SEASON_OPTIONS: SEASONS,
  STYLES,
  STYLE_FILTER_OPTIONS,
  PRIMARY_COLORS,
  THICKNESSES,
  CATEGORY_MAP,
  SEASON_MAP,
  STYLE_MAP,
  COLOR_MAP,
  THICKNESS_MAP,
  getCurrentSeason,
  formatLocalDate,
  normalizeCategory,
  normalizeSeason,
  normalizeStyle
};
