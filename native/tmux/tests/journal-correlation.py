#!/usr/bin/env python3
"""Cooperative UUID assertion requires independent same-connection issuer binding."""
import json, os, pathlib, shutil, subprocess, sys, tempfile, time, uuid
from native_test_evidence import export_sanitizer_evidence
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-journal-correlation-',dir='/tmp'); socket=root+'/sock'
env=dict(os.environ,ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
control=None
def call(*args,ok=True):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=5)
 assert (p.returncode==0)==ok,(args,p.stderr)
 return p.stdout.strip()
def event(*args):return json.loads(call('tmux-ide-events',*args))
def records():return event('-r','-E',epoch,'-a','0')['records']
def until(predicate):
 deadline=time.monotonic()+3
 while not predicate():
  assert time.monotonic()<deadline
  time.sleep(.01)
try:
 call('-f','/dev/null','new-session','-d','-s','probe','cat')
 operation=str(uuid.uuid4())
 call('tmux-ide-run','-O',operation,'send-keys -t probe -l disabled-wrapper-works')
 until(lambda:'disabled-wrapper-works' in call('capture-pane','-p','-t','probe'))
 assert not event('-V')['enabled']
 epoch=event('-e')['journalEpoch']
 for value in ['missing','x'*36,'00000000-0000-0000-0000-000000000000','"'+operation]:
  call('tmux-ide-run','-O',value,'send-keys -t probe -l invalid',ok=False)
 assert records()==[]
 control=subprocess.Popen([binary,'-S',socket,'-C','attach-session','-t','probe'],env=env,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 control.stdin.write('tmux-ide-events -i\n');control.stdin.flush()
 identity=None
 while identity is None:
  line=control.stdout.readline()
  if line.startswith('{'):identity=json.loads(line)
 owned_issuer=identity['connectionId']; assert owned_issuer!='0'
 control.stdin.write('tmux-ide-run -O '+operation+' { send-keys -t probe -l owned }\n');control.stdin.flush()
 until(lambda:any(r['correlation']==operation for r in records()))
 owned=[r for r in records() if r['correlation']==operation]
 assert all(r['issuerId']==owned_issuer and r['parentCommandId']!='0' for r in owned)
 # UUID is just an assertion: another connection can copy it but not this issuer.
 call('tmux-ide-run','-O',operation,'send-keys -t probe -l forged')
 forged=records()[-2:]
 assert all(r['correlation']==operation and r['issuerId']!=owned_issuer for r in forged)
 # This predicate illustrates required adapter binding, not authentication by UUID.
 accept=lambda r: r['correlation']==operation and r['issuerId']==owned_issuer and identity['serverEpoch']==event('-V')['serverEpoch']
 assert all(accept(r) for r in owned) and not any(accept(r) for r in forged)
 call('set-hook','-g','after-send-keys','capture-pane -t probe')
 derived=str(uuid.uuid4())
 call('tmux-ide-run','-O',derived,'run-shell -b -d 0.1 -C "send-keys -t probe -l delayed"')
 until(lambda:len([r for r in records() if r['correlation']==derived])>=4)
 descendants=[r for r in records() if r['correlation']==derived]
 assert {r['kind'] for r in descendants}=={1,2,5,6}
 assert len({r['issuerId'] for r in descendants})==1
 assert {r['derivation'] for r in descendants}=={2,3}
 call('set-hook','-gu','after-send-keys')
 call('send-keys','-t','probe','-l','uncorrelated')
 assert all(r['correlation'] is None for r in records()[-2:])
 assert not list(pathlib.Path(root).glob('asan*')) and not list(pathlib.Path(root).glob('ubsan*'))
 print('native correlation: disabled execution, validation, same-connection binding, forged assertion, delayed/hook inheritance passed')
finally:
 try:
  if control and control.poll() is None:control.terminate();control.communicate(timeout=3)
  subprocess.run([binary,'-S',socket,'kill-server'],env=env,capture_output=True)
 finally:
  export_sanitizer_evidence(root)
  logs=list(pathlib.Path(root).glob('asan*'))+list(pathlib.Path(root).glob('ubsan*'))
  if logs:print('Sanitizer logs retained:',root,file=sys.stderr)
  else:shutil.rmtree(root)
