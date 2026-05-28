const SEASONS = [
  { value: "spring", label: "春" },
  { value: "summer", label: "夏" },
  { value: "autumn", label: "秋" },
  { value: "winter", label: "冬" },
  { value: "all", label: "四季" }
];

const DEFAULT_TEMP_RANGES = {
  spring: { min: 10, max: 24 },
  summer: { min: 24, max: 38 },
  autumn: { min: 12, max: 26 },
  winter: { min: -10, max: 12 },
  all: { min: -10, max: 38 }
};

const COLOR_GROUPS = {
  neutral: ["黑", "白", "灰", "米", "杏", "棕", "咖", "卡其", "牛仔"],
  warm: ["红", "粉", "橙", "黄", "驼"],
  cool: ["蓝", "绿", "紫", "青"],
  dark: ["黑", "藏青", "深蓝", "深灰"],
  light: ["白", "米", "杏", "浅", "粉"]
};

const STYLE_TAGS = ["通勤", "休闲", "甜美", "运动", "简约", "复古", "优雅", "清爽", "日常"];

module.exports = {
  SEASONS,
  DEFAULT_TEMP_RANGES,
  COLOR_GROUPS,
  STYLE_TAGS
};
