const assert = require("assert");
const Module = require("module");

const deferred = {};
const saved = [];
const locations = [
  { cityName: "上海", source: "manual" },
  { cityName: "北京", source: "manual" }
];
const appService = {
  getLocation() { return Promise.resolve(locations.shift()); },
  getWeather(location) {
    return new Promise((resolve) => { deferred[location.cityName] = resolve; });
  },
  saveLocation(location) { saved.push(location); return location; }
};

let definition;
global.Page = (value) => { definition = value; };
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "../../services/app-service") return appService;
  return originalLoad.call(this, request, parent, isMain);
};
require("../miniprogram/pages/home/index");
Module._load = originalLoad;
delete global.Page;

function pageInstance() {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); }
  };
}

(async () => {
  const page = pageInstance();
  const shanghaiRequest = page.loadLocationAndWeather();
  await Promise.resolve();
  await Promise.resolve();
  const beijingRequest = page.loadLocationAndWeather();
  await Promise.resolve();
  await Promise.resolve();

  deferred["北京"]({ cityName: "北京", currentTemp: 30, condition: "晴", forecast: [] });
  await beijingRequest;
  assert.strictEqual(page.data.location.cityName, "北京");
  assert.strictEqual(page.data.weather.currentTemp, 30);

  deferred["上海"]({ cityName: "上海", currentTemp: 20, condition: "雨", forecast: [] });
  await shanghaiRequest;
  assert.strictEqual(page.data.location.cityName, "北京", "迟到的旧请求不得覆盖新城市");
  assert.strictEqual(page.data.weather.currentTemp, 30);
  assert.deepStrictEqual(saved.map((item) => item.cityName), ["北京"]);
  console.log("weather request race tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
