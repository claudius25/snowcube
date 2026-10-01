"""Editable seven-tile asset generator. Python 3 + numpy, Pillow.
Run: python build_tiles.py. Shapes are manually drawn, not image-to-mesh scans.
Authoring plane XY, height Z; GLB export converts to standard Y-up.
"""
from pathlib import Path
import json, struct, math, io, zipfile
import numpy as np
from PIL import Image

OUT=Path(__file__).resolve().parent
MESHES=[]; MATERIALS=[]

def mat(name, color, roughness=.36, metallic=0):
    rgb=[int(color[i:i+2],16)/255 for i in (0,2,4)]
    # glTF factors use linear RGB
    linear=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb]
    MATERIALS.append(dict(name=name,pbrMetallicRoughness=dict(baseColorFactor=linear+[1],metallicFactor=metallic,roughnessFactor=roughness)))
    return len(MATERIALS)-1

def area(p):
    return .5*np.sum(p[:,0]*np.roll(p[:,1],-1)-p[:,1]*np.roll(p[:,0],-1))

def cross(a,b): return a[0]*b[1]-a[1]*b[0]

def triangulate(p):
    ids=list(range(len(p))); faces=[]
    while len(ids)>3:
        found=False
        for j in range(len(ids)):
            a,b,c=ids[j-1],ids[j],ids[(j+1)%len(ids)]
            if cross(p[b]-p[a],p[c]-p[b])<=1e-10: continue
            inside=False
            for k in ids:
                if k in (a,b,c): continue
                q=p[k]
                if min(cross(p[b]-p[a],q-p[a]),cross(p[c]-p[b],q-p[b]),cross(p[a]-p[c],q-p[c]))>=-1e-10:
                    inside=True; break
            if not inside:
                faces.append((a,b,c)); ids.pop(j); found=True; break
        if not found: raise ValueError('Invalid polygon / failed triangulation')
    faces.append(tuple(ids)); return faces

def inset(p,d):
    result=[]
    for i,b in enumerate(p):
        a=p[i-1]; c=p[(i+1)%len(p)]
        u=(b-a)/np.linalg.norm(b-a); v=(c-b)/np.linalg.norm(c-b)
        n1=np.array([-u[1],u[0]]); n2=np.array([-v[1],v[0]])
        bis=n1+n2; result.append(b+d*bis/max(.2,1+np.dot(n1,n2)))
    return np.array(result)

def addmesh(name,verts,faces,material,tile):
    v=np.array(verts,float); f=np.array(faces,int)
    n=np.zeros_like(v)
    fn=np.cross(v[f[:,1]]-v[f[:,0]],v[f[:,2]]-v[f[:,0]])
    for i in range(3): np.add.at(n,f[:,i],fn)
    n/=np.maximum(np.linalg.norm(n,axis=1)[:,None],1e-12)
    assert np.isfinite(v).all() and np.isfinite(n).all()
    assert np.min(np.linalg.norm(fn,axis=1))>1e-12, name
    MESHES.append(dict(name=name,v=v,f=f,n=n,mat=material,tile=tile))

def extrude(name,p,z0,z1,material,tile,bevel=.009):
    p=np.array(p,float)
    if area(p)<0: p=p[::-1]
    n=len(p); b=min(bevel,(z1-z0)/2.2)
    levels=[(b,z0),(.293*b,z0+.293*b),(0,z0+b),(0,z1-b),(.293*b,z1-.293*b),(b,z1)]
    verts=[]
    for d,z in levels: verts.extend([(x,y,z) for x,y in inset(p,d)])
    faces=[]
    for k in range(len(levels)-1):
        for i in range(n):
            j=(i+1)%n; a=k*n+i; c=(k+1)*n+j
            faces.extend([(a,k*n+j,c),(a,c,(k+1)*n+i)])
    # Duplicate cap vertices for truly flat normals.
    for z,reverse in [(z0,True),(z1,False)]:
        cap=inset(p,b); off=len(verts); verts.extend([(x,y,z) for x,y in cap])
        for face in triangulate(cap): faces.append(tuple(off+i for i in (face[::-1] if reverse else face)))
    addmesh(name,verts,faces,material,tile)

def rr(w,h,r,steps=10):
    p=[]
    for cx,cy,start in [(w/2-r,h/2-r,0),(-w/2+r,h/2-r,90),(-w/2+r,-h/2+r,180),(w/2-r,-h/2+r,270)]:
        for a in np.linspace(start,start+90,steps,endpoint=False):
            a=math.radians(a); p.append((cx+r*math.cos(a),cy+r*math.sin(a)))
    return np.array(p)

