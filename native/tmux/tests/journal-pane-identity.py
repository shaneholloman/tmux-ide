#!/usr/bin/env python3
"""Immutable pane identity independent of enable state or current placement."""
import json, os, pathlib, shutil, subprocess, sys, tempfile
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-journal-pane-',dir='/tmp'); socket=root+'/sock'
env=dict(os.environ,ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
def call(*args):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=5)
 assert p.returncode==0,(args,p.stderr)
 return p.stdout.strip()
def event(*args):return json.loads(call('tmux-ide-events',*args))
def identity(pane):return call('display-message','-p','-t',pane,'#{pane_birth_id}')
try:
 first=call('-f','/dev/null','new-session','-d','-P','-F','#{pane_id}','-s','probe','cat')
 birth=identity(first); assert int(birth)>0 and not event('-V')['enabled']
 second=call('new-window','-d','-P','-F','#{pane_id}','-t','probe','cat');second_birth=identity(second)
 assert int(second_birth)>int(birth)
 call('join-pane','-d','-s',first,'-t',second);assert identity(first)==birth
 caps=event('-e');assert caps['schemaVersion']==2 and 'pane-identity-v1' in caps['coverage']
 call('send-keys','-t',first,'-l','hello')
 rows=event('-r','-E',caps['journalEpoch'],'-a','0')['records']
 assert len(rows)==2 and all(r['targetBirthId']==birth and r['targetId']==int(first[1:]) for r in rows)
 call('kill-pane','-t',first)
 third=call('split-window','-d','-P','-F','#{pane_id}','-t',second,'cat');assert int(identity(third))>int(second_birth)
 call('tmux-ide-events','-B')
 fourth=call('split-window','-d','-P','-F','#{pane_id}','-t',second,'cat');assert identity(fourth)=='0' and event('-V')['degraded']==16
 call('send-keys','-t',fourth,'-l','still-works')
 rows=event('-r','-E',caps['journalEpoch'],'-a','2')['records'];assert len(rows)==2 and all(r['targetBirthId']=='0' for r in rows)
 assert identity(second)==second_birth and int(identity(third))>0
 assert not list(pathlib.Path(root).glob('asan*')) and not list(pathlib.Path(root).glob('ubsan*'))
 print('native pane identity: pre-enable birth, movement stability, no reuse, metadata, exhausted fail-open passed')
finally:
 subprocess.run([binary,'-S',socket,'kill-server'],env=env,capture_output=True)
 logs=list(pathlib.Path(root).glob('asan*'))+list(pathlib.Path(root).glob('ubsan*'))
 if logs:print('Sanitizer logs retained:',root,file=sys.stderr)
 else:shutil.rmtree(root)
