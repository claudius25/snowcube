from pathlib import Path
import json,struct,math
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
import cadquery as cq
import vtk
from vtk.util.numpy_support import vtk_to_numpy
ROOT=Path(__file__).resolve().parent
T=ROOT/'textures';T.mkdir(exist_ok=True)
rng=np.random.default_rng(49); N=1024
noise=gaussian_filter(rng.random((N,N)),2,mode='wrap'); noise=(noise-noise.min())/(noise.max()-noise.min())
frost=gaussian_filter((rng.random((N,N))>.994).astype(float),.55,mode='wrap');frost/=frost.max()
def save(name,a): Image.fromarray(np.uint8(np.clip(a,0,1)*255)).save(T/name)
ice=np.clip(np.array([.79,.89,1])[None,None,:]+noise[:,:,None]*.14+frost[:,:,None]*.2,0,1)
save('ice_basecolor.png',ice)
rough=np.clip(.23+.16*noise-.09*frost,.12,.46);save('ice_roughness.png',rough)
save('ice_orm.png',np.stack([np.ones_like(rough),rough,np.zeros_like(rough)],-1))
def normal(height,strength):
 dy,dx=np.gradient(height); n=np.stack([-dx*strength,-dy*strength,np.ones_like(dx)],-1);n/=np.linalg.norm(n,axis=-1,keepdims=True);return n*.5+.5
save('ice_normal.png',normal(noise*.08+frost*.12,2.5))
pr=np.clip(.16+.045*noise,.13,.23);save('panel_roughness.png',pr);save('panel_orm.png',np.stack([np.ones_like(pr),pr,np.zeros_like(pr)],-1));save('panel_normal.png',normal(noise*.005+frost*.007,1))
colors={'orange':(1,.43,.018),'yellow':(1,.80,.01),'red':(.96,.013,.10),'green':(.24,.92,.009),'blue':(.018,.36,1),'purple':(.51,.018,.95)}
for name,c in colors.items():save(name+'_basecolor.png',np.clip(np.array(c)[None,None,:]*(.96+.04*noise[:,:,None])+frost[:,:,None]*.025,0,1))
frame=cq.Workplane('XY').box(2,2,2)
for d in [(3,1.54,1.54),(1.54,3,1.54),(1.54,1.54,3)]:frame=frame.cut(cq.Workplane('XY').box(*d))
frame=frame.edges().fillet(.085)
panel=cq.Workplane('XY').box(1.26,1.26,.12).edges('|Z').fillet(.16).edges('not |Z').fillet(.045)
parts=[('Ice_Frame',frame,'ice'),('Panel_Orange_Top',panel.translate((0,0,.92)),'orange'),('Panel_Purple_Bottom',panel.translate((0,0,-.92)),'purple'),('Panel_Yellow_Front',panel.rotate((0,0,0),(1,0,0),90).translate((0,-.92,0)),'yellow'),('Panel_Blue_Back',panel.rotate((0,0,0),(1,0,0),90).translate((0,.92,0)),'blue'),('Panel_Red_Right',panel.rotate((0,0,0),(0,1,0),90).translate((.92,0,0)),'red'),('Panel_Green_Left',panel.rotate((0,0,0),(0,1,0),90).translate((-.92,0,0)),'green')]
assembly=cq.Assembly(name='Snowcube')
meshes=[]
for name,obj,mat in parts:
 assert obj.val().isValid()
 assembly.add(obj,name=name)
 verts,faces=obj.val().tessellate(.008,.12)
 v=np.array([x.toTuple() for x in verts]); f=np.array(faces)
 points=vtk.vtkPoints()
 for p in v:points.InsertNextPoint(*p)
 cells=vtk.vtkCellArray()
 for face in f:
  cells.InsertNextCell(3)
  for i in face:cells.InsertCellPoint(int(i))
 pd=vtk.vtkPolyData();pd.SetPoints(points);pd.SetPolys(cells)
 clean=vtk.vtkCleanPolyData();clean.SetInputData(pd);clean.SetTolerance(1e-6);clean.Update()
 normals=vtk.vtkPolyDataNormals();normals.SetInputConnection(clean.GetOutputPort());normals.SplittingOff();normals.ConsistencyOn();normals.AutoOrientNormalsOn();normals.Update()
 out=normals.GetOutput();v=vtk_to_numpy(out.GetPoints().GetData()).astype(float);n=vtk_to_numpy(out.GetPointData().GetNormals()).astype(float);f=vtk_to_numpy(out.GetPolys().GetData()).reshape(-1,4)[:,1:]
 # Separate each triangle's UVs for box projection; retain smooth normals.
 vv=v[f].reshape(-1,3); nn=n[f].reshape(-1,3)
 axes=np.abs(n[f].mean(1)).argmax(1)
 uv=[]
 for face,axis in zip(v[f],axes):
  dims=[[1,2],[0,2],[0,1]][axis];uv.extend(face[:,dims]*.75+.5)
 uv=np.array(uv);ff=np.arange(len(vv)).reshape(-1,3)
 meshes.append(dict(name=name,mat=mat,v=vv,n=nn,uv=uv,f=ff))
