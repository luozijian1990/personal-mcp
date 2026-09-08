import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PersonalMcpToolMetadata, PluginConfigField } from "./plugin.js";
import {
  configControlKind,
  groupConfigFields,
  toolRiskPresentation,
} from "../ui/config-metadata.js";
import { ConfigFieldEditor, ToolMetadataRow } from "../ui/MetadataControls.js";

const fields: readonly PluginConfigField[] = [
  { key: "TEXT", label: "Text", description: "Text description", type: "text", defaultValue: "", required: true, placeholder: "text value" },
  { key: "PASSWORD", label: "Password", description: "Password description", type: "password", defaultValue: "", secret: true },
  { key: "NUMBER", label: "Number", description: "Number description", type: "number", defaultValue: 3 },
  { key: "BOOLEAN", label: "Boolean", description: "Boolean description", type: "boolean", defaultValue: false, dangerous: true },
  { key: "SELECT", label: "Select", description: "Select description", type: "select", defaultValue: "safe", options: [{ value: "safe", label: "Safe" }] },
  { key: "MULTI", label: "Multi", description: "Multi description", type: "multiselect", defaultValue: ["read"], options: [{ value: "read", label: "Read" }] },
  { key: "TEXTAREA", label: "Textarea", description: "Textarea description", type: "textarea", defaultValue: "", placeholder: "notes" },
  { key: "PATH", label: "Path", description: "Path description", type: "path", defaultValue: "", placeholder: "/server/path" },
];

test("Console maps every config schema type without plugin-specific branches", () => {
  assert.deepEqual(fields.map(configControlKind), [
    "text",
    "password",
    "number",
    "boolean",
    "select",
    "multiselect",
    "textarea",
    "path",
  ]);
  const secretText: PluginConfigField = {
    key: "TOKEN",
    label: "Token",
    description: "Secret token",
    type: "text",
    defaultValue: "",
    secret: true,
  };
  assert.equal(configControlKind(secretText), "password");
});

test("Console preserves declaration order when a group reappears", () => {
  const connection = { id: "connection", label: "Connection" };
  const orderedFields: readonly PluginConfigField[] = [
    { key: "HOST", label: "Host", description: "Host", type: "text", defaultValue: "", group: connection },
    { key: "NOTES", label: "Notes", description: "Notes", type: "textarea", defaultValue: "" },
    { key: "PORT", label: "Port", description: "Port", type: "number", defaultValue: 22, group: connection },
  ];
  const groups = groupConfigFields(orderedFields);
  assert.deepEqual(groups.map(({ fields: groupFields }) => groupFields.map(({ key }) => key)), [
    ["HOST"],
    ["NOTES"],
    ["PORT"],
  ]);
});

test("Console renders accessible controls for the complete config schema", () => {
  const markup = fields.map((field) => renderToStaticMarkup(createElement(ConfigFieldEditor, {
    field,
    pluginId: "schema-test",
    saving: false,
    value: field.defaultValue,
    update: () => undefined,
  }))).join("\n");

  assert.match(markup, /for="schema-test-TEXT"/);
  assert.match(markup, /id="schema-test-TEXT"/);
  assert.match(markup, /required=""/);
  assert.match(markup, /aria-describedby="schema-test-TEXT-description"/);
  assert.match(markup, /placeholder="text value"/);
  assert.match(markup, /type="password"/);
  assert.match(markup, /type="number"/);
  assert.match(markup, /role="switch"/);
  assert.match(markup, /<select[^>]*>.*Safe.*<\/select>/s);
  assert.match(markup, /<select[^>]*multiple=""[^>]*>.*Read.*<\/select>/s);
  assert.match(markup, /<textarea[^>]*placeholder="notes"/);
  assert.match(markup, /data-config-type="path"/);
});

test("Console renders all tool risks and operational safety hints", () => {
  const tools: readonly PersonalMcpToolMetadata[] = [
    { name: "read", title: "Read", risk: "read-only" },
    { name: "write", title: "Write", risk: "write" },
    { name: "delete", title: "Delete", risk: "destructive" },
    { name: "admin", title: "Admin", risk: "privileged", requiresConfirmation: true, disabledByDefault: true },
    { name: "legacy", title: "Legacy", risk: "write-capable" },
  ];
  const markup = tools.map((tool) => renderToStaticMarkup(createElement(ToolMetadataRow, { tool }))).join("\n");
  for (const label of ["只读", "可变更", "破坏性", "高权限", "调用前确认", "默认停用"]) {
    assert.match(markup, new RegExp(label));
  }
  assert.deepEqual(toolRiskPresentation("write-capable"), { label: "可变更", variant: "attention" });
});