def ellipse(cx,cy,rx,ry,n=48):
    return [(cx+rx*math.cos(t),cy+ry*math.sin(t)) for t in np.linspace(0,2*math.pi,n,endpoint=False)]

def path(start,segments,steps=9):
    p=[start]; current=np.array(start,float)
    for s in segments:
        if len(s)==2: p.append(s); current=np.array(s,float); continue
        a,b,c=np.array(s).reshape(3,2)
        for t in np.linspace(0,1,steps+1)[1:]: p.append((1-t)**3*current+3*(1-t)**2*t*a+3*(1-t)*t*t*b+t**3*c)
        current=c
    if np.linalg.norm(np.array(p[-1])-p[0])<1e-8: p.pop()
    return p

def rim(tile,material):
    verts=[]; faces=[]
    # Closed cross section: rounded outer wall, top lip, inner wall, bottom.
    profile=[(1,.115,.105), (1,.115,.230),(.991,.110,.245),(.970,.103,.253),
             (.838,.090,.253),(.821,.084,.246),(.812,.080,.232),(.812,.080,.156),
             (.835,.085,.146),(.970,.103,.146)]
    for w,r,z in profile: verts.extend([(x,y,z) for x,y in rr(w,w,r)])
    n=40
    for k in range(len(profile)):
        l=(k+1)%len(profile)
        for i in range(n):
            j=(i+1)%n; faces.extend([(k*n+i,k*n+j,l*n+j),(k*n+i,l*n+j,l*n+i)])
    addmesh(tile+'_rounded_rim',verts,faces,material,tile)

