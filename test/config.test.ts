import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listAgentDefinitions,
  loadAgentDefaults,
  resolveChildTools,
  restoreChildTools,
} from "../pi-extension/subagents/config.ts";

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `subagent-config-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAgent(
  root: string,
  name: string,
  frontmatter: string,
  body = `# ${name}\n`,
): void {
  const directory = join(root, "agents");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), `---\n${frontmatter}\n---\n${body}`);
}

function writeProjectAgent(
  cwd: string,
  name: string,
  frontmatter: string,
  body = `# ${name}\n`,
): void {
  writeAgent(join(cwd, ".pi"), name, frontmatter, body);
}

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("agent configuration", () => {
  it("preserves explicitly empty tool lists instead of inheriting broad defaults", () => {
    const cwd = temporaryDirectory("empty-cwd");
    const profile = temporaryDirectory("empty-profile");
    process.env.PI_CODING_AGENT_DIR = profile;
    writeAgent(profile, "empty-tools", "tools: []");
    const defaults = loadAgentDefaults("empty-tools", cwd)!;
    assert.equal(defaults.tools, "");
    assert.deepEqual(resolveChildTools(defaults, ["read", "bash"]), ["codemode", "subagent_done"]);
  });
  it("uses trusted project definitions before profile definitions", () => {
    const cwd = temporaryDirectory("cwd");
    const profile = temporaryDirectory("profile");
    process.env.PI_CODING_AGENT_DIR = profile;

    writeAgent(profile, "policy-test", "name: ignored-profile-name\nmodel: profile/model");
    writeProjectAgent(cwd, "policy-test", "name: ignored-project-name\nmodel: project/model");

    assert.equal(loadAgentDefaults("policy-test", cwd)?.model, "project/model");
    assert.equal(loadAgentDefaults("policy-test", cwd, false)?.model, "profile/model");

    const trusted = listAgentDefinitions(cwd).find((agent) => agent.name === "policy-test");
    const untrusted = listAgentDefinitions(cwd, false).find((agent) => agent.name === "policy-test");
    assert.equal(trusted?.source, "project");
    assert.equal(untrusted?.source, "profile");
  });

  it("allows a profile to opt out of bundled agent defaults", () => {
    const cwd = temporaryDirectory("no-bundled-cwd");
    const profile = temporaryDirectory("no-bundled-profile");
    process.env.PI_CODING_AGENT_DIR = profile;

    writeAgent(profile, "general", "description: General-purpose coding agent");
    writeProjectAgent(cwd, "special", "description: Project-only agent");
    assert.ok(loadAgentDefaults("scout", cwd));
    assert.ok(listAgentDefinitions(cwd).some((agent) => agent.name === "scout"));

    writeFileSync(join(profile, "agents", ".no-bundled"), "");
    assert.equal(loadAgentDefaults("scout", cwd), null);
    assert.deepEqual(listAgentDefinitions(cwd, false).map((agent) => agent.name), ["general"]);
    assert.deepEqual(listAgentDefinitions(cwd).map((agent) => agent.name), ["general", "special"]);
  });

  it("uses filename identity consistently and parses YAML scalar types and quotes", () => {
    const cwd = temporaryDirectory("identity-cwd");
    const profile = temporaryDirectory("identity-profile");
    process.env.PI_CODING_AGENT_DIR = profile;

    writeAgent(
      profile,
      "filename-agent",
      [
        "name: frontmatter-alias",
        'description: "Quoted: description"',
        "model: 'provider/model'",
        "tools: [read, custom_tool]",
        "skills: [one, two]",
        "spawning: false",
        "max-instances: 2",
      ].join("\n"),
      "Agent instructions.\n",
    );

    assert.deepEqual(loadAgentDefaults("filename-agent", cwd), {
      model: "provider/model",
      tools: "read,custom_tool",
      skills: "one,two",
      thinking: undefined,
      spawning: false,
      maxInstances: 2,
      cwd: undefined,
      workspace: undefined,
      env: undefined,
      body: "Agent instructions.",
    });
    assert.equal(loadAgentDefaults("frontmatter-alias", cwd), null);

    const definition = listAgentDefinitions(cwd).find((agent) => agent.name === "filename-agent");
    assert.deepEqual(definition, {
      name: "filename-agent",
      description: "Quoted: description",
      model: "provider/model",
      source: "profile",
    });
  });

  it("keeps profile agent directories isolated without falling back to the legacy home", () => {
    const cwd = temporaryDirectory("profile-cwd");
    const home = temporaryDirectory("home");
    const firstProfile = temporaryDirectory("profile-one");
    const secondProfile = temporaryDirectory("profile-two");
    process.env.HOME = home;

    writeAgent(join(home, ".pi", "agent"), "isolated-agent", "model: legacy/model");
    writeAgent(firstProfile, "isolated-agent", "model: first/model");
    writeAgent(secondProfile, "isolated-agent", "model: second/model");

    process.env.PI_CODING_AGENT_DIR = firstProfile;
    assert.equal(loadAgentDefaults("isolated-agent", cwd)?.model, "first/model");

    process.env.PI_CODING_AGENT_DIR = secondProfile;
    assert.equal(loadAgentDefaults("isolated-agent", cwd)?.model, "second/model");

    const emptyProfile = temporaryDirectory("profile-empty");
    process.env.PI_CODING_AGENT_DIR = emptyProfile;
    assert.equal(loadAgentDefaults("isolated-agent", cwd), null);
  });

  it("rejects traversal names and ignores unsupported chain definitions", () => {
    const cwd = temporaryDirectory("traversal-cwd");
    const profile = temporaryDirectory("traversal-profile");
    process.env.PI_CODING_AGENT_DIR = profile;

    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "outside.md"),
      "---\nmodel: escaped/model\n---\nescaped\n",
    );
    writeAgent(profile, "workflow.chain", "description: unsupported\nmodel: chain/model");

    assert.equal(loadAgentDefaults("../outside", cwd), null);
    assert.equal(loadAgentDefaults("..\\outside", cwd), null);
    assert.equal(loadAgentDefaults("workflow.chain", cwd), null);
    assert.equal(
      listAgentDefinitions(cwd).some((agent) => agent.name === "workflow.chain"),
      false,
    );
  });
});

