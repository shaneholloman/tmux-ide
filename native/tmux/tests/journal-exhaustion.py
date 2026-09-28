#!/usr/bin/env python3
"""Explicit degraded evidence and terminal fail-open after forced ID exhaustion."""
import json, os, pathlib, shutil, subprocess, sys, tempfile, time
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-journal-exhaustion-',dir='/tmp'); socket=root+'/sock'
env=dict(os.environ,ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
reader=None
def call(*args):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=5)
 assert p.returncode==0,(args,p.stderr)
 return p.stdout.strip()
def event(*args): return json.loads(call('tmux-ide-events',*args))
try:
 call('-f','/dev/null','new-session','-d','-s','probe','cat')
 caps=event('-e'); epoch=caps['journalEpoch']; assert caps['degraded']==0
 reader=subprocess.Popen([binary,'-S',socket,'tmux-ide-events','-r','-w','-E',epoch,'-a','0'],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 deadline=time.monotonic()+3
 while event('-V')['waitingReaders']!=1:
  assert time.monotonic()<deadline
  time.sleep(.01)
 call('tmux-ide-events','-D')
 out,err=reader.communicate(timeout=3); assert reader.returncode==0,err
 assert json.loads(out)['degraded']==7
 assert event('-V')['degraded']==7 and event('-i')['connectionId']=='0'
 call('send-keys','-t','probe','-l','still-works-after-exhaustion')
 deadline=time.monotonic()+3
 while 'still-works-after-exhaustion' not in call('capture-pane','-p','-t','probe'):
  assert time.monotonic()<deadline
  time.sleep(.01)
 batch=event('-r','-E',epoch,'-a','0')
 assert batch['degraded']==7 and batch['records']
 assert all(r['commandId']==r['issuerId']==r['requestId']=='0' for r in batch['records'])
 assert event('-r','-w','-E',epoch,'-a',batch['next'])['degraded']==7
 assert not list(pathlib.Path(root).glob('asan*')) and not list(pathlib.Path(root).glob('ubsan*'))
 print('native exhaustion: explicit degradation, reader wake, no ID reuse, continued input/observation passed')
finally:
 if reader and reader.poll() is None: reader.kill(); reader.communicate()
 subprocess.run([binary,'-S',socket,'kill-server'],env=env,capture_output=True)
 logs=list(pathlib.Path(root).glob('asan*'))+list(pathlib.Path(root).glob('ubsan*'))
 if logs: print('Sanitizer logs retained:',root,file=sys.stderr)
 else: shutil.rmtree(root)