COLORS=[('fox','F5B919'),('peacock','9228DD'),('boar','F47713'),('lava','EA263C'),('siren','149FD5'),('serpent','27AE3F')]
for name,color in COLORS:
    base=mat(name+'_base',color,.32)
    rgb=np.array([int(color[i:i+2],16) for i in (0,2,4)])
    highlight=''.join(f'{int(x):02x}' for x in np.minimum(255,rgb*.82+46))
    relief=mat(name+'_relief',highlight,.30)
    floor=mat(name+'_recess',''.join(f'{int(x):02x}' for x in rgb*.79),.43)
    extrude(name+'_base',rr(.996,.996,.113),0,.155,base,name,.018)
    extrude(name+'_recess',rr(.84,.84,.09),.144,.165,floor,name,.006)
    rim(name,base)
    def symbol(part,p,z0=.163,z1=.229,b=.008,material=relief): extrude(name+'_'+part,p,z0,z1,material,name,b)
    if name=='fox':
        p=[(-.30,.29),(-.14,.20),(0,.235),(.14,.20),(.30,.29),(.255,.025),(0,-.29),(-.255,.025)]
        symbol('head',p)
        symbol('muzzle_left',[(-.245,.01),(-.17,.045),(-.08,-.025),(0,-.262),(-.13,-.12)],.224,.242,.004)
        symbol('muzzle_right',[(.245,.01),(.17,.045),(.08,-.025),(0,-.262),(.13,-.12)],.224,.242,.004)
    elif name=='peacock':
        # Fan merged into one single scalloped outline.
        p=path((-.25,-.12),[(-.39,.01,-.35,.12,-.25,.15),(-.29,.29,-.15,.34,-.08,.27),(-.04,.40,.10,.40,.14,.27),(.28,.34,.37,.22,.29,.13),(.43,.06,.34,-.08,.23,-.12),(-.25,-.12)])
        symbol('fan',p,.164,.204)
        p=path((-.075,-.27),[(-.22,-.17,-.12,-.055,-.03,.0),(.0,.05,-.03,.16,.04,.20),(.11,.25,.18,.18,.16,.14),(.225,.115),(.155,.095),(.10,.11,.09,.07,.085,.015),(.08,-.04,.18,-.11,.14,-.20),(.11,-.30,-.015,-.32,-.075,-.27)])
        symbol('body',p,.200,.245)
    elif name=='boar':
        p=path((-.23,.04),[(-.28,.15,-.27,.27,-.27,.31),(-.14,.23),(-.07,.26,.07,.26,.14,.23),(.27,.31),(.27,.15,.29,.08,.23,-.03),(.18,-.22,-.18,-.22,-.23,.04)])
        symbol('head',p)
        tusk=mat('boar_tusks','FFE1A0',.3)
        for side in [-1,1]:
            p=path((.115,-.17),[(.24,-.14,.25,-.04,.21,.07),(.19,-.04,.15,-.06,.10,-.07),(.115,-.17)])
            symbol('tusk_'+str(side),[(side*x,y) for x,y in p],.226,.262,.005,tusk)
        symbol('snout',ellipse(0,-.135,.135,.104),.229,.281,.008)
        nostril=mat('boar_nostril_inlay','8E3709',.6)
        # Deliberately shallow dark inlays; no costly boolean holes.
        for x in [-.049,.049]: symbol('nostril_'+str(x),ellipse(x,-.128,.021,.034,24),.279,.282,.001,nostril)
    elif name=='lava':
        p=path((0,-.32),[(-.31,-.18,-.29,.01,-.18,.15),(-.18,.015,-.10,-.025,-.075,.025),(.015,.15,-.055,.245,-.015,.335),(.15,.24,.16,.10,.105,.04),(.20,.065,.22,.12,.23,.16),(.35,-.045,.25,-.20,0,-.32)])
        symbol('flame',p,.164,.236,.010)
    elif name=='siren':
        # Flowing hair and a single connected simplified mermaid silhouette.
        hair=path((-.02,.14),[(-.10,.10,-.22,.13,-.34,.05),(-.31,.21,-.19,.19,-.14,.29),(-.06,.40,.08,.35,.10,.27),(.04,.23,.02,.15,-.02,.14)])
        symbol('hair',hair,.164,.211,.007)
        body=path((.03,.27),[(.08,.30,.13,.25,.115,.215),(.15,.195),(.115,.18),(.115,.13,.075,.13,.065,.115),(.08,.05,.14,.005,.23,-.02),(.24,-.06,.18,-.06,.12,-.025),(.12,-.12,.20,-.17,.11,-.25),(-.005,-.36,-.21,-.28,-.20,-.145),(-.29,-.12,-.29,-.05,-.30,-.01),(-.18,-.025,-.115,-.08,-.15,-.14),(-.145,-.23,-.04,-.24,.01,-.18),(.07,-.115,-.025,-.085,-.025,-.005),(-.08,-.045,-.16,-.045,-.18,-.005),(-.10,-.012,-.06,.055,-.035,.10),(-.01,.135,.02,.14,.015,.18),(-.01,.205,.0,.25,.03,.27)])
        symbol('silhouette',body,.165,.235,.006)
    elif name=='serpent':
        p=path((.23,.19),[(.17,.34,-.015,.35,-.12,.27),(-.29,.12,-.13,.015,.01,-.04),(.18,-.105,.10,-.19,-.005,-.185),(-.12,-.18,-.12,-.085,-.215,-.11),(-.30,-.145,-.235,-.27,-.12,-.30),(.075,-.365,.30,-.23,.235,-.08),(.19,.03,.045,.06,-.02,.105),(-.09,.15,-.035,.195,.02,.18),(.08,.125,.175,.12,.23,.19)])
        symbol('snake',p,.164,.237,.011)

ice=mat('ice_blue_gloss','77BBDD',.18,.03)
snow=mat('snow_frost','EEF7FF',.74)
extrude('snow_ice_base',rr(1,1,.105),0,.197,ice,'snow',.025)
extrude('snow_frost_cap',rr(1.004,1.004,.125),.168,.273,snow,'snow',.033)

# Seamless procedural frost maps, embedded into GLB and also provided as PNGs.
rng=np.random.default_rng(17); size=256
noise=rng.random((size,size)); grain=np.clip(.94+.06*noise,0,1)
tex=np.empty((size,size,4),np.uint8)
tex[:,:,:3]=np.uint8(grain[:,:,None]*np.array([244,250,255])); tex[:,:,3]=255
im=Image.fromarray(tex); buf=io.BytesIO(); im.save(buf,format='PNG'); frost_png=buf.getvalue(); (OUT/'snow_frost_basecolor.png').write_bytes(frost_png)
MATERIALS[snow]['pbrMetallicRoughness']['baseColorFactor']=[1,1,1,1]
MATERIALS[snow]['pbrMetallicRoughness']['baseColorTexture']={'index':0}

