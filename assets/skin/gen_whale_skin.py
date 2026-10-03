# gen_whale_skin.py — 生成蓝色大肥鲸 64x64 Minecraft 皮肤
from PIL import Image

img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
px = img.load()
BLUE  = (66, 148, 214, 255)    # 主蓝
DBLUE = (45, 112, 172, 255)    # 深蓝（描边/尾部）
LBLUE = (120, 190, 238, 255)   # 浅蓝（高光）
WHITE = (235, 245, 252, 255)   # 肚皮
BLACK = (25, 25, 35, 255)      # 眼睛
PINK  = (250, 160, 170, 255)   # 腮红


def rect(x0, y0, x1, y1, c):
    for x in range(x0, x1):
        for y in range(y0, y1):
            px[x, y] = c


# ---- 头（正面在 (8,8)-(16,16)）----
rect(8, 0, 16, 8, BLUE)     # 头顶
rect(16, 0, 24, 8, LBLUE)   # 头底
rect(0, 8, 8, 16, BLUE)     # 头右
rect(16, 8, 24, 16, BLUE)   # 头左
rect(24, 8, 32, 16, BLUE)   # 头后
rect(8, 8, 16, 16, BLUE)    # 正脸底
rect(9, 12, 15, 16, WHITE)  # 下半脸肚白
# 大眼睛（2x2，呆萌风）
px[9, 10] = BLACK; px[10, 10] = BLACK; px[9, 11] = BLACK
px[13, 10] = BLACK; px[14, 10] = BLACK; px[14, 11] = BLACK
# 微笑
px[10, 13] = BLACK; px[11, 13] = BLACK; px[12, 13] = BLACK
# 腮红
px[8, 12] = PINK; px[15, 12] = PINK
# 喷水孔
px[11, 9] = DBLUE; px[12, 9] = DBLUE

# ---- 身（正面 (20,20)-(28,32)）----
rect(16, 16, 40, 32, BLUE)
rect(20, 16, 28, 20, LBLUE)   # 身顶
rect(28, 16, 36, 20, DBLUE)   # 身底
rect(36, 16, 40, 32, DBLUE)   # 身右侧深蓝
rect(20, 20, 28, 32, WHITE)   # 正面大白肚
for y in range(21, 31, 3):    # 肚皮横纹
    rect(21, y, 27, y + 1, LBLUE)

# ---- 手臂（鳍，(40,16)-(56,32)）----
rect(40, 16, 56, 32, BLUE)
rect(44, 16, 48, 20, LBLUE)
rect(52, 16, 56, 20, DBLUE)
rect(40, 28, 48, 32, LBLUE)   # 左鳍尖
rect(48, 28, 56, 32, DBLUE)   # 右鳍尖

# ---- 腿（尾鳍，(40,0)-(56,16)）----
rect(40, 0, 56, 16, BLUE)
rect(44, 0, 48, 4, LBLUE)
rect(52, 0, 56, 4, DBLUE)
rect(40, 12, 48, 16, DBLUE)
rect(48, 12, 56, 16, DBLUE)

img.save('bbb_skin_v1_pixelwhale.png')
print('skin OK: 64x64')
