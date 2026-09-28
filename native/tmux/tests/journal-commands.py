#!/usr/bin/env python3
"""Command evidence and immutable lineage, always on a disposable server."""
import json, os, pathlib, shutil, subprocess, sys, tempfile, time
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-journal-origin-',dir='/tmp')
socket=root+'/tmux.sock'
env=dict(os.environ,ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
children=[]
def call(*args,ok=True):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=5)
 assert (p.returncode==0)==ok,(args,p.returncode,p.stdout,p.stderr)
 return p.stdout.strip()
def event(*args): return json.loads(call('tmux-ide-events',*args))
def records(): return event('-r','-E',epoch,'-a','0')['records']
def until(predicate):
 end=time.monotonic()+3
 while not predicate():
  assert time.monotonic()<end,'timed out'
  time.sleep(.01)
def identified(*args):
 out=call('tmux-ide-events','-i',';',*args)
 return json.loads(out.splitlines()[0])['connectionId']
try:
 call('-f','/dev/null','new-session','-d','-s','probe','cat')
 epoch=event('-e')['journalEpoch']
 issuer=identified('send','-t','probe','-l','private-input-must-not-be-journalled')
 first=records()[0]
 assert first['issuerId']==issuer and first['transport']==1 and first['derivation']==0
 assert first['parentCommandId']=='0' and first['requestId']!='0'
 assert first['kind']==1 and first['outcome']==1 and first['flags']==1 and first['count']=='0'
 # Error is not delivery; no target evidence when target lookup failed.
 call('send','-t','missing-pane','x',ok=False)
 failed=records()[-1]; assert failed['outcome']==2 and failed['flags']==0
 identified('send','-R','-t','probe')
 assert records()[-1]['flags']==9
 # Native descendant expansion has explicit parent lineage.
 pathlib.Path(root+'/commands').write_text('send-keys -t probe -l sourced\n')
 source_issuer=identified('source-file',root+'/commands')
 sourced=records()[-1]
 assert sourced['issuerId']==source_issuer and sourced['derivation']==1 and sourced['parentCommandId']!='0',sourced
 # Hooks keep the initiating request rather than any current/target client.
 call('set-hook','-g','after-send-keys','capture-pane -p -t probe')
 hook_issuer=identified('send','-t','probe','-l','hooked')
 sent,hook=records()[-2:]
 assert sent['issuerId']==hook['issuerId']==hook_issuer
 assert hook['kind']==2 and hook['derivation']==2 and hook['parentCommandId']==sent['commandId'],(sent,hook)
 assert hook['requestId']==sent['requestId']
 call('set-hook','-gu','after-send-keys')
 # Native delayed background command survives departure of its original CLI.
 background_issuer=identified('run-shell','-b','-d','0.1','-C','send-keys -t probe -l delayed')
 until(lambda:records()[-1]['issuerId']==background_issuer)
 delayed=records()[-1]
 assert delayed['derivation']==3 and delayed['parentCommandId']!='0',delayed
 conditional_issuer=identified('if-shell','-b','sleep 0.1; true','send-keys -t probe -l conditional')
 until(lambda:records()[-1]['issuerId']==conditional_issuer)
 assert records()[-1]['derivation']==3 and records()[-1]['parentCommandId']!='0'
 # Control connection identity is stable and distinct from a CLI next to it.
 control=subprocess.Popen([binary,'-S',socket,'-C','attach-session','-t','probe'],env=env,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 children.append(control)
 control.stdin.write('tmux-ide-events -i\nsend-keys -t probe -l controlled\n');control.stdin.flush()
 control_identity=None
 deadline=time.monotonic()+3
 while control_identity is None:
  assert time.monotonic()<deadline
  line=control.stdout.readline()
  if line.startswith('{'): control_identity=json.loads(line)['connectionId']
 until(lambda:records()[-1]['issuerId']==control_identity)
 controlled=records()[-1]
 assert controlled['transport']==2 and controlled['derivation']==0
 separate=identified('send','-t','probe','-l','independent')
 assert separate!=control_identity and records()[-1]['issuerId']==separate
 # A delayed hook retains the initiating issuer across queue yields.
 call('set-hook','-g','after-send-keys','run-shell -d 0.05 -C \"capture-pane -p -t probe\"')
 yielding=identified('send','-t','probe','-l','yielded')
 send_record,capture_record=records()[-2:]
 assert send_record['issuerId']==capture_record['issuerId']==yielding
 assert capture_record['derivation']==1 and capture_record['parentCommandId']!=send_record['commandId']
 call('set-hook','-gu','after-send-keys')
 # A server notification is not attributed to the attached viewer as origin.
 call('set-hook','-g','after-new-window','capture-pane -p -t probe')
 window_issuer=identified('new-window','-d','-t','probe')
 assert records()[-1]['issuerId']==window_issuer
 call('set-hook','-gu','after-new-window')
 call('set-hook','-g','client-detached','capture-pane -t probe:0')
 before=len(records())
 control.terminate(); control.communicate(timeout=3)
 until(lambda:len(records())>before)
 notification=records()[-1]
 assert notification['issuerId']=='0' and notification['transport']==0 and notification['derivation']==2,notification
 call('set-hook','-gu','client-detached')
 # Successful commands still do not claim bytes were consumed by an application.
 call('select-pane','-t','probe:0','-d')
 identified('send','-t','probe:0','-l','disabled-input')
 disabled=records()[-1]; assert disabled['outcome']==1 and disabled['count']=='0'
 call('select-pane','-t','probe:0','-e')
 identified('send','-t','probe:0')
 assert records()[-1]['outcome']==1 and records()[-1]['count']=='0'
 call('set-buffer','private-buffer-must-not-be-journalled')
 identified('paste-buffer','-t','probe:0')
 assert records()[-1]['kind']==3
 identified('send-prefix','-t','probe:0')
 assert records()[-1]['kind']==4
 data=json.dumps(records())
 assert 'private-input' not in data and 'private-buffer' not in data
 assert not list(pathlib.Path(root).glob('asan*')) and not list(pathlib.Path(root).glob('ubsan*'))
 print('native command evidence: direct, alias, error, variants, source, hook, background, control, no content passed')
finally:
 for p in children:
  if p.poll() is None: p.terminate()
  p.communicate(timeout=3)
 subprocess.run([binary,'-S',socket,'kill-server'],env=env,capture_output=True)
 logs=list(pathlib.Path(root).glob('asan*'))+list(pathlib.Path(root).glob('ubsan*'))
 if logs: print('Sanitizer logs retained:',root,file=sys.stderr)
 else: shutil.rmtree(root)
