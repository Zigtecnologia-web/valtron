import type { ColumnProfile } from "../profiling/profiling.types";
import type {
  TransformationDefinition,
  TransformationState,
  TransformationType,
} from "./transformation.types";

export type TransformationDrawerActions = {
  onSelectType: (type: TransformationType) => void;
  onConfigChange: (key: string, value: string | number | boolean) => void;
  onPreview: () => void;
  onApply: () => void;
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

const definitions: TransformationDefinition[] = [
  {
    type: "trim",
    label: "Remover espaços",
    description: "Remove espaços no início e no fim do valor.",
  },
  {
    type: "uppercase",
    label: "Maiúsculas",
    description: "Converte texto para letras maiúsculas.",
  },
  {
    type: "lowercase",
    label: "Minúsculas",
    description: "Converte texto para letras minúsculas.",
  },
  {
    type: "replace",
    label: "Localizar e substituir",
    description: "Substitui um trecho literal por outro valor.",
  },
  {
    type: "pad_left",
    label: "Preencher zeros à esquerda",
    description: "Completa o valor até o tamanho final informado.",
  },
  {
    type: "excel_serial_date",
    label: "Serial Excel → Data",
    description: "Converte números como 33639 para datas.",
  },
];

function recommended(profile: ColumnProfile) {
  const names = profile.column.toLowerCase();
  if (profile.date_stats?.example_original || names.includes("data") || names.includes("nascimento")) {
    return definitions.filter((item) => item.type === "excel_serial_date");
  }

  if (names.includes("cpf") || names.includes("cnpj") || names.includes("matricula")) {
    return definitions.filter((item) => item.type === "pad_left" || item.type === "trim");
  }

  return definitions.filter((item) => item.type === "trim");
}

function operationCard(definition: TransformationDefinition, selected: boolean, group: string) {
  return `
    <button
      class="transform-card ${selected ? "selected" : ""}"
      type="button"
      data-transform-type="${definition.type}"
    >
      <strong>${escapeHtml(definition.label)}</strong>
      <span>${escapeHtml(definition.description)}</span>
      <small>${escapeHtml(group)}</small>
    </button>
  `;
}

function configValue(state: TransformationState, key: string, fallback = "") {
  const value = state.configuration[key];
  return value === null || value === undefined ? fallback : String(value);
}

function renderConfig(state: TransformationState) {
  if (!state.selectedType) return "";

  if (state.selectedType === "replace") {
    return `
      <section class="transform-form">
        <label>Localizar
          <input data-transform-config="find" value="${escapeHtml(configValue(state, "find"))}" />
        </label>
        <label>Substituir por
          <input data-transform-config="replacement" value="${escapeHtml(configValue(state, "replacement"))}" />
        </label>
        <label class="transform-check">
          <input type="checkbox" data-transform-config="regex" ${state.configuration.regex ? "checked" : ""} />
          Usar expressão regular
        </label>
        ${
          state.configuration.regex
            ? `<div class="transform-warning">Regex ainda não está disponível para aplicar. Desmarque para usar substituição literal.</div>`
            : ""
        }
      </section>
    `;
  }

  if (state.selectedType === "pad_left") {
    return `
      <section class="transform-form">
        <label>Tamanho final
          <input type="number" min="1" max="512" step="1" data-transform-config="length" value="${escapeHtml(configValue(state, "length", "11"))}" />
        </label>
      </section>
    `;
  }

  if (state.selectedType === "excel_serial_date") {
    return `
      <section class="transform-form">
        <label>Formato de saída
          <select data-transform-config="output_format">
            ${["DD/MM/YYYY", "YYYY-MM-DD", "YYYY/MM/DD", "DD-MM-YYYY"]
              .map((format) => `<option value="${format}" ${configValue(state, "output_format", "DD/MM/YYYY") === format ? "selected" : ""}>${format}</option>`)
              .join("")}
          </select>
        </label>
        <div class="transform-failure-policy">
          <span>Quando um valor não puder ser convertido</span>
          <strong>Manter valor original</strong>
        </div>
      </section>
    `;
  }

  return `
    <section class="transform-form">
      <div class="transform-failure-policy">
        <span>Comportamento</span>
        <strong>Aplicação determinística sobre a coluna selecionada</strong>
      </div>
    </section>
  `;
}

function renderPreview(state: TransformationState) {
  if (state.status === "previewing") {
    return `<section class="transform-preview"><p>Calculando preview...</p></section>`;
  }

  if (state.error) {
    return `<section class="transform-error"><strong>Não foi possível preparar a transformação.</strong><p>${escapeHtml(state.error)}</p></section>`;
  }

  if (!state.preview) return "";

  return `
    <section class="transform-impact">
      <h3>Impacto</h3>
      <div class="transform-impact-grid">
        <article><span>Analisados</span><strong>${formatNumber(state.preview.total_rows)}</strong></article>
        <article><span>Alterados</span><strong>${formatNumber(state.preview.affected_rows)}</strong></article>
        <article><span>Iguais</span><strong>${formatNumber(state.preview.unchanged_rows)}</strong></article>
        <article><span>Falhas</span><strong>${formatNumber(state.preview.failed_rows)}</strong></article>
      </div>
    </section>
    <section class="transform-preview">
      <h3>Preview</h3>
      <div class="transform-samples">
        ${state.preview.samples
          .map(
            (sample) => `
              <div class="transform-sample ${sample.status === "failed" ? "failed" : ""}">
                <span title="${escapeHtml(sample.original ?? "")}">${escapeHtml(sample.original ?? "NULL")}</span>
                <strong title="${escapeHtml(sample.transformed ?? "")}">${escapeHtml(sample.transformed ?? "NULL")}</strong>
                <em>${sample.status === "failed" ? "inválido" : "alterado"}</em>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

export function renderTransformationDrawer(profile: ColumnProfile, state: TransformationState) {
  const recommendedItems = recommended(profile);
  const recommendedTypes = new Set(recommendedItems.map((item) => item.type));
  const otherItems = definitions.filter((item) => !recommendedTypes.has(item.type));
  const selected = definitions.find((item) => item.type === state.selectedType);

  return `
    <div class="transform-panel">
      <div>
        <p class="eyebrow">Transformar</p>
        <h3>${escapeHtml(profile.column)}</h3>
      </div>

      <section class="transform-section">
        <h4>Transformações recomendadas</h4>
        <div class="transform-card-list">
          ${recommendedItems.map((item) => operationCard(item, item.type === state.selectedType, "Recomendada")).join("")}
        </div>
      </section>

      <section class="transform-section">
        <h4>Outras transformações</h4>
        <div class="transform-card-list compact">
          ${otherItems.map((item) => operationCard(item, item.type === state.selectedType, "Disponível")).join("")}
        </div>
      </section>

      ${
        selected
          ? `
            <section class="transform-selected">
              <h4>${escapeHtml(selected.label)}</h4>
              <p>${escapeHtml(selected.description)}</p>
              ${renderConfig(state)}
              <div class="transform-actions">
                <button class="ghost-button" type="button" data-transform-preview ${state.status === "previewing" || state.status === "applying" ? "disabled" : ""}>Preview</button>
                <button class="primary-button" type="button" data-transform-apply ${!state.preview || state.status === "applying" ? "disabled" : ""}>
                  ${state.status === "applying" ? "Aplicando..." : "Aplicar transformação"}
                </button>
              </div>
            </section>
          `
          : ""
      }

      ${renderPreview(state)}
    </div>
  `;
}

export function bindTransformationDrawer(
  root: HTMLElement,
  actions: TransformationDrawerActions,
) {
  root.querySelectorAll<HTMLElement>("[data-transform-type]").forEach((item) => {
    item.addEventListener("click", () => {
      const type = item.dataset.transformType as TransformationType | undefined;
      if (type) actions.onSelectType(type);
    });
  });

  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-transform-config]").forEach((item) => {
    item.addEventListener("input", () => {
      const key = item.dataset.transformConfig;
      if (!key) return;
      if (item instanceof HTMLInputElement && item.type === "checkbox") {
        actions.onConfigChange(key, item.checked);
      } else if (item instanceof HTMLInputElement && item.type === "number") {
        actions.onConfigChange(key, Number(item.value));
      } else {
        actions.onConfigChange(key, item.value);
      }
    });
  });

  root.querySelector("[data-transform-preview]")?.addEventListener("click", actions.onPreview);
  root.querySelector("[data-transform-apply]")?.addEventListener("click", actions.onApply);
}
