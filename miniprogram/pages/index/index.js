const outfitService = require("../../services/outfit-service");
const { ensurePrivacyAuthorized } = require("../../utils/privacy");

const WEATHER_CONTEXT_KEY = "chuanda_recommendation_context";

const formatToday = () => {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

const defaultWeather = {
  loading: false,
  tempText: "--℃",
  weatherText: "等待获取",
  cityText: "未选择城市",
  suggestion: "获取天气后，会根据温度给出今日穿衣建议。",
  forecast: []
};

function getSeasonByDate(dateText) {
  const date = dateText ? new Date(dateText) : new Date();
  const month = Number.isFinite(date.getTime()) ? date.getMonth() + 1 : new Date().getMonth() + 1;
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

function saveRecommendationContext(payload) {
  wx.setStorageSync(WEATHER_CONTEXT_KEY, {
    temperature: payload.temperature,
    season: payload.season || getSeasonByDate(payload.date),
    preferredTags: ["日常", "简约", "通勤"]
  });
}

Page({
  data: {
    todayLabel: formatToday(),
    weather: defaultWeather,
    selectedForecastIndex: 0,
    records: [],
    loadingRecords: false
  },

  onShow() {
    this.loadRecords();
  },

  async loadRecords() {
    this.setData({ loadingRecords: true });
    try {
      const records = await outfitService.getOutfits();
      this.setData({ records, loadingRecords: false });
    } catch (err) {
      console.warn("load outfit records failed", err);
      this.setData({ loadingRecords: false });
      wx.showToast({ title: "记录加载失败", icon: "none" });
    }
  },

  async refreshByLocation() {
    try {
      await ensurePrivacyAuthorized();
    } catch (err) {
      wx.showToast({ title: "同意隐私政策后可使用自动定位", icon: "none" });
      return;
    }

    this.setData({
      "weather.loading": true,
      "weather.weatherText": "定位中",
      "weather.cityText": "正在获取当前位置"
    });

    wx.getLocation({
      type: "gcj02",
      success: ({ latitude, longitude }) => {
        this.fetchWeather({ lat: latitude, lng: longitude });
      },
      fail: () => {
        this.setData({
          weather: {
            ...defaultWeather,
            weatherText: "定位失败",
            cityText: "可手动选择城市"
          }
        });
        wx.showToast({ title: "请手动选择城市", icon: "none" });
      }
    });
  },

  chooseManualCity() {
    wx.showModal({
      title: "手动城市",
      editable: true,
      placeholderText: "例如：上海",
      success: (res) => {
        const cityName = (res.content || "").trim();
        if (!res.confirm || !cityName) return;
        this.fetchWeather({ cityName });
      }
    });
  },

  fetchWeather(payload) {
    this.setData({ "weather.loading": true });

    wx.cloud.callFunction({
      name: "getWeather",
      data: payload,
      success: ({ result }) => {
        if (!result || !result.ok) {
          const message = result && result.errorCode
            ? `${result.errorCode}: ${result.errorMessage}`
            : result && result.errorMessage;
          this.handleWeatherFail(message);
          return;
        }

        this.setData({
          weather: {
            loading: false,
            tempText: `${result.data.temp}℃`,
            weatherText: result.data.weatherText,
            cityText: result.data.cityName,
            suggestion: result.data.outfitSuggestion,
            forecast: (result.data.forecast || []).map((item, index) => ({
              ...item,
              label: index === 0 ? "今天" : item.date.slice(5)
            }))
          },
          selectedForecastIndex: 0
        });
        saveRecommendationContext({
          temperature: result.data.temp,
          season: getSeasonByDate(),
          date: result.data.date
        });
      },
      fail: (err) => {
        this.handleWeatherFail(err && err.errMsg);
      }
    });
  },

  handleWeatherFail(message) {
    this.setData({
      weather: {
        ...defaultWeather,
        weatherText: "获取失败",
        cityText: "请稍后重试或手动选择",
        suggestion: message || "天气服务暂时不可用。"
      }
    });
    wx.showToast({ title: "天气获取失败", icon: "none" });
  },

  goWardrobe() {
    wx.switchTab({ url: "/pages/wardrobe/wardrobe" });
  },

  goRecommendation() {
    if (this.data.selectedForecastIndex !== 0) {
      this.switchToTodayForecast();
      return;
    }
    wx.switchTab({ url: "/pages/recommendation/recommendation" });
  },

  switchToTodayForecast() {
    const todayForecast = this.data.weather.forecast[0];
    if (!todayForecast) {
      this.setData({ selectedForecastIndex: 0 });
      return;
    }

    this.setData({
      selectedForecastIndex: 0,
      "weather.tempText": `${todayForecast.tempMin}-${todayForecast.tempMax}℃`,
      "weather.weatherText": todayForecast.weatherText,
      "weather.suggestion": todayForecast.outfitSuggestion
    });
    saveRecommendationContext({
      temperature: (Number(todayForecast.tempMin) + Number(todayForecast.tempMax)) / 2,
      season: getSeasonByDate(todayForecast.date),
      date: todayForecast.date
    });
  },

  selectForecast(event) {
    const index = Number(event.currentTarget.dataset.index);
    const forecast = this.data.weather.forecast[index];
    if (!forecast) return;

    this.setData({
      selectedForecastIndex: index,
      "weather.tempText": `${forecast.tempMin}-${forecast.tempMax}℃`,
      "weather.weatherText": forecast.weatherText,
      "weather.suggestion": forecast.outfitSuggestion
    });
    saveRecommendationContext({
      temperature: (Number(forecast.tempMin) + Number(forecast.tempMax)) / 2,
      season: getSeasonByDate(forecast.date),
      date: forecast.date
    });
  },

  deleteRecord(event) {
    const id = event.currentTarget.dataset.id;
    const record = this.data.records.find((item) => item.id === id);
    if (!record) return;

    wx.showModal({
      title: "删除记录",
      content: "删除后暂时不能恢复，确认删除吗？",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const records = await outfitService.deleteOutfit(record);
          this.setData({ records });
          wx.showToast({ title: "已删除记录", icon: "success" });
        } catch (err) {
          console.warn("delete outfit record failed", err);
          wx.showToast({ title: "删除失败，请重试", icon: "none" });
        }
      }
    });
  },

  clearMyData() {
    wx.showModal({
      title: "清除全部数据",
      content: "这会清除衣橱和穿搭记录，确认继续吗？",
      confirmColor: "#b45f6b",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          if (wx.cloud && wx.cloud.callFunction) {
            await wx.cloud.callFunction({ name: "clearUserData", data: {} });
          }
        } catch (err) {
          console.warn("clearUserData cloud failed", err);
        }
        wx.removeStorageSync("chuanda_wardrobe_items");
        wx.removeStorageSync("chuanda_outfit_records");
        this.setData({ records: [] });
        wx.showToast({ title: "已清除数据", icon: "success" });
      }
    });
  }
});
