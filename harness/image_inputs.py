"""Bounded static reference images. Never accept paths or URLs from a caller."""
import base64,hashlib,io,json,re,warnings
from pathlib import Path
MAX_IMAGES=4
MAX_IMAGE_BYTES=5*1024*1024
MAX_TOTAL_BYTES=8*1024*1024
MIMES={'PNG':('image/png','.png'),'JPEG':('image/jpeg','.jpg'),'WEBP':('image/webp','.webp')}
class ImageInputError(ValueError):code='reference_image'

def inspect_image(data,mime):
 from PIL import Image
 if not isinstance(data,bytes) or not 1<=len(data)<=MAX_IMAGE_BYTES:raise ImageInputError('参考图片超过5MiB或内容为空')
 try:
  with warnings.catch_warnings():
   warnings.simplefilter('error',Image.DecompressionBombWarning)
   with Image.open(io.BytesIO(data)) as image:
    actual=MIMES.get(image.format);width,height=image.size
    if not actual or actual[0]!=mime or getattr(image,'n_frames',1)!=1 or not 1<=width<=16384 or not 1<=height<=16384 or width*height>24000000:raise ValueError()
    image.verify()
 except Exception:raise ImageInputError('参考图片需为有效静态PNG/JPG/WebP，且不能超过2400万像素') from None
 return {'mime':mime,'width':width,'height':height,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'ext':actual[1]}

def decode_inputs(rows):
 if rows is None:return []
 if not isinstance(rows,list) or len(rows)>MAX_IMAGES:raise ImageInputError('一次最多上传4张参考图片')
 result=[];total=0
 for row in rows:
  if not isinstance(row,dict) or set(row)-{'base64','mime','sha256'} or not isinstance(row.get('base64'),str) or len(row['base64'])>4*((MAX_IMAGE_BYTES+2)//3):raise ImageInputError('参考图片参数无效')
  try:data=base64.b64decode(row['base64'],validate=True)
  except Exception:raise ImageInputError('参考图片编码无效') from None
  meta=inspect_image(data,row.get('mime'));total+=len(data)
  if total>MAX_TOTAL_BYTES:raise ImageInputError('参考图片总大小不能超过8MiB')
  if row.get('sha256')!=meta['sha256']:raise ImageInputError('参考图片校验失败')
  result.append({**meta,'buffer':data})
 return result

def load_manifest(manifest):
 if not manifest:return []
 path=Path(manifest)
 if path.is_symlink() or path.stat().st_size>8192:raise ValueError('参考图片清单无效')
 rows=json.loads(path.read_text())
 if not isinstance(rows,list) or len(rows)>MAX_IMAGES:raise ValueError('参考图片清单无效')
 result=[];total=0
 for index,row in enumerate(rows):
  filename=str(row.get('file',''))
  if not re.fullmatch(r'input-[0-3]\.(?:png|jpg|webp)',filename):raise ValueError('参考图片文件名无效')
  file=path.parent/'image-inputs'/filename
  if file.is_symlink() or file.stat().st_size>MAX_IMAGE_BYTES:raise ValueError('参考图片文件无效')
  data=file.read_bytes();meta=inspect_image(data,row.get('mime'));total+=len(data)
  if total>MAX_TOTAL_BYTES or meta['sha256']!=row.get('sha256'):raise ValueError('参考图片校验失败')
  result.append({**meta,'buffer':data,'file':filename})
 return result