assembly.save(str(ROOT/'snowcube.step'))
# Build portable glTF 2.0 with embedded PBR maps, Y up.
g={'asset':{'version':'2.0','generator':'Snowcube CAD / PBR builder'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'name':'Snowcube','children':list(range(1,8))}],'meshes':[],'materials':[],'buffers':[],'bufferViews':[],'accessors':[],'images':[],'textures':[],'samplers':[{'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497}],'extensionsUsed':['KHR_materials_clearcoat']};buf=bytearray()
def add_bytes(data,target=None):
 while len(buf)%4:buf.append(0)
 idx=len(g['bufferViews']);entry={'buffer':0,'byteOffset':len(buf),'byteLength':len(data)}
 if target:entry['target']=target
 g['bufferViews'].append(entry);buf.extend(data);return idx
def accessor(a,kind,component):
 a=np.ascontiguousarray(a,dtype='<f4' if component==5126 else '<u4');view=add_bytes(a.tobytes(),34963 if kind=='SCALAR' else 34962);entry={'bufferView':view,'componentType':component,'count':len(a),'type':kind}
 if kind=='VEC3':entry.update(min=a.min(0).tolist(),max=a.max(0).tolist())
 g['accessors'].append(entry);return len(g['accessors'])-1
texcache={}
def texture(fn):
 if fn in texcache:return texcache[fn]
 bv=add_bytes((T/fn).read_bytes());i=len(g['images']);g['images'].append({'name':fn,'bufferView':bv,'mimeType':'image/png'});idx=len(g['textures']);g['textures'].append({'source':i,'sampler':0});texcache[fn]=idx;return idx
matidx={}
for mat in ['ice']+list(colors):
 matidx[mat]=len(g['materials']);prefix='ice' if mat=='ice' else 'panel'
 g['materials'].append({'name':'Icy_Glossy_Frame' if mat=='ice' else 'Glossy_'+mat.title(),'pbrMetallicRoughness':{'baseColorTexture':{'index':texture(mat+'_basecolor.png')},'metallicFactor':0,'roughnessFactor':1,'metallicRoughnessTexture':{'index':texture(prefix+'_orm.png')}},'normalTexture':{'index':texture(prefix+'_normal.png'),'scale':.45 if mat=='ice' else .18},'extensions':{'KHR_materials_clearcoat':{'clearcoatFactor':.5 if mat=='ice' else .9,'clearcoatRoughnessFactor':.12 if mat=='ice' else .08}}})
for mesh in meshes:
 v=mesh['v'][:,[0,2,1]].copy();v[:,2]*=-1;n=mesh['n'][:,[0,2,1]].copy();n[:,2]*=-1
 attrs={'POSITION':accessor(v,'VEC3',5126),'NORMAL':accessor(n,'VEC3',5126),'TEXCOORD_0':accessor(mesh['uv'],'VEC2',5126)}
 mi=len(g['meshes']);g['meshes'].append({'name':mesh['name'],'primitives':[{'attributes':attrs,'indices':accessor(mesh['f'].flatten(),'SCALAR',5125),'material':matidx[mesh['mat']]}]});g['nodes'].append({'name':mesh['name'],'mesh':mi})
while len(buf)%4:buf.append(0)
g['buffers']=[{'byteLength':len(buf)}];js=json.dumps(g,separators=(',',':')).encode();js+=b' '*((-len(js))%4)
(ROOT/'snowcube.glb').write_bytes(struct.pack('<III',0x46546c67,2,28+len(js)+len(buf))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(buf),0x004e4942)+buf)
# Textured OBJ fallback, in native CAD Z-up coordinates.
with (ROOT/'snowcube.obj').open('w') as o:
 o.write('mtllib snowcube.mtl\n');offset=1
 for m in meshes:
  o.write('o '+m['name']+'\nusemtl '+m['mat']+'\n')
  for v in m['v']:o.write('v '+' '.join(map(str,v))+'\n')
  for uv in m['uv']:o.write('vt '+' '.join(map(str,uv))+'\n')
  for n in m['n']:o.write('vn '+' '.join(map(str,n))+'\n')
  for f in m['f']:o.write('f '+' '.join(f'{i+offset}/{i+offset}/{i+offset}' for i in f)+'\n')
  offset+=len(m['v'])
with (ROOT/'snowcube.mtl').open('w') as o:
 for mat in matidx:o.write(f'newmtl {mat}\nKd 1 1 1\nKs 0.8 0.8 0.8\nNs 160\nmap_Kd textures/{mat}_basecolor.png\n\n')
# Deterministic software rasterizer: preview the actual exported mesh.
def render(filename,eye):
 size=1000; eye=np.array(eye,float);eye/=np.linalg.norm(eye);right=np.cross([0,0,1],eye);right/=np.linalg.norm(right);up=np.cross(eye,right);rot=np.stack([right,up,eye]);scale=285
 Y,X=np.mgrid[:size,:size];rad=((X-450)**2+(Y-360)**2)/(size*size);image=np.zeros((size,size,3))+np.array([.025,.047,.095]);image+=np.exp(-rad*5)[:,:,None]*np.array([.025,.045,.08]);depth=np.full((size,size),-1e9)
 lights=[(np.array([-3,-4,7.]),.85),(np.array([4,-1,3.]),.6),(np.array([0,4,5.]),.7)]
 lights=[(l/np.linalg.norm(l),power) for l,power in lights]
 for m in meshes:
  v=m['v'];n=m['n'];p=v@rot.T;p[:,0]=p[:,0]*scale+size/2;p[:,1]=-p[:,1]*scale+size/2
  tex=np.array(Image.open(T/(m['mat']+'_basecolor.png')))/255
  for ids in m['f']:
   pts=p[ids];xmin=max(0,int(pts[:,0].min()));xmax=min(size-1,int(pts[:,0].max())+1);ymin=max(0,int(pts[:,1].min()));ymax=min(size-1,int(pts[:,1].max())+1)
   if xmin>xmax or ymin>ymax:continue
   a,b,c=pts;den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
   if abs(den)<1e-8:continue
   yy,xx=np.mgrid[ymin:ymax+1,xmin:xmax+1];w0=((b[1]-c[1])*(xx-c[0])+(c[0]-b[0])*(yy-c[1]))/den;w1=((c[1]-a[1])*(xx-c[0])+(a[0]-c[0])*(yy-c[1]))/den;w2=1-w0-w1;z=w0*a[2]+w1*b[2]+w2*c[2]
   mask=(w0>=-1e-5)&(w1>=-1e-5)&(w2>=-1e-5)&(z>depth[ymin:ymax+1,xmin:xmax+1])
   if not mask.any():continue
   weights=np.stack([w0[mask],w1[mask],w2[mask]],-1);norm=weights@n[ids];norm/=np.linalg.norm(norm,axis=1,keepdims=True);uv=(weights@m['uv'][ids])%1;rgb=tex[(uv[:,1]*1023).astype(int),(uv[:,0]*1023).astype(int)]
   # Linear-light shading and compact studio specular lobes.
   base=rgb**2.2;diff=np.full(len(rgb),.20);spec=np.zeros(len(rgb))
   for l,power in lights:
    diff+=np.maximum(0,norm@l)*power*.6;h=l+eye;h/=np.linalg.norm(h);spec+=np.maximum(0,norm@h)**95*power*.7
   fres=(1-np.clip(norm@eye,0,1))**4*.12
   shaded=np.clip(base*diff[:,None]+spec[:,None]+fres[:,None],0,1)**(1/2.2)
   image[ymin:ymax+1,xmin:xmax+1][mask]=shaded;depth[ymin:ymax+1,xmin:xmax+1][mask]=z[mask]
 Image.fromarray(np.uint8(np.clip(image,0,1)*255)).save(ROOT/filename)
render('preview.png',(4,-6,4.6));render('preview-rear.png',(-4,6,4.6))
report={'parts':len(meshes),'triangles':sum(len(m['f']) for m in meshes),'frame_outer_size':2,'face_opening':1.54,'panel_width':1.26,'panel_thickness':.12,'gap_each_side':.14,'valid_solids':all(o.val().isValid() for _,o,_ in parts),'glb_bytes':(ROOT/'snowcube.glb').stat().st_size}
(ROOT/'validation.json').write_text(json.dumps(report,indent=2));print(report,flush=True)
