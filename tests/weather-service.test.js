const assert = require("assert");

const storage = new Map();
const weatherPayload = {
  cityName: "上海",
  lat: 31.23,
  lng: 121.47,
  temp: 26,
  weatherText: "多云",
  weatherCode: "cloudy",
  outfitSuggestion: "薄上衣即可",
  source: "location",
  forecast: [{ tempMin: 22, tempMax: 29 }]
};

global.getApp = () => ({ globalData: { userScope: "openid_weather_test" } });
global.wx = {
  getStorageSync(key) {
    return storage.has(key) ? storage.get(key) : "";
  },
  setStorageSync(key, value) {
    storage.set(key, value);
  },
  removeStorageSync(key) {
    storage.delete(key);
  },
  getLocation({ success }) {
    success({ latitude: 31.2, longitude: 121.4 });
  },
  cloud: {
    callFunction({ name, data }) {
      assert.strictEqual(name, "getWeather");
      if (data.cityName) assert.strictEqual(data.cityName, "上海");
      else assert.deepStrictEqual(data, { lat: 31.2, lng: 121.4 });
      return Promise.resolve({ result: { ok: true, data: weatherPayload } });
    }
  }
};

const service = require("../miniprogram/services/app-service");

(async () => {
  const manual = await service.getWeather({ cityName: "上海", source: "manual" });
  assert.deepStrictEqual(manual, {
    cityName: "上海",
    latitude: 31.23,
    longitude: 121.47,
    source: "device",
    condition: "多云",
    currentTemp: 26,
    minTemp: 22,
    maxTemp: 29,
    icon: "cloudy",
    outfitAdvice: "薄上衣即可",
    forecast: weatherPayload.forecast
  });

  const located = await service.locateCurrentCity();
  assert.strictEqual(located.cityName, "上海");
  assert.strictEqual(located.source, "device");
  assert.strictEqual(located.weather.currentTemp, 26);
  assert.strictEqual(service.getLocation().cityName, "未选择城市", "天气查询必须是无持久化副作用的纯查询");

  console.log("weather service integration tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