describe("child tool policy", () => {
  const registered = ["read", "bash", "edit", "subagent", "subagents_list", "subagent_resume", "subagent_kill", "subagent_message", "web_search", "database_query"];

  it("trusted peers inherit permitted registered tools, not active schemas", () => {
    const tools = resolveChildTools({}, registered);
    assert.ok(registered.every((name) => tools.includes(name)));
    assert.ok(["codemode", "subagent_done", "write_artifact"].every((name) => tools.includes(name)));
  });

  it("roles have a positive allowlist with only common codemode and handback added", () => {
    assert.deepEqual(resolveChildTools({ tools: "read,database_query" }, registered),
      ["read", "database_query", "codemode", "subagent_done"]);
    assert.deepEqual(resolveChildTools({ tools: "" }, registered), ["codemode", "subagent_done"]);
  });

  it("new extensions never expand a restricted role", () => {
    const before = resolveChildTools({ tools: "read" }, registered);
    assert.deepEqual(resolveChildTools({ tools: "read" }, [...registered, "send_email", "browser_eval"]), before);
    assert.ok(!before.includes("write_artifact"));
  });

  it("spawning false excludes the orchestration family even when listed", () => {
    assert.deepEqual(resolveChildTools({ tools: "read,subagent,subagents_list,subagent_resume,subagent_kill,subagent_message", spawning: false }, registered),
      ["read", "codemode", "subagent_done"]);
  });

  it("child-only conveniences must be explicitly selected by restricted roles", () => {
    assert.deepEqual(resolveChildTools({ tools: "write_artifact,set_pane_title" }, []),
      ["write_artifact", "set_pane_title", "codemode", "subagent_done"]);
  });

  it("recognises the legacy pane alias only when explicitly selected or saved", () => {
    assert.equal(resolveChildTools({}, [...registered, "set_tab_title"]).includes("set_tab_title"), false);
    const legacy = resolveChildTools({ tools: "set_tab_title" }, []);
    assert.deepEqual(legacy, ["set_tab_title", "codemode", "subagent_done"]);
    assert.deepEqual(restoreChildTools(legacy, []), legacy);
    assert.deepEqual(restoreChildTools(["read", "subagent_done"], registered), ["read", "subagent_done", "codemode"]);
  });

  it("rejects unknown explicit tool names", () => {
    assert.throws(() => resolveChildTools({ tools: "read,typo_tool" }, registered), /Unknown tool in tools: typo_tool/);
  });

  it("rejects removed policy fields instead of ignoring them or falling through to a broader role", () => {
    const cwd = temporaryDirectory("migration-cwd");
    const profile = temporaryDirectory("migration-profile");
    process.env.PI_CODING_AGENT_DIR = profile;
    writeAgent(profile, "policy", "tools: read,bash");
    for (const field of ["deny-tools", "allow-tools", "initial-tools", "auto-exit"]) {
      writeProjectAgent(cwd, "policy", `tools: read\n${field}: []`);
      assert.throws(() => loadAgentDefaults("policy", cwd), /Unsupported agent field/);
    }
  });
});