def glb(filename,meshes,layout=False):
    blob=bytearray(); views=[]; acc=[]
    def view(data,target=None):
        while len(blob)%4: blob.append(0)
        idx=len(views); v=dict(buffer=0,byteOffset=len(blob),byteLength=len(data))
        if target: v['target']=target
        views.append(v); blob.extend(data); return idx
    def accessor(a,typ,ctype,target):
        i=view(a.tobytes(),target); d=dict(bufferView=i,componentType=ctype,count=len(a),type=typ)
        if typ=='VEC3': d.update(min=a.min(axis=0).tolist(),max=a.max(axis=0).tolist())
        acc.append(d); return len(acc)-1
    gm=[]; nodes=[]; roots=[]
    tiles=list(dict.fromkeys(m['tile'] for m in meshes))
    offsets={t:((i%3-1)*1.28,0,-(1-i//3)*1.28) for i,t in enumerate(tiles)}
    for t in tiles:
        root=len(nodes); roots.append(root); nodes.append(dict(name='tile_'+t,children=[]))
        if layout: nodes[root]['translation']=list(offsets[t])
        for m in [m for m in meshes if m['tile']==t]:
            v=m['v'][:,[0,2,1]].copy(); v[:,2]*=-1
            n=m['n'][:,[0,2,1]].copy(); n[:,2]*=-1
            uv=np.array(m['v'][:,:2]+.5,dtype='<f4')
            pos=accessor(v.astype('<f4'),'VEC3',5126,34962)
            norm=accessor(n.astype('<f4'),'VEC3',5126,34962)
            uvacc=accessor(uv,'VEC2',5126,34962)
            idx=accessor(m['f'].astype('<u4').reshape(-1),'SCALAR',5125,34963)
            mi=len(gm); gm.append(dict(name=m['name'],primitives=[dict(attributes={'POSITION':pos,'NORMAL':norm,'TEXCOORD_0':uvacc},indices=idx,material=m['mat'])]))
            nodes[root]['children'].append(len(nodes)); nodes.append(dict(name=m['name'],mesh=mi))
    iv=view(frost_png)
    doc=dict(asset={'version':'2.0','generator':'Snowcube procedural tile kit'},scene=0,scenes=[{'nodes':roots}],nodes=nodes,meshes=gm,materials=MATERIALS,accessors=acc,bufferViews=views,buffers=[{'byteLength':len(blob)}],images=[{'bufferView':iv,'mimeType':'image/png','name':'snow_frost'}],textures=[{'source':0}])
    while len(blob)%4: blob.append(0)
    js=json.dumps(doc,separators=(',',':')).encode()
    js+=b' '*((-len(js))%4)
    data=struct.pack('<III',0x46546c67,2,12+8+len(js)+8+len(blob))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(blob),0x004e4942)+blob
    (OUT/filename).write_bytes(data)

for t in [n for n,c in COLORS]+['snow']: glb('tile_'+t+'.glb',[m for m in MESHES if m['tile']==t])
glb('all-seven-tiles.glb',MESHES,True)

# Portable OBJ/MTL fallback with the same editable mesh parts (Y-up).
with (OUT/'all-seven-tiles.obj').open('w') as f:
    f.write('mtllib all-seven-tiles.mtl\n'); count=1
    tiles=[n for n,c in COLORS]+['snow']
    for m in MESHES:
        i=tiles.index(m['tile']); off=np.array([(i%3-1)*1.28,0,-(1-i//3)*1.28])
        v=m['v'][:,[0,2,1]].copy(); v[:,2]*=-1; v+=off
        f.write('o '+m['name']+'\nusemtl '+MATERIALS[m['mat']]['name']+'\n')
        for x,y,z in v: f.write(f'v {x:.6f} {y:.6f} {z:.6f}\n')
        for a,b,c in m['f']: f.write(f'f {a+count} {b+count} {c+count}\n')
        count+=len(v)
with (OUT/'all-seven-tiles.mtl').open('w') as f:
    for m in MATERIALS:
        f.write('newmtl '+m['name']+'\nKd '+' '.join(map(str,m['pbrMetallicRoughness']['baseColorFactor'][:3]))+'\nNs 50\n\n')

stats={t:{'parts':sum(m['tile']==t for m in MESHES),'triangles':sum(len(m['f']) for m in MESHES if m['tile']==t)} for t in [n for n,c in COLORS]+['snow']}
(OUT/'mesh-stats.json').write_text(json.dumps(stats,indent=2))

if (OUT/'render_preview.py').exists():
    import subprocess, sys
    subprocess.run([sys.executable,str(OUT/'render_preview.py')],check=True)
print(json.dumps(stats,indent=2))
