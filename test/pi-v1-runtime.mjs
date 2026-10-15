// Offline integration against Pi v1, using its scripted faux provider, never a remote model.
// PI_V1_SDK_PATH=/absolute/path/to/pi/dist/index.js node test/pi-v1-runtime.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import childExtension from '../pi-extension/subagents/subagent-done.ts';
import { childLaunchSpec } from '../pi-extension/subagents/launch.ts';
import { createRunRuntime } from '../pi-extension/subagents/runtime.ts';

const sdkPath = process.env.PI_V1_SDK_PATH;
if (!sdkPath) throw new Error('Set PI_V1_SDK_PATH to Pi v1 dist/index.js; this test never uses a live model.');
const requireSdk = createRequire(sdkPath);
const sdk = await import(pathToFileURL(sdkPath).href);
const ai = await import(new URL('./dist/index.js', pathToFileURL(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(sdkPath)))).href);
const { Type } = await import(pathToFileURL(requireSdk.resolve('typebox')).href);
assert.equal(typeof ai.fauxProvider, 'function', 'Pi v1 is required');
const root = mkdtempSync(join(tmpdir(), 'pi-v1-subagent-tools-'));
const agentDir = join(root, 'agent'); mkdirSync(agentDir);
const envKeys = ['PI_SUBAGENT_ID', 'PI_SUBAGENT_NAME', 'PI_SUBAGENT_SOCKET', 'PI_SUBAGENT_TOKEN', 'PI_SUBAGENT_AUTO_EXIT', 'PI_SUBAGENT_MODEL', 'PI_SUBAGENT_THINKING', 'PI_SUBAGENT_TOOLS', 'PI_SUBAGENT_INITIAL_TOOLS'];
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
const config = { schemaVersion: 2, tools: ['read', 'bash', 'tool_search', 'codemode', 'probe_browser_navigate', 'subagent_done'], initialTools: ['read', 'tool_search', 'codemode', 'subagent_done'], autoExit: false };
process.env.PI_SUBAGENT_ID = 'offline-child';
process.env.PI_SUBAGENT_TOOLS = config.tools.join(',');
process.env.PI_SUBAGENT_INITIAL_TOOLS = config.initialTools.join(',');
let calls = 0;
let registerLate, registerLateSelected;
let lateCalls = 0;
const nestedEvents = [];
const errors = [];
let session;
try {
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'models.json'), refreshOnCreate: false });
  const faux = ai.fauxProvider();
  runtime.registerNativeProvider(faux.provider);
  const settings = sdk.SettingsManager.inMemory({ defaultTools: ['+tool_search', '+codemode'], retry: { enabled: false } });
  let sessionManager = sdk.SessionManager.inMemory();
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [sdk.createToolSearchExtension(), sdk.createCodemodeExtension({ models: false }), pi => {
      registerLate = () => pi.registerTool({ name: 'late_unselected', label: 'Late', description: 'Late unrelated registration', exposure: 'deferred',
        parameters: Type.Object({}), execute: async () => ({content:[],details:undefined}) });
      registerLateSelected = () => pi.registerTool({ name: 'probe_late_selected', label: 'Selected late tool', description: 'Selected late deferred tool', exposure: 'deferred',
        parameters: Type.Object({}), execute: async () => { lateCalls++; return {content:[{type:'text',text:'late selected ok'}],details:undefined}; } });
      for (const name of ['probe_browser_navigate', 'forbidden', 'mcp__selected__read', 'mcp__unselected__read', 'list_mcp_resources']) {
        pi.registerTool({ name, label: name, description: 'Navigate browser pages to a URL', exposure: 'deferred', parameters: Type.Object({}), execute: async () => {
          calls++; return { content: [{type:'text', text:'dummy result'}], details: undefined };
        }});
      }
      pi.on('tool_call', event => nestedEvents.push({ name: event.toolName, parent: event.parentToolCallId }));
    }, childExtension] });
  const start = async () => {
    const spec = childLaunchSpec(createRunRuntime(), config, 'offline-child', 'Offline', join(root, 'child.jsonl'), root);
    const excludeIndex = spec.argv.indexOf('--exclude-tools');
    const exclusions = excludeIndex < 0 ? undefined : spec.argv[excludeIndex + 1].split(',');
    await loader.reload();
    const result = await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: faux.getModel(), tools: config.tools,
      excludeTools: exclusions, resourceLoader: loader, settingsManager: settings, sessionManager });
    session = result.session;
    await session.bindExtensions({ onError: event => errors.push(event) });
  };
  await start();
  assert.deepEqual(session.getActiveToolNames(), config.initialTools);
  const initialLeaf = sessionManager.getLeafId();
  registerLate(); // Even an excluded deferred registration reactivates allowed direct tools in Pi.
  for (const name of ['forbidden', 'mcp__unselected__read', 'list_mcp_resources']) assert.ok(!session.getAllTools().some(tool => tool.name === name), `${name} must be absent from discovery`);
  assert.ok(!session.agent.state.tools.find(tool => tool.name === 'codemode').description.includes('probe_browser_navigate'));
  const requests = [];
  faux.setResponses([
    context => { requests.push(ai.getCurrentTools(context.messages).map(tool=>tool.name)); registerLate(); return ai.fauxAssistantMessage(ai.fauxToolCall('tool_search', {query:'browser navigate',limit:1}), {stopReason:'toolUse'}); },
    context => { requests.push(ai.getCurrentTools(context.messages).map(tool=>tool.name)); return ai.fauxAssistantMessage(ai.fauxToolCall('probe_browser_navigate', {}), {stopReason:'toolUse'}); },
    ai.fauxAssistantMessage('done'),
  ]);
  await session.prompt('Discover and call the dummy browser tool.');
  assert.ok(!requests[0].includes('probe_browser_navigate'));
  assert.ok(requests[1].includes('probe_browser_navigate'));
  assert.ok(requests.every(names=>!names.includes('bash')), 'Late registration must not expose an initially omitted direct tool');
  assert.equal(calls,1);
  const discoveredLeaf = sessionManager.getLeafId();
  await session.navigateTree(initialLeaf, {summarize:false});
  registerLate();
  let branchRequest;
  faux.setResponses([context => {
    branchRequest = ai.getCurrentTools(context.messages).map(tool=>tool.name);
    return ai.fauxAssistantMessage('branch checked');
  }]);
  await session.prompt('Check the smaller branch loadout.');
  assert.ok(branchRequest && !branchRequest.includes('bash') && !branchRequest.includes('probe_browser_navigate'), 'Branch-local visibility survives a registry refresh');
  await session.navigateTree(discoveredLeaf, {summarize:false});
  registerLate();
  await session.reload();
  assert.ok(session.getActiveToolNames().includes('probe_browser_navigate'), 'Reload preserves discovery');
  session.dispose();
  process.env.PI_SUBAGENT_ID = 'offline-resume';
  await start();
  assert.ok(session.getActiveToolNames().includes('probe_browser_navigate'), 'Resume preserves discovery');
  // The optional tool need not stay declared to remain callable through codemode.
  await session.navigateTree(initialLeaf, {summarize:false});
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('codemode', {code:'return await tools.probe_browser_navigate({});'}), {stopReason:'toolUse'}),
    ai.fauxAssistantMessage('done'),
  ]);
  await session.prompt('Call the permitted deferred tool from a script.');
  assert.equal(calls,2, JSON.stringify({ errors, messages: session.messages.slice(-4) }));
  assert.ok(!session.getActiveToolNames().includes('probe_browser_navigate'));
  assert.ok(nestedEvents.some(event => event.name==='probe_browser_navigate' && event.parent));
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('codemode', {code:'return await tools.forbidden({});'}), {stopReason:'toolUse'}),
    ai.fauxAssistantMessage('done'),
  ]);
  await session.prompt('Attempt a forbidden nested call.');
  assert.equal(calls,2,'Forbidden nested call must not execute');
  const result = session.messages.findLast(message => message.role==='toolResult' && message.toolName==='codemode');
  assert.equal(result.isError,true);
  session.dispose();
  config.tools.push('mcp__selected__read');
  process.env.PI_SUBAGENT_TOOLS = config.tools.join(',');
  await start();
  assert.ok(session.getAllTools().some(tool => tool.name==='mcp__selected__read'));
  for (const name of ['mcp__unselected__read', 'list_mcp_resources']) assert.ok(!session.getAllTools().some(tool => tool.name===name), 'An explicit MCP permission must not grant other MCP tools/resources');
  session.dispose();
  config.tools = ['read', 'probe_late_selected', 'subagent_done'];
  config.initialTools = config.tools.slice();
  process.env.PI_SUBAGENT_TOOLS = config.tools.join(',');
  process.env.PI_SUBAGENT_INITIAL_TOOLS = config.initialTools.join(',');
  sessionManager = sdk.SessionManager.inMemory();
  await start();
  assert.ok(!session.getAllTools().some(tool=>tool.name==='tool_search' || tool.name==='codemode'));
  let lateRequest;
  faux.setResponses([
    () => { registerLateSelected(); return ai.fauxAssistantMessage(ai.fauxToolCall('read', {path:'/dev/null'}), {stopReason:'toolUse'}); },
    context => { lateRequest = ai.getCurrentTools(context.messages).map(tool=>tool.name); return ai.fauxAssistantMessage(ai.fauxToolCall('probe_late_selected', {}), {stopReason:'toolUse'}); },
    ai.fauxAssistantMessage('late connection checked'),
  ]);
  await session.prompt('Use the selected tool as soon as it connects.');
  assert.ok(lateRequest?.includes('probe_late_selected'), 'An initially selected deferred tool connecting mid-run must be declared on the next model turn without search');
  assert.equal(lateCalls, 1);
  assert.deepEqual(errors,[], 'Extension hooks must not fail silently');
  console.log('Pi v1 runtime: deferred discovery, direct/nested calls, reload, resume and permission filtering passed (offline faux provider).');
} finally {
  session?.dispose();
  for (const [key,value] of savedEnv) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
  rmSync(root,{recursive:true,force:true});
}
