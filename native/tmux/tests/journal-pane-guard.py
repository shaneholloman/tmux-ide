#!/usr/bin/env python3
"""Direct-child physical pane guard survives hook yields; descendants stay ordinary."""
import json, os, pathlib, shlex, subprocess, sys, tempfile, time, uuid, shutil
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-pane-guard-',dir='/tmp');socket=root+'/s'
env=dict(os.environ,ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
def run(*args,ok=True):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=8)
 assert (p.returncode==0)==ok,(args,p.stdout,p.stderr)
 return p.stdout

def identity(target):return run('display-message','-p','-t',target,'#{pane_id}\t#{pane_birth_id}').strip().split('\t')
def wrapper(pane,birth,body,op=None):return ['tmux-ide-run','-I','-E',epoch,'-t',pane,'-B',birth,'-O',op or str(uuid.uuid4()),body]
def records(op):return [r for r in json.loads(run('tmux-ide-events','-r','-E',journal,'-a','0'))['records'] if r['correlation']==op]
def yielded(hook,pane,birth,body,mutation):
 # Distinct channels per case and one waiting hook; no sleeps/racy timing.
 channel='guard-'+uuid.uuid4().hex
 cli=shlex.join([binary,'-S',socket])
 script=f'{cli} wait-for -S {channel}-entered; {cli} wait-for {channel}-continue'
 run('set-hook','-g',hook,'run-shell '+shlex.quote(script))
 op=str(uuid.uuid4());p=subprocess.Popen([binary,'-S',socket,*wrapper(pane,birth,body,op)],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 try:
  run('wait-for',channel+'-entered');mutation();run('wait-for','-S',channel+'-continue')
  out,err=p.communicate(timeout=8)
  return p.returncode,out,err,records(op)
 finally:
  run('set-hook','-gu',hook)
  if p.poll() is None:p.kill();p.wait()
try:
 run('-f','/dev/null','new-session','-d','-s','proof','-n','keep','cat')
 cap=json.loads(run('tmux-ide-events','-e'));epoch=cap['serverEpoch'];journal=cap['journalEpoch']
 assert cap['ownedOperationPaneGuard']=='direct-pane-v1'
 run('new-window','-d','-t','proof','-n','victim','cat');pane,birth=identity('proof:victim')
 # Wrong birth is rejected before the first non-pane mutation and acknowledgement.
 assert run(*wrapper(pane,str(int(birth)+1),'set-buffer -b forbidden nope'),ok=False)==''
 run('show-buffer','-b','forbidden',ok=False)
 for tail in [['-t',pane],['-B',birth],['-t',pane,'-B','0'],['-t',pane,'-B','01']]:
  run('tmux-ide-run','-I','-E',epoch,*tail,'-O',str(uuid.uuid4()),'set-buffer -b forbidden nope',ok=False)
 other,otherbirth=identity('proof:keep')
 # A direct command naming another physical pane never captures or injects there.
 op=str(uuid.uuid4());run(*wrapper(pane,birth,'capture-pane -p -t '+other,op),ok=False)
 assert not any(r['kind']==6 for r in records(op))
 op=str(uuid.uuid4());run(*wrapper(pane,birth,'send-keys -l -t '+other+' forbidden',op),ok=False)
 assert not any(r['kind']==5 for r in records(op))
 for mode in ['-K','-M']:
  run(*wrapper(pane,birth,'send-keys '+mode+' -t '+pane+' x'),ok=False)
 # Linked session aliases are acceptable if they resolve the exact physical pane.
 run('new-session','-d','-s','alias','cat');run('link-window','-s','proof:victim','-t','alias:1')
 output=run(*wrapper(pane,birth,'capture-pane -p -t alias:1'))
 assert output.split('\n',1)[1]==run('capture-pane','-p','-t',pane)
 run('unlink-window','-t','alias:1')
 # Moving a pane while a hook yields preserves birth and is permitted.
 def move():run('break-pane','-d','-s',pane,'-t','proof:')
 run('split-window','-d','-t',pane,'cat')
 rc,out,err,rows=yielded('after-set-buffer',pane,birth,'set-buffer -b moving x ; capture-pane -p -t '+pane,move)
 assert rc==0,(out,err)
 assert any(r['kind']==6 and r['targetBirthId']==birth for r in rows)
 # Deletion/replacement after a yielded hook stops even a non-pane next child.
 def replace():
  run('kill-pane','-t',pane);run('new-window','-d','-t','proof','-n','replacement','cat')
 rc,out,err,rows=yielded('after-set-buffer',pane,birth,'set-buffer -b first x ; set-buffer -b forbidden nope ; send-keys -t proof:replacement Enter',replace)
 assert rc!=0,(out,err)
 run('show-buffer','-b','forbidden',ok=False)
 assert not any(r['kind'] in [5,6] for r in rows)
 # Partial paste is observed, but loss during its hook must prevent the Enter.
 run('new-window','-d','-t','proof','-n','partial','cat');pane,birth=identity('proof:partial');run('set-buffer','-b','partial','abc')
 rc,out,err,rows=yielded('after-paste-buffer',pane,birth,'paste-buffer -b partial -t '+pane+' ; send-keys -t proof:keep Enter',lambda:run('kill-pane','-t',pane))
 assert rc!=0 and any(r['kind']==5 and int(r['count'])==3 for r in rows),(out,err,rows)
 assert not any(r['kind']==1 and r['outcome']==1 for r in rows)
 # Hook descendants can target other panes; their different parent remains visible.
 pane,birth=identity('proof:keep');run('set-hook','-g','after-set-buffer','capture-pane -p -t alias:0')
 op=str(uuid.uuid4());run(*wrapper(pane,birth,'set-buffer -b hook x ; capture-pane -p -t '+pane,op));run('set-hook','-gu','after-set-buffer')
 rows=records(op);assert len([r for r in rows if r['kind']==6])==2
 assert len(set(r['parentCommandId'] for r in rows if r['kind']==6))==2
 # Synchronization fans out inside one command. Physical effect records stay exact;
 # downstream permits only match the requested birth and leave other effects unknown.
 run('split-window','-d','-t',pane,'cat');run('set-window-option','-t',pane,'synchronize-panes','on')
 op=str(uuid.uuid4());run(*wrapper(pane,birth,'send-keys -l -t '+pane+' x',op))
 effects=[r for r in records(op) if r['kind']==5]
 assert len(effects)==2 and len(set(r['targetBirthId'] for r in effects))==2,effects
 assert not list(pathlib.Path(root).glob('asan.*')) and not list(pathlib.Path(root).glob('ubsan.*'))
 print('native pane guard: stale birth, paired flags, wrong target, linked alias, yielded move/replacement, partial paste, hook descendants, sync fanout passed')
finally:
 try:run('kill-server')
 except Exception:pass
 shutil.rmtree(root)
