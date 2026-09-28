#!/usr/bin/env python3
"""Atomic recovery prototype, only private servers and actual control clients."""
import json, os, pathlib, re, select, shlex, shutil, subprocess, sys, tempfile, time, uuid
binary=str(pathlib.Path(sys.argv[1]).resolve())
root=tempfile.mkdtemp(prefix='tmux-ide-atomic-',dir='/tmp');socket=root+'/sock';clients=[]
env=dict(os.environ,TMUX='',ASAN_OPTIONS='detect_leaks=0:halt_on_error=1:log_path='+root+'/asan',UBSAN_OPTIONS='halt_on_error=1:log_path='+root+'/ubsan')
def call(*args,ok=True):
 p=subprocess.run([binary,'-S',socket,*args],env=env,text=True,capture_output=True,timeout=5)
 assert (p.returncode==0)==ok,(args,p.stdout,p.stderr)
 return p.stdout
class Control:
 def __init__(self):
  self.p=subprocess.Popen([binary,'-C','-S',socket,'attach-session','-t','proof'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE);self.buffer=b'';clients.append(self)
  self.execute('display-message -p attached')
 def line(self,deadline):
  while b'\n' not in self.buffer:
   assert time.monotonic()<deadline,('timeout',self.buffer)
   if select.select([self.p.stdout],[],[],.02)[0]:
    data=os.read(self.p.stdout.fileno(),65536)
    assert data,('closed',self.p.poll())
    self.buffer+=data
  data,self.buffer=self.buffer.split(b'\n',1);return data.decode(errors="surrogateescape")
 def execute(self,command):
  token='done-'+uuid.uuid4().hex
  self.p.stdin.write((command+'\ndisplay-message -p '+token+'\n').encode());self.p.stdin.flush()
  lines=[];seen=False;deadline=time.monotonic()+5
  while True:
   try:line=self.line(deadline)
   except Exception as error:raise AssertionError((command,lines)) from error
   lines.append(line)
   if line==token:seen=True
   if seen and (line.startswith('%end ') or line.startswith('%error ')):return lines
 def pause(self):
  return self.execute("refresh-client -A \""+pane+":pause\"")
 def close(self):
  if self.p.poll() is None:self.p.kill();self.p.communicate(timeout=3)
def wrap(body,birth_override=None):
 return shlex.join(['tmux-ide-run','-I','-E',epoch,'-t',pane,'-B',birth_override or birth,'-O',str(uuid.uuid4()),body])
def capture(c,extra='',ok=True,history='-'):
 lines=c.execute(wrap(f'capture-pane -p -R -Q -S {history} -t {pane} '+extra))
 assert any(l.startswith('%error ') for l in lines)!=ok,lines
 return lines
def snapshot(lines):return next(json.loads(l) for l in lines if l.startswith('{"snapshotVersion":'))
try:
 call('-f','/dev/null','new-session','-d','-s','proof','-x','80','-y','24','cat')
 pane,birth=call('display-message','-p','-t','proof','#{pane_id}\t#{pane_birth_id}').strip().split('\t')
 cap=json.loads(call('tmux-ide-events','-e'));epoch=cap['serverEpoch'];journal=cap['journalEpoch']
 assert cap['atomicPaneSnapshot']=='capture-resume-v1'
 a,b=Control(),Control();a.pause();b.pause()
 # No fallback client, raw control command, incompatible flags, bad limit, or
 # pane-identity mismatch may resume anything or produce a successful snapshot.
 call(*shlex.split(wrap(f'capture-pane -p -R -Q -S -10 -t {pane}')),ok=False)
 assert any(l.startswith('%error ') for l in a.execute(f'capture-pane -p -R -Q -S -10 -t {pane}'))
 for flags in ['-U 1','-U 0','-U 16777217','-U 01','-U 18446744073709551615','-J','-P']:
  capture(a,flags,False)
 mismatch=a.execute(wrap(f'capture-pane -p -R -Q -S -10 -t {pane}',str(int(birth)+1)))
 assert any(l.startswith('%error ') for l in mismatch)
 lines=capture(a);meta=snapshot(lines)
 assert meta['paneBirthId']==birth and meta['serverEpoch']==epoch and meta['resumed'] is True
 assert len(meta['cursor'].split())==23
 assert lines.count('%continue '+pane)==1
 # Another client's paused offsets are untouched. Same issuer cannot repeat
 # until paused again; no silently successful not-paused recovery.
 capture(a,ok=False);assert snapshot(capture(b))['resumed'] is True
 # Original grid bytes are identical, and mode slots match the fixed production
 # cursor probe exactly at quiescence (including unknown handling).
 fields=['cursor_x','cursor_y','pane_width','pane_height','alternate_on','cursor_flag','insert_flag','keypad_cursor_flag','keypad_flag','mouse_any_flag','mouse_button_flag','mouse_standard_flag','origin_flag','wrap_flag','history_size','history_limit','bracket_paste_flag','mouse_all_flag','mouse_sgr_flag','mouse_utf8_flag','scroll_region_upper','scroll_region_lower','scroll-on-clear']
 fmt=' '.join('#{?#{==:#{'+f+'},},unknown,#{'+f+'}}' for f in fields)
 a.pause();lines=capture(a)
 assert snapshot(lines)['cursor']==call('display-message','-p','-t',pane,fmt).strip()
 grid='\n'.join(l for l in lines if l.startswith('{"version":') or l.startswith('{"row":'))+'\n'
 assert grid==call('capture-pane','-p','-R','-S','-','-t',pane)
 # Exact byte budget includes the metadata header and all grid rows. Failure
 # at one byte below the boundary leaves the same issuer paused for retry.
 length=sum(len((l+'\n').encode()) for l in lines if l.startswith('{"snapshotVersion":') or l.startswith('{"version":') or l.startswith('{"row":'))
 a.pause();capture(a,'-U '+str(length-1),False)
 assert snapshot(capture(a,'-U '+str(length)))['resumed']
 a.pause();assert snapshot(capture(a,history='-10'))['resumed']
 # Hook captures stay distinct children; the direct snapshot has exactly one
 # direct effect and the hook's ordinary capture cannot steal its proof.
 call('set-hook','-g','after-capture-pane',f'capture-pane -p -t {pane}')
 a.pause();lines=capture(a);call('set-hook','-gu','after-capture-pane')
 ack=next(json.loads(l) for l in lines if l.startswith('{"schemaVersion":2,"type":"operation-identity"'))
 records=json.loads(call('tmux-ide-events','-r','-E',journal,'-a','0'))['records']
 effects=[r for r in records if r['kind']==6 and r['correlation']==ack['operationId']]
 assert len(effects)==2,effects
 assert sum(r['parentCommandId']==ack['wrapperCommandId'] for r in effects)==1,effects
 # A queued command after the recovery/hook group retains its own correct frame.
 follow=a.execute('display-message -p clean-followup')
 assert follow.count('clean-followup')==1 and not any(l.startswith('%error ') for l in follow)
 # Continuous producer: every numbered line occurs exactly once across the
 # native snapshot and subsequent live control output (no interleaving gap).
 producer=pathlib.Path(root)/'producer.py';start=pathlib.Path(root)/'start';progress=pathlib.Path(root)/'progress'
 producer.write_text("import os,time,pathlib\nroot=pathlib.Path("+repr(root)+")\nwhile not (root/'start').exists(): time.sleep(.001)\nfor i in range(500):\n os.write(1,('ATOMIC-%04d\\r\\n'%i).encode())\n (root/'progress').write_text(str(i))\n time.sleep(.0005)\nwhile not (root/'modes').exists(): time.sleep(.001)\nos.write(1,b'\\x1b[?1049h\\x1b[?25l\\x1b[4h\\x1b[?1h\\x1b=\\x1b[?1003h\\x1b[?1006h\\x1b[?2004h\\x1b[3;20r\\x1b[?6h\\x1b[?7lMODE-READY')\nfor stage,prefix,suffix in [('escape',b'\\x1b[',b'31m'),('utf8',b'\\xe7',b'\\x95\\x8c'),('sync',b'\\x1b[?2026h',b'\\x1b[?2026l')]:\n while not (root/stage).exists(): time.sleep(.001)\n os.write(1,prefix)\n while not (root/(stage+'-finish')).exists(): time.sleep(.001)\n os.write(1,suffix+b'STATE-READY-'+stage.encode())\ntime.sleep(60)\n")
 call('new-window','-d','-t','proof','-n','producer',shlex.join([sys.executable,str(producer)]))
 pane,birth=call('display-message','-p','-t','proof:producer','#{pane_id}\t#{pane_birth_id}').strip().split('\t')
 a.pause();start.touch();deadline=time.monotonic()+5
 while not progress.exists() or int(progress.read_text() or '0')<50:
  assert time.monotonic()<deadline;time.sleep(.001)
 lines=capture(a)
 while 'ATOMIC-0499' not in call('capture-pane','-p','-t',pane):
  assert time.monotonic()<deadline;time.sleep(.001)
 lines+=a.execute('display-message -p stream-drained')
 snapshots=[];live=[]
 for line in lines:
  if line.startswith('{"row":'):
   row=json.loads(line);snapshots.append(''.join(bytes.fromhex(cell[2]).decode() for cell in row['cells']))
  elif line.startswith('%output '+pane+' '):
   encoded=line.split(' ',2)[2]
   live.append(re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),encoded))
 observed=[int(n) for n in re.findall(r'ATOMIC-(\d{4})','\n'.join(snapshots)+''.join(live))]
 header=next(json.loads(line) for line in lines if line.startswith('{"version":'))
 assert len(snapshots)==header['history']+header['rows']
 assert observed==list(range(500)),(len(observed),observed[:10],observed[-10:])
 # Alternate screen and nondefault input/rendering modes are extracted at
 # the same instant as grid/cursor; all23slots equal the ordinary fixed probe.
 (pathlib.Path(root)/'modes').touch();deadline=time.monotonic()+5
 while 'MODE-READY' not in call('capture-pane','-p','-t',pane):
  assert time.monotonic()<deadline;time.sleep(.001)
 a.pause();modes=snapshot(capture(a))['cursor']
 assert modes==call('display-message','-p','-t',pane,fmt).strip()
 values=modes.split();assert values[4]=='1' and values[5]=='0' and values[16]=='1',values
 # Already queued output is checked before committing new recovery offsets.
 # One large prior command, not an unbounded request flood.
 a.pause()
 blocked=a.execute('display-message -p '+shlex.quote('x'*70000)+' ; '+wrap(f'capture-pane -p -R -Q -S -10 -t {pane}'))
 assert any(l.startswith('%error ') for l in blocked),blocked[-5:]
 assert '%continue '+pane not in blocked
 assert snapshot(capture(a))['resumed']
 # A grid snapshot cannot restore partial parser state. Each incomplete
 # escape/UTF8/synchronized-output interval must remain paused until completed.
 for stage in ['escape','utf8','sync']:
  (pathlib.Path(root)/stage).touch();deadline=time.monotonic()+3
  while True:
   a.pause();attempt=a.execute(wrap(f'capture-pane -p -R -Q -S -1000 -t {pane}'))
   if any(l.startswith('%error ') for l in attempt):break
   assert time.monotonic()<deadline
  assert '%continue '+pane not in attempt
  (pathlib.Path(root)/(stage+'-finish')).touch()
  while 'STATE-READY-'+stage not in call('capture-pane','-p','-t',pane):
   assert time.monotonic()<deadline;time.sleep(.001)
  assert snapshot(capture(a))['resumed']
 # Dual representation is generated at the same commit, using exact stock
 # -e -J bytes, including control-line normalization and trailing wrapped rows.
 assert cap['atomicPaneSnapshotDual']=='capture-resume-dual-v2'
 samples=[b'', b'one\r\n\r\ntrailing   ',
  (b'wrapped-'+b'x'*210+b'\r\n')*35,
  'wide: 界🙂 é\r\n'.encode()+b'\x1b[38;2;12;34;56mRGB\x1b[48;5;42mBG\x1b[4:3mUL\x1b[0m\tTAB\r\n'+
  b'\x1b]8;;https://example.test/a\x1b\\'+b'LINK'*65+b'\x1b]8;;\x1b\\\r\n'+
  b'%end 1 2 3\r\n%continue %0\r\n{"ansiEnd":true}']
 for sample_no,payload in enumerate(samples):
  script=pathlib.Path(root)/('dual-'+str(sample_no)+'.py')
  script.write_text('import os,time\nos.write(1,'+repr(payload)+')\ntime.sleep(60)\n')
  pane,birth=call('new-window','-d','-P','-F','#{pane_id}\t#{pane_birth_id}','-t','proof',shlex.join([sys.executable,str(script)])).strip().split('\t')
  time.sleep(.08)
  a.pause();lines=capture(a,'-D');meta=snapshot(lines)
  assert meta['snapshotVersion']==2 and meta['representation']=='dual'
  records=[json.loads(l) for l in lines if l.startswith('{')]
  chunks=[r['ansiHex'] for r in records if 'ansiHex' in r]
  assert all(0<len(h)<=8192 and re.fullmatch('[0-9a-f]+',h) for h in chunks)
  assert all(len(h)==8192 for h in chunks[:-1])
  ansi=bytes.fromhex(''.join(chunks));end=next(r for r in records if 'ansiEnd' in r)
  assert end=={'ansiEnd':True,'bytes':len(ansi),'chunks':len(chunks)},end
  stock=subprocess.run([binary,'-S',socket,'capture-pane','-p','-e','-J','-S','-','-t',pane],env=env,capture_output=True,check=True).stdout
  assert ansi==stock,(sample_no,ansi,stock)
  # Actual control reply frames remove exactly one capture terminal newline,
  # then one trailing CR from each line. Plain seed bytes use CRLF joins.
  stock_lines=a.execute('capture-pane -p -e -J -S - -t '+pane)
  begin=next(i for i,l in enumerate(stock_lines) if l.startswith('%begin '))
  finish=next(i for i in range(begin+1,len(stock_lines)) if stock_lines[i]=='%end '+stock_lines[begin][7:])
  # Sentinel-looking terminal bytes are raw in stock capture; our data fixture
  # deliberately uses a non-matching literal frame number for the continuation.
  body=ansi[:-1] if ansi.endswith(b'\n') else ansi
  decoded_seed=b'\r\n'.join(l[:-1] if l.endswith(b'\r') else l for l in body.split(b'\n'))
  actual_seed=b'\r\n'.join(l.removesuffix('\r').encode(errors='surrogateescape') for l in stock_lines[begin+1:finish])
  assert decoded_seed==actual_seed,(sample_no,decoded_seed,actual_seed)
  wire=sum(len((l+'\n').encode()) for l in lines if l.startswith('{"snapshotVersion":') or l.startswith('{"version":') or l.startswith('{"row":') or l.startswith('{"ansi'))+len(('%continue '+pane+'\n').encode())
  a.pause();failed=capture(a,'-D -U '+str(wire-1),False)
  assert '%continue '+pane not in failed
  assert not any(l.startswith('{"snapshotVersion":') for l in failed)
  assert snapshot(capture(a,'-D -U '+str(wire)))['resumed']
  a.pause();assert snapshot(capture(a))['snapshotVersion']==1
  assert any(l.startswith('%error ') for l in a.execute('capture-pane -p -D -t '+pane))
 print('dual snapshot: stock ANSI parity, control seed normalization, hex/chunk framing, exact combined budget, v1 compatibility passed')
 assert not list(pathlib.Path(root).glob('asan.*')) and not list(pathlib.Path(root).glob('ubsan.*'))
 print('atomic snapshot: strict origin/guards/flags/bounds, issuer-only resume, exact grid/modes, hook lineage/framing, cap edge/backlog, continuous output, parser boundary passed')
finally:
 for c in clients:c.close()
 try:call('kill-server')
 except Exception:pass
 shutil.rmtree(root)
