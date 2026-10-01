"""Rebuild index.html from the source: python scripts/build.py"""
from pathlib import Path
from html import escape
import json

root=Path(__file__).resolve().parents[1]
src=root/'src'
vendor=root/'vendor'
library=(vendor/'cannon-es.cjs').read_text(encoding='utf-8')
library=library.replace("const performance = require('perf_hooks') && require('perf_hooks').performance || {};",'const performance = self.performance;')
library='// cannon-es 0.20.0 | https://github.com/pmndrs/cannon-es\n'+(vendor/'cannon-LICENSE.txt').read_text(encoding='utf-8')+'\n'+library
worker='const CANNON=(()=>{const exports={};\n'+library+'\nreturn exports;})();\n'
for name in ['fluid-core.js','physics-core.js','bubble-core.js','simulation-worker.js']:
    worker+=(src/name).read_text(encoding='utf-8')+'\n'
fragment=(src/'interface.html').read_text(encoding='utf-8')
fragment=fragment.replace('/* WORKER_SOURCE */',json.dumps(worker))
fragment=fragment.replace('/* SIMULATION_CLIENT */',(src/'simulation-client.js').read_text(encoding='utf-8'))
fragment=fragment.replace('/* FRAGMENT_SHADER */',json.dumps((src/'ball.frag').read_text(encoding='utf-8')))
template=(src/'page-template.html').read_text(encoding='utf-8')
assert template.count('<!-- MAGIC_EIGHT_BALL_FRAGMENT -->')==1
output=template.replace('<!-- MAGIC_EIGHT_BALL_FRAGMENT -->',escape(fragment))
(root/'index.html').write_text(output,encoding='utf-8',newline='\n')
print(f'Built index.html ({len(output.encode("utf-8")):,} bytes)')
