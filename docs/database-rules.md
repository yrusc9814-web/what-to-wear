# 云数据库权限规则建议

第一版所有写入都通过云函数执行，集合中每条记录必须写入 `openid`。生产环境不要使用“所有用户可读写”。

## clothing_items

建议控制台规则方向：

```json
{
  "read": "auth.openid == resource.openid",
  "write": false
}
```

说明：

- 前端读取也可以完全走 `getWardrobe` 云函数。
- 如果控制台规则不支持该表达式版本，则设置为“仅创建者可读写”，并优先通过云函数访问。
- 写入、更新、删除分别由 `saveClothing`、`updateClothing`、`deleteClothing` 执行。

## outfit_records

建议控制台规则方向：

```json
{
  "read": "auth.openid == resource.openid",
  "write": false
}
```

说明：

- 前端读取也可以完全走 `getOutfitRecords` 云函数。
- 写入、更新、删除分别由 `saveOutfit`、`updateSavedOutfit`、`deleteOutfitRecord` 执行。

## 必查项

- 集合默认权限不能保持测试期全开放。
- 两个集合都要有 `openid` 字段。
- 删除采用软删除：`isDeleted=true`、`deletedAt` 写入服务端时间。
- 用户主动清除数据时，`clearUserData` 写入 `dataDeleteRequestedAt`。
