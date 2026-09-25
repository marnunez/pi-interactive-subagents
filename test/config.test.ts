import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listAgentDefinitions,
  loadAgentDefaults,
  resolveChildTools,
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
    writeAgent(profile, "empty-tools", "tools: []\nallow-tools: []");
    const defaults = loadAgentDefaults("empty-tools", cwd)!;
    assert.equal(defaults.tools, "");
    assert.equal(defaults.allowTools, "");
    assert.deepEqual(resolveChildTools(defaults, ["read", "bash"], ["read", "bash"]), ["subagent_done"]);
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
        "auto-exit: true",
      ].join("\n"),
      "Agent instructions.\n",
    );

    assert.deepEqual(loadAgentDefaults("filename-agent", cwd), {
      model: "provider/model",
      tools: "read,custom_tool",
      skills: "one,two",
      thinking: undefined,
      denyTools: undefined,
      allowTools: undefined,
      spawning: false,
      maxInstances: 2,
      cwd: undefined,
      workspace: undefined,
      env: undefined,
      autoExit: true,
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
  const registered = [
    "read",
    "bash",
    "edit",
    "subagent",
    "subagents_list",
    "subagent_resume",
    "subagent_kill",
    "web_search",
    "database_query",
  ];

  it("inherits only the parent's active preset when tools are not explicit", () => {
    assert.deepEqual(
      resolveChildTools({}, ["read", "bash", "web_search"], registered),
      [
        "read",
        "bash",
        "web_search",
        "subagent_done",
        "set_tab_title",
        "write_artifact",
        "read_artifact",
      ],
    );
  });

  it("treats explicit built-in and extension tools as a strict allowlist", () => {
    assert.deepEqual(
      resolveChildTools(
        { tools: "read,database_query" },
        ["read", "bash", "web_search"],
        registered,
      ),
      [
        "read",
        "database_query",
        "subagent_done",
        "set_tab_title",
        "write_artifact",
        "read_artifact",
      ],
    );
  });

  it("lets allowTools narrow but never expand the selected tools", () => {
    assert.deepEqual(
      resolveChildTools(
        { allowTools: "read,database_query,set_tab_title" },
        ["read", "bash"],
        registered,
      ),
      ["read", "subagent_done", "set_tab_title"],
    );
  });

  it("applies denials to built-ins and optional child lifecycle tools", () => {
    assert.deepEqual(
      resolveChildTools(
        { denyTools: "bash,set_tab_title,write_artifact,read_artifact,subagent_done" },
        ["read", "bash"],
        registered,
      ),
      ["read", "subagent_done"],
    );
  });

  it("does not let allowTools bypass spawning false", () => {
    assert.deepEqual(
      resolveChildTools(
        {
          allowTools: "read,subagent,subagents_list,subagent_resume,subagent_kill,set_tab_title",
          spawning: false,
        },
        ["read", "subagent", "subagents_list", "subagent_resume", "subagent_kill"],
        registered,
      ),
      ["read", "subagent_done", "set_tab_title"],
    );
  });

  it("allows mandatory child-only tools without parent registration", () => {
    assert.deepEqual(
      resolveChildTools(
        { tools: "subagent_done,set_tab_title,write_artifact,read_artifact" },
        [],
        [],
      ),
      ["subagent_done", "set_tab_title", "write_artifact", "read_artifact"],
    );
  });

  it("rejects unknown explicit tool names with a useful error", () => {
    assert.throws(
      () => resolveChildTools({ tools: "read,typo_tool" }, ["read"], registered),
      /Unknown tool in tools: typo_tool.*registered tool name/,
    );
    assert.throws(
      () => resolveChildTools({ denyTools: "missing_tool" }, ["read"], registered),
      /Unknown tool in denyTools: missing_tool/,
    );
  });
});
