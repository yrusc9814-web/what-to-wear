const assert = require("assert");
const Module = require("module");

const deferred = {};
const saved = [];
const appService = {
  getLocation() { return Promise.resolve({ cityName: "深圳", source: "manual" }); },
  searchCities() { return Promise.resolve([]); },
  locateCurrentCity() { return new Promise((resolve) => { deferred.relocate = resolve; }); },
  getWeather(location) {
    return new Promise((resolve) => { deferred[`weather:${location.cityName}`] = resolve; });
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
require("../miniprogram/pages/city-select/index");
Module._load = originalLoad;
delete global.Page;

global.wx = {
  showLoading() {},
  hideLoading() {},
  showToast() {},
  showModal() {},
  navigateBack() {}
};

function instance() {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); }
  };
}

(async () => {
  const page = instance();
  page.data.results = [{ cityName: "北京", source: "manual" }];
  const relocate = page.onRelocate();
  await Promise.resolve();
  page.onCitySelect({ currentTarget: { dataset: { index: 0 } } });
  await Promise.resolve();
  deferred["weather:北京"]({ cityName: "北京", latitude: 39.9, longitude: 116.4, source: "manual" });
  await Promise.resolve();
  deferred.relocate({ cityName: "上海", latitude: 31.2, longitude: 121.4, source: "device" });
  await Promise.all([relocate, new Promise((resolve) => setTimeout(resolve, 0))]);
  assert.deepStrictEqual(saved.map((location) => location.cityName), ["北京"], "迟到定位不得覆盖手动城市");

  const unloadPage = instance();
  unloadPage.data.results = [{ cityName: "广州", source: "manual" }];
  const pending = unloadPage.selectLocation(unloadPage.data.results[0]);
  unloadPage.onUnload();
  deferred["weather:广州"]({ cityName: "广州", latitude: 23.1, longitude: 113.3, source: "manual" });
  await pending;
  assert.deepStrictEqual(saved.map((location) => location.cityName), ["北京"], "页面卸载后请求不得持久化城市");
  console.log("second-round city race and unload tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
