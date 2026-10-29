// Native Pi v1 integration with a scripted faux provider: no remote model or GUI.
// PI_V1_SDK_PATH=/absolute/path/to/pi/dist/index.js npm run test:pi-v1
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import childExtension from '../pi-extension/subagents/subagent-done.ts';
import { childLaunchSpec } from '../pi-extension/subagents/launch.ts';
import { createRunRuntime } from '../pi-extension/subagents/runtime.ts';
import { ParentIpcServer } from '../pi-extension/subagents/ipc.ts';

const sdkPath = process.env.PI_V1_SDK_PATH;
if (!sdkPath) throw new Error('Set PI_V1_SDK_PATH to Pi v1 dist/index.js.');
const requireSdk = createRequire(sdkPath);
const sdk = await import(pathToFileURL(sdkPath).href);
const ai = await import(new URL('./dist/index.js', pathToFileURL(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(sdkPath)))).href);
const { Type } = await import(pathToFileURL(requireSdk.resolve('typebox')).href);
const root = mkdtempSync(join(tmpdir(), 'pi-v1-subagent-policy-'));
const agentDir = join(root, 'agent'); mkdirSync(agentDir);
const envKeys = ['PI_SUBAGENT_ID', 'PI_SUBAGENT_NAME', 'PI_SUBAGENT_SOCKET', 'PI_SUBAGENT_TOKEN', 'PI_SUBAGENT_AUTO_EXIT', 'PI_SUBAGENT_MODEL', 'PI_SUBAGENT_THINKING', 'PI_SUBAGENT_TOOLS', 'PI_SUBAGENT_INITIAL_TOOLS', 'PI_DENY_TOOLS'];
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
let session, registerLate;
let calls = 0, forbiddenCalls = 0;
const errors = [], nestedEvents = [];
const config = { schemaVersion: 3, tools: ['read', 'codemode', 'tool_search', 'probe_browser_navigate', 'subagent_done'] };
process.env.PI_SUBAGENT_ID = 'offline-child';
const names = context => ai.getCurrentTools(context.messages).map(tool => tool.name);
const toolCall = (name, args) => ai.fauxAssistantMessage(ai.fauxToolCall(name, args), {stopReason:'toolUse'});
try {
  const runtime = await sdk.ModelRuntime.create({ authPath:join(agentDir,'auth.json'), modelsPath:null, modelsStorePath:join(agentDir,'models.json'), refreshOnCreate:false });
  const faux = ai.fauxProvider(); runtime.registerNativeProvider(faux.provider);
  const settings = sdk.SettingsManager.inMemory({ retry:{enabled:false} });
  let sessionManager = sdk.SessionManager.inMemory();
  const loader = new sdk.DefaultResourceLoader({ cwd:root, agentDir, settingsManager:settings, noContextFiles:true, noSkills:true, noThemes:true, noPromptTemplates:true,
    extensionFactories:[sdk.createToolSearchExtension(), sdk.createCodemodeExtension({models:false}), pi => {
      const register = (name, exposure = 'deferred') => pi.registerTool({ name, label:name, description:'Navigate browser pages to a URL', exposure, parameters:Type.Object({}),
        execute:async()=>{ if (name==='forbidden') forbiddenCalls++; else calls++; return {content:[{type:'text',text:'dummy result'}],details:undefined}; } });
      for (const name of ['probe_browser_navigate','forbidden','mcp__selected__read','mcp__unselected__read','list_mcp_resources']) register(name);
      registerLate = () => register('probe_late');
      pi.on('tool_call', event=>nestedEvents.push({name:event.toolName,parent:event.parentToolCallId}));
    },childExtension] });
  const start = async () => {
    process.env.PI_SUBAGENT_TOOLS = config.tools.join(',');
    const spec = childLaunchSpec(createRunRuntime(),config,'offline-child','Offline',join(root,'child.jsonl'),root);
    const i = spec.argv.indexOf('--exclude-tools');
    await loader.reload();
    ({session}=await sdk.createAgentSession({ cwd:root,agentDir,modelRuntime:runtime,model:faux.getModel(),tools:config.tools,
      excludeTools:i<0?undefined:spec.argv[i+1].split(','),resourceLoader:loader,settingsManager:settings,sessionManager }));
    await session.bindExtensions({onError:event=>errors.push(event)});
  };
  const noCustomVisibility = () => assert.ok(!sessionManager.getEntries().some(entry=>entry.type==='custom' && entry.customType==='subagent_tool_loadout'));
  await start();
  assert.ok(session.getActiveToolNames().includes('codemode'));
  assert.ok(!session.getActiveToolNames().includes('probe_browser_navigate'), 'Exact native permission names must not eagerly declare deferred schemas');
  for (const name of ['forbidden','mcp__unselected__read','list_mcp_resources']) assert.ok(!session.getAllTools().some(tool=>tool.name===name));
  const requests = [];
  faux.setResponses([
    context=>{requests.push(names(context)); return toolCall('tool_search',{query:'browser navigate',limit:1});},
    context=>{requests.push(names(context)); return toolCall('probe_browser_navigate',{});},
    ai.fauxAssistantMessage('done'),
  ]);
  await session.prompt('Discover and call the browser tool.');
  assert.ok(!requests[0].includes('probe_browser_navigate') && requests[1].includes('probe_browser_navigate'));
  assert.equal(calls,1);
  noCustomVisibility();
  const discoveredLeaf = sessionManager.getLeafId();
  const initialSystem = sessionManager.getEntries().find(entry=>entry.type==='message' && entry.message.role==='system' && entry.message.toolsAdded?.some(tool=>tool.name==='read'));
  assert.ok(initialSystem, 'Native Pi must persist its own initial declarations');
  await session.navigateTree(initialSystem.id,{summarize:false});
  assert.ok(!session.getActiveToolNames().includes('probe_browser_navigate'));
  await session.navigateTree(discoveredLeaf,{summarize:false});
  await session.reload();
  assert.ok(!session.getActiveToolNames().includes('probe_browser_navigate'), 'Reload returns deferred tools to on-demand discovery');
  session.dispose();
  await start();
  assert.ok(!session.getActiveToolNames().includes('probe_browser_navigate'), 'Resumed sessions keep deferred capabilities without eagerly declaring schemas');
  await session.navigateTree(initialSystem.id,{summarize:false});
  faux.setResponses([toolCall('codemode',{code:'return await tools.probe_browser_navigate({});'}),ai.fauxAssistantMessage('done')]);
  await session.prompt('Call the permitted tool through codemode.');
  assert.equal(calls,2);
  assert.ok(nestedEvents.some(event=>event.name==='probe_browser_navigate' && event.parent));
  assert.ok(!session.getActiveToolNames().includes('probe_browser_navigate'));
  faux.setResponses([toolCall('codemode',{code:'return await tools.forbidden({});'}),ai.fauxAssistantMessage('done')]);
  await session.prompt('Attempt a forbidden nested call.');
  assert.equal(forbiddenCalls,0);
  assert.equal(session.messages.findLast(message=>message.role==='toolResult' && message.toolName==='codemode').isError,true);
  noCustomVisibility();

  session.dispose();
  config.tools.push('mcp__selected__read');
  await start();
  assert.ok(session.getAllTools().some(tool=>tool.name==='mcp__selected__read'));
  for (const name of ['mcp__unselected__read','list_mcp_resources']) assert.ok(!session.getAllTools().some(tool=>tool.name===name));

  // A restricted role needs no loader: common codemode can discover and call
  // an allowed tool that connects mid-run without directly declaring its schema.
  session.dispose();
  config.tools = ['read','codemode','probe_late','subagent_done'];
  sessionManager = sdk.SessionManager.inMemory();
  await start();
  assert.ok(!session.getAllTools().some(tool=>tool.name==='tool_search'));
  let lateRequest;
  faux.setResponses([
    ()=>{registerLate(); return toolCall('read',{path:'/dev/null'});},
    context=>{lateRequest=names(context); return toolCall('codemode',{code:'const t = await describeTool("probe_late"); if (!t) throw new Error("Missing permitted late tool"); return await tools.probe_late({});'});},
    ai.fauxAssistantMessage('late connection checked'),
  ]);
  await session.prompt('Use the permitted late tool through codemode.');
  assert.ok(lateRequest?.includes('codemode') && !lateRequest.includes('probe_late'));
  assert.equal(calls,3,JSON.stringify(session.messages.slice(-3)));
  noCustomVisibility();
  // Real native tool-loop test: receipt pauses, an advisory does not wake, and
  // a correlated answer wakes the same run, including across extension reload.
  session.dispose();
  config.tools = ['read', 'message_parent', 'subagent_done'];
  sessionManager = sdk.SessionManager.inMemory();
  process.env.PI_SUBAGENT_ID = 'offline-child';
  process.env.PI_SUBAGENT_SOCKET = join(root, 'parent.sock');
  process.env.PI_SUBAGENT_TOKEN = 'offline-token';
  let question, answerImmediately = false;
  const parent = new ParentIpcServer({ socketPath:process.env.PI_SUBAGENT_SOCKET, onMessage:frame=>{
    if (frame.type === 'child_message') {
      question = frame.payload;
      if (answerImmediately) parent.send("offline-child", "parent_message", {
        runId:"offline-child",messageId:`fast-${question.messageId}`,replyTo:question.messageId,text:"Fast answer",
      });
      parent.send('offline-child', 'child_message_ack', frame.payload);
    }
  }});
  parent.registerChild('offline-child','offline-token');
  await parent.start();
  const until = async predicate => {
    const deadline = Date.now()+3000;
    while (!predicate()) {
      if (Date.now()>deadline) throw new Error('Timed out waiting for native clarification lifecycle');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  };
  try {
    await start();
    assert.ok(session.getActiveToolNames().includes('message_parent'));
    let extraRequests = 0;
    faux.setResponses([toolCall('message_parent',{message:'Which API?',waitForReply:true}),()=>{
      extraRequests++; return ai.fauxAssistantMessage('unexpected continuation');
    }]);
    await session.prompt('Ask the parent which API to use.');
    assert.ok(question);
    assert.equal(extraRequests,0,'Waiting must terminate the native automatic tool follow-up');
    assert.ok(!sessionManager.getEntries().some(entry=>entry.customType==='subagent_done_result'));
    await session.reload();
    await until(()=>parent.isConnected('offline-child'));
    parent.send('offline-child','parent_message',{runId:'offline-child',messageId:'advisory',text:'Additional context'});
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(extraRequests,0,'An uncorrelated advisory must not wake the paused child');
    faux.setResponses([context=>{
      assert.ok(JSON.stringify(context.messages).includes('Use v2'));
      return ai.fauxAssistantMessage('clarification received');
    }]);
    parent.send('offline-child','parent_message',{runId:'offline-child',messageId:'answer',replyTo:question.messageId,text:'Use v2'});
    await until(()=>session.getLastAssistantText()==='clarification received');
    await session.waitForIdle();
    assert.ok(!sessionManager.getEntries().some(entry=>entry.customType==='subagent_done_result'));
    answerImmediately = true;
    faux.setResponses([toolCall('message_parent',{message:'Another question',waitForReply:true}),
      ai.fauxAssistantMessage('fast clarification received')]);
    await session.prompt('Ask another question.');
    await until(()=>session.getLastAssistantText()==='fast clarification received');
    await session.waitForIdle();
  } finally {
    await session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});
    session.dispose();
    await parent.close();
  }
  assert.deepEqual(errors,[], 'Extension hooks must not fail silently');
  console.log('Pi v1: native discovery/permissions and clarification pause/advisory/reload/reply passed (offline).');
} finally {
  session?.dispose();
  for (const [key,value] of savedEnv) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
  rmSync(root,{recursive:true,force:true});
}
