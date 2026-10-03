# -*- coding: utf-8 -*-
# 鲸鱼娘皮肤 v2 —— 严格照参考图绘制（藏青卷发+女仆头饰+蓝眼+女仆裙白围裙+鲸尾）
from PIL import Image

img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
px = img.load()

# ---------- 调色板（取自参考图） ----------
SKIN   = (255, 227, 207, 255)   # 肤色
SKIND  = (245, 210, 190, 255)   # 肤色暗部
WHITE  = (246, 247, 251, 255)   # 头饰/围裙白
WHITES = (219, 224, 238, 255)   # 白色暗部（褶皱）
NAVY   = (58, 66, 105, 255)     # 头发主色（藏青）
NAVY2  = (78, 90, 138, 255)     # 头发中部
BLUE   = (116, 152, 205, 255)   # 发梢渐变蓝
HILITE = (168, 199, 236, 255)   # 头发高光
DRESS  = (56, 62, 100, 255)     # 裙子藏青
DRESSD = (40, 45, 76, 255)      # 裙子暗部
RIBBON = (80, 140, 230, 255)    # 蓝丝带
RIBBOND= (55, 105, 195, 255)
GOLD   = (208, 178, 118, 255)   # 金色蝴蝶结
IRIS   = (105, 170, 240, 255)   # 瞳孔亮蓝
IRISD  = (55, 105, 200, 255)    # 瞳孔深蓝
EYEW   = (252, 253, 255, 255)   # 眼高光
MOUTH  = (150, 62, 76, 255)     # 张嘴
TONGUE = (246, 140, 150, 255)   # 舌头
BLUSH  = (252, 170, 170, 255)   # 腮红
SOCK   = (52, 60, 98, 255)      # 袜
SHOE   = (38, 42, 70, 255)      # 鞋
SOLE   = (26, 29, 50, 255)      # 鞋底
WHALE  = (36, 41, 70, 255)      # 围裙小鲸鱼

def rect(x0, y0, x1, y1, c):
    for x in range(x0, x1):
        for y in range(y0, y1):
            px[x, y] = c

def p(x, y, c):
    px[x, y] = c

# ================= 头部（基础层 8x8/面） =================
# 正脸 (8,8)-(16,16)
F = [
"WWWWWWWW",
"NNNNNNNN",
"NHNNNNHN",
"BBBBBBBB",
"SEIEIISE"[:0] or "",  # 占位，下面逐像素
]
# fy0 女仆头饰白边
for fx in range(8):
    p(8+fx, 8, WHITES if fx in (0, 7) else WHITE)
# fy1-3 刘海（藏青，fy2 高光，fy3 发梢仅在两侧露蓝）
rect(8, 9, 16, 10, NAVY)
p(10, 10, HILITE); p(13, 10, HILITE)
rect(8, 11, 16, 12, NAVY)
p(8, 11, BLUE); p(15, 11, BLUE)
# fy4-5 大眼睛 (fx1-2, fx5-6)
for fx in range(8):
    p(8+fx, 12, SKIN)
p(9, 12, EYEW);  p(10, 12, IRIS)
p(13, 12, IRIS); p(14, 12, EYEW)
for fx in range(8):
    p(8+fx, 13, SKIN)
p(9, 13, IRISD); p(10, 13, IRISD)
p(13, 13, IRISD); p(14, 13, IRISD)
# fy6 微笑小嘴（含舌头一角） + 腮红
for fx in range(8):
    p(8+fx, 14, SKIN)
p(11, 14, MOUTH); p(12, 14, TONGUE)
p(8, 14, BLUSH);  p(15, 14, BLUSH)
# fy7 下巴
rect(8, 15, 16, 16, SKIN)

# 头顶 (8,0)-(16,8)：前缘白色头饰带，其余藏青
rect(8, 0, 16, 8, NAVY)
rect(8, 0, 16, 1, WHITE)
rect(8, 1, 16, 2, NAVY)
p(10, 4, HILITE); p(11, 4, HILITE); p(11, 5, HILITE)

