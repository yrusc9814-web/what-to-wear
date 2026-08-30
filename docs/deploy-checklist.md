# 微信小程序部署与联调清单

## 需要用户介入的步骤

这些步骤需要在微信开发者工具或微信云开发控制台中完成，Codex 无法在本地直接代办：

1. 已完成：在 `project.config.json` 中填写小程序 `appid`。
2. 用微信开发者工具打开当前项目目录。
3. 已完成：开通或选择微信云开发环境 `cloud1-d1gjweewr2740aa1f`。
4. 上传并部署全部云函数。
   - 部署 mutation 云函数前先执行：`node scripts/prepare-cloudfunctions.mjs`。
   - `cloudfunctions/shared/` 是唯一 canonical 源；脚本会生成六个 mutation 函数目录内的 `shared/` 副本。当前工作区已包含这些副本，可直接按单函数目录部署。
   - 衣橱 / 穿搭 mutation 云函数仍需安装各函数 `package.json` 中的 `@cloudbase/node-sdk`。
5. 为 `getWeather` 云函数配置环境变量 `QWEATHER_API_KEY`（和风天气）。
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
11. `getUserIdentity`
12. `updateSavedOutfit`
13. `segmentClothing`

## 环境变量

`getWeather` 必填：

```text
QWEATHER_API_KEY=你的和风天气 API Key
```

可选覆盖项（不配置时使用下列默认值；和风控制台分配了专属 API Host 时覆盖 `QWEATHER_API_HOST`）：

```text
QWEATHER_API_HOST=devapi.qweather.com
QWEATHER_GEO_HOST=geoapi.qweather.com
```

`analyzeClothing` 正式识图必填：

```text
DASHSCOPE_API_KEY=你的通义千问Key
```

可选覆盖项（不配置时使用下列默认值）：

```text
QWEN_API_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
QWEN_VL_MODEL=qwen-vl-plus
```

未配置密钥、图片不属于当前用户、响应超时或模型返回不合规时，页面会进入手动填写流程，不会伪造 AI 识别结果。

`segmentClothing`（真实服饰抠图 Spike）必填（只需配置以下变量名，值在微信云开发控制台按阿里云 RAM 实际值填写，不要提交到仓库）：

```text
ALIBABA_CLOUD_ACCESS_KEY_ID
ALIBABA_CLOUD_ACCESS_KEY_SECRET
```

## segmentClothing（服饰抠图 Spike）部署步骤

1. 上传部署 `cloudfunctions/segmentClothing`（依赖 `wx-server-sdk` 与 `@alicloud/imageseg20191230`、`@alicloud/openapi-client`、`@alicloud/tea-util`，云端安装依赖即可，无需本地 npm install）。
2. 在微信云开发控制台为该函数配置上面两个阿里云环境变量（官方约定变量名，代码从 `process.env` 读取）。
3. 建议将该函数的「超时时间」从默认 20 秒调整为 60 秒：VIAPI 同步分割加结果下载与上传可能超过 20 秒。
4. 在阿里云控制台开通「视觉智能开放平台」的「分割抠图」类目（API：SegmentCloth，endpoint 固定为华东2上海 `imageseg.cn-shanghai.aliyuncs.com`）。未开通会返回 `InvalidApi.NotPurchase`。
5. 为该 AccessKey 所属 RAM 子账号授予 `AliyunVIAPIFullAccess` 系统权限（或按最小化原则自定义策略，仅放行 imageseg 的 SegmentCloth / SegmentClothAdvance 调用与 openplatform 文件中转授权）。
6. 该函数只接受 `wardrobe/{openid}/tmp/` 下的 temp 图（`cloud://` fileId 且必须包含当前用户 openid）；结果 PNG 上传到 `wardrobe/{openid}/tmp/cutout_*.png`，由小程序端 `registerTempImage` 登记进现有 temp 生命周期（24 小时客户端 TTL 清扫），不建第二套清理机制。
7. 任何一步失败都返回 `{ ok:false, errorCode, errorMessage }` 并绝不回退原图；日志只记录脱敏摘要（尺寸、字节数、错误码），不打印 URL、AccessKey 或图片内容。

## 云数据库集合

创建集合：

```text
clothing_items
outfit_records
```

本轮同步架构需要的索引说明（仅写部署清单，不在本轮修改线上数据库）：

```text
clothing_items: openid ASC, _id ASC
outfit_records: openid ASC, _id ASC
clothing_items: openid ASC, clientRecordId ASC  (兼容旧随机 _id 的一次性 canonical 查找)
outfit_records: openid ASC, clientRecordId ASC  (兼容旧随机 _id 的一次性 canonical 查找)
```

不要在未清理历史重复数据前建立 `openid + clientRecordId` 唯一索引。部署前先按两个字段统计重复记录，明确 canonical 记录后再评估唯一约束。分页技术游标只使用 `_id ASC` 和 `lastId`，业务展示排序仍由客户端使用 `savedAt` / `createdAt` fallback 完成。

## 真机验收

- 首次进入首页不应自动弹位置授权。
- 点击“自动定位”后才触发隐私/位置授权。
- 拒绝定位后可手动选择城市。
- 城市改变后，首页城市、温度、天气状态、图标、区间和建议同步刷新。
- 衣橱可完成上传三步、读取、编辑、逻辑删除；AI 失败时仍可手动保存。
- 衣橱新增后穿搭五槽可选；衣橱删除后新搭配不可选，历史快照仍可显示。
- 穿搭保存后首页最近保存出现；详情确认设为今日后首页同步刷新。
- 首页智能筛选只返回符合季节、风格的已保存搭配。
- 首页快速开始进入历史组合，不自动选中；“去搭配单品”进入穿搭 Tab。
- 跨日重新进入后，昨日今日穿搭自动失效。
- 上传单品成功后，「抠图预览（Spike）」按钮可发起真实抠图：成功显示透明底图与尺寸/透明像素数，失败明确展示 errorCode/errorMessage，不会回退显示原图。
