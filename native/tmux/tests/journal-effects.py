#!/usr/bin/env python3
"""Measure real enqueue/capture effects; never infer delivery from command success."""
import json, os, pathlib, shutil, subprocess, sys, tempfile, time
from native_test_evidence import export_sanitizer_evidence
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-journal-effects-',dir='/tmp'); socket=root+'/sock'
env=dict(os.environ,ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
def call(*args,ok=True):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=8)
 assert (p.returncode==0)==ok,(args,p.stderr)
 return p.stdout
def event(*args): return json.loads(call('tmux-ide-events',*args))
def all_records(): return event('-r','-E',epoch,'-a','0')['records']
def run(*args,ok=True):
 before=event('-r','-E',epoch,'-a','0')['next']
 call(*args,ok=ok)
 return event('-r','-E',epoch,'-a',before)['records']
def effects(records): return [r for r in records if r['kind']==5]
try:
 pane=call('-f','/dev/null','new-session','-d','-P','-F','#{pane_id}','-x','500','-y','100','-s','probe','cat').strip()
 epoch=event('-e')['journalEpoch']
 r=run('send','-t',pane,'-l','private-é🙂')
 e=effects(r); assert len(e)==1 and e[0]['count']==str(len('private-é🙂'.encode())),r
 assert e[0]['commandId']==r[-1]['commandId'] and r[-1]['kind']==1
 assert r[-1]['count']=='0' and int(e[0]['sequence'])<int(r[-1]['sequence'])
 assert e[0]['issuerId']==r[-1]['issuerId']!='0'
 assert effects(run('send-prefix','-t',pane))[0]['count']=='1'
 assert effects(run('send','-t',pane,'Enter'))[0]['count']=='1'
 assert not effects(run('send','-t',pane,'-R'))
 assert not effects(run('send','-t','missing','x',ok=False))
 call('select-pane','-t',pane,'-d')
 assert not effects(run('send','-t',pane,'-l','ignored'))
 call('set-buffer','empty-when-disabled')
 assert not effects(run('paste-buffer','-t',pane))
 call('select-pane','-t',pane,'-e')
 call('copy-mode','-t',pane)
 assert not effects(run('send','-t',pane,'-X','cursor-up'))
 call('send','-t',pane,'-X','cancel')
 call('set-buffer','a\nb')
 assert effects(run('paste-buffer','-S','-t',pane))[0]['count']=='3'
 assert effects(run('paste-buffer','-S','-s','---','-t',pane))[0]['count']=='5'
 tty=call('display-message','-p','-t',pane,'#{pane_tty}').strip()
 call('run-shell',"printf '\\033[?2004h' > "+tty)
 time.sleep(.05)
 assert effects(run('paste-buffer','-p','-S','-t',pane))[0]['count']=='15'
 assert not effects(run('paste-buffer','-b','missing','-t',pane,ok=False))
 capture=run('capture-pane','-p','-t',pane)
 snapshots=[r for r in capture if r['kind']==6]
 assert len(snapshots)==1 and int(snapshots[0]['count'])>0 and capture[-1]['kind']==2
 assert snapshots[0]['commandId']==capture[-1]['commandId']
 assert len([r for r in run('capture-pane','-t',pane) if r['kind']==6])==1
 grid=run('capture-pane','-p','-R','-t',pane)
 assert grid[-1]['flags']==33 and len([r for r in grid if r['kind']==6])==1
 assert not [r for r in run('capture-pane','-p','-t','missing',ok=False) if r['kind']==6]
 assert run('clear-history','-t',pane)==[]
 second=call('split-window','-h','-l','3','-d','-P','-F','#{pane_id}','-t',pane,'cat').strip()
 call('set-window-option','-t','probe','synchronize-panes','on')
 two=effects(run('send','-t',pane,'-l','abc'))
 assert len(two)==2 and {r['targetId'] for r in two}=={int(pane[1:]),int(second[1:])},two
 assert {r['count'] for r in two}=={'3'} and len({r['commandId'] for r in two})==1
 # More than64 actual synchronized targets exhaust only observation aggregation.
 for _ in range(63): call('split-window','-h','-l','3','-d','-t',pane,'cat')
 many=run('send','-t',pane,'-l','z')
 assert len(effects(many))==64 and event('-V')['degraded']==8
 assert many[-1]['kind']==1 and many[-1]['outcome']==1
 assert 'private-' not in json.dumps(all_records())
 assert not list(pathlib.Path(root).glob('asan*')) and not list(pathlib.Path(root).glob('ubsan*'))
 print('native effects: exact UTF8/keys/paste bytes, no-effect/error cases, capture production, sync fanout/bound passed')
finally:
 try:
  subprocess.run([binary,'-S',socket,'kill-server'],env=env,capture_output=True)
 finally:
  export_sanitizer_evidence(root)
  logs=list(pathlib.Path(root).glob('asan*'))+list(pathlib.Path(root).glob('ubsan*'))
  if logs: print('Sanitizer logs retained:',root,file=sys.stderr)
  else: shutil.rmtree(root)
