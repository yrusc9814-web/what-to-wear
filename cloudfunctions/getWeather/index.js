const cloud = require("wx-server-sdk");
const https = require("https");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const TENCENT_MAP_KEY = process.env.TENCENT_MAP_KEY;
const TIMEOUT_MS = 8000;

const WMO_TEXT = {
  0: "晴天",
  1: "晴天",
  2: "多云",
  3: "阴天",
  45: "雾",
  48: "雾",
  51: "小雨",
  53: "小雨",
  55: "小雨",
  61: "下雨",
  63: "下雨",
  65: "大雨",
  71: "下雪",
  73: "下雪",
  75: "大雪",
  80: "阵雨",
  81: "阵雨",
  82: "强阵雨",
  95: "雷雨"
};

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP_${res.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error("JSON_PARSE_FAILED"));
        }
      });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error("REQUEST_TIMEOUT"));
    });
    req.on("error", reject);
  });
}

function ensureMapKey() {
  if (!TENCENT_MAP_KEY) {
    const err = new Error("TENCENT_MAP_KEY_NOT_CONFIGURED");
    err.code = "TENCENT_MAP_KEY_NOT_CONFIGURED";
    throw err;
  }
}

function createProviderError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function getUserErrorMessage(err) {
  const code = err.code || err.message;
  const detail = err.message && err.message !== code ? `（${err.message}）` : "";
  if (code === "TENCENT_MAP_KEY_NOT_CONFIGURED") {
    return "getWeather 云函数未配置 TENCENT_MAP_KEY。";
  }
  if (code === "TENCENT_GEOCODE_FAILED") {
    return `城市解析失败，请确认腾讯地图 Key 已开通 WebService API${detail}。`;
  }
  if (code === "TENCENT_REVERSE_GEOCODE_FAILED") {
    return `定位解析失败，请确认腾讯地图 Key 已开通 WebService API${detail}。`;
  }
  if (code === "REQUEST_TIMEOUT") {
    return "天气服务请求超时，请稍后重试。";
  }
  if (code === "WEATHER_RESPONSE_INVALID") {
    return "天气服务返回异常，请稍后重试。";
  }
  if (String(code).startsWith("HTTP_")) {
    return "天气或地图接口访问失败，请稍后重试。";
  }
  return "天气获取失败，请稍后重试或手动选择城市。";
}

function buildSuggestion(temp, weatherText) {
  if (temp >= 30) return `今日${temp}℃，${weatherText}，建议轻薄透气单品，避免深色厚料。`;
  if (temp >= 25) return `今日${temp}℃，${weatherText}，短袖、裙装或棉麻材质比较合适。`;
  if (temp >= 20) return `今日${temp}℃，${weatherText}，可穿轻薄上衣，早晚备一件薄外套。`;
  if (temp >= 15) return `今日${temp}℃，${weatherText}，建议长袖或薄针织，适合轻叠穿。`;
  if (temp >= 8) return `今日${temp}℃，${weatherText}，建议加外套或厚针织衫。`;
  if (temp >= 0) return `今日${temp}℃，${weatherText}，厚外套和保暖下装更稳妥。`;
  return `今日${temp}℃，${weatherText}，优先羽绒或厚呢大衣，注意防寒。`;
}

async function reverseGeocode(lat, lng) {
  ensureMapKey();
  const url =
    "https://apis.map.qq.com/ws/geocoder/v1/?" +
    `location=${encodeURIComponent(`${lat},${lng}`)}` +
    `&key=${encodeURIComponent(TENCENT_MAP_KEY)}`;
  const data = await requestJson(url);
  if (data.status !== 0 || !data.result) {
    throw createProviderError("TENCENT_REVERSE_GEOCODE_FAILED", data.message);
  }

  const component = data.result.address_component || {};
  return {
    cityName: component.city || component.district || component.province || "当前位置",
    lat,
    lng
  };
}

async function geocodeCity(cityName) {
  ensureMapKey();
  const url =
    "https://apis.map.qq.com/ws/geocoder/v1/?" +
    `address=${encodeURIComponent(cityName)}` +
    `&key=${encodeURIComponent(TENCENT_MAP_KEY)}`;
  const data = await requestJson(url);
  if (data.status !== 0 || !data.result || !data.result.location) {
    throw createProviderError("TENCENT_GEOCODE_FAILED", data.message);
  }

  return {
    cityName,
    lat: data.result.location.lat,
    lng: data.result.location.lng
  };
}

async function fetchOpenMeteo(lat, lng) {
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lng)}` +
    "&current=temperature_2m,weather_code,wind_speed_10m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min" +
    "&forecast_days=6" +
    "&timezone=auto";
  const data = await requestJson(url);
  if (!data.current) throw new Error("WEATHER_RESPONSE_INVALID");

  const temp = Math.round(data.current.temperature_2m);
  const weatherCode = data.current.weather_code;
  const weatherText = WMO_TEXT[weatherCode] || "多云";

  const daily = data.daily || {};
  const forecast = (daily.time || []).slice(0, 6).map((date, index) => {
    const code = daily.weather_code[index];
    const tempMin = Math.round(daily.temperature_2m_min[index]);
    const tempMax = Math.round(daily.temperature_2m_max[index]);
    return {
      date,
      weatherText: WMO_TEXT[code] || "多云",
      weatherCode: code,
      tempMin,
      tempMax,
      outfitSuggestion: buildSuggestion(Math.round((tempMin + tempMax) / 2), WMO_TEXT[code] || "多云")
    };
  });

  return {
    temp,
    weatherText,
    weatherCode,
    windSpeed: data.current.wind_speed_10m,
    forecast
  };
}

exports.main = async (event = {}) => {
  try {
    const hasLocation = Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lng));
    const cityName = typeof event.cityName === "string" ? event.cityName.trim() : "";

    if (!hasLocation && !cityName) {
      return {
        ok: false,
        errorCode: "CITY_REQUIRED",
        errorMessage: "请提供城市名或经纬度。"
      };
    }

    const location = hasLocation
      ? await reverseGeocode(Number(event.lat), Number(event.lng))
      : await geocodeCity(cityName);
    const weather = await fetchOpenMeteo(location.lat, location.lng);

    return {
      ok: true,
      data: {
        cityName: location.cityName,
        lat: location.lat,
        lng: location.lng,
        temp: weather.temp,
        weatherText: weather.weatherText,
        weatherCode: weather.weatherCode,
        windSpeed: weather.windSpeed,
        outfitSuggestion: buildSuggestion(weather.temp, weather.weatherText),
        forecast: weather.forecast,
        source: hasLocation ? "location" : "manual_city"
      }
    };
  } catch (err) {
    console.error("getWeather failed", err);
    return {
      ok: false,
      errorCode: err.code || err.message || "WEATHER_FAILED",
      errorMessage: getUserErrorMessage(err)
    };
  }
};
