import type { ColumnProfile, InferredColumnType } from "../profiling/profiling.types";
import type {
  QualityRule,
  QualityRuleInput,
  QualityRuleResult,
  QualityRuleType,
  QualityState,
  RuleConfig,
} from "./quality.types";
import { qualityRuleDefinitions } from "./quality.types";

export type QualityDrawerActions = {
  onAddRule: () => void;
  onCancelForm: () => void;
  onSaveRule: (input: QualityRuleInput, ruleId: string | null) => void;
  onEditRule: (rule: QualityRule) => void;
  onToggleRule: (rule: QualityRule) => void;
  onDeleteRule: (rule: QualityRule) => void;
  onApplyRuleFilter: (rule: QualityRule) => void;
  onRetryQuality: () => void;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("pt-BR").format(value);
}

function formatDecimal(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${formatDecimal(value, 2)}%`;
}

function parseConfig(rule: QualityRule | null): RuleConfig {
  if (!rule) return {};
  try {
    return JSON.parse(rule.configuration_json) as RuleConfig;
  } catch {
    return {};
  }
}

function defaultConfig(type: QualityRuleType): RuleConfig {
  if (type === "length") return { mode: "exact", value: 11 };
  if (type === "numeric_range") return { min: 0, max: 10, inclusive: true };
  if (type === "allowed_values") return { values: [""], ignore_case: false };
  if (type === "regex") return { pattern: "", mode: "exact" };
  if (type === "date") return { format: "DD/MM/YYYY", accept_excel_serial: false };
  return {};
}

function resultFor(rule: QualityRule, state: QualityState) {
  return state.summary?.results.find((result) => result.rule_id === rule.id) ?? null;
}

function ruleResultLine(rule: QualityRule, result: QualityRuleResult | null) {
  if (!rule.enabled) return "Regra desativada";
  if (!result) return "Aguardando validacao";
  if (result.status === "error") return result.error ?? "Nao foi possivel validar";
  return `${formatNumber(result.violation_count)} violacoes · ${formatPercent(result.violation_percentage)}`;
}

function renderScore(state: QualityState) {
  if (state.status === "loading") {
    return `
      <section class="quality-panel">
        <h3>Qualidade</h3>
        <p>Calculando qualidade...</p>
        <div class="profile-skeleton line wide"></div>
        <div class="profile-skeleton line"></div>
      </section>
    `;
  }

  if (state.status === "error") {
    return `
      <section class="quality-panel">
        <h3>Qualidade</h3>
        <strong>Nao foi possivel validar as regras.</strong>
        <p>Os dados nao foram modificados.</p>
        <button class="ghost-button" type="button" data-quality-retry>Tentar novamente</button>
      </section>
    `;
  }

  if (!state.rules.length) {
    return `
      <section class="quality-empty">
        <h3>Qualidade</h3>
        <strong>Nenhuma regra configurada.</strong>
        <p>Defina regras para identificar dados inconsistentes nesta coluna.</p>
        <button class="primary-button compact" type="button" data-quality-add>+ Adicionar regra</button>
      </section>
    `;
  }

  const summary = state.summary;
  if (!summary) return "";
  const width = Math.max(0, Math.min(100, Math.round(summary.score)));

  return `
    <section class="quality-score">
      <h3>Qualidade</h3>
      <strong>${formatDecimal(summary.score, 0)}%</strong>
      <span>Qualidade geral</span>
      <div class="quality-score-bar"><i style="width: ${width}%"></i></div>
      <p>${formatNumber(summary.total_rows)} registros</p>
      <p>${formatNumber(summary.problem_rows)} com problemas</p>
    </section>
  `;
}

function renderRules(state: QualityState) {
  if (!state.rules.length) return "";

  return `
    <section class="quality-rules">
      <div class="quality-section-title">
        <h3>Regras</h3>
        <button class="ghost-button compact" type="button" data-quality-add>+ Adicionar regra</button>
      </div>
      <div class="quality-rule-list">
        ${state.rules
          .map((rule) => {
            const result = resultFor(rule, state);
            const applied = state.appliedRuleId === rule.id;
            return `
              <article class="quality-rule ${!rule.enabled ? "disabled" : ""} ${applied ? "applied" : ""}">
                <button class="quality-rule-main" type="button" data-quality-apply="${escapeHtml(rule.id)}">
                  <strong>${escapeHtml(rule.name)}</strong>
                  <span>${escapeHtml(ruleResultLine(rule, result))}</span>
                  ${applied ? `<em>Filtro aplicado</em>` : ""}
                </button>
                <div class="quality-rule-actions">
                  <button type="button" data-quality-edit="${escapeHtml(rule.id)}">Editar</button>
                  <button type="button" data-quality-toggle="${escapeHtml(rule.id)}">${rule.enabled ? "Desativar" : "Ativar"}</button>
                  <button type="button" data-quality-delete="${escapeHtml(rule.id)}">Excluir</button>
                </div>
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderRuleFields(type: QualityRuleType, config: RuleConfig) {
  if (type === "length") {
    return `
      <label>Condicao
        <select name="mode">
          ${["exact", "min", "max", "between"]
            .map((mode) => `<option value="${mode}" ${config.mode === mode ? "selected" : ""}>${mode === "exact" ? "Exatamente" : mode === "min" ? "Minimo" : mode === "max" ? "Maximo" : "Entre"}</option>`)
            .join("")}
        </select>
      </label>
      <label>Valor <input name="value" type="number" value="${escapeHtml(String(config.value ?? 11))}" /></label>
      <label>Minimo <input name="min" type="number" value="${escapeHtml(String(config.min ?? ""))}" /></label>
      <label>Maximo <input name="max" type="number" value="${escapeHtml(String(config.max ?? ""))}" /></label>
    `;
  }

  if (type === "numeric_range") {
    return `
      <label>Minimo <input name="min" type="number" step="any" value="${escapeHtml(String(config.min ?? 0))}" /></label>
      <label>Maximo <input name="max" type="number" step="any" value="${escapeHtml(String(config.max ?? 10))}" /></label>
      <label class="quality-check"><input name="inclusive" type="checkbox" ${config.inclusive !== false ? "checked" : ""} /> incluir limites</label>
    `;
  }

  if (type === "allowed_values") {
    return `
      <label>Valores permitidos
        <textarea name="values" rows="4" placeholder="Um valor por linha">${escapeHtml((config.values ?? []).join("\n"))}</textarea>
      </label>
      <label class="quality-check"><input name="ignore_case" type="checkbox" ${config.ignore_case ? "checked" : ""} /> Ignorar maiusculas/minusculas</label>
    `;
  }

  if (type === "regex") {
    return `<label>Expressao <input name="pattern" value="${escapeHtml(config.pattern ?? "")}" placeholder="^[0-9]{11}$" /></label>`;
  }

  if (type === "date") {
    return `
      <label>Formato
        <select name="format">
          ${["DD/MM/YYYY", "YYYY/MM/DD", "YYYY-MM-DD", "DD-MM-YYYY"]
            .map((format) => `<option value="${format}" ${config.format === format ? "selected" : ""}>${format}</option>`)
            .join("")}
        </select>
      </label>
      <label class="quality-check"><input name="accept_excel_serial" type="checkbox" ${config.accept_excel_serial ? "checked" : ""} /> Aceitar serial de data do Excel</label>
      ${
        config.accept_excel_serial
          ? `<p class="quality-help">Formatos aceitos: ${escapeHtml(config.format ?? "DD/MM/YYYY")} e serial de data do Excel. Exemplo: 33639 -> 05/02/1992.</p>`
          : `<p class="quality-help">Valores vazios sao ignorados nesta regra.</p>`
      }
    `;
  }

  if (type === "required") {
    return `<p class="quality-help">Considera invalidos: NULL, string vazia e somente espacos.</p>`;
  }

  if (type === "unique") {
    return `<p class="quality-help">Valores vazios sao ignorados nesta regra.</p>`;
  }

  return `<p class="quality-help">Valores vazios nao sao considerados violacoes. Use Obrigatorio para tratar ausencia.</p>`;
}

function renderForm(profile: ColumnProfile, state: QualityState) {
  const editing = state.editingRule;
  const selectedType = editing?.rule_type ?? "required";
  const definitions = qualityRuleDefinitions(profile.inferred_type as InferredColumnType);
  const selectedDefinition = definitions.find((item) => item.type === selectedType) ?? definitions[0];
  const config = { ...defaultConfig(selectedType), ...parseConfig(editing) };

  return `
    <form class="quality-form" data-quality-form data-rule-id="${escapeHtml(editing?.id ?? "")}">
      <div class="quality-form-header">
        <button class="ghost-button compact" type="button" data-quality-cancel>←</button>
        <h3>${editing ? "Editar regra" : "Nova regra"}</h3>
      </div>
      <label>Tipo de regra
        <select name="rule_type">
          ${definitions
            .map((definition) => `<option value="${definition.type}" ${definition.type === selectedType ? "selected" : ""}>${definition.label}</option>`)
            .join("")}
        </select>
      </label>
      <label>Nome
        <input name="name" value="${escapeHtml(editing?.name ?? selectedDefinition.defaultName)}" />
      </label>
      <div data-quality-dynamic-fields>
        ${renderRuleFields(selectedType, config)}
      </div>
      <div class="quality-form-actions">
        <button class="ghost-button" type="button" data-quality-cancel>Cancelar</button>
        <button class="primary-button" type="submit">Salvar</button>
      </div>
    </form>
  `;
}

export function renderQualityDrawer(profile: ColumnProfile, state: QualityState) {
  if (state.mode === "form") {
    return renderForm(profile, state);
  }

  return `
    ${renderScore(state)}
    ${renderRules(state)}
  `;
}

function readNumber(form: FormData, key: string) {
  const raw = String(form.get(key) ?? "").trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function inputFromForm(formEl: HTMLFormElement, column: string): QualityRuleInput {
  const form = new FormData(formEl);
  const ruleType = String(form.get("rule_type") ?? "required") as QualityRuleType;
  const config: RuleConfig = {};

  if (ruleType === "length") {
    config.mode = String(form.get("mode") ?? "exact") as RuleConfig["mode"];
    config.value = readNumber(form, "value");
    config.min = readNumber(form, "min");
    config.max = readNumber(form, "max");
  } else if (ruleType === "numeric_range") {
    config.min = readNumber(form, "min");
    config.max = readNumber(form, "max");
    config.inclusive = form.get("inclusive") === "on";
  } else if (ruleType === "allowed_values") {
    config.values = String(form.get("values") ?? "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    config.ignore_case = form.get("ignore_case") === "on";
  } else if (ruleType === "regex") {
    config.pattern = String(form.get("pattern") ?? "").trim();
  } else if (ruleType === "date") {
    config.format = String(form.get("format") ?? "DD/MM/YYYY") as RuleConfig["format"];
    config.accept_excel_serial = form.get("accept_excel_serial") === "on";
  }

  return {
    column_name: column,
    rule_type: ruleType,
    name: String(form.get("name") ?? "").trim(),
    configuration_json: JSON.stringify(config),
    enabled: true,
  };
}

export function bindQualityDrawer(root: HTMLElement, profile: ColumnProfile, state: QualityState, actions: QualityDrawerActions) {
  const ruleById = new Map(state.rules.map((rule) => [rule.id, rule]));

  root.querySelector("[data-quality-add]")?.addEventListener("click", actions.onAddRule);
  root.querySelectorAll("[data-quality-cancel]").forEach((item) => item.addEventListener("click", actions.onCancelForm));
  root.querySelector("[data-quality-retry]")?.addEventListener("click", actions.onRetryQuality);
  root.querySelectorAll<HTMLElement>("[data-quality-apply]").forEach((item) => {
    item.addEventListener("click", () => {
      const rule = ruleById.get(item.dataset.qualityApply ?? "");
      if (rule) actions.onApplyRuleFilter(rule);
    });
  });
  root.querySelectorAll<HTMLElement>("[data-quality-edit]").forEach((item) => {
    item.addEventListener("click", () => {
      const rule = ruleById.get(item.dataset.qualityEdit ?? "");
      if (rule) actions.onEditRule(rule);
    });
  });
  root.querySelectorAll<HTMLElement>("[data-quality-toggle]").forEach((item) => {
    item.addEventListener("click", () => {
      const rule = ruleById.get(item.dataset.qualityToggle ?? "");
      if (rule) actions.onToggleRule(rule);
    });
  });
  root.querySelectorAll<HTMLElement>("[data-quality-delete]").forEach((item) => {
    item.addEventListener("click", () => {
      const rule = ruleById.get(item.dataset.qualityDelete ?? "");
      if (rule) actions.onDeleteRule(rule);
    });
  });
  root.querySelector<HTMLFormElement>("[data-quality-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    actions.onSaveRule(inputFromForm(form, profile.column), form.dataset.ruleId || null);
  });
  const formEl = root.querySelector<HTMLFormElement>("[data-quality-form]");
  const typeSelect = formEl?.querySelector<HTMLSelectElement>('select[name="rule_type"]');
  typeSelect?.addEventListener("change", () => {
    if (!formEl) return;
    const type = typeSelect.value as QualityRuleType;
    const fields = formEl.querySelector<HTMLElement>("[data-quality-dynamic-fields]");
    const nameInput = formEl.querySelector<HTMLInputElement>('input[name="name"]');
    const definition = qualityRuleDefinitions(profile.inferred_type).find((item) => item.type === type);
    if (fields) {
      fields.innerHTML = renderRuleFields(type, defaultConfig(type));
    }
    if (nameInput && definition && !state.editingRule) {
      nameInput.value = definition.defaultName;
    }
  });
}
