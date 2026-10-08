#!/usr/bin/env python3
"""Render actual DSH onboarding/provider picker components with isolated data.

The model/catalog and credential services are fixtures; React, DSH primitives,
components, dictionaries and Android CSS are the production bundle. No profile
or real key is read/written. --prepare-only also supports physical WebView QA.
"""
import argparse
import functools
import http.server
import json
from pathlib import Path
import re
import shutil
import threading

p = argparse.ArgumentParser()
p.add_argument("package", type=Path)
p.add_argument("--fixture-dir", type=Path, required=True)
p.add_argument("--prepare-only", action="store_true")
a = p.parse_args()
dist = a.package / "node_modules/@deepseek-ai/dsh-web-frontend/dist"
out = a.fixture_dir
out.mkdir(parents=True, exist_ok=True)
index = (dist / "index.html").read_text()
entry = re.search(r'src="\./assets/(index-[^"]+\.js)"', index)[1]
css = re.search(r'href="\./assets/(index-[^"]+\.css)"', index)[1]
source = (dist / "assets" / entry).read_text()
assert source.count("const fo = globalThis.dshDesktopBoot,") == 1
assert source.count("function rM() {") == 1
(out / "qa-entry.js").write_text(source.split("const fo = globalThis.dshDesktopBoot,")[0] + "\nwindow.qaSeeds = rM();\n")
for vendor in re.findall(r'from "\./([^"/]+\.js)"', source):
    shutil.copyfile(dist / "assets" / vendor, out / vendor)
for name in [css, "vendor-BNsW4eBh.css", "dsh-android-mobile-navigation.js", "dsh-webview83-polyfills.js"]:
    # Patching inputs may omit unchanged assets: pass a complete staged package.
    shutil.copyfile(dist / "assets" / name, out / name)
models = (a.package / "node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js").read_text()
assert models.count("    exports.apply = apply;") == 1
models = models.replace("    exports.apply = apply;", "    exports.qa = { DeepSeekOnboardingDialog, ModelListEditor, en, zh };\n    exports.apply = apply;")
(out / "qa-models.js").write_text(models)
theme = (a.package / "node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js").read_text()
assert theme.count("    exports.apply = apply;") == 1
(out / "qa-theme.js").write_text(theme.replace("    exports.apply = apply;", "    exports.qaStyles = STYLES;\n    exports.apply = apply;"))
html = '''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="dsh-android-mobile-navigation.js"></script>
<script src="dsh-webview83-polyfills.js"></script>
<link rel="stylesheet" href="vendor-BNsW4eBh.css"><link rel="stylesheet" href="CSS">
</head><body><div id="root"></div><script type="module">
import './qa-entry.js';
(async function () {
window.__ModuleLoader__ = {load: row => {const value = row.factory(name => {
 if (!(name in window.qaSeeds)) throw Error('Missing actual seed ' + name);
 return window.qaSeeds[name];
}); if(row.id.endsWith('dsh-client-ui-theme')) window.qaTheme=value; else window.qaModels=value}};
await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='qa-models.js';s.onload=resolve;s.onerror=reject;document.head.append(s)});
await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='qa-theme.js';s.onload=resolve;s.onerror=reject;document.head.append(s)});
for(const [name,css] of qaTheme.qaStyles){const s=document.createElement('style');s.dataset.qaTheme=name;s.textContent=css;document.head.append(s)}
const React=qaSeeds.react, h=React.createElement, M=qaModels.qa;
const emptySchema={type:'object',dict:{},meta:{}};
const schema={getPath:(o,path)=>path.reduce((v,k)=>v&&v[k],o),rehydrate:s=>s,nodeAtPath:()=>emptySchema,
 hasPath:()=>false,setPath:(o,path,value)=>({...o,[path[0]]:value}),deletePath:(o,path)=>{const n={...o};delete n[path[0]];return n}};
const namespace={ns:'llm-deepseek',schema:emptySchema,user:{},value:{},base:{},revision:1};
const state={status:'loaded',writable:true,credentialError:null,rows:[{entry:{provider:'deepseek-official',displayName:'DeepSeek',settingsNs:'llm-deepseek',settingsPath:[],active:true},apiKeyEnv:'DEEPSEEK_API_KEY',credential:{configured:false,writable:true}}],namespaces:new Map([['llm-deepseek',namespace]])};
const candidates=Array.from({length:500},(_,i)=>({id:'qa-model-'+String(i).padStart(4,'0'),name:'Fixture model '+i}));
const operations={describeCredential:async()=>({configured:false,writable:true}),storeCredential:async()=>{throw Error('QA cannot store credentials')},discoverModels:async()=>({kind:'found',models:candidates})};
const t=key=>{const d=document.documentElement.lang==='zh'?M.zh:M.en;if(!(key in d))throw Error('Unknown translation '+key);return d[key]};
function Fixture(){
 const [mode,setMode]=React.useState('key'),[models,setModels]=React.useState([]);
 window.qaMode=setMode;window.qaSelected=models.map(m=>m.id);
 return h(React.Fragment,null,h('span',{'data-qa-root':'',hidden:true}),mode==='key'?h(M.DeepSeekOnboardingDialog,{complete:()=>setMode('models'),automatic:true,explicit:true,controller:{load(){}},useModels:fn=>fn(state),schema,operations,t,renderSlot:(_name,_props,options)=>options.fallback}):
 h(M.ModelListEditor,{models,onChange:setModels,probe:{settingsNs:'llm-pi-ai',baseURL:'https://fixture.invalid/v1',api:'openai-completions'},operations,t,onBusyChange:()=>{},disabled:false}));
}
window.qaRoot=qaSeeds['react-dom/client'].createRoot(document.getElementById('root'));
qaRoot.render(h(Fixture));
})();
</script></body></html>'''.replace("CSS", css)
(out / "qa.html").write_text(html)
if a.prepare_only:
    print(json.dumps({"fixture": str(out / "qa.html"), "upstreamModels": 500, "services": "isolated", "components": "production"}))
    raise SystemExit