# 头右 (0,8)-(8,16) / 头左 (16,8)-(24,16)：藏青 + 顶部白带 + 底部渐变
for (x0, x1) in [(0, 8), (16, 24)]:
    rect(x0, 8, x1, 16, NAVY)
    rect(x0, 8, x1, 9, WHITE)          # 头饰绕到耳侧
    rect(x0, 14, x1, 15, NAVY2)
    rect(x0, 15, x1, 16, BLUE)
p(2, 11, HILITE); p(19, 11, HILITE)

# 头后 (24,8)-(32,16)：长发披背，底部渐变+高光
rect(24, 8, 32, 16, NAVY)
rect(24, 14, 32, 15, NAVY2)
rect(24, 15, 32, 16, BLUE)
p(27, 11, HILITE); p(28, 12, HILITE)

# 头底 (16,0)-(24,8)：脖子
rect(16, 0, 24, 8, SKIN)
rect(16, 0, 24, 3, SKIND)

# ================= 身体（基础层） =================
# 身顶 (20,16)-(28,20) / 身底 (28,16)-(36,20)
rect(20, 16, 28, 20, DRESS)
rect(28, 16, 36, 20, DRESSD)
# 身右 (16,20)-(20,32) / 身左 (28,20)-(32,32)
for (x0, x1) in [(16, 20), (28, 32)]:
    rect(x0, 20, x1, 32, DRESS)
    rect(x0, 31, x1, 32, WHITE)   # 裙摆白褶边
# 身正 (20,20)-(28,32)
rect(20, 20, 28, 32, DRESS)
rect(20, 21, 28, 22, WHITE)        # 领口白色褶边
p(23, 22, RIBBON); p(24, 22, RIBBON)          # 胸口蓝丝带蝴蝶结
p(23, 23, RIBBOND)
for y in range(23, 31):            # 中间白围裙
    rect(22, y, 26, y+1, APRON if False else WHITE)
p(21, 25, GOLD); p(21, 27, GOLD)   # 侧边金扣
rect(22, 27, 26, 28, WHITES)       # 围裙褶皱
p(23, 29, WHALE); p(24, 29, WHALE) # 围裙上的小鲸鱼
p(24, 28, WHALE)                   # 鲸尾
p(20, 28, GOLD); p(27, 28, GOLD)   # 腰间金蝴蝶结
rect(20, 31, 28, 32, WHITE)        # 裙摆白褶边
# 身后 (32,20)-(40,32)：藏青 + 鲸尾 + 白褶边
rect(32, 20, 40, 32, DRESS)
rect(32, 31, 40, 32, WHITE)
rect(35, 26, 37, 27, DRESSD)       # 身后鲸尾（上下摆）
p(34, 27, DRESSD); p(37, 27, DRESSD)
rect(34, 28, 38, 29, DRESSD)
p(35, 29, DRESSD); p(36, 29, DRESSD)

# ================= 手臂（经典 4px，袖+白袖口+手） =================
def arm(xf0, yf0):
    # xf0: front face 左上角 x；yf0: front face 顶 y（右臂 44,20 / 左臂 36,52）
    rect(xf0, yf0, xf0+4, yf0+12, DRESS)
    rect(xf0, yf0, xf0+4, yf0+1, NAVY2)     # 肩部浅一档
    p(xf0, yf0+4, NAVY2); p(xf0, yf0+7, NAVY2)  # 袖子褶
    rect(xf0, yf0+9, xf0+4, yf0+10, WHITE)  # 白袖口
    rect(xf0, yf0+10, xf0+4, yf0+12, SKIN)  # 手
