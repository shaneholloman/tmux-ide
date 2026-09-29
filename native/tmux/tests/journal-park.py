#!/usr/bin/env python3
"""Bounded sessionless reader: no attach/resize, closed grammar and cancellation."""
import json, os, pathlib, select, shutil, subprocess, sys, tempfile, time
from native_test_evidence import export_sanitizer_evidence
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-journal-park-',dir='/tmp');socket=root+'/sock';readers=[]
env=dict(os.environ,ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
def call(*args):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=5)
 assert p.returncode==0,(args,p.stderr)
 return p.stdout.strip()
def event(*args):return json.loads(call('tmux-ide-events',*args))
class Reader:
 def __init__(self):
  self.p=subprocess.Popen([binary,'-N','-C','-S',socket,'tmux-ide-events','-P'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE);self.buffer=b'';readers.append(self)
 def frame(self):
  lines=[];end=time.monotonic()+3
  while time.monotonic()<end:
   if b'\n' in self.buffer:
    line,self.buffer=self.buffer.split(b'\n',1);line=line.decode();lines.append(line)
    if line.startswith('%end ') or line.startswith('%error '):return lines
   else:
    if select.select([self.p.stdout],[],[],.05)[0]:
     data=os.read(self.p.stdout.fileno(),65536)
     assert data,('eof',lines,self.p.poll(),self.p.stderr.read())
     self.buffer+=data
  raise Exception(('frame timeout',lines,self.buffer))
 def write(self,text):self.p.stdin.write(text.encode());self.p.stdin.flush()
 def close(self):
  if self.p.poll() is None:
   self.p.kill();self.p.communicate(timeout=3)
 def handshake(self):
  frame=self.frame();assert len(frame)==4 and frame[0].startswith('%begin ') and frame[-1].startswith('%end '),frame
  cap,identity=map(json.loads,frame[1:3]);assert cap['readerTransport']=='sessionless-control-v1' and identity['type']=='identity' and int(identity['connectionId'])>0 and identity['serverEpoch']==cap['serverEpoch'];return cap
 def exited(self):
  self.p.wait(timeout=3)
 def read(self,epoch,cursor,wait=0):self.write(f'read {epoch} {cursor} 64 {wait}\n');frame=self.frame();assert len(frame)==3,frame;return json.loads(frame[1])
try:
 call('-f','/dev/null','new-session','-d','-s','probe','-x','90','-y','30','cat')
 call('set-hook','-g','client-attached','set-option -g @unexpected-attach yes')
 initial=call('display-message','-p','-t','probe','#{window_width},#{window_height},#{session_attached}')
 epoch=event('-e')['journalEpoch']
 call('set-hook','-g','command-error','set-option -g @unexpected-error-hook yes')
 call('set-option','-s','command-alias[100]','tmux-ide-events=set-option -g @alias-mutation yes ; display-message')
 alias_reader=Reader();alias_reader.handshake();assert alias_reader.read(epoch,'0')['type']=='batch';alias_reader.close()
 call('set-option','-su','command-alias[100]')
 assert call('show-options','-gqv','@alias-mutation')==''
 r=Reader();r.handshake()
 assert call('display-message','-p','-t','probe','#{window_width},#{window_height},#{session_attached}')==initial
 assert call('show-options','-gqv','@unexpected-attach')==''
 cursor='0'
 for i in range(50):
  call('send-keys','-t','probe','-l','x');batch=r.read(epoch,cursor);assert len(batch['records'])==2 and batch['gap'] is None;cursor=batch['next']
 # Keep an actual wait open beyond the old5s command timeout, then wake.
 r.write(f'read {epoch} {cursor} 64 1\n');time.sleep(6.1)
 assert r.p.poll() is None and event('-V')['waitingReaders']==1
 call('send-keys','-t','probe','-l','z');frame=r.frame();assert len(frame)==3,frame
 waited=json.loads(frame[1]);assert len(waited['records'])==2;cursor=waited['next']
 # Global notifications are never unsolicited reader output.
 for i in range(20):call('set-buffer','-b','notification-probe',str(i))
 assert not r.buffer and not select.select([r.p.stdout],[],[],.05)[0]
 r.write(f'read {epoch} {cursor} 64 1\n')
 end=time.monotonic()+3
 while event('-V')['waitingReaders']!=1:
  assert time.monotonic()<end;time.sleep(.01)
 r.write('\n');r.exited();assert event('-V')['waitingReaders']==0
 # EOF cancellation while an atomic wait is pending.
 r=Reader();r.handshake();r.write(f'read {epoch} {cursor} 64 1\n');time.sleep(.03);r.p.stdin.close();r.exited();assert event('-V')['waitingReaders']==0
 # Strict ingress rejects commands, separators, repeated park and malformed tokens.
 for invalid in ['attach-session\n','tmux-ide-events -P\n',f'read {epoch} 0 64 0; attach-session\n',f'read {epoch} 18446744073709551616 64 0\n',f'read {epoch} 0 65 0\n','x'*200,f'read{epoch} 0 64 0\n',f'read {epoch} 00 64 0\n',f'read {epoch} 0 64 0\x00junk\n']:
  r=Reader();r.handshake();r.write(invalid);r.exited();assert event('-V')['waitingReaders']==0
 assert call('show-options','-gqv','@unexpected-error-hook')==''
 # At most four parked readers, including idle ones.
 parked=[]
 for i in range(4):r=Reader();r.handshake();parked.append(r)
 extra=Reader();extra.exited()
 assert call('show-options','-gqv','@unexpected-error-hook')==''
 for r in parked:r.close()
 # Slow output plus repeated requests cannot accumulate requests or waiters.
 args=[]
 for i in range(128):
  if i:args.append(';')
  args.extend(['send-keys','-t','probe','-l','y'])
 call(*args)
 r=Reader();r.handshake();r.write(f'read {epoch} 0 64 0\n'*100)
 r.exited();assert event('-V')['waitingReaders']==0
 # Stop consuming output and send paced reads. Once pipe/output fills,
 # native EV_READ backpressure bounds input; killing the helper must still reap.
 r=Reader();r.handshake();os.set_blocking(r.p.stdin.fileno(),False)
 for i in range(100):
  try:os.write(r.p.stdin.fileno(),f'read {epoch} 0 64 0\n'.encode())
  except (BlockingIOError,BrokenPipeError):break
  time.sleep(.002)
 r.close();assert event('-V')['waitingReaders']==0
 # Wrong journal epoch responds reset; no silent cross-epoch continuation.
 r=Reader();r.handshake();reset=r.read('00000000-0000-4000-8000-000000000001','0');assert reset['type']=='reset'
 # A parked reader must not keep the last-session server alive.
 call('kill-session','-t','probe');r.exited()
 call('-f','/dev/null','new-session','-d','-s','replacement','cat')
 replacement=event('-V');assert replacement['serverEpoch']!=reset['serverEpoch'] and not replacement['enabled']
 rejected=Reader();rejected.exited()
 event('-e');fresh=Reader();freshcap=fresh.handshake();assert freshcap['serverEpoch']==replacement['serverEpoch']
 assert not list(pathlib.Path(root).glob('asan*')) and not list(pathlib.Path(root).glob('ubsan*'))
 print('native parked reader: handshake,50reads,noattach/noresize/nonotify,strictgrammar,flood/cancel/EOF,4readers,lastsession passed')
finally:
 try:
  for r in readers:r.close()
  subprocess.run([binary,'-S',socket,'kill-server'],env=env,capture_output=True)
 finally:
  export_sanitizer_evidence(root)
  logs=list(pathlib.Path(root).glob('asan*'))+list(pathlib.Path(root).glob('ubsan*'))
  if logs:print('Sanitizer logs retained:',root,file=sys.stderr)
  else:shutil.rmtree(root)
