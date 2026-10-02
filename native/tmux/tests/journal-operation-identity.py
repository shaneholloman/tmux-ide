#!/usr/bin/env python3
"""Strict wrapper acknowledgement proves only direct children on actual issuer."""
import json, os, pathlib, shutil, subprocess, sys, tempfile, time, uuid
from native_test_evidence import export_sanitizer_evidence
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-journal-operation-',dir='/tmp');socket=root+'/sock';control=None
env=dict(os.environ,ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
def call(*args,ok=True):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=5)
 assert (p.returncode==0)==ok,(args,p.stderr)
 return p.stdout.strip()
def event(*args):return json.loads(call('tmux-ide-events',*args))
def rows():return event('-r','-E',epoch,'-a','0')['records']
def until(pred):
 end=time.monotonic()+3
 while not pred():assert time.monotonic()<end;time.sleep(.01)
def read_json(kind):
 while True:
  line=control.stdout.readline();assert line,'control EOF'
  if line.startswith('{'):
   value=json.loads(line)
   if value.get('type')==kind:return value
try:
 call('-f','/dev/null','new-session','-d','-s','probe','cat');operation=str(uuid.uuid4())
 call('tmux-ide-run','-I','-O',operation,'set-option -g @disabled-effect yes',ok=False)
 assert call('show-options','-gqv','@disabled-effect')==''
 # Both protocol names are reserved throughout nested parsing, not just -P.
 call('set-option','-s','command-alias[100]','tmux-ide-events=set-option -g @event-alias yes ; tmux-ide-events')
 call('set-option','-s','command-alias[101]','tmux-ide-run=set-option -g @wrapper-alias yes ; tmux-ide-run')
 cap=json.loads(call('if-shell','-F','1','tmux-ide-events -e'));epoch=cap['journalEpoch']
 assert cap['ownedOperationTransport']=='direct-wrapper-v1'
 assert cap['ownedOperationEpochGuard']=='server-epoch-v1'
 # Epoch guard refuses before body parsing, output acknowledgement, or child effects.
 for stale in [str(uuid.uuid4()), 'malformed']:
  assert call('tmux-ide-run','-I','-E',stale,'-O',operation,'TMUX_IDE_EPOCH_LEAK=bad ; set-option -g @epoch-effect yes',ok=False)==''
 assert call('show-options','-gqv','@epoch-effect')==''
 assert 'TMUX_IDE_EPOCH_LEAK=' not in call('show-environment','-g')
 assert call('tmux-ide-run','-E',cap['serverEpoch'],'-O',operation,'set-option -g @epoch-effect yes',ok=False)==''
 epoch_capture=call('capture-pane','-p','-t','probe')
 guarded=call('tmux-ide-run','-I','-E',cap['serverEpoch'],'-O',str(uuid.uuid4()),'capture-pane -p -t probe')
 guarded_ack,separator,guarded_capture=guarded.partition('\n')
 assert json.loads(guarded_ack)['serverEpoch']==cap['serverEpoch']
 assert guarded_capture==epoch_capture

 assert call('show-options','-gqv','@event-alias')==''
 # The strict body parse itself must not change global environment on error.
 call('tmux-ide-run','-I','-O',operation,'TMUX_IDE_PARSE_LEAK=bad ; missing-native-command',ok=False)
 assert 'TMUX_IDE_PARSE_LEAK=' not in call('show-environment','-g')
 # Ordinary aliases, including builtin aliases, retain ordinary semantics.
 call('set-option','-s','command-alias[102]','send-keys=set-option -g @send-alias yes ; send-keys')
 call('send-keys','-t','probe','-l','ordinary');assert call('show-options','-gqv','@send-alias')=='yes';call('set-option','-gu','@send-alias')
 ack=json.loads(call('tmux-ide-run','-I','-O',operation,'send-keys -t probe -l exact'))
 assert ack['type']=='operation-identity' and ack['serverEpoch']==cap['serverEpoch'] and ack['operationId']==operation
 assert int(ack['connectionId'])>0 and int(ack['wrapperCommandId'])>0
 direct=[r for r in rows() if r['correlation']==operation]
 assert len(direct)==2 and all(r['issuerId']==ack['connectionId'] and r['parentCommandId']==ack['wrapperCommandId'] for r in direct)
 assert call('show-options','-gqv','@send-alias')==call('show-options','-gqv','@wrapper-alias')==''
 control=subprocess.Popen([binary,'-S',socket,'-C','attach-session','-t','probe'],env=env,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 control.stdin.write('tmux-ide-events -i\n');control.stdin.flush();identity=read_json('identity')
 # Braced commands may already be alias-expanded; reject before any effects.
 control.stdin.write('tmux-ide-run -I -O '+operation+' { set-option -g @brace-effect yes }\n');control.stdin.flush()
 while not control.stdout.readline().startswith('%error '):pass
 assert call('show-options','-gqv','@brace-effect')==''
 call('set-hook','-g','after-send-keys',"if-shell -F 1 'capture-pane -t probe'")
 owned=str(uuid.uuid4());control.stdin.write('tmux-ide-run -I -O '+owned+' "send-keys -t probe -l owned"\n');control.stdin.flush();owned_ack=read_json('operation-identity')
 assert owned_ack['connectionId']==identity['connectionId'] and owned_ack['serverEpoch']==identity['serverEpoch']
 until(lambda:len([r for r in rows() if r['correlation']==owned])==4)
 observed=[r for r in rows() if r['correlation']==owned]
 assert all(r['parentCommandId']==owned_ack['wrapperCommandId'] for r in observed if r['kind'] in [1,5])
 hook=[r for r in observed if r['kind'] in [2,6]]
 assert len(hook)==2 and all(r['derivation']==1 and r['parentCommandId']!=owned_ack['wrapperCommandId'] for r in hook)
 assert all(r['issuerId']==owned_ack['connectionId'] for r in hook)
 # Same assertion on another connection has distinct immutable issuer+wrapper.
 forged=json.loads(call('tmux-ide-run','-I','-O',owned,'send-keys -t probe -l forged'))
 assert forged['connectionId']!=owned_ack['connectionId'] and forged['wrapperCommandId']!=owned_ack['wrapperCommandId']
 call('set-hook','-gu','after-send-keys')
 if '--production' not in sys.argv:
  call('tmux-ide-events','-D')
  call('tmux-ide-run','-I','-O',operation,'set-option -g @exhausted-effect yes',ok=False)
  assert call('show-options','-gqv','@exhausted-effect')==''
 assert not list(pathlib.Path(root).glob('asan*')) and not list(pathlib.Path(root).glob('ubsan*'))
 print('native operation identity: reservedaliases,ordinaryaliases,strictstring,noaliasbody,bracesrejected,actualissuer,directparent,hookparent passed (exhaustion tested only in qualification build)')
finally:
 try:
  if control and control.poll() is None:control.terminate();control.communicate(timeout=3)
  subprocess.run([binary,'-S',socket,'kill-server'],env=env,capture_output=True)
 finally:
  export_sanitizer_evidence(root)
  logs=list(pathlib.Path(root).glob('asan*'))+list(pathlib.Path(root).glob('ubsan*'))
  if logs:print('Sanitizer logs retained:',root,file=sys.stderr)
  else:shutil.rmtree(root)
