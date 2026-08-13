const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const wardrobeWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/wardrobe/wardrobe.wxml'), 'utf8')
const wardrobeJs = fs.readFileSync(path.join(root, 'miniprogram/pages/wardrobe/wardrobe.js'), 'utf8')
const wardrobeWxss = fs.readFileSync(path.join(root, 'miniprogram/pages/wardrobe/wardrobe.wxss'), 'utf8')
const uploadWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/item-upload/item-upload.wxml'), 'utf8')
const uploadJs = fs.readFileSync(path.join(root, 'miniprogram/pages/item-upload/item-upload.js'), 'utf8')
const outfitWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/outfit/index.wxml'), 'utf8')
const appJson = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'))

assert(wardrobeWxml.includes('bindtap="navigateToProfile"'), '衣橱头像必须绑定个人中心入口')
assert(wardrobeJs.includes("wx.navigateTo({ url: '/pages/profile/index' })"), '衣橱头像必须跳转到已注册个人中心')

assert(uploadWxml.includes('支持 JPG / PNG / WebP 格式'), '上传页只应展示真实支持的格式')
assert(!uploadWxml.includes('HEIC'), '上传页不得宣称支持 HEIC')
assert(uploadJs.includes('detectSupportedImageFormat(imageHeader)'), '上传前必须校验实际图片格式')
assert(uploadJs.includes('HEIC 暂不支持'), '选择 HEIC 时必须给出明确提示')
assert(uploadJs.includes("return 'jpeg'"), '格式校验必须允许 JPEG')
assert(uploadJs.includes("return 'png'"), '格式校验必须允许 PNG')
assert(uploadJs.includes("return 'webp'"), '格式校验必须允许 WebP')

assert.deepStrictEqual(appJson.tabBar.list.map((item) => item.text), ['首页', '衣橱', '穿搭'], '底部必须保持三个正式 Tab')
assert(outfitWxml.includes('<view class="brand">穿搭 '), '穿搭主页面必须保持正式标题“穿搭”')
assert(wardrobeJs.includes("viewMode: 'grid'"), '衣橱默认视图必须保持网格')
assert(wardrobeWxss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), '衣橱网格必须保持两列')
;['name', 'category', 'seasons', 'styles', 'primaryColor', 'thickness', 'size', 'purchasePrice', 'purchaseDate', 'purchaseChannel', 'aiDescription', 'note'].forEach((field) => {
  assert(new RegExp(`\\b${field}:`).test(uploadJs), `上传字段不可缺少 ${field}`)
})

console.log('p2 ui/heic tests passed')
