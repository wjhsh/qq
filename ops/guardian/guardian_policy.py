"""Deterministic recovery policy; no model, shell text or credential values."""
import copy

SERVICES={'napcat-qq','qq-agent','codex-mihomo','codex-gateway','qq-onebot-bridge','qq-cloud-transport'}
def decide(snapshot,state,now):
    state=copy.deepcopy(state)
    state.setdefault('version',1);fails=state.setdefault('failures',{});history=state.setdefault('actions',[])
    history[:]=[x for x in history if now-x['at']<3600]
    actions=[];s=snapshot
    def count(key,bad):
        fails[key]=fails.get(key,0)+1 if bad else 0
        return fails[key]
    def reserve(kind,target='',interval=300,limit=3):
        if actions:return False  # At most one mutating recovery per scan.
        key=kind+':'+target;prior=[x for x in history if x['key']==key]
        if len(prior)>=limit or prior and now-prior[-1]['at']<interval:return False
        history.append({'key':key,'at':now});actions.append({'kind':kind,'target':target});return True
    is_snow=s.get('transport_mode')=='snowluma'
    native_target='qq-cloud-transport' if is_snow else 'napcat-qq'
    transport_testing=s.get('transport_mode','napcat') not in ['napcat','snowluma']
    auth_paused=transport_testing or s.get('risk_blocked',False) or s.get('forced_offline_hold',False)
    public={'qq':'unknown','proxy':'healthy' if s.get('proxy_outbound_ok') else 'checking','gateway':'healthy' if s.get('gateway_ready') else 'checking','credential_configured':s.get('credential_configured',False),'auth_recovery_paused':auth_paused}
    if s.get('paused'):
        public.update(qq='maintenance_paused',proxy='maintenance_paused',gateway='maintenance_paused')
        return state,actions,public
    generation=s.get('credential_generation','')
    if generation!=state.get('credential_generation',''):
        state.update(credential_generation=generation,auth_blocked='',quick_invalid=False)
        history[:]=[x for x in history if not x['key'].startswith('password_login:')]
    native_bad=count('native',not s.get('native_reachable'))
    agent_bad=count('agent',not s.get('agent_reachable'))
    if transport_testing:
        public['qq']='official_qq_trial' if s.get('transport_mode')=='official_qq_trial' else 'transport_maintenance'
        count('onebot',False)
    elif auth_paused:
        # A login pause limits mutations; it must not hide a successful manual login.
        if s.get('native_reachable') and s.get('login_ready'):
            state.update(auth_blocked='',quick_invalid=False,offline_since=None)
            if s.get('onebot_online') is True and s.get('onebot_connected'):
                public['qq']='online';count('onebot',False)
            else:
                public['qq']='onebot_disconnected'
                if count('onebot',True)>=3 and not s.get('onebot_connected'):
                    reserve('restart','qq-agent',600,3)
        else:public['qq']='risk_device_blocked' if s.get('risk_blocked') else 'forced_offline_review_required'
    elif native_bad>=3:
        public['qq']='native_unreachable'
        reserve('restart',native_target,600,3)
    elif not s.get('native_reachable'):
        public['qq']='native_checking'
    elif s.get('login_ready'):
        state.update(auth_blocked='',quick_invalid=False,offline_since=None)
        if s.get('onebot_online') is True and s.get('onebot_connected'):
            public['qq']='online';count('onebot',False)
        else:
            public['qq']='onebot_disconnected'
            if count('onebot',True)>=3:
                if s.get('onebot_online') is True:target='qq-agent'
                elif is_snow:target='qq-onebot-bridge' if s.get('onebot_direct_online') is True else native_target
                else:target=native_target if s.get('onebot_online') is False else 'qq-agent'
                reserve('restart',target,600,3)
    else:
        count('onebot',False)
        if state.get('offline_since') is None:state['offline_since']=now
        phase=s.get('phase','')
        if is_snow:
            public['qq']='protocol_attach_pending' if s.get('snowluma_attach_available') else 'device_confirmation_required'
            if s.get('snowluma_attach_available'):reserve('snowluma_attach',interval=600,limit=2)
            elif phase=='client_missing':reserve('restart',native_target,600,3)
        elif phase in ['qrcode_scanned','initializing','reconnecting','generating_qrcode']:
            public['qq']='login_in_progress'
            if now-state['offline_since']>300:reserve('restart','napcat-qq',900,2)
        elif state.get('auth_blocked'):
            public['qq']=state['auth_blocked']
        elif s.get('quick_available') and not state.get('quick_invalid'):
            public['qq']='quick_login_pending'
            reserve('quick_login',interval=300,limit=3)
        elif s.get('credential_configured'):
            public['qq']='password_login_pending'
            reserve('password_login',interval=300,limit=4)
        else:public['qq']='credentials_required'
    if agent_bad>=3 and not transport_testing:reserve('restart','qq-agent',600,3)
    proxy_bad=count('proxy',not s.get('proxy_outbound_ok'))
    proxy_local_bad=count('proxy_local',not s.get('proxy_local_ready'))
    if proxy_local_bad>=3:
        public['proxy']='local_proxy_unavailable';reserve('restart','codex-mihomo',600,3)
    elif proxy_bad>=3:
        public['proxy']='outbound_unavailable'
        if reserve('proxy_auto',interval=600,limit=3):public['proxy']='repair_scheduled'
    gateway_bad=count('gateway',not s.get('gateway_ready') and s.get('gateway_error') not in ['auth','quota','region'])
    if gateway_bad>=3:
        public['gateway']='local_gateway_unavailable';reserve('restart','codex-gateway',600,3)
    if s.get('gateway_error') in ['auth','quota','region']:public['gateway']=s['gateway_error']
    state['last_public']=public
    return state,actions,public

