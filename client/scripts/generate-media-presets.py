from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

ROOT=Path(__file__).resolve().parent.parent/'public'/'media-presets'
PACKS={'hello':('HELLO!','#5865f2'),'love':('LOVE','#d74c77'),'party':('PARTY!','#b066dc'),'thanks':('THANK YOU','#17865b'),'wow':('WOW!','#dc9931'),'gg':('GG!','#2787b8'),'bye':('SEE YOU','#677484'),'happy':('HAPPY','#e9a12c')}
font=ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf',27)
for name,(label,color) in PACKS.items():
    frames=[]
    for frame in range(16):
        image=Image.new('RGB',(256,256),'#20232c');draw=ImageDraw.Draw(image)
        y=int(88+9*math.sin(frame*math.pi/8))
        draw.rounded_rectangle((10,10,246,246),radius=32,fill=color)
        draw.ellipse((56,y-50,200,y+94),fill='#fff3dc')
        eye_y=y+8
        draw.ellipse((90,eye_y,101,eye_y+15),fill='#282b35');draw.ellipse((155,eye_y,166,eye_y+15),fill='#282b35')
        draw.arc((102,y+20,154,y+60),0,180,fill='#282b35',width=6)
        if name=='love':
            for cx in (82,174):
                draw.polygon([(cx-14,y-4),(cx,y+12),(cx+14,y-4),(cx+9,y-13),(cx,y-7),(cx-9,y-13)],fill='#d74c77')
        if name=='party':
            for i in range(12):
                x=(i*53+frame*5)%230+12;cy=(i*31+frame*7)%90+15
                draw.rectangle((x,cy,x+5,cy+8),fill=('#ffe287','#aeeacb','#d6c5ff')[i%3])
        draw.text((128,213),label,font=font,anchor='mm',fill='white')
        frames.append(image)
    (ROOT/'gifs').mkdir(parents=True,exist_ok=True)
    (ROOT/'stickers').mkdir(parents=True,exist_ok=True)
    frames[0].save(ROOT/'stickers'/f'{name}.png')
    frames[0].save(ROOT/'gifs'/f'{name}.gif',save_all=True,append_images=frames[1:],duration=80,loop=0,optimize=True)
print('Generated 8 animated GIFs and 8 stickers.')
