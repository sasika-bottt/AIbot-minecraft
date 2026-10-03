# gen_whalegirl_skin.py — 蓝色鲸鱼娘皮肤 v2（参考 AI 立绘重绘）
from PIL import Image

img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
px = img.load()

# 调色板（取自立绘）
HAIR_D  = (52, 104, 176, 255)   # 头发深蓝
HAIR    = (91, 148, 216, 255)   # 头发主蓝
HAIR_L  = (143, 195, 238, 255)  # 头发浅蓝高光
HOOD    = (46, 109, 180, 255)   # 鲸鱼帽深蓝
HOOD_D  = (32, 82, 142, 255)    # 帽子暗部
HOOD_B  = (245, 249, 255, 255)  # 帽子白肚边
SKIN    = (255, 227, 207, 255)  # 肤色
BLUSH   = (255, 179, 186, 255)  # 腮红
EYE_W   = (255, 255, 255, 255)  # 眼白
EYE_B   = (79, 168, 232, 255)   # 虹膜蓝
EYE_P   = (27, 58, 102, 255)    # 瞳孔深蓝
MOUTH   = (224, 136, 152, 255)  # 嘴
SLEEVE  = (168, 212, 240, 255)  # 卫衣浅蓝
SLEEVE_D= (147, 198, 232, 255)  # 卫衣暗部（口袋）
SKIRT   = (247, 250, 255, 255)  # 白裙
SKIRT_D = (221, 232, 245, 255)  # 裙阴影
SOCK    = (207, 232, 250, 255)  # 袜
SHOE    = (74, 127, 193, 255)   # 鞋
SOLE    = (52, 82, 122, 255)    # 鞋底
TAIL    = (28, 66, 118, 255)    # 鲸尾


def rect(x0, y0, x1, y1, c):
    for x in range(x0, x1):
        for y in range(y0, y1):
            px[x, y] = c


# ============ 头部 ============
rect(8, 0, 16, 8, HOOD)                      # 头顶=鲸鱼帽
px[11, 2] = HOOD_D; px[12, 2] = HOOD_D       # 喷水孔
rect(16, 0, 24, 8, SKIN)                     # 头底（脖子）
# 正脸 (8,8)-(16,16)
rect(8, 8, 16, 16, SKIN)
rect(8, 8, 16, 9, HOOD)                      # 帽檐
px[8, 9] = HOOD; px[15, 9] = HOOD            # 帽檐两侧包边
rect(9, 9, 15, 10, HAIR)                     # 刘海
px[11, 9] = HAIR_L; px[12, 9] = HAIR_L       # 刘海高光
# 大眼睛（2x2 双眼）
px[9, 10] = EYE_W; px[10, 10] = EYE_B; px[9, 11] = EYE_B; px[10, 11] = EYE_P
px[14, 10] = EYE_W; px[13, 10] = EYE_B; px[14, 11] = EYE_B; px[13, 11] = EYE_P
# 腮红 + 嘴
px[9, 12] = BLUSH; px[14, 12] = BLUSH
px[11, 13] = MOUTH; px[12, 13] = MOUTH
# 头侧 = 蓝发
rect(0, 8, 8, 16, HAIR); rect(0, 8, 8, 10, HOOD)
rect(16, 8, 24, 16, HAIR); rect(16, 8, 24, 10, HOOD)
px[2, 12] = HAIR_L; px[19, 12] = HAIR_L      # 侧发高光
# 头后 = 鲸鱼帽背
rect(24, 8, 32, 16, HOOD)
rect(26, 10, 30, 13, TAIL)                   # 帽后鲸尾
px[27, 11] = HOOD_D; px[29, 11] = HOOD_D