def auth_result(state,kind,result):
    state=copy.deepcopy(state)
    if result=='accepted':state['auth_blocked']=''
    elif result=='invalid_session':state['quick_invalid']=True
    elif result in ['captcha_required','device_confirmation_required','password_rejected']:
        state['auth_blocked']=result
    # Network errors consume the reserved attempt and retain cooldowns, never force a new QR.
    return state


def observe(state,public,now):
    """Persist measured coverage. Gaps and unknown/offline samples break continuity."""
    state=copy.deepcopy(state);public=dict(public)
    observation=state.setdefault('observation',{'first_checked_at':now,'samples':0,'online_seconds':0,'observed_seconds':0,'interruptions':0,'monitoring_gaps':0,'longest_online_seconds':0})
    previous=observation.get('last_checked_at');online=public.get('qq')=='online'
    delta=now-previous if previous is not None else 0
    gap=previous is not None and not 0<=delta<=120
    was_online=observation.get('last_online',False)
    if gap:observation['monitoring_gaps']+=1
    elif previous is not None:
        observation['observed_seconds']+=delta
        if online and was_online:observation['online_seconds']+=delta
        elif was_online:observation['interruptions']+=1;observation['last_interruption_at']=now
    if not online:observation['online_since']=None
    elif gap or not was_online or observation.get('online_since') is None:observation['online_since']=now
    continuous=max(0,now-observation['online_since']) if online else 0
    observation['longest_online_seconds']=max(observation['longest_online_seconds'],continuous)
    observation.update(last_checked_at=now,last_online=online,samples=observation['samples']+1)
    public['qq_observation']={
      'first_checked_at':observation['first_checked_at'],
      'continuous_online_seconds':int(continuous),
      'longest_online_seconds':int(observation['longest_online_seconds']),
      'observed_seconds':int(observation['observed_seconds']),
      'online_seconds':int(observation['online_seconds']),
      'interruptions':observation['interruptions'],'monitoring_gaps':observation['monitoring_gaps'],
      'last_interruption_at':observation.get('last_interruption_at'),'samples':observation['samples']}
    return state,public
