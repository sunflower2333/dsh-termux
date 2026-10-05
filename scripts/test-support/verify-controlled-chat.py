#!/usr/bin/env python3
"""Verify the real DSH chat UI against the loopback Messages fixture.

Requires Python Playwright and Chromium. Use a disposable DSH test HOME:
this script edits provider settings, stores the fixture credential, and creates
persistent test sessions. It never prints auth URLs, HTTP bodies, or credentials.
It does not execute an Android Activity/WebView or call a real DeepSeek model.
"""
from pathlib import Path
import argparse, json, re, sys, time, traceback
from playwright.sync_api import sync_playwright, expect

def require(value, message):
    if not value: raise AssertionError(message)
PUBLIC_FAILURES = {
    'Expected loopback-only controlled Messages fixture metadata',
    'Models did not expose editor or configured card',
    'Settings repeatedly closed before provider configuration',
    'new-session composer did not become editable',
    'default mode unexpectedly changed before Send',
    'document overflows viewport', 'touch target smaller than 44px',
    'native bash tool not advertised', 'fixture did not finish multiple SSE frames',
    'stream continued changing after Stop', 'fixture did not observe stream cancellation',
    'approval touch target smaller than 44px', 'missing default/fallback/result model rounds',
    'default sandbox failure not observed', 'escalated tool result not observed',
    'tool result does not match actual approval choice',
    'one-time approval changed default mode', 'page errors occurred',
    'console errors occurred',
}

