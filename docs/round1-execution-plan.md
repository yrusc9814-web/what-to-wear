# 第一轮执行拆分（V1.5/V1.6）

日期：2026-08-27。基线：main @ 3f96aaa（工作区干净），测试基线 33/33 通过。

## 并行边界与所有权表

| 区域 | 第一责任 | 第一轮规则 |
| --- | --- | --- |
| `app-service.js` uploadImage 区（~724-790）+ `stabilizeWardrobeItem` 相关调用 | A | A 唯一可改 app-service.js |
| `pages/item-upload/*`、`pages/item-edit/*` | A | |
| `pages/outfit/index.js/wxml/wxss`、新建 layout 模块 | B | B 不改 saveOutfit 协议、不改 app-service.js |
| 新建 `cloudfunctions/saveOutfitReference`、`updateOutfitReference`、`deleteOutfitReference`、`getOutfitReferences`；`scripts/prepare-cloudfunctions.mjs`（如需）；`cloudfunction-deploy-structure.test.js` | C | C 不改 app-service.js、不改现有云函数 |
| `normalizeWardrobeItem` / `normalizeOutfit` / `mergeById` | 主代理 | 第一轮任何人不动 |
| `clearUserData`、`performSyncTask` OutfitReference 分支、hydrate | C（整合阶段） | 三个子代理全部返回后，由主代理安排 C 单独接线 |
| `cloudfunctions/shared/cloudbase.js`、`cloudfunctions/shared/outfit-slots.js` | — | 禁止修改（只允许 require） |
| 四个展示页（outfit-detail / saved-outfits / outfit-history / outfit-match） | — | 第一轮不动，保留各自 CSS |
| tests/ 新增测试文件 | 各自新增各自命名 | 不改他人测试 |

## A：临时图片生命周期

1. `uploadImage` 增加用途参数（temp/clothing/reference，具体名自定），默认行为必须兼容现有全部调用点（item-upload.js:138/294、item-edit.js:176、app-service.js:833/952/981）。
2. temp 路径 `wardrobe/{userScope}/tmp/{ts}_{rand}.{ext}`；clothing/reference 路径分别明确。
3. item-upload/item-edit 流程：选图 → 传 tmp；保存成功后将临时图转正（本地路径仍在时正式上传）并删 tmp；重新选择 / 取消 / 失败时删 tmp；删除失败不阻塞主业务，记录后继续。
4. TTL=24h 客户端兜底：temps 登记表（本地存储，记录 fileId+时间戳），进入 item-upload 或 app 启动时清扫过期项。
5. 摘除 item-upload / item-edit 中对 AI 识别（recognizeWardrobeItem / analyzeClothing）的调用，改为纯手动填属性；**不删**云函数 analyzeClothing，保留服务层函数不动。
6. 新增测试（如 `tests/temp-image-lifecycle.test.js`），遵循现有测试风格。

## B：自由画布基础交互（本地草稿态）

1. 新建统一默认 layout 模块（新文件，如 `miniprogram/services/outfit-layout.js`）：为 hat/top/bottom/shoes/bag 提供默认 `{x, y, scale, zIndex}`、clamp、层级上移/下移、重置逻辑（纯函数，便于测试）。
2. 改造 `pages/outfit/index.*`：五层渲染由 `.layer-*` 硬编码 CSS 改为 layout 数据驱动内联样式（保留 DOM 结构与类名兜底）。
3. 交互：点击选中、单指拖动、双指缩放、上移一层、下移一层、重置当前、重置整套。只支持拖动/缩放/图层，不做旋转/倾斜/镜像/滤镜。
4. layout 只存页面 draft 状态；**保存协议不变**（createSavedOutfit/updateSavedOutfit payload 第一轮不带 layout 入云）。
5. 新增测试（layout 纯逻辑）。

## C：OutfitReference 数据层

1. 新 collection：`outfit_references`。
2. 新建四个云函数（克隆 Clothing 线 saveClothing/updateClothing/deleteClothing/getWardrobe 模式，复用 `shared/cloudbase.js` 的 applyMutation，不得修改 shared）：
   - 业务字段：imageFileId, name, seasons, styles, occasion, note, source(self/web/other)
   - 同步字段：openid, clientRecordId, mutationVersion, mutationIdentity, isDeleted, deletedAt
   - 幂等、tombstone、游标分页（对照 final-pagination 测试模式）
3. 若 `scripts/prepare-cloudfunctions.mjs` 的 shared 复制清单需要覆盖新函数，更新之；同步维护 `cloudfunction-deploy-structure.test.js`。
4. 客户端写**新文件模块**（如 `miniprogram/services/reference-service.js`）：normalizeOutfitReference + CRUD 封装（通过 app-service 已导出的 queueSync 等能力组合，零修改既有文件）；performSyncTask 分支、hydrate、clearUserData 接线**明确不做**，列为整合阶段 TODO。
5. 新增测试（fake-cloud helper 风格，对照 cloud-contract / final-cloud-mutation）。

## 依赖

- B 最终视觉验收依赖 A 第二轮的透明素材（本轮不做）。
- C 整合接线依赖 A 完成（同文件顺序：先 A 后 C）。
- 云函数部署（4 个新函数）不在本轮范围，返回后由主代理评估是否提请人工部署。

## 验收标准

- 各自新增测试通过；全仓 `node tests/*.test.js` 逐个执行仍为 33+N 全过、0 失败。
- git diff 无越权文件（对照上表）；无全仓格式化、重命名、删旧字段。
- B 的画布交互需真实运行截图（由主代理在门禁阶段用 miniprogram-automator 验收，子代理不得自我宣布通过）。

## 已知风险

- P1：客户端 wx.cloud.deleteFile 依赖文件归属当前用户，失败仅记录不阻塞；TTL 清扫是客户端兜底，云端无定时触发器（CLI 能力限制），遗留 tmp 依赖用户打开 App 时回收。
- P1：B 改造 outfit 页面为数据驱动渲染，可能造成默认视觉与 V1.4 硬编码效果偏移——需截图对比。
- P2：C 的新云函数未部署前，reference-service 的云端调用会失败；本地 outbox 逻辑应先可测。
- P2：摘除 AI 调用后 item-upload 的 uploadAndRecognize 状态机残留逻辑需清理干净，upload-state.test.js 不得被破坏。

## 硬门禁

三代理返回后：主代理查 diff、跑全测试、V1.4 回归清单、取 B 截图 → 输出完成状态/遗留/第二轮建议 → **立即停止，等人工确认。**