arm(44, 20)   # 右臂正面
arm(36, 52)   # 左臂正面
# 其余臂面填充（简化：全部按正面样式覆盖）
rect(40, 20, 44, 32, DRESS);  rect(48, 20, 52, 32, DRESS);  rect(52, 20, 56, 32, DRESS)
rect(40, 29, 44, 30, WHITE);  rect(48, 29, 52, 30, WHITE);  rect(52, 29, 56, 30, WHITE)
rect(40, 30, 44, 32, SKIN);   rect(48, 30, 52, 32, SKIN);   rect(52, 30, 56, 32, SKIN)
rect(32, 52, 36, 64, DRESS);  rect(40, 52, 44, 64, DRESS);  rect(44, 52, 48, 64, DRESS)
rect(32, 61, 36, 62, WHITE);  rect(40, 61, 44, 62, WHITE);  rect(44, 61, 48, 62, WHITE)
rect(32, 62, 36, 64, SKIN);   rect(40, 62, 44, 64, SKIN);   rect(44, 62, 48, 64, SKIN)
rect(44, 16, 56, 20, DRESS)   # 臂顶/底

# ================= 腿（裙摆+白褶+藏青袜+鞋） =================
def leg(xf0, yf0):
    rect(xf0, yf0, xf0+4, yf0+3, DRESS)      # 裙摆延伸
    rect(xf0, yf0+3, xf0+4, yf0+4, WHITE)    # 白褶边
    rect(xf0, yf0+4, xf0+4, yf0+8, SOCK)     # 藏青袜
    p(xf0+1, yf0+5, GOLD)                    # 袜扣金点
    rect(xf0, yf0+8, xf0+4, yf0+11, SHOE)    # 鞋
    rect(xf0, yf0+11, xf0+4, yf0+12, SOLE)   # 鞋底
leg(4, 20)    # 右腿正面
leg(20, 52)   # 左腿正面
rect(0, 20, 4, 32, SOCK);  rect(12, 20, 16, 32, SOCK);  rect(8, 20, 12, 32, SOCK)
rect(16, 48, 32, 64, DRESS)   # 左腿区其余面 + 腿顶
rect(0, 16, 16, 20, DRESS)    # 右腿顶/底
rect(0, 28, 4, 32, SHOE);  rect(8, 28, 12, 32, SHOE);  rect(12, 28, 16, 32, SHOE)
rect(0, 31, 4, 32, SOLE);  rect(8, 31, 12, 32, SOLE);  rect(12, 31, 16, 32, SOLE)
rect(0, 52, 4, 64, SOCK); rect(4, 52, 8, 64, SOCK); rect(12, 52, 16, 64, SOCK)
rect(16, 48, 32, 52, DRESS)
rect(0, 60, 4, 64, SHOE); rect(4, 60, 8, 64, SHOE); rect(12, 60, 16, 64, SHOE)
rect(0, 63, 4, 64, SOLE); rect(4, 63, 8, 64, SOLE); rect(12, 63, 16, 64, SOLE)

# ================= 第二层（帽子层） =================
# 头顶第二层 (40,0)-(48,8)：呆毛
p(43, 0, NAVY); p(44, 0, NAVY); p(44, 1, NAVY2)
# 头两侧第二层：鬓发垂在耳前
rect(38, 9, 40, 14, NAVY)     # 右侧
rect(48, 9, 50, 14, NAVY)     # 左侧
rect(38, 13, 40, 14, BLUE)
rect(48, 13, 50, 14, BLUE)
# 头后第二层：长发加厚
rect(56, 8, 64, 16, NAVY)
rect(56, 14, 64, 16, NAVY2)

img.save('bbb_skin_v3_whalemaid.png')

# ================= 预览拼装（正面） =================
head = img.crop((8, 8, 16, 16))
body = img.crop((20, 20, 28, 32))
armR = img.crop((44, 20, 48, 32))
armL = img.crop((36, 52, 40, 64))
legR = img.crop((4, 20, 8, 32))
legL = img.crop((20, 52, 24, 64))
c = Image.new('RGBA', (16, 24), (246, 248, 252, 255))
c.paste(legR, (4, 20)); c.paste(legL, (9, 20))
c.paste(armR, (1, 8));  c.paste(armL, (12, 8))
c.paste(body, (4, 8))
c.paste(head, (4, 0))
c.resize((16*20, 24*20), Image.NEAREST).save('bbb_skin_v3_whalemaid_preview.png')
print('skin v2 done')
