const cloud = require("wx-server-sdk");
const https = require("https");
const zlib = require("zlib");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const API_KEY = String(process.env.QWEATHER_API_KEY || "").trim() || null;
const API_HOST = process.env.QWEATHER_API_HOST || "devapi.qweather.com";
const GEO_HOST = process.env.QWEATHER_GEO_HOST || "geoapi.qweather.com";
const TIMEOUT_MS = 8000;

const ALLOWED_HOSTS = new Set([API_HOST, GEO_HOST]);
const PRIVATE_HOST_PATTERN = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?|.*\.local$|.*\.internal$)/i;

// 和风天气图标码 → WMO 风格码（保持既有 weatherCode 数值语义，前端按数值兜底渲染表情）
const QWEATHER_TO_WMO = {
  100: 0, 150: 0,
  101: 2, 102: 2, 103: 3, 104: 3,
  300: 51, 301: 53, 302: 95, 303: 95, 304: 95,
  305: 61, 306: 61, 307: 63, 308: 65, 309: 51,
  310: 63, 311: 65, 312: 65, 313: 65,
  400: 71, 401: 73, 402: 75, 403: 75, 404: 61, 405: 63, 406: 65,
  407: 75, 408: 73, 409: 75, 410: 75,
  500: 45, 501: 45, 502: 48, 503: 45, 504: 48,
  507: 95, 508: 95, 509: 45, 510: 48, 511: 48, 512: 45, 513: 48, 514: 45, 515: 48
};

function toWmoCode(iconCode) {
  const mapped = QWEATHER_TO_WMO[Number(iconCode)];
  return Number.isInteger(mapped) ? mapped : 2;
}

function assertAllowedHost(host) {
  if (typeof host !== "string" || !ALLOWED_HOSTS.has(host) || PRIVATE_HOST_PATTERN.test(host)) {
    const err = new Error("HOST_FORBIDDEN");
    err.code = "HOST_FORBIDDEN";
    throw err;
  }
}

// 只允许访问白名单主机（和风天气 API / GeoAPI），固定 https + 443，不跟随重定向
function requestJson(host, path) {
  assertAllowedHost(host);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port: 443,
        path,
        method: "GET",
        headers: { "X-QW-Api-Key": API_KEY }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          let buffer = Buffer.concat(chunks);
          if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
            try {
              buffer = zlib.gunzipSync(buffer);
            } catch (err) {
              reject(new Error("JSON_PARSE_FAILED"));
              return;
            }
          }
          let body = "";
          try {
            body = buffer.toString("utf8");
          } catch (err) {
            body = "";
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`HTTP_${res.statusCode}`);
            err.code = `HTTP_${res.statusCode}`;
            if (body) err.detail = body.slice(0, 160);
            reject(err);
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error("JSON_PARSE_FAILED"));
          }
        });
      }
    );

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error("REQUEST_TIMEOUT"));
    });
    req.on("error", reject);
    req.end();
  });
}

function ensureApiKey() {
  if (!API_KEY) {
    const err = new Error("QWEATHER_API_KEY_NOT_CONFIGURED");
    err.code = "QWEATHER_API_KEY_NOT_CONFIGURED";
    throw err;
  }
}

