"""Software z-buffer preview of the exported GLB files. numpy + Pillow only."""
from pathlib import Path
import json, struct
import numpy as np
from PIL import Image, ImageDraw, ImageFont
OUT=Path(__file__).resolve().parent

def load_glb(path):
    data=path.read_bytes(); magic,version,length=struct.unpack_from('<III',data)
    assert magic==0x46546c67 and version==2 and length==len(data)
    jl=struct.unpack_from('<I',data,12)[0]; doc=json.loads(data[20:20+jl]); binary=data[28+jl:]
    def a(i):
        ac=doc['accessors'][i]; vw=doc['bufferViews'][ac['bufferView']]
        dtype={5126:'<f4',5125:'<u4'}[ac['componentType']]; width={'VEC3':3,'VEC2':2,'SCALAR':1}[ac['type']]
        arr=np.frombuffer(binary,dtype=dtype,count=ac['count']*width,offset=vw.get('byteOffset',0)+ac.get('byteOffset',0)).reshape(-1,width)
        assert np.isfinite(arr).all()
        return arr
    parts=[]
    for mesh in doc['meshes']:
        for p in mesh['primitives']:
            v=a(p['attributes']['POSITION']); n=a(p['attributes']['NORMAL']); f=a(p['indices']).reshape(-1,3)
            assert f.max()<len(v)
            assert np.allclose(np.linalg.norm(n,axis=1),1,atol=.01)
            # Convert back to Z up for rendering.
            vv=v[:,[0,2,1]].copy(); vv[:,1]*=-1
            nn=n[:,[0,2,1]].copy(); nn[:,1]*=-1
            material=doc['materials'][p['material']]
            parts.append((vv,nn,f,material))
    return parts

def render(parts,size=840):
    camera=np.array([2.8,-4.2,5.8]); camera/=np.linalg.norm(camera)
    right=np.cross([0,0,1],camera); right/=np.linalg.norm(right)
    up=np.cross(camera,right)
    light=np.array([-3.,-4.,7.]); light/=np.linalg.norm(light)
    half=(light+camera); half/=np.linalg.norm(half)
    scale=size/.1 if False else size/1.62
    canvas=np.full((size,size,3),[233,238,245],float)
    depth=np.full((size,size),-1e9)
    for v,n,faces,material in parts:
        # Render only opaque materials, all assets use opaque stylized ice.
        xy=np.column_stack((v@right*scale+size/2, -(v@up-.115)*scale+size/2)); zz=v@camera
        mr=material['pbrMetallicRoughness']; color=np.array(mr['baseColorFactor'][:3]); rough=mr['roughnessFactor']
        for face in faces:
            p=xy[face]; z=zz[face]
            lo=np.maximum(0,np.floor(p.min(axis=0)).astype(int)); hi=np.minimum(size-1,np.ceil(p.max(axis=0)).astype(int))
            if np.any(hi<lo): continue
            xx,yy=np.meshgrid(np.arange(lo[0],hi[0]+1)+.5,np.arange(lo[1],hi[1]+1)+.5)
            den=(p[1,1]-p[2,1])*(p[0,0]-p[2,0])+(p[2,0]-p[1,0])*(p[0,1]-p[2,1])
            if abs(den)<1e-8: continue
            w0=((p[1,1]-p[2,1])*(xx-p[2,0])+(p[2,0]-p[1,0])*(yy-p[2,1]))/den
            w1=((p[2,1]-p[0,1])*(xx-p[2,0])+(p[0,0]-p[2,0])*(yy-p[2,1]))/den
            w2=1-w0-w1; zval=w0*z[0]+w1*z[1]+w2*z[2]
            dst=depth[lo[1]:hi[1]+1,lo[0]:hi[0]+1]
            mask=(w0>=-1e-6)&(w1>=-1e-6)&(w2>=-1e-6)&(zval>dst)
            if not mask.any(): continue
            norm=w0[:,:,None]*n[face[0]]+w1[:,:,None]*n[face[1]]+w2[:,:,None]*n[face[2]]
            norm/=np.maximum(1e-8,np.linalg.norm(norm,axis=2)[:,:,None])
            lambert=np.clip(norm@light,0,1)
            spec=np.clip(norm@half,0,1)**(12+70*(1-rough))*.16*(1-rough)
            rgb=color[None,None,:]*(.34+.66*lambert[:,:,None])+spec[:,:,None]
            if 'baseColorTexture' in mr:
                pos=w0[:,:,None]*v[face[0]]+w1[:,:,None]*v[face[1]]+w2[:,:,None]*v[face[2]]
                grain=.96+.04*np.sin(pos[:,:,0]*1530)*np.sin(pos[:,:,1]*1270)
                rgb*=grain[:,:,None]
            rgb=np.where(rgb<=.0031308,12.92*rgb,1.055*np.maximum(0,rgb)**(1/2.4)-.055)
            dst[mask]=zval[mask]
            dest=canvas[lo[1]:hi[1]+1,lo[0]:hi[0]+1]; dest[mask]=np.clip(rgb[mask]*255,0,255)
    return Image.fromarray(canvas.astype('uint8')).resize((560,560),Image.Resampling.LANCZOS)

names=['fox','peacock','boar','lava','siren','serpent','snow']
canvas=Image.new('RGB',(1800,1950),'#e9eef5'); draw=ImageDraw.Draw(canvas)
fontpath='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
font=ImageFont.truetype(fontpath,29); title=ImageFont.truetype(fontpath,43)
draw.text((900,62),'SNOWCUBE · SEVEN 3D TILES',fill='#20374d',font=title,anchor='mm')
for i,name in enumerate(names):
    im=render(load_glb(OUT/('tile_'+name+'.glb')))
    x=20+(i%3)*590; y=130+(i//3)*590
    canvas.paste(im,(x,y)); draw.text((x+280,y+535),name.upper() if name!='snow' else 'SNOW / ICE',fill='#20374d',font=font,anchor='mm')
draw.multiline_text((710,1540),'Actual exported mesh preview\n\n7 individual GLBs + combined set\nSeparate parts and PBR materials',fill='#385069',font=font,spacing=15)
canvas.save(OUT/'tile-models-preview.png')
print('Validated and rendered all 7 exported GLB files.')
