import importlib.util,json,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('middleware',Path(__file__).resolve().parents[1]/'middleware-config.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 root=Path(d);m.ROOT=root;p=root/'compose.yml';p.write_text('services:\n  probe:\n    image: busybox:1.37\n');g={'compose':p,'paths':{p},'containers':[]}
 values,manifest=m.values_for(g);assert m.apply(g,values)==0;print('PASS unchanged vault produces no writes')
 bad=dict(values);bad['FILES_MANIFEST_JSON']=json.dumps({'COMPOSE_YAML':{'path':'/etc/passwd','mode':384,'uid':0,'gid':0}})
 try:m.apply(g,bad,True);raise AssertionError('invalid path accepted')
 except RuntimeError:print('PASS altered manifest rejected')
 bad=dict(values);bad['COMPOSE_YAML']='services: ['
 try:m.apply(g,bad,True);raise AssertionError('invalid compose accepted')
 except Exception:assert p.read_text()==values['COMPOSE_YAML'];print('PASS invalid Compose rolled back to original file')
 changed=dict(values);changed['COMPOSE_YAML']=p.read_text()+'# vault verification\n';assert m.apply(g,changed,True)==1;assert p.read_text()==changed['COMPOSE_YAML'];assert m.apply(g,changed,True)==0;print('PASS valid edit applied and repeat is idempotent')
