# 开发配置

## 和风天气 Key

`getWeather` 云函数通过和风天气（QWeather）做三件事：

- 自动定位：`lat/lng` 就近城市查找（GeoAPI，经纬度顺序 lon,lat）。
- 手动城市：城市名查找（GeoAPI City Lookup）。
- 天气数据：v7 实时天气 + 7 日预报（now / 7d）。

不要把真实 Key 写进前端或提交到仓库。请在微信云开发控制台为 `getWeather` 云函数配置环境变量：

```text
QWEATHER_API_KEY=你的和风天气 API Key
```

可选覆盖（不配置时使用默认值）：

```text
QWEATHER_API_HOST=devapi.qweather.com
QWEATHER_GEO_HOST=geoapi.qweather.com
```

如果和风控制台为你的账号分配了专属 API Host，请把 `QWEATHER_API_HOST` 覆盖为该专属域名。

## 本地调试

在微信开发者工具中打开当前项目根目录。当前前端已绑定云环境：

```text
cloud1-d1gjweewr2740aa1f
```

上传并部署 `cloudfunctions/getWeather`，然后在云函数环境变量里填入 `QWEATHER_API_KEY`。

## 云函数清单

当前需要上传部署：

- `getWeather`：天气、和风天气城市查找（GeoAPI）。
- `saveClothing`：保存衣物。
- `getWardrobe`：读取衣橱。
- `updateClothing`：更新衣物。
- `deleteClothing`：软删除衣物。
- `analyzeClothing`：通义千问 VL 衣物图片识别，正式使用需配置 `DASHSCOPE_API_KEY`（兼容 `QWEN_VL_API_KEY`），可用 `QWEN_API_URL`、`QWEN_VL_MODEL` 覆盖默认端点与模型。
- `saveOutfit`：保存穿搭记录。
- `getOutfitRecords`：读取穿搭记录。
- `deleteOutfitRecord`：软删除穿搭记录。
- `updateSavedOutfit`：更新已有穿搭，校验并保留五槽历史快照。
- `getUserIdentity`：返回当前 OpenID，用于本地缓存按用户隔离。
- `clearUserData`：用户主动清除数据时，软删除衣橱与穿搭记录。

## 数据库集合

需要在云开发数据库创建：

- `clothing_items`
- `outfit_records`

建议索引：

- `clothing_items`：`openid` 升序、`isDeleted` 升序、`createdAt` 降序。
- `outfit_records`：`openid` 升序、`isDeleted` 升序、`date` 降序、`createdAt` 降序。

## 权限规则

第一版所有写入都通过云函数执行。数据库集合建议使用“仅创建者可读写”或更严格规则，并确保记录里有 `openid` 字段。生产环境不要使用默认开放规则。

## 隐私与权限

- `app.json` 已声明 `__usePrivacyCheck__: true`。
- `scope.userLocation` 权限用途已声明。
- 首页不会在进入时自动申请定位；只有用户点击“自动定位”才触发隐私授权与位置权限。
