"""Materialize the pinned WorkBuddy runtime without credentials or service changes."""
import argparse
import hashlib
import io
import json
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
PROFILE=ROOT/'ops/workbuddy'


def hardened_proxy(data):
    text=data.decode('utf-8')
    begin=text.index('                # Panel degrade.go: a content rejection')
    end=text.index('                log("upstream 403 for',begin)
    return (text[:begin]+'                # Local policy: return content refusals unchanged; never rewrite and replay.\n'+text[end:]).encode('utf-8')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination',type=Path,required=True,help='A new directory; existing directories are never overwritten')
    parser.add_argument('--upstream',type=Path,help='Use an existing upstream checkout instead of downloading')
    args=parser.parse_args()
    lock=json.loads((PROFILE/'upstream-lock.json').read_text(encoding='utf-8'))
    destination=args.destination.resolve()
    if destination.exists():raise SystemExit('Destination already exists; choose a new directory')
    source=None
    if args.upstream:
        checkout=args.upstream.resolve()
        def load(name):return (checkout/name).read_bytes()
    else:
        revision=lock['revision']
        if len(revision)!=40 or any(c not in '0123456789abcdef' for c in revision):raise ValueError('Invalid revision')
        url='https://codeload.github.com/ardeyouxipianyi/workbuddy2api-hub/zip/'+revision
        with urllib.request.urlopen(url,timeout=45) as response:data=response.read(16*1024*1024+1)
        if len(data)>16*1024*1024:raise ValueError('Source archive is too large')
        source=zipfile.ZipFile(io.BytesIO(data))
        prefix='workbuddy2api-hub-'+revision+'/'
        def load(name):
            member=source.getinfo(prefix+name)
            if member.file_size>2*1024*1024:raise ValueError('Source member is too large')
            return source.read(member)
    destination.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='workbuddy-source-',dir=destination.parent) as directory:
        temporary=Path(directory)
        for name,expected in lock['files'].items():
            if Path(name).name!=name or name in ('.','..'):raise ValueError('Invalid locked filename')
            data=(PROFILE/name).read_bytes() if name=='guarded_gateway.py' else load(name)
            if name=='wb_proxy.py':data=hardened_proxy(data)
            if hashlib.sha256(data).hexdigest()!=expected:raise ValueError('Pinned source hash mismatch: '+name)
            (temporary/name).write_bytes(data)
        (temporary/'manifest.json').write_text(json.dumps(lock,indent=2),encoding='utf-8')
        # All names and digests have been verified before the result appears.
        temporary.replace(destination)
    if source is not None:source.close()
    print(json.dumps({'revision':lock['revision'],'verifiedFiles':len(lock['files']),'credentialsIncluded':False,'serviceInstalled':False}))


if __name__=='__main__':main()