# ============ 身体 ============
rect(16, 16, 40, 32, SLEEVE)                 # 全部底色=卫衣
rect(20, 16, 28, 20, HOOD)                   # 身顶=帽子肩部
rect(28, 16, 36, 20, SKIRT)                  # 身底=裙摆
# 正面 (20,20)-(28,32)
rect(20, 20, 28, 29, SLEEVE)
px[22, 21] = HOOD_B; px[25, 21] = HOOD_B     # 帽绳
rect(22, 25, 26, 28, SLEEVE_D)               # 口袋
rect(20, 29, 28, 32, SKIRT)                  # 白裙
rect(20, 31, 28, 32, SKIRT_D)
# 侧身
rect(16, 20, 20, 29, SLEEVE); rect(16, 29, 20, 32, SKIRT)
rect(28, 20, 32, 29, SLEEVE); rect(28, 29, 32, 32, SKIRT)
rect(36, 16, 40, 32, SLEEVE_D)
# 背面 (32,20)-(40,32)：帽子背+鲸尾
rect(32, 20, 40, 25, HOOD)
rect(34, 21, 38, 24, TAIL)
px[35, 22] = HOOD_D; px[37, 22] = HOOD_D
rect(32, 25, 40, 29, SLEEVE)
rect(32, 29, 40, 32, SKIRT); rect(32, 31, 40, 32, SKIRT_D)

# ============ 手臂（袖子+手）x2 ============
for ox, oy in ((40, 16), (32, 48)):          # 右臂块 / 左臂块
    rect(ox, oy, ox + 16, oy + 16, SLEEVE)
    rect(ox + 4, oy, ox + 8, oy + 4, HOOD)   # 肩顶=帽
    rect(ox + 12, oy, ox + 16, oy + 4, SLEEVE_D)
    for fx in (ox + 4, ox + 12):             # 两个正面
        rect(fx, oy + 4, fx + 4, oy + 12, SLEEVE)
        rect(fx, oy + 12, fx + 4, oy + 14, SLEEVE_D)   # 袖口
        rect(fx, oy + 14, fx + 4, oy + 16, SKIN)       # 手
    rect(ox, oy + 14, ox + 4, oy + 16, SKIN)
    rect(ox + 12, oy + 14, ox + 16, oy + 16, SKIN)

# ============ 腿（裙+肤+袜+鞋）x2 ============
for ox, oy in ((0, 16), (16, 48)):           # 右腿块 / 左腿块
    rect(ox, oy, ox + 16, oy + 16, SKIN)
    rect(ox + 4, oy, ox + 8, oy + 4, SKIRT)  # 腿顶=裙
    rect(ox + 8, oy, ox + 12, oy + 4, SOLE)  # 腿底=鞋底
    for fx in (ox + 4, ox + 12):             # 两个正面
        rect(fx, oy + 4, fx + 4, oy + 6, SKIRT)
        rect(fx, oy + 6, fx + 4, oy + 9, SKIN)
        rect(fx, oy + 9, fx + 4, oy + 13, SOCK)        # 袜
        px[fx, oy + 10] = SHOE; px[fx + 3, oy + 10] = SHOE  # 袜条纹
        rect(fx, oy + 13, fx + 4, oy + 15, SHOE)       # 鞋
        rect(fx, oy + 15, fx + 4, oy + 16, SOLE)       # 鞋底
    rect(ox, oy + 13, ox + 4, oy + 16, SHOE)
    rect(ox + 12, oy + 13, ox + 16, oy + 16, SHOE)

# ============ 第二层（帽子描边+双马尾）============
# 帽层头部
rect(32, 0, 64, 8, HOOD)                     # 帽顶外层
rect(32, 8, 40, 16, HAIR)                    # 右侧外层=马尾
rect(40, 8, 48, 16, HOOD)
rect(48, 8, 56, 16, HAIR)                    # 左侧外层=马尾
rect(56, 8, 64, 16, HOOD)                    # 后侧外层
px[34, 12] = HAIR_L; px[50, 12] = HAIR_L
rect(34, 8, 36, 16, HAIR_D); rect(50, 8, 52, 16, HAIR_D)  # 马尾内缘
# 身体外层（帽边）
rect(16, 32, 40, 34, HOOD)                   # 肩部帽边
rect(20, 32, 28, 34, HOOD)

img.save('bbb_skin_v2_whalegirl.png')
print('whale girl skin OK')