def redact(value):
    # Error text can contain HTTP bodies, arbitrary credentials, or Playwright's
    # complete accessibility tree. Persist only our own fixed assertion labels.
    value = str(value)
    return value if value in PUBLIC_FAILURES else '[free-form diagnostic omitted]'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url-file', type=Path, required=True, help='Private file containing the authenticated real DSH URL; its contents are never printed.')
    parser.add_argument('--fixture-file', type=Path, required=True, help='server.json written by messages-fixture-server.py.')
    parser.add_argument('--output-dir', type=Path, default=Path('build/controlled-chat-check'))
    parser.add_argument('--chromium', default='/usr/bin/chromium', help='Installed Chromium executable.')
    parser.add_argument('--phases',default='text,stop,queue,allow,reject')
    args=parser.parse_args(); args.output_dir.mkdir(parents=True,exist_ok=True)
    fixture=json.loads(args.fixture_file.read_text()); phases=args.phases.split(',')
    if not phases or any(phase not in {'text', 'stop', 'queue', 'allow', 'reject'} for phase in phases):
        parser.error('--phases must select text,stop,queue,allow,reject')
    require(fixture.get('fixture') is True and fixture.get('real_deepseek') is False and fixture.get('host') == '127.0.0.1', 'Expected loopback-only controlled Messages fixture metadata')
    report={'controlledLocalSseOnly':True,'realDeepSeekModel':False,'realBackend':'Supplied DSH backend; OS/architecture are not inspected by this UI script',
            'browser':'Chromium portrait 360x800; this is not Android Activity/WebView execution',
            'fixturePort':fixture['port'],'phases':phases,'notCovered':['Android Activity/WebView, app UID, IME and app lifecycle','Real DeepSeek inference or real API credential validity','Completion of queued follow-up after stopping the initial response','Documents, terminal and Android file dialogs'],'checks':[],'pageErrors':[],'consoleErrors':[],'screenshots':[],'sessions':{}}
    log_path=Path(fixture['request_log'])
    def logs(since=0):
        return [r for r in (json.loads(line) for line in log_path.read_text().splitlines()) if r.get('time_ns',0)>=since] if log_path.exists() else []
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox'])
        context=browser.new_context(viewport={'width':360,'height':800},is_mobile=True,has_touch=True)
        page=context.new_page(); page.set_default_timeout(30000)
        page.on('pageerror',lambda e:report['pageErrors'].append({'type':'JavaScriptError'}))
        page.on('console',lambda m:report['consoleErrors'].append({'type':'console.error'}) if m.type=='error' else None)
        def dismiss_onboarding(button):
            report.setdefault('onboardingDismissals',[]).append({'label':button.inner_text(),'timeNs':time.time_ns()})
            button.click()
        for label in (r'^(Continue|继续)$',r'^(Configure later|稍后配置)$'):
            page.add_locator_handler(page.get_by_role('button',name=re.compile(label)),dismiss_onboarding)
        dialog=page.locator('[data-shortcut-modal="settings"]')
        composer=page.locator('[data-composer-input]')
        def save_report(): (args.output_dir/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        def check(name, **facts): report['checks'].append({'name':name,'passed':True,**facts});save_report()
        def snap(name):
            page.locator('body').click(trial=True)
            page.screenshot(path=str(args.output_dir/f'{name}.png'))
            report['screenshots'].append(f'{name}.png');save_report()
        def ready():
            composer.wait_for(state='visible',timeout=60000)
            page.locator('[data-slot="settings.launcher"] button').click(trial=True)
        def open_settings():
            page.locator('[data-slot="settings.launcher"] button').click();expect(dialog).to_be_visible()
        def close_settings():
            dialog.get_by_role('button',name=re.compile(r'^(Close|关闭)$')).click();expect(dialog).to_be_hidden()
        def configure(scenario):
            # Upstream late onboarding can close Settings while Configure later
            # is clicked by an action handler. Wait for either the real editor
            # or configured card and reopen only when the dialog actually closed.
            for attempt in range(3):
                report['lastUiAction']='Open Settings Models'
                try:
                    open_settings(); dialog.get_by_role('button',name='Models',exact=True).click(timeout=5000)
                except Exception:
                    if not dialog.is_visible():
                        report.setdefault('onboardingSettingsReopened',0);report['onboardingSettingsReopened']+=1;continue
                    raise
                key=dialog.get_by_label('API key',exact=True)
                edit=dialog.get_by_role('button',name=re.compile(r'^Edit DeepSeek(?: \(deepseek-official\))?$'))
                deadline=time.monotonic()+30
                while not key.is_visible() and not edit.is_visible() and dialog.is_visible():
                    require(time.monotonic()<deadline,'Models did not expose editor or configured card')
                    page.wait_for_timeout(100)
                if not dialog.is_visible():
                    report.setdefault('onboardingSettingsReopened',0);report['onboardingSettingsReopened']+=1;continue
                try:
                    report['lastUiAction']='Edit fixture provider credential'
                    if not key.is_visible(): edit.click(timeout=5000)
                    key.fill('dsh-loopback-test-key',timeout=5000)
                except Exception:
                    if not dialog.is_visible():
                        report.setdefault('onboardingSettingsReopened',0);report['onboardingSettingsReopened']+=1;continue
                    raise
                details=dialog.locator('details').first
                if details.get_attribute('open') is None: details.locator('summary').click()
                base=dialog.get_by_label('Base URL',exact=True)
                report['lastUiAction']='Apply fixture provider configuration'
                base.fill(fixture['scenario_base_urls'][scenario])
                dialog.get_by_role('button',name='Apply',exact=True).click()
                expect(key).to_be_hidden(timeout=60000)
                expect(edit).to_be_visible(timeout=60000)
                if dialog.is_visible(): close_settings()
                # Provider settings restart their Cordis client dependencies.
                # Reload after saving so the next session uses the persisted
                # configuration and fully rebuilt client, as a fresh launch does.
                report['lastUiAction']='Reload saved provider configuration'
                page.reload(wait_until='domcontentloaded',timeout=60000);ready();sidebar_close();return
            raise AssertionError('Settings repeatedly closed before provider configuration')
        def new_session(prompt):
            report['lastUiAction']='New session'
            page.get_by_role('button',name='New session',exact=True).click()
            expect(page.get_by_text('Into the Unknown',exact=False).last).to_be_visible(timeout=30000)
            report['lastUiAction']='Choose or restore Default workspace'
            # Fresh clients can restore the saved default before the chooser
            # appears. Accept that real selection; otherwise choose it in UI.
            deadline=time.monotonic()+60
            while composer.get_attribute('contenteditable')!='true':
                choose=page.get_by_role('button',name='Choose workspace',exact=True)
                if choose.is_visible():
                    choose.click()
                    page.get_by_role('menuitem',name='Default workspace',exact=True).click()
                    break
                require(time.monotonic()<deadline,'new-session composer did not become editable')
                page.wait_for_timeout(100)
            expect(composer).to_have_attribute('contenteditable','true',timeout=60000)
            require(page.get_by_role('button',name='Access mode, current: Workspace Write',exact=True).count()==1,'default mode unexpectedly changed before Send')
            report['lastUiAction']='Send controlled fixture prompt'
            composer.fill(prompt);page.get_by_role('button',name='Send message',exact=True).click()
        def final_text(text, timeout=60000):
            expect(page.get_by_text(text,exact=True).last).to_be_visible(timeout=timeout)
            expect(page.get_by_role('button',name='Stop generating',exact=True)).to_have_count(0,timeout=timeout)
        def sidebar_open():
            if page.get_by_role('button',name='Open sidebar',exact=True).count(): page.get_by_role('button',name='Open sidebar',exact=True).click()
            expect(page.get_by_role('button',name='Collapse sidebar',exact=True)).to_be_visible()
        def sidebar_close():
            collapse=page.get_by_role('button',name='Collapse sidebar',exact=True)
            if collapse.is_visible(): collapse.click()
        def session_id(name):
            sidebar_open(); selected=page.locator('[data-row-key^="session:"][aria-selected="true"]')
            expect(selected).to_have_count(1)
            sid=selected.get_attribute('data-row-key').removeprefix('session:')
            report['sessions'][name]=sid;sidebar_close();save_report();return sid
        def history_reload(sid, prompt, reply):
            page.reload(wait_until='domcontentloaded',timeout=60000);ready()
            sidebar_open();item=page.locator(f'[data-row-key="session:{sid}"]')
            expect(item).to_be_visible(timeout=60000);item.click(position={'x':60,'y':10});sidebar_close()
            expect(page.get_by_text(prompt,exact=True)).to_be_visible(timeout=60000)
            expect(page.get_by_text(reply,exact=True).last).to_be_visible(timeout=60000)
        def viewport_bounds(name):
            layout=page.evaluate('''() => ({width:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth,
              targets:[...document.querySelectorAll('[data-slot="sidebar"] button, [data-composer-card] button')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({name:e.getAttribute('aria-label')||e.innerText,rect:e.getBoundingClientRect().toJSON()}))})''')
            require(layout['html']<=layout['width']+1 and layout['body']<=layout['width']+1,'document overflows viewport')
            for target in layout['targets']:
                require(target['rect']['width']>=44 and target['rect']['height']>=44,'touch target smaller than 44px')
            check(name,layout=layout)
        try:
            report['activePhase']='initial preferences'
            page.goto(args.url_file.read_text().strip(),wait_until='domcontentloaded',timeout=60000);ready()
            open_settings();dialog.get_by_role('button',name=re.compile(r'^(General|通用)$')).click()
            language=dialog.get_by_role('button',name=re.compile(r'^(English|中文)$'))
            if language.inner_text()!='English':
                language.click();page.get_by_role('menuitem',name='English',exact=True).click()
            close_settings();sidebar_close()
            if 'text' in phases:
                report['activePhase']='text'
                configure('text');start=time.time_ns();prompt='Android UI controlled text and history probe'
                new_session(prompt);reply='本地受控 Messages 流式响应正常。';final_text(reply)
                rows=logs(start);received=[r for r in rows if r['event']=='request_received' and r.get('scenario')=='text' and r.get('tool_names')]
                require(received and 'bash' in received[0]['tool_names'],'native bash tool not advertised')
                completed=[r for r in rows if r['event']=='stream_finished' and r['request_id'] in {request['request_id'] for request in received}]
                require(completed and all(r['chunks']>1 for r in completed),'fixture did not finish multiple SSE frames')
                check('real UI send, native tool catalog and streamed body',requestIds=[r['request_id'] for r in received],sseFrameCounts=[r['chunks'] for r in completed])
                sid=session_id('text');snap('conversation-text-360');viewport_bounds('conversation text portrait layout')
                history_reload(sid,prompt,reply);check('persisted session visible and history replayed after browser reload',sessionId=sid);snap('history-reloaded-360')
            if 'stop' in phases:
                report['activePhase']='stop'
                configure('longstream');start=time.time_ns();new_session('Android UI controlled Stop probe')
                expect(page.get_by_text(re.compile(r'受控流式片段 1。')).last).to_be_visible(timeout=60000)
                expect(page.get_by_role('button',name='Stop generating',exact=True)).to_be_visible();snap('longstream-before-stop-360')
                page.get_by_role('button',name='Stop generating',exact=True).click()
                expect(page.get_by_role('button',name='Stop generating',exact=True)).to_have_count(0,timeout=30000)
                before=page.locator('[data-conversation-content]').inner_text();page.wait_for_timeout(1000)
                after=page.locator('[data-conversation-content]').inner_text()
                require(before==after,'stream continued changing after Stop')
                deadline=time.monotonic()+10
                while not any(r['event']=='stream_cancelled' for r in logs(start)):
                    require(time.monotonic()<deadline,'fixture did not observe stream cancellation');page.wait_for_timeout(200)
                check('real Stop cancels provider request and stops visible deltas');snap('longstream-stopped-360')
            if 'queue' in phases:
                report['activePhase']='queue'
                configure('longstream');new_session('Android UI controlled busy-send probe')
                expect(page.get_by_text(re.compile(r'受控流式片段 1。')).last).to_be_visible(timeout=60000)
                queued='Android UI follow-up while response is running'
                composer.fill(queued)
                submit=page.get_by_role('button',name=re.compile(r'^(Queue message|Steer message)$'))
                expect(submit).to_be_enabled();behavior=submit.get_attribute('aria-label');submit.click()
                expect(composer).to_have_text('')
                expect(page.get_by_text(queued,exact=True)).to_be_visible(timeout=30000)
                snap('message-submitted-while-busy-360');check('busy Send accepts follow-up without losing draft',behavior=behavior)
                # Stop any current/steered runs; remove a retained queue row only
                # through its real UI control so subsequent phases start cleanly.
                for _ in range(3):
                    stop=page.get_by_role('button',name='Stop generating',exact=True)
                    if stop.count(): stop.click();page.wait_for_timeout(500)
                remove=page.get_by_role('button',name='Remove queued message',exact=True)
                if remove.count():
                    remove.click()
                    expect(remove).to_have_count(0)
                    expect(page.get_by_text(queued,exact=True)).to_have_count(0)
                    check('retained queued input can be removed through UI')
            for phase in ('allow','reject'):
                if phase not in phases: continue
                report['activePhase']=phase
                configure('approval');start=time.time_ns();new_session(f'Android UI controlled approval {phase} probe')
                allow=page.get_by_role('button',name='Allow once',exact=True);reject=page.get_by_role('button',name='Reject',exact=True)
                expect(allow).to_be_visible(timeout=60000);expect(reject).to_be_visible();snap(f'approval-{phase}-pending-360')
                for button in (allow,reject):
                    rect=button.bounding_box();require(rect['width']>=44 and rect['height']>=44,'approval touch target smaller than 44px')
                (allow if phase=='allow' else reject).click()
                reply='受控 Bash 工具结果已收到：ANDROID_DSH_LOOPBACK_OK。' if phase=='allow' else '受控工具调用已结束；未收到成功标记，请检查工具结果或审批决定。'
                final_text(reply);expect(allow).to_have_count(0)
                received=[r for r in logs(start) if r['event']=='request_received' and r.get('scenario')=='approval' and r.get('tool_names')]
                require(len(received)>=3,'missing default/fallback/result model rounds')
                require(any(t['sandbox_unavailable'] and not t['approved_attempt'] for r in received for t in r.get('tool_results',[])),'default sandbox failure not observed')
                latest=received[-1]['tool_results'][-1]
                require(latest['approved_attempt'],'escalated tool result not observed')
                require(latest['marker_present']==(phase=='allow') and latest['is_error']==(phase=='reject'),'tool result does not match actual approval choice')
                require(page.get_by_role('button',name='Access mode, current: Workspace Write',exact=True).count()==1,'one-time approval changed default mode')
                check(f'actual UI {phase}, real Bash tool result and unchanged Workspace Write',requestIds=[r['request_id'] for r in received],lastToolResult=latest)
                sid=session_id(phase);snap(f'approval-{phase}-completed-360');history_reload(sid,f'Android UI controlled approval {phase} probe',reply)
                check(f'{phase} transcript persisted and reloaded',sessionId=sid)
            require(not report['pageErrors'],'page errors occurred')
            require(not report['consoleErrors'],'console errors occurred')
            report['activePhase']='completed'
            report['passed']=True
        except Exception as error:
            own_lines=[line for frame,line in traceback.walk_tb(error.__traceback__) if Path(frame.f_code.co_filename).resolve()==Path(__file__).resolve()]
            report['passed']=False;report['failure']={'type':type(error).__name__,'phase':report.get('activePhase'),'lastUiAction':report.get('lastUiAction'),'driverLines':own_lines,'detail':redact(error)}
            page.screenshot(path=str(args.output_dir/'controlled-e2e-failure.png'))
            report['screenshots'].append('controlled-e2e-failure.png')
        finally:
            save_report();browser.close()
    print(json.dumps({'passed':report['passed'],'checks':report['checks'],'failure':report.get('failure'),
                      'pageErrors':report['pageErrors'],'report':str(args.output_dir/'report.json')},ensure_ascii=False))
    return 0 if report['passed'] else 1

if __name__=='__main__':sys.exit(main())
