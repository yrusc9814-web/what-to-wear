# tests/fixtures/outfit — Round 1.5.1 女生穿搭测试 fixture

## 用途限制（重要）

本目录图片**仅用于 Round 1.5.1 视觉验收**（穿搭画布搭建、单品图层摆放的测试输入）。
**禁止**混入正式用户测试或线上数据；**禁止**上传任何网络/对象存储；不含任何真实用户数据。
不要在 node 测试（`tests/*.test.js`）中引用本目录；如需扩展请重新程序化生成，勿手工替换为实拍图。

## 来源

五张图片均为 **PIL/Pillow 程序化绘制**的示意线稿/填充图（无 AI 生成、无网络下载、无真实照片）。
绘制坐标原点为各自设计画布，3 倍超采样后 LANCZOS 降采样抗锯齿。
生成脚本（开发期临时脚本，未入库）：`%TEMP%/gen_outfit_fixtures_151.py`，重跑即可复现或调整后再生。

## 单品清单与风格（一套夏装搭配，色系协调：棕褐 x 米白 x 浅蓝）

| 文件 | 单品 | 内容 | 主色 |
| --- | --- | --- | --- |
| hat.png | 宽帽檐草帽 | 圆角帽冠 + 体育场形帽檐 + 深棕饰带 | 棕褐系 |
| top.png | 短袖 T 恤 | 落肩箱型 + 领口弧 + 下摆/袖口缝线 | 白色 |
| bottom.png | A 字半身裙 | 深蓝腰头 + 上窄下宽裙身 + 裥褶线 | 浅蓝/牛仔 |
| shoes.png | 厚底板鞋 x2 | 同基线左右两只、前鞋叠后鞋 | 米杏 + 灰底 |
| bag.png | 箱型斜挎包 | 方正包身 + 包盖 + 低拱扁平肩带 | 米粉/奶白 |

## 标准化规则（每张已执行）

1. 紧致裁剪：自动检测非白（RGB 任一分量 < 250）像素 bbox，裁掉多余空白；
2. 主体居中：粘贴位置取「bbox 中心居中」与「质心居中」的折中；
3. 保持 aspect ratio：仅等比外扩白底画布，**不做任何非等比拉伸**；
4. 面积占比归一：按 `主体像素面积 / 画布面积` 缩放至各自目标（70-75% 区间内，极差 < 10 个百分点）；
5. 统一输出：长边 400px（LANCZOS），纯白背景 #ffffff（透明化由页面代码负责）。

## 生成后自检数据（2026-08-28 实测，numpy 非背景像素统计）

| 文件 | 尺寸 (WxH) | 主体占比 | bbox 中心偏移 | 质心偏移 | aspect |
| --- | --- | --- | --- | --- | --- |
| hat.png | 400x253 | 74.3% | 1.1% | 1.5% | 1.58 |
| top.png | 318x400 | 70.4% | 0.1% | 2.7% | 0.80 |
| bottom.png | 315x400 | 73.6% | 1.5% | 2.4% | 0.79 |
| shoes.png | 400x176 | 72.8% | 1.6% | 3.1% | 2.27 |
| bag.png | 346x400 | 73.0% | 2.1% | 2.1% | 0.86 |

占比区间 70.4%-74.3%（极差 4.0 个百分点），中心偏移全部 <= 2.1%（要求 ±10%）。
复核方式：任一 python 环境执行

```bash
python - <<'PY'
import numpy as np
from PIL import Image
import math, os
d = r"D:\Vanta-pro\小衣橱\what-to-wear\tests\fixtures\outfit"
for f in ["hat.png","top.png","bottom.png","shoes.png","bag.png"]:
    a = np.asarray(Image.open(os.path.join(d,f)).convert("RGB"), dtype=np.int16)
    m = a.min(axis=2) < 250
    H, W = m.shape
    yy, xx = np.nonzero(m)
    cx = (xx.min()+xx.max()+1)/2; cy = (yy.min()+yy.max()+1)/2
    off = math.hypot(cx-W/2, cy-H/2)/max(W,H)*100
    print(f"{f:12s} {W}x{H}  ratio={m.mean()*100:.1f}%  center_off={off:.1f}%  aspect={W/H:.2f}")
PY
```
