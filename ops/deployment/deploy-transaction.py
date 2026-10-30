#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qq-agent 部署事务脚本（apply / rollback）。仅供领队审查，未执行。
用法:
  deploy.py apply    /var/lib/qq-deploy/staging/<release_id>
  deploy.py rollback /var/lib/qq-deploy/backups/<release_id>
默认离线；直连 127.0.0.1 控制 API；配置/密钥仅内存；stdout 无敏感原文/路径。
"""
import os, sys, json, hashlib, subprocess, shutil, stat, tempfile, urllib.request

ROOT = "/opt/codex-qq/QQ-agent"
CFG = "/var/lib/qq-agent/config.json"
DEPLOY_ROOT = "/var/lib/qq-deploy"
STAGING_ROOT = os.path.join(DEPLOY_ROOT, "staging")
BACKUP_ROOT = os.path.join(DEPLOY_ROOT, "backups")
SERVICE = "qq-agent"
ALLOWED_SKILL_FILES = ("index.js", "skill.json")
STATE_FILES = ("meme-library.json", "social-state.json")
WRITTEN = {"socialBehavior.enabled": True,
           "socialBehavior.allowDirectPeers": False,
           "voice.provider": "edge"}


class DeployError(Exception):
    pass


def out(stage, ok=True, **kw):
    rec = {"stage": stage, "ok": ok}
    rec.update(kw)
    sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(stage, code=1):
    out(stage, ok=False)
    sys.exit(code)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(65536), b""):
            h.update(c)
    return h.hexdigest()


def sha256_norm(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read().replace(b"\r\n", b"\n")).hexdigest()


def under(base, target):
    b = os.path.realpath(base); t = os.path.realpath(target)
    return t == b or t.startswith(b + os.sep)


def safe_rel(rel):
    if not isinstance(rel, str) or not rel or rel.startswith("/") or "\\" in rel:
        return False
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return False
    if parts[0] == "src":
        return len(parts) >= 2 and parts[-1].endswith((".js", ".mjs"))
    if parts[0] == "skills" and len(parts) == 3 and parts[1] == "local-voice":
        return parts[2] in ALLOWED_SKILL_FILES
    if parts == ["knowledge", "humor-mechanisms-v1.json"]:
        return True
    return False


def no_symlink(path, base):
    if os.path.islink(base):
        return False
    cur = base
    for part in os.path.relpath(path, base).split(os.sep):
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            return False
    return True


def check_no_symlink_dir(p):
    current=os.path.abspath(p)
    while True:
        if os.path.islink(current):raise DeployError('root-symlink')
        parent=os.path.dirname(current)
        if parent==current:break
        current=parent
    if not os.path.isdir(p):raise DeployError('missing-root')


def atomic_write(path, data, mode, uid, gid):
    fd, tmp = tempfile.mkstemp(prefix=".dep-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.chmod(tmp, mode); os.chown(tmp, uid, gid)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_json(p):
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def read_cfg():
    return load_json(CFG)


def http_status(cfg):
    srv = cfg.get("server", {}) if isinstance(cfg, dict) else {}
    port = int(srv.get("port", 3210)); token = srv.get("token", "")
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request("http://127.0.0.1:%d/api/status" % port,
                                 headers={"x-console-token": token})
    with op.open(req, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


def status_idle(st):
    if not isinstance(st, dict) or st.get("paused") is not True:
        return False
    o = st.get("orchestrator", {})
    if not isinstance(o, dict):
        return False
    for k in ("running", "waiting", "activeSessions"):
        if not isinstance(o.get(k), list) or o.get(k):
            return False
    return True


def svc_active():
    r = subprocess.run(["systemctl", "is-active", SERVICE], capture_output=True, text=True)
    return r.returncode == 0 and r.stdout.strip() == "active"


def svc_stop():
    subprocess.run(["systemctl", "stop", SERVICE], check=True)


def svc_start():
    subprocess.run(["systemctl", "start", SERVICE], check=True)


def node_check(paths):
    for p in paths:
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
        if r.returncode != 0:
            raise DeployError("node-check-failed")


def file_meta(p):
    st = os.stat(p)
    return {"mode": stat.S_IMODE(st.st_mode), "uid": st.st_uid, "gid": st.st_gid}


def three_now(cfg):
    sb = cfg.get("socialBehavior") if isinstance(cfg, dict) else None
    v = cfg.get("voice") if isinstance(cfg, dict) else None
    res = {}
    res["socialBehavior.enabled"] = (sb.get("enabled") if isinstance(sb, dict) else None,
                                     "socialBehavior" in cfg and "enabled" in sb if isinstance(sb, dict) else False)
    res["socialBehavior.allowDirectPeers"] = (sb.get("allowDirectPeers") if isinstance(sb, dict) else None,
                                             "allowDirectPeers" in sb if isinstance(sb, dict) else False)
    res["voice.provider"] = (v.get("provider") if isinstance(v, dict) else None,
                             "provider" in v if isinstance(v, dict) else False)
    return res


def three_before_export(cfg):
    """返回 {key: {present, value}}。"""
    sb = cfg.get("socialBehavior") if isinstance(cfg, dict) else None
    v = cfg.get("voice") if isinstance(cfg, dict) else None
    def g(sec, name):
        if isinstance(sec, dict) and name in sec:
            return {"present": True, "value": sec[name]}
        return {"present": False, "value": None}
    return {
        "socialBehavior.enabled": g(sb, "enabled"),
        "socialBehavior.allowDirectPeers": g(sb, "allowDirectPeers"),
        "voice.provider": g(v, "provider"),
    }


def patch_cfg(cfg):
    o = json.loads(json.dumps(cfg))
    o.setdefault("socialBehavior", {})["enabled"] = True
    o["socialBehavior"]["allowDirectPeers"] = False
    o.setdefault("voice", {})["provider"] = "edge"
    return o


def restore_three(before, cfg, section_presence=None):
    """按 before（present/value）恢复三项；空 section 移除。类型敏感比较由调用方处理。"""
    o = json.loads(json.dumps(cfg))
    secs = (("socialBehavior", "enabled", "socialBehavior.enabled"),
            ("socialBehavior", "allowDirectPeers", "socialBehavior.allowDirectPeers"),
            ("voice", "provider", "voice.provider"))
    for sec, name, key in secs:
        b = before.get(key, {"present": False, "value": None})
        if b.get("present"):
            o.setdefault(sec, {})[name] = b["value"]
        else:
            if isinstance(o.get(sec), dict):
                o[sec].pop(name, None)
                if not o[sec] and (section_presence or {}).get(sec) is False:
                    o.pop(sec, None)
    return o


def type_eq(a, b):
    return type(a) is type(b) and a == b


def verify_manifest(manifest, staging):
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise DeployError("manifest-files-invalid")
    cand_root = os.path.join(staging, "qq-agent")
    seen = set(); plan = []
    for ent in files:
        rel = ent.get("path")
        if not safe_rel(rel):
            raise DeployError("path-not-allowed")
        if rel in seen:
            raise DeployError("manifest-dup-path")
        seen.add(rel)
        for key in ['old_sha256','new_sha256']:
            value=ent.get(key)
            if key=='old_sha256' and value is None:continue
            if not isinstance(value,str) or len(value)!=64 or any(c not in '0123456789abcdef' for c in value):raise DeployError('manifest-invalid-hash')
        cand = os.path.join(cand_root, rel)
        if not under(cand_root, cand) or not os.path.isfile(cand) or not no_symlink(cand, cand_root):
            raise DeployError("candidate-invalid")
        if sha256_norm(cand) != ent.get("new_sha256"):
            raise DeployError("candidate-hash-mismatch")
        if rel == 'knowledge/humor-mechanisms-v1.json':
            try:
                if os.path.getsize(cand)>128*1024:raise ValueError('oversized')
                value=load_json(cand)
                if value.get('version')!=1 or not isinstance(value.get('cards'),list) or len(value['cards'])>15:raise ValueError('invalid')
            except (ValueError,TypeError,AttributeError):raise DeployError('knowledge-json-invalid')
        prod = os.path.join(ROOT, rel)
        if not under(ROOT, prod):
            raise DeployError("prod-outside")
        if not no_symlink(prod, ROOT):
            raise DeployError("prod-parent-symlink")
        exists = os.path.lexists(prod)
        if exists:
            if os.path.islink(prod) or not os.path.isfile(prod):
                raise DeployError("prod-not-regular")
            if sha256_file(prod) != ent.get("old_sha256"):
                raise DeployError("old-hash-mismatch")
        else:
            if ent.get("old_sha256") is not None:
                raise DeployError("old-hash-mismatch-missing")
        plan.append({"rel": rel, "cand": cand, "prod": prod, "old_exists": exists,
                     "old": ent.get("old_sha256"), "new": ent.get("new_sha256")})
    return plan


def verify_old_again(plan):
    for p in plan:
        if not no_symlink(p['prod'],ROOT):raise DeployError('old-parent-race')
        if p["old_exists"]:
            if not os.path.isfile(p["prod"]) or os.path.islink(p["prod"]):
                raise DeployError("old-recheck-race")
            if sha256_file(p["prod"]) != p["old"]:
                raise DeployError("old-recheck-race")
        else:
            if os.path.lexists(p["prod"]):
                raise DeployError("old-recheck-race")


def make_backup(rel):
    os.makedirs(BACKUP_ROOT, mode=0o700, exist_ok=True)
    check_no_symlink_dir(BACKUP_ROOT)
    bak = os.path.join(BACKUP_ROOT, rel)
    if os.path.lexists(bak):
        raise DeployError("backup-exists")
    os.mkdir(bak, 0o700)
    os.chmod(bak, 0o700)
    return bak


def do_apply(rel, staging):
    check_no_symlink_dir(ROOT)
    if not os.path.isabs(staging) or not under(STAGING_ROOT, staging):
        raise DeployError("staging-outside")
    check_no_symlink_dir(STAGING_ROOT)
    check_no_symlink_dir(DEPLOY_ROOT)
    if os.path.islink(staging):
        raise DeployError("staging-symlink")
    if not os.path.isdir(staging):
        raise DeployError("staging-missing")
    mpath = os.path.join(staging, "manifest.json")
    if not os.path.isfile(mpath):
        raise DeployError("manifest-missing")
    if not os.path.isdir(os.path.join(staging, "qq-agent")):
        raise DeployError("candidate-missing")
    manifest = load_json(mpath)
    if manifest.get("release") != rel:
        raise DeployError("release-mismatch")
    plan = verify_manifest(manifest, staging)
    node_check([p["cand"] for p in plan if p['cand'].endswith(('.js','.mjs'))])

    if not svc_active():
        raise DeployError("service-not-active")
    cfg0 = read_cfg()
    if not status_idle(http_status(cfg0)):
        raise DeployError("service-busy")

    verify_old_again(plan)

    bak = make_backup(rel)
    bak_ok = True
    svc_stopped = False
    applied = False
    try:
        svc_stopped = True; svc_stop()
        verify_old_again(plan)

        cfg = read_cfg()  # stop 后重读
        meta = {"files": [], "config": None,
                "three_before": three_before_export(cfg),
                "section_presence":{name:name in cfg for name in ['socialBehavior','voice']},
                "revision":manifest.get('revision')}
        for p in plan:
            rec = {"rel": p["rel"], "existed": p["old_exists"],"sha256":p['old'],"deployed_sha256":sha256_file(p['cand'])}
            if p["old_exists"]:
                rec["meta"] = file_meta(p["prod"])
                dst = os.path.join(bak, "src", p["rel"])
                os.makedirs(os.path.dirname(dst), mode=0o700, exist_ok=True)
                shutil.copy2(p["prod"], dst)
                os.chmod(dst, 0o600)
                if sha256_file(dst)!=p['old']:raise DeployError('backup-hash-mismatch')
            meta["files"].append(rec)
        shutil.copy2(CFG, os.path.join(bak, "config.json"))
        os.chmod(os.path.join(bak, "config.json"), 0o600)
        meta["config"] = file_meta(CFG)
        for sf in STATE_FILES:
            s = os.path.join(os.path.dirname(CFG), sf)
            if os.path.isfile(s):
                shutil.copy2(s, os.path.join(bak, sf))
                os.chmod(os.path.join(bak, sf), 0o600)
        with open(os.path.join(bak, "backup-meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f)

        applied = True
        for p in plan:
            with open(p["cand"], "rb") as f:
                data = f.read()
            os.makedirs(os.path.dirname(p["prod"]), exist_ok=True)
            if p["old_exists"]:
                m = file_meta(p["prod"])
                atomic_write(p["prod"], data, m["mode"], m["uid"], m["gid"])
            else:
                atomic_write(p["prod"], data, 0o644, 0, 0)

        new_cfg = patch_cfg(cfg)
        cm = file_meta(CFG)
        atomic_write(CFG, json.dumps(new_cfg, ensure_ascii=False, indent=2).encode("utf-8"),
                     0o600, cm["uid"], cm["gid"])

        svc_start(); svc_stopped = False
        out("apply-done", files=len(plan))
    except BaseException:
        if not applied and svc_stopped:
            try:
                svc_start()
            except Exception:
                out("rollback-failed", ok=False)
                raise SystemExit(1)
            raise
        if applied:
            try:
                svc_stop()
                for p in plan:
                    if p["old_exists"]:
                        src = os.path.join(bak, "src", p["rel"])
                        with open(src, "rb") as f:
                            data = f.read()
                        m = next(e['meta'] for e in meta['files'] if e['rel']==p['rel'])
                        os.makedirs(os.path.dirname(p["prod"]), exist_ok=True)
                        atomic_write(p["prod"], data, m["mode"], m["uid"], m["gid"])
                    else:
                        if os.path.isfile(p["prod"]) and not os.path.islink(p["prod"]):
                            os.unlink(p["prod"])
                cm2 = file_meta(CFG)
                restored = restore_three(meta["three_before"], read_cfg(),meta['section_presence'])
                atomic_write(CFG, json.dumps(restored, ensure_ascii=False, indent=2).encode("utf-8"),
                             0o600, cm2["uid"], cm2["gid"])
                svc_start()
            except Exception:
                out("rollback-failed", ok=False)
                raise SystemExit(1)
        raise


def do_rollback(bak):
    check_no_symlink_dir(ROOT)
    if not os.path.isabs(bak) or not under(BACKUP_ROOT, bak):
        raise DeployError("backup-outside")
    check_no_symlink_dir(BACKUP_ROOT)
    check_no_symlink_dir(DEPLOY_ROOT)
    if os.path.islink(bak) or not os.path.isdir(bak):
        raise DeployError("backup-missing")
    meta_path = os.path.join(bak, "backup-meta.json")
    if not os.path.isfile(meta_path):
        raise DeployError("backup-meta-missing")
    meta = load_json(meta_path)
    if set(meta.get('three_before',{}))!=set(WRITTEN):raise DeployError('backup-config-meta-invalid')
    files = meta.get("files", [])
    if not isinstance(files, list) or not files:
        raise DeployError("backup-meta-invalid")

    # 先校验 backup 源 SHA 与目标父路径安全
    seen=set()
    for ent in files:
        rel = ent.get("rel")
        if not safe_rel(rel):
            raise DeployError("backup-path-invalid")
        if rel in seen:raise DeployError('backup-dup-path')
        seen.add(rel)
        prod = os.path.join(ROOT, rel)
        if not under(ROOT, prod) or not no_symlink(prod, ROOT):
            raise DeployError("prod-parent-symlink")
        if ent.get("existed"):
            src = os.path.join(bak, "src", rel)
            if not os.path.isfile(src) or not under(bak, src) or not no_symlink(src, bak):
                raise DeployError("backup-src-missing")
            if sha256_file(src)!=ent.get('sha256'):raise DeployError('backup-hash-mismatch')
        if os.path.isfile(prod) and sha256_file(prod) not in (ent.get('sha256'),ent.get('deployed_sha256')):
            raise DeployError('source-conflict')

    cur = read_cfg()
    before = meta.get("three_before", {})
    now = three_now(cur)
    for key, wv in WRITTEN.items():
        b = before.get(key, {"present": False, "value": None})
        cur_val, cur_present = now[key]
        ok_written = cur_present and type_eq(cur_val, wv)
        ok_orig = (cur_present == b["present"]) and (not b["present"] or type_eq(cur_val, b["value"]))
        if not (ok_written or ok_orig):
            raise DeployError("config-conflict")

    svc_stop()
    try:
        restored = 0
        for ent in files:
            rel = ent["rel"]; prod = os.path.join(ROOT, rel)
            if ent.get("existed"):
                src = os.path.join(bak, "src", rel)
                with open(src, "rb") as f:
                    data = f.read()
                m = ent.get("meta") or {"mode": 0o644, "uid": 0, "gid": 0}
                atomic_write(prod, data, m["mode"], m["uid"], m["gid"])
                restored += 1
            else:
                if os.path.isfile(prod) and not os.path.islink(prod):
                    os.unlink(prod)
        cm = file_meta(CFG)
        current=read_cfg()
        if three_now(current)!=three_now(cur):raise DeployError('config-race')
        patched = restore_three(before, current,meta.get('section_presence'))
        atomic_write(CFG, json.dumps(patched, ensure_ascii=False, indent=2).encode("utf-8"),
                     0o600, cm["uid"], cm["gid"])
        svc_start()
        out("rollback-done", files=restored)
    except BaseException:
        try:
            svc_start()
        except Exception:
            out("rollback-failed", ok=False)
            raise SystemExit(1)
        raise


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("apply", "rollback"):
        fail("usage", 2)
    mode, p = sys.argv[1], sys.argv[2]
    if not os.path.isabs(p):
        fail("path-not-abs", 2)
    try:
        if mode == "apply":
            rel = os.path.basename(os.path.normpath(p))
            if not rel or not all(c.isalnum() or c in "._-" for c in rel):
                raise DeployError("release-invalid")
            do_apply(rel, p)
        else:
            do_rollback(p)
    except DeployError as e:
        out('error',ok=False,code=str(e));raise SystemExit(1)
    except SystemExit:
        raise
    except BaseException:
        fail("error")


if __name__ == "__main__":
    main()