from playwright.sync_api import sync_playwright
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(out)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width":360,"height":568}, has_touch=True)
        errors=[]
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"http://127.0.0.1:{server.server_port}/qa.html")
        page.locator('.jLrgrW_dialog input[type=password]').wait_for()
        assert page.locator('body').evaluate("e=>getComputedStyle(e).getPropertyValue('--dsw-alias-bg-layer-2').trim()")
        def box(): return page.locator('.jLrgrW_dialog').bounding_box()
        initial=box()
        for _ in range(3):
            page.set_viewport_size({"width":360,"height":300})
            assert box()['y']>=0
            page.set_viewport_size({"width":360,"height":568})
            assert abs(box()['y']-initial['y'])<2
        page.evaluate("qaMode('models')")
        page.get_by_role('button',name='Fetch available models').click()
        picker=page.locator('.zGbnIq_fetchDialog');picker.wait_for()
        assert page.locator('.zGbnIq_candidate').count()==500
        metrics=page.locator('.zGbnIq_candidateList').evaluate("e=>({height:e.clientHeight,scroll:e.scrollHeight,card:getComputedStyle(e.closest('[role=dialog]')).overflowY})")
        assert metrics['height']>100 and metrics['scroll']>metrics['height']*10
        assert metrics['card']=='hidden'
        page.get_by_role('button',name='Deselect all',exact=True).click()
        page.locator('.zGbnIq_candidateList').evaluate("e=>e.scrollTop=12000")
        assert page.locator('.zGbnIq_candidateList').evaluate("e=>e.scrollTop")>10000
        page.get_by_role('searchbox').fill('qa-model-0499')
        assert page.locator('.zGbnIq_candidate').count()==1
        page.get_by_role('checkbox').check()
        page.get_by_role('button',name='Add selected').click()
        page.wait_for_function("JSON.stringify(qaSelected) === '[\"qa-model-0499\"]'")
        assert not errors, errors
        browser.close()
        print(json.dumps({"onboardingResizeCycles":3,"models":500,"picker":metrics,"selection":"last upstream model retained","pageErrors":errors}))
finally:
    server.shutdown()
