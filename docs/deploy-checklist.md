# 微信小程序部署与联调清单

## 需要用户介入的步骤

这些步骤需要在微信开发者工具或微信云开发控制台中完成，Codex 无法在本地直接代办：

1. 已完成：在 `project.config.json` 中填写小程序 `appid`。
2. 已完成：用微信开发者工具打开 `D:\chuanda-project`。
3. 已完成：开通或选择微信云开发环境 `cloud1-d1gjweewr2740aa1f`。
4. 上传并部署全部云函数。
5. 为 `getWeather` 云函数配置环境变量 `TENCENT_MAP_KEY`。
6. 创建云数据库集合 `clothing_items`、`outfit_records`。
7. 配置数据库权限规则和索引，参考 `docs/database-rules.md`。
8. 在真机上验证隐私授权、位置授权、图片上传、云函数调用。

## 云函数部署顺序

建议按下面顺序上传部署：

1. `getWeather`
2. `saveClothing`
3. `getWardrobe`
4. `updateClothing`
5. `deleteClothing`
6. `analyzeClothing`
7. `saveOutfit`
8. `getOutfitRecords`
9. `deleteOutfitRecord`
10. `clearUserData`

## 环境变量

`getWeather` 必填：

```text
TENCENT_MAP_KEY=你的腾讯地图WebService API Key
```

`analyzeClothing` 可选，正式接入通义千问 VL 时再配置：

```text
DASHSCOPE_API_KEY=你的通义千问Key
```

## 云数据库集合

创建集合：

```text
clothing_items
outfit_records
```

建议索引：

```text
clothing_items: openid ASC, isDeleted ASC, createdAt DESC
outfit_records: openid ASC, isDeleted ASC, date DESC, createdAt DESC
```

## 真机验收

- 首次进入首页不应自动弹位置授权。
- 点击“自动定位”后才触发隐私/位置授权。
- 拒绝定位后可手动选择城市。
- 首页展示今天 + 未来 5 天天气。
- 选中未来日期时推荐入口不可用，并提示第一版仅支持今日推荐。
- 衣橱可上传图片、保存、读取、删除。
- 推荐页可基于衣橱生成 3 套方案。
- 点击“记录这套”后首页出现穿搭记录。
- 清除数据后衣橱和穿搭记录为空。
