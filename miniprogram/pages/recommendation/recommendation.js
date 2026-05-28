const wardrobeService = require("../../services/wardrobe-service");
const outfitService = require("../../services/outfit-service");
const { buildContext, generateRecommendations } = require("../../services/recommendation-engine");

const WEATHER_CONTEXT_KEY = "chuanda_recommendation_context";

function pickByType(items, type) {
  return items.filter((item) => item.type === type);
}

function todayStr() {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${date}`;
}

Page({
  data: {
    items: [],
    counts: {
      top: 0,
      bottom: 0,
      shoes: 0
    },
    loading: false,
    results: [],
    recommendationContext: buildContext(),
    generationSeed: 0
  },

  async onShow() {
    this.setData({ loading: true });
    try {
      const items = await wardrobeService.getWardrobe();
      this.setData({
        loading: false,
        items,
        counts: {
          top: pickByType(items, "top").length,
          bottom: pickByType(items, "bottom").length,
          shoes: pickByType(items, "shoes").length
        }
      });
      this.generate();
    } catch (err) {
      console.warn("load recommendation wardrobe failed", err);
      this.setData({ loading: false });
      wx.showToast({ title: "衣橱加载失败", icon: "none" });
    }
  },

  generate() {
    const items = this.data.items;
    if (!items.length) {
      this.setData({ results: [] });
      return;
    }

    const storedContext = wx.getStorageSync(WEATHER_CONTEXT_KEY) || {};
    const recommendationContext = buildContext(storedContext);
    const generationSeed = this.data.generationSeed + 1;
    const results = generateRecommendations(items, recommendationContext, { seedOffset: generationSeed });

    this.setData({ results, recommendationContext, generationSeed });
  },

  goWardrobe() {
    wx.switchTab({ url: "/pages/wardrobe/wardrobe" });
  },

  async saveRecommendation(event) {
    const index = Number(event.currentTarget.dataset.index);
    const result = this.data.results[index];
    if (!result) return;

    try {
      await outfitService.saveOutfit({
        date: todayStr(),
        top: result.top,
        bottom: result.bottom,
        shoes: result.shoes,
        accessory: result.accessory,
        note: result.tag
      });

      wx.showToast({ title: "已记录今日穿搭", icon: "success" });
    } catch (err) {
      console.warn("save recommendation failed", err);
      wx.showToast({ title: "记录失败，请重试", icon: "none" });
    }
  }
});