function createProviderError(code, detail) {
  const err = new Error(code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

function getUserErrorMessage(err) {
  const code = err.code || err.message;
  const detail = err.detail ? `（${err.detail}）` : "";
  if (code === "QWEATHER_API_KEY_NOT_CONFIGURED") {
    return "getWeather 云函数未配置 QWEATHER_API_KEY。";
  }
  if (code === "QWEATHER_GEO_LOOKUP_FAILED") {
    return `城市解析失败，请确认和风天气 Key 有效且已开通城市查找（GeoAPI）服务${detail}。`;
  }
  if (code === "QWEATHER_WEATHER_FAILED") {
    return `天气服务返回异常，请稍后重试${detail}。`;
  }
  if (code === "REQUEST_TIMEOUT") {
    return "天气服务请求超时，请稍后重试。";
  }
  if (code === "WEATHER_RESPONSE_INVALID") {
    return "天气服务返回异常，请稍后重试。";
  }
  if (String(code).startsWith("HTTP_")) {
    return `天气接口访问失败，请稍后重试${detail}。`;
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

function isHttpNotFound(err) {
  return String(err && (err.code || err.message)).startsWith("HTTP_404");
}

// 城市名 / 经纬度（lon,lat）→ 和风城市信息（经纬度查找时返回最近城市）
// 公共 GeoAPI 域名对新账号可能 404，此时回退到专属 API Host 的 /geo/v2/city/lookup
async function lookupLocation(query) {
  ensureApiKey();
  const publicPath =
    "/v2/city/lookup?" +
    `location=${encodeURIComponent(query)}` +
    "&number=1&lang=zh";
  let data;
  try {
    data = await requestJson(GEO_HOST, publicPath);
  } catch (err) {
    if (!isHttpNotFound(err) || API_HOST === GEO_HOST) throw err;
    const dedicatedPath =
      "/geo/v2/city/lookup?" +
      `location=${encodeURIComponent(query)}` +
      "&number=1&lang=zh";
    data = await requestJson(API_HOST, dedicatedPath);
  }
  if (data.code !== "200" || !Array.isArray(data.location) || !data.location.length) {
    throw createProviderError("QWEATHER_GEO_LOOKUP_FAILED", `code=${data.code}`);
  }
  const city = data.location[0];
  return {
    cityName: city.adm2 || city.adm1 || city.name,
    displayName: city.name,
    locationId: city.id,
    lat: Number(city.lat),
    lng: Number(city.lon)
  };
}

async function fetchCurrentWeather(locationId) {
  ensureApiKey();
  const data = await requestJson(
    API_HOST,
    `/v7/weather/now?location=${encodeURIComponent(locationId)}`
  );
  if (data.code !== "200" || !data.now) {
    throw createProviderError("QWEATHER_WEATHER_FAILED", `code=${data.code}`);
  }
  return data.now;
}

async function fetchDailyForecast(locationId) {
  ensureApiKey();
  const data = await requestJson(
    API_HOST,
    `/v7/weather/7d?location=${encodeURIComponent(locationId)}`
  );
  if (data.code !== "200" || !Array.isArray(data.daily) || !data.daily.length) {
    throw createProviderError("QWEATHER_WEATHER_FAILED", `code=${data.code}`);
  }
  return data.daily;
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

    // 和风 GeoAPI 经纬度查找顺序为 lon,lat
    const location = hasLocation
      ? await lookupLocation(`${Number(event.lng)},${Number(event.lat)}`)
      : await lookupLocation(cityName);
    const [now, daily] = await Promise.all([
      fetchCurrentWeather(location.locationId),
      fetchDailyForecast(location.locationId)
    ]);

    const temp = Math.round(Number(now.temp));
    if (!Number.isFinite(temp)) throw new Error("WEATHER_RESPONSE_INVALID");

    const forecast = daily.slice(0, 6).map((day) => {
      const tempMin = Math.round(Number(day.tempMin));
      const tempMax = Math.round(Number(day.tempMax));
      const weatherText = day.textDay || "多云";
      return {
        date: day.fxDate,
        weatherText,
        weatherCode: toWmoCode(day.iconDay),
        tempMin,
        tempMax,
        outfitSuggestion: buildSuggestion(Math.round((tempMin + tempMax) / 2), weatherText)
      };
    });

    return {
      ok: true,
      data: {
        cityName: location.cityName,
        displayName: location.displayName,
        lat: location.lat,
        lng: location.lng,
        temp,
        weatherText: now.text || "多云",
        weatherCode: toWmoCode(now.icon),
        windSpeed: Number(now.windSpeed),
        outfitSuggestion: buildSuggestion(temp, now.text || "多云"),
        forecast,
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
