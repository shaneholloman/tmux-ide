#!/usr/bin/env python3
"""Protected exact-session guard parity with the captured ALS name/id/seconds tuple."""
import json, os, pathlib, shlex, subprocess, sys, tempfile, uuid, shutil
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-session-guard-',dir='/tmp');socket=root+'/s'
env=dict(os.environ,ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
def run(*args,ok=True):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=8)
 assert (p.returncode==0)==ok,(args,p.stdout,p.stderr)
 return p.stdout

def identity(name):return run('display-message','-p','-t','='+name+':','#{session_id}\t#{session_created}').strip().split('\t')
def wrapper(name,ident,created,body):return ['tmux-ide-run','-I','-E',epoch,'-s',name,'-S',ident,'-C',created,'-O',str(uuid.uuid4()),body]
def yielded(body,mutation):
 name='selected';ident,created=identity(name);channel='session-'+uuid.uuid4().hex
 cli=shlex.join([binary,'-S',socket]);script=f'{cli} wait-for -S {channel}-entered; {cli} wait-for {channel}-continue'
 run('set-hook','-g','after-set-buffer','run-shell '+shlex.quote(script))
 p=subprocess.Popen([binary,'-S',socket,*wrapper(name,ident,created,body)],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 try:
  run('wait-for',channel+'-entered');mutation();run('wait-for','-S',channel+'-continue')
  out,err=p.communicate(timeout=8)
  return p.returncode,out,err
 finally:
  run('set-hook','-gu','after-set-buffer')
  if p.poll() is None:p.kill();p.wait()
try:
 run('-f','/dev/null','new-session','-d','-s','keep','cat')
 run('new-session','-d','-s','selected','cat')
 cap=json.loads(run('tmux-ide-events','-e'));epoch=cap['serverEpoch']
 assert cap['ownedOperationSessionGuard']=='direct-session-v1'
 ident,created=identity('selected')
 # Exact name/id/creation seconds and whole trio are checked before parse/effects/ack.
 for name,sid,seconds in [('missing',ident,created),('selected','$4294967295',created),('selected',ident,str(int(created)+1)),('selected',ident,'01'),('x'*4097,ident,created)]:
  assert run(*wrapper(name,sid,seconds,'TMUX_IDE_SESSION_PARSE=bad ; set-buffer -b forbidden x'),ok=False)==''
 run('show-buffer','-b','forbidden',ok=False)
 assert 'TMUX_IDE_SESSION_PARSE=' not in run('show-environment','-g')
 for tail in [['-s','selected'],['-S',ident,'-C',created],['-s','selected','-S',ident]]:
  run('tmux-ide-run','-I','-E',epoch,*tail,'-O',str(uuid.uuid4()),'set-buffer -b forbidden x',ok=False)
 # Same context permits a different session's pane: no new membership requirement.
 capture=run('capture-pane','-p','-t','keep')
 out=run(*wrapper('selected',ident,created,'capture-pane -p -t keep'))
 assert out.split('\n',1)[1]==capture
 # Empty body, parse error and over-capacity bodies free their bounded guard state.
 run(*wrapper('selected',ident,created,''))
 run(*wrapper('selected',ident,created,'not-a-command'),ok=False)
 run(*wrapper('selected',ident,created,' ; '.join(['set-buffer -b forbidden x']*65)),ok=False)
 run('show-buffer','-b','forbidden',ok=False)
 # Rename while earlier child hook yields prevents the remaining command.
 rc,out,err=yielded('set-buffer -b first x ; set-buffer -b forbidden x',lambda:run('rename-session','-t','selected','renamed'))
 assert rc!=0,(out,err);run('show-buffer','-b','forbidden',ok=False)
 run('rename-session','-t','renamed','selected')
 # Rename away and back before the next child preserves the exact old semantics.
 def roundtrip():run('rename-session','-t','selected','renamed');run('rename-session','-t','renamed','selected')
 # Use a non-hook-triggering second command to keep one deterministic gate.
 rc,out,err=yielded('set-buffer -b first x ; capture-pane -p -t keep',roundtrip)
 assert rc==0,(out,err)
 # Reusing the name does not reuse session ID, even within the same timestamp second.
 def replacement():run('kill-session','-t','selected');run('new-session','-d','-s','selected','cat')
 rc,out,err=yielded('set-buffer -b first x ; set-buffer -b forbidden x',replacement)
 assert rc!=0,(out,err);run('show-buffer','-b','forbidden',ok=False)
 # Unrelated hook descendants execute normally against another session.
 ident,created=identity('selected');run('set-hook','-g','after-set-buffer','capture-pane -p -t keep')
 run(*wrapper('selected',ident,created,'set-buffer -b hook x ; capture-pane -p -t selected'))
 run('set-hook','-gu','after-set-buffer')
 # A direct WAIT owns guard references until continuation; changed session is rechecked.
 channel='direct-'+uuid.uuid4().hex
 p=subprocess.Popen([binary,'-S',socket,*wrapper('selected',ident,created,f'wait-for -S {channel}-entered ; wait-for {channel}-continue ; set-buffer -b forbidden x')],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 run('wait-for',channel+'-entered');run('rename-session','-t','selected','renamed');run('wait-for','-S',channel+'-continue');out,err=p.communicate(timeout=8)
 assert p.returncode!=0,(out,err);run('show-buffer','-b','forbidden',ok=False)
 run('rename-session','-t','renamed','selected')
 # Disconnect a WAIT client, then retire its session and release the queue.
 channel='cancel-'+uuid.uuid4().hex;ident,created=identity('selected')
 p=subprocess.Popen([binary,'-S',socket,*wrapper('selected',ident,created,f'wait-for -S {channel}-entered ; wait-for {channel}-continue ; capture-pane -p -t keep')],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 run('wait-for',channel+'-entered');p.kill();p.communicate(timeout=8)
 run('kill-session','-t','selected');run('wait-for','-S',channel+'-continue')
 assert run('display-message','-p','alive').strip()=='alive'
 assert not list(pathlib.Path(root).glob('asan.*')) and not list(pathlib.Path(root).glob('ubsan.*'))
 print('native session guard: exact tuple, bounded name/commands, cross-session pane, rename/recreate yields, hook parity, WAIT/disconnect/death cleanup passed')
finally:
 try:run('kill-server')
 except Exception:pass
 shutil.rmtree(root)
