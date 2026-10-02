#!/usr/bin/env python3
"""Disposable native-journal acceptance. Requires test build with TMUX_IDE_JOURNAL_TEST."""
import json, os, pathlib, shutil, subprocess, sys, tempfile, time, uuid
from native_test_evidence import export_sanitizer_evidence
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-native-journal-',dir='/tmp')
socket=root+'/tmux.sock'
env=dict(os.environ,ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
children=[]
def call(*args,ok=True):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=5)
 if ok: assert p.returncode==0,(args,p.returncode,p.stdout,p.stderr)
 else: assert p.returncode!=0,(args,p.stdout)
 return p.stdout.strip()
def event(*args): return json.loads(call('tmux-ide-events',*args))
def until(predicate):
 end=time.monotonic()+3
 while not predicate():
  assert time.monotonic()<end,'timed out'
  time.sleep(.01)
def reader(after):
 p=subprocess.Popen([binary,'-S',socket,'tmux-ide-events','-r','-w','-E',epoch,'-a',str(after)],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 children.append(p)
 return p
try:
 call('-f','/dev/null','new-session','-d','-s','probe','cat')
 caps=event('-V'); assert caps['enabled'] is False and caps['coverage']==['command-outcome-v1','pty-enqueue-v1','capture-produced-v1','cooperative-operation-v1','pane-identity-v1']
 uuid.UUID(caps['serverEpoch']); uuid.UUID(caps['journalEpoch'])
 call('tmux-ide-events','-r','-E',caps['journalEpoch'],'-a','0',ok=False)
 call('send-keys','-t','probe','-l','input-still-works')
 until(lambda:'input-still-works' in call('capture-pane','-p','-t','probe'))
 call('tmux-ide-events','-e','-F',ok=False)
 assert event('-V')['enabled'] is False
 call('send-keys','-t','probe','-l','allocation-failure-does-not-block-input')
 until(lambda:'allocation-failure-does-not-block-input' in call('capture-pane','-p','-t','probe'))
 caps=event('-e'); epoch=caps['journalEpoch']; assert caps['enabled'] is True
 assert event('-e')['journalEpoch']==epoch
 identities=[json.loads(line) for line in call('tmux-ide-events','-i',';','tmux-ide-events','-i').splitlines()]
 assert identities[0]['connectionId']==identities[1]['connectionId']!='0'
 assert event('-i')['connectionId']!=identities[0]['connectionId']
 empty=event('-r','-E',epoch,'-a','0'); assert empty['records']==[] and empty['next']=='0'
 assert event('-r','-E',str(uuid.uuid4()),'-a','0')['type']=='reset'
 for value in ['-1','1.5','18446744073709551616','abc']:
  call('tmux-ide-events','-r','-E',epoch,'-a',value,ok=False)
 call('tmux-ide-events','-r','-E',epoch,'-a','1',ok=False)
 waiters=[reader(0) for _ in range(4)]
 until(lambda:event('-V')['waitingReaders']==4)
 call('tmux-ide-events','-r','-w','-E',epoch,'-a','0',ok=False)
 call('tmux-ide-events','-T')
 for waiter in waiters:
  out,err=waiter.communicate(timeout=3); assert waiter.returncode==0,err
  batch=json.loads(out); assert batch['next']=='1' and len(batch['records'])==1
 until(lambda:event('-V')['waitingReaders']==0)
 dead=reader(1); until(lambda:event('-V')['waitingReaders']==1)
 dead.terminate(); dead.communicate(timeout=3)
 until(lambda:event('-V')['waitingReaders']==0)
 # Generate >capacity through one bounded argv list per128 commands.
 for _ in range(33):
  args=[]
  for i in range(128):
   if i: args.append(';')
   args.extend(['tmux-ide-events','-T'])
  call(*args)
 batch=event('-r','-E',epoch,'-a','0','-n','256')
 assert batch['gap']=={'from':'1','through':str(int(batch['oldest'])-1)}
 assert len(batch['records'])==256 and int(batch['next'])==int(batch['oldest'])+255
 assert all(r['kind']==255 for r in batch['records'])
 cursor=batch['next']
 following=event('-r','-E',epoch,'-a',cursor,'-n','1')
 assert int(following['records'][0]['sequence'])==int(cursor)+1
 latest=event('-r','-E',epoch,'-a',batch['newest']); assert latest['records']==[]
 # All metadata fields at maximum width must fit bounded response buffers.
 for _ in range(2):
  args=[]
  for i in range(128):
   if i: args.append(';')
   args.extend(['tmux-ide-events','-W'])
  call(*args)
 raw=call('tmux-ide-events','-r','-E',epoch,'-a',batch['newest'],'-n','256')
 wide=json.loads(raw); assert len(wide['records'])==256 and len(raw.encode())<131072
 assert wide['records'][0]['requestId']=='18446744073709551615'
 small=call('tmux-ide-events','-r','-E',epoch,'-a',batch['newest'],'-n','64')
 assert len(json.loads(small)['records'])==64 and len(small.encode())<65536
 batch=wide
 reset_waiter=reader(int(batch['newest'])); until(lambda:event('-V')['waitingReaders']==1)
 call('tmux-ide-events','-X')
 reset=json.loads(reset_waiter.communicate(timeout=3)[0]); assert reset['type']=='reset' and reset['journalEpoch']!=epoch
 epoch=reset['journalEpoch']
 parked=reader(1); until(lambda:event('-V')['waitingReaders']==1)
 call('kill-server')
 parked.communicate(timeout=3)
 time.sleep(.1)
 assert not list(pathlib.Path(root).glob('asan*')),root
 assert not list(pathlib.Path(root).glob('ubsan*')),root
 print('native journal live: capability, identity, atomic wait, waiter cap/disconnect, overflow/replay, shutdown passed')
finally:
 try:
  for p in children:
   if p.poll() is None: p.kill(); p.communicate()
  subprocess.run([binary,'-S',socket,'kill-server'],env=env,capture_output=True)
 finally:
  export_sanitizer_evidence(root)
  logs=list(pathlib.Path(root).glob('asan*'))+list(pathlib.Path(root).glob('ubsan*'))
  if logs: print('Sanitizer logs retained:',root,file=sys.stderr)
  else: shutil.rmtree(root)
