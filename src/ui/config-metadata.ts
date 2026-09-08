import type {
  PluginConfigField,
  PluginConfigGroup,
  PluginConfigValue,
  ToolRisk,
} from "../core/plugin.js";

export type ConfigControlKind =
  | "text"
  | "password"
  | "number"
  | "boolean"
  | "select"
  | "multiselect"
  | "textarea"
  | "path";

export interface ConfigFieldGroupView {
  readonly group?: PluginConfigGroup;
  readonly fields: readonly PluginConfigField[];
}

export function toggleSecretClearIntent(
  values: Readonly<Record<string, PluginConfigValue>>,
  clearSecrets: ReadonlySet<string>,
  key: string,
): { readonly values: Record<string, PluginConfigValue>; readonly clearSecrets: Set<string> } {
  const nextClearSecrets = new Set(clearSecrets);
  if (nextClearSecrets.has(key)) {
    nextClearSecrets.delete(key);
    return { values: { ...values }, clearSecrets: nextClearSecrets };
  }
  nextClearSecrets.add(key);
  return { values: { ...values, [key]: "" }, clearSecrets: nextClearSecrets };
}

/** Maps schema types to generic Console controls without consulting a plugin id. */
export function configControlKind(field: PluginConfigField): ConfigControlKind {
  if (field.secret || field.type === "password") return "password";
  return field.type;
}

/** Preserves declaration order and creates a new section whenever the group changes. */
export function groupConfigFields(
  fields: readonly PluginConfigField[],
): readonly ConfigFieldGroupView[] {
  const groups: Array<{ group?: PluginConfigGroup; fields: PluginConfigField[] }> = [];
  for (const field of fields) {
    const current = groups.at(-1);
    if (current !== undefined && current.group?.id === field.group?.id) {
      current.fields.push(field);
    } else {
      groups.push(field.group === undefined
        ? { fields: [field] }
        : { group: field.group, fields: [field] });
    }
  }
  return groups;
}

export interface ToolRiskPresentation {
  readonly label: string;
  readonly variant: "success" | "attention" | "danger";
}

/** `write-capable` remains visually and semantically compatible with the old Console. */
export function toolRiskPresentation(risk: ToolRisk): ToolRiskPresentation {
  switch (risk) {
    case "read-only": return { label: "只读", variant: "success" };
    case "write":
    case "write-capable": return { label: "可变更", variant: "attention" };
    case "destructive": return { label: "破坏性", variant: "danger" };
    case "privileged": return { label: "高权限", variant: "danger" };
  }
}
