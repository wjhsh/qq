"""Offline integrity checks for this research artifact; does not contact production."""
import collections
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT=Path(__file__).resolve().parent
REPO=next(p for p in ROOT.parents if (p/'qq-agent').is_dir())
cases=[json.loads(line) for line in (ROOT/'cases.jsonl').read_text(encoding='utf-8').splitlines()]
sources=json.loads((ROOT/'sources.json').read_text(encoding='utf-8'))
schema=json.loads((ROOT/'schema.json').read_text(encoding='utf-8'))
stats=json.loads((ROOT/'statistics.json').read_text(encoding='utf-8'))
assert len({c['id'] for c in cases})==len(cases)
assert len({s['id'] for s in sources})==len(sources)
source_ids={s['id'] for s in sources}
cached={}
for c in cases:
    assert set(c)==set(schema['required']),c['id']
    assert re.fullmatch(schema['properties']['id']['pattern'],c['id'])
    assert c['source_id'] in source_ids
    assert c['evidence_type'] in schema['properties']['evidence_type']['enum']
    assert c['excerpt_mode'] in schema['properties']['excerpt_mode']['enum']
    assert type(c['intensity']) is int and 0<=c['intensity']<=3
    assert c['training_eligible'] is False
    assert urlsplit(c['source_url']).scheme=='https'
    for field in schema['required']:
        if schema['properties'].get(field,{}).get('type')=='string':
            assert isinstance(c[field],str) and c[field].strip(),(c['id'],field)
    if c['evidence_type']=='project_chat_text':
        loc=c['locator']; path=REPO/loc['path']
        if path not in cached: cached[path]=path.read_text(encoding='utf-8').splitlines()
        lines=cached[path]; i=loc['line']-1
        assert lines[i].startswith('### ['+loc['message_id']+']'),c['id']
        end=next((j for j in range(i+1,len(lines)) if lines[j].startswith('### [')),len(lines))
        block='\n'.join(lines[i:end])
        assert c['excerpt'] in block,c['id']
        assert len(c['excerpt'])<=60
        assert unquote(urlsplit(c['source_url']).path).endswith(loc['path'])
        assert urlsplit(c['source_url']).fragment=='L'+str(loc['line'])
        assert '83f9e4f48d600fdc397817b66c2f319ee2060416' in c['source_url']

assert stats['cases']==len(cases) and stats['sources']==len(sources)
assert stats['verdicts']==dict(collections.Counter(c['verdict'] for c in cases))
assert stats['evidence']==dict(collections.Counter(c['evidence_type'] for c in cases))
assert stats['digest_format']=='UTF-8 with LF newlines'
assert stats['case_sha256']==hashlib.sha256((ROOT/'cases.jsonl').read_text(encoding='utf-8').encode('utf-8')).hexdigest()
assert stats['production_modified'] is False

# Pattern scan is a publication aid, not a complete privacy or rights audit.
sensitive=[r'(?<!\d)1[3-9]\d{9}(?!\d)',r'(?i)Bearer\s+[A-Za-z0-9._~-]{15,}',
           r'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----',r'gh[pousr]_[A-Za-z0-9]{20,}',
           r'(?i)(?:refresh_token|access_token|api_key)\s*[=:]\s*[\"\x27][^\"\x27]{12,}']
for file in ROOT.iterdir():
    if file.suffix not in {'.md','.json','.jsonl'}:continue
    text=file.read_text(encoding='utf-8')
    for pattern in sensitive:assert not re.search(pattern,text),(file.name,'possible sensitive string')
    if file.suffix=='.md':
        for link in re.findall(r'\]\(([^)]+)\)',text):
            if link.startswith(('http:','https:','#')):continue
            assert (file.parent/unquote(link.split('#')[0])).exists(),(file.name,link)

print(json.dumps({'ok':True,'cases':len(cases),'sources':len(sources),
                  'verified_chat_excerpts':sum(c['source_id']=='S01' for c in cases),
                  'external_semantic_review':'manual; network availability not re-tested',
                  'production_contacted':False},ensure_ascii=False))
