import type {
  PersonalMcpToolMetadata,
  PluginConfigField,
  PluginConfigValue,
} from "../core/plugin.js";
import { configControlKind, toolRiskPresentation } from "./config-metadata.js";

export function ToolMetadataRow({ tool }: { readonly tool: PersonalMcpToolMetadata }) {
  const risk = toolRiskPresentation(tool.risk);
  return (
    <div className="tool-row">
      <div>
        <strong>{tool.title}</strong><code>{tool.name}</code>
        {(tool.requiresConfirmation || tool.disabledByDefault) && (
          <span className="tool-hints">
            {tool.requiresConfirmation && <span>调用前确认</span>}
            {tool.disabledByDefault && <span>默认停用</span>}
          </span>
        )}
      </div>
      <span className={`metadata-label metadata-label-${risk.variant}`}>{risk.label}</span>
    </div>
  );
}

export function ConfigFieldEditor({ field, pluginId, saving, value, update }: {
  readonly field: PluginConfigField;
  readonly pluginId: string;
  readonly saving: boolean;
  readonly value: PluginConfigValue;
  readonly update: (value: PluginConfigValue) => void;
}) {
  const control = configControlKind(field);
  const controlId = `${pluginId}-${field.key}`;
  const descriptionId = `${controlId}-description`;
  const label = (
    <span className="config-field-label">
      <strong>{field.label}</strong>
      <code>{field.key}</code>
      {field.required && <span className="metadata-label">必填</span>}
      {field.secret && <span className="metadata-label">敏感</span>}
      {field.dangerous && <span className="metadata-label metadata-label-attention">高风险</span>}
    </span>
  );

  if (control === "boolean") {
    return (
      <div className="config-field config-toggle-row">
        <div id={`${controlId}-label`} className="config-field-copy">
          {label}
          <p id={descriptionId}>{field.description}</p>
        </div>
        <label className="config-switch">
          <input
            id={controlId}
            type="checkbox"
            role="switch"
            aria-describedby={descriptionId}
            aria-labelledby={`${controlId}-label`}
            checked={value === true}
            disabled={saving}
            onChange={(event) => update(event.target.checked)}
          />
          <span aria-hidden="true" className="config-switch-track"><span /></span>
          <span>{value === true ? "已启用" : "已停用"}</span>
        </label>
      </div>
    );
  }

  const stringValue = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const sharedProps = {
    "aria-describedby": descriptionId,
    disabled: saving,
    id: controlId,
    required: field.required ?? false,
  };
  return (
    <div className="config-field config-text-field">
      <label htmlFor={controlId}>{label}</label>
      {control === "select" ? (
        <select {...sharedProps} value={stringValue} onChange={(event) => update(event.target.value)}>
          {!field.required && <option value="">未选择</option>}
          {(field.options ?? []).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      ) : control === "multiselect" ? (
        <select
          {...sharedProps}
          multiple
          value={Array.isArray(value) ? [...value] : []}
          onChange={(event) => update(Array.from(event.target.selectedOptions, (option) => option.value))}
        >
          {(field.options ?? []).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      ) : control === "textarea" ? (
        <textarea {...sharedProps} placeholder={field.placeholder} value={stringValue} onChange={(event) => update(event.target.value)} />
      ) : (
        <input
          {...sharedProps}
          className="config-input"
          data-config-type={control}
          placeholder={field.placeholder}
          type={control === "password" ? "password" : control === "number" ? "number" : "text"}
          value={stringValue}
          onChange={(event) => update(control === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)}
        />
      )}
      <p id={descriptionId}>{field.description}</p>
    </div>
  );
}
