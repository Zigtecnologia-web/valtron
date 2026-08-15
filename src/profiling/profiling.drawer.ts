import type { ColumnProfile, ProfilingState, ValueFrequency } from "./profiling.types";
import { bindQualityDrawer, renderQualityDrawer, type QualityDrawerActions } from "../quality/quality.drawer";
import type { QualityState } from "../quality/quality.types";
import {
  bindTransformationDrawer,
  renderTransformationDrawer,
  type TransformationDrawerActions,
} from "../transformations/transformation.drawer";
import type { TransformationState } from "../transformations/transformation.types";

type DrawerActions = {
  onClose: () => void;
  onRetry: (column: string) => void;
  onFilterValue: (column: string, value: string) => void;
  onFilterEmpty: (column: string) => void;
  activeFilterLabel: (column: string) => string | null;
  onTabChange: (tab: "profile" | "quality" | "transform") => void;
  quality: QualityDrawerActions;
  transformation: TransformationDrawerActions;
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
  return `${formatDecimal(value, 1)}%`;
}

function typeLabel(profile: ColumnProfile) {
  const labels: Record<string, string> = {
    text: "Texto provável",
    integer: "Inteiro provável",
    decimal: "Decimal provável",
    date: "Data provável",
    datetime: "Data e hora provável",
    boolean: "Booleano provável",
  };

  return labels[profile.inferred_type] ?? "Texto provável";
}

function metric(label: string, value: string, extra = "", action = "") {
  const tag = action ? "button" : "article";
  const attrs = action ? ` type="button" ${action}` : "";
  return `
    <${tag} class="profile-metric ${action ? "actionable" : ""}"${attrs}>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${extra ? `<small>${escapeHtml(extra)}</small>` : ""}
    </${tag}>
  `;
}

function statRows(rows: Array<[string, string]>) {
  return rows
    .map(
      ([label, value]) => `
        <div class="profile-stat-row">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `,
    )
    .join("");
}

function renderDistribution(profile: ColumnProfile) {
  if (!profile.distribution.length) return "";
  const max = Math.max(...profile.distribution.map((bucket) => bucket.count), 1);
  const first = profile.distribution[0];
  const last = profile.distribution[profile.distribution.length - 1];

  return `
    <section class="profile-section">
      <h3>Distribuição</h3>
      <div class="profile-histogram" aria-label="Distribuição numérica">
        ${profile.distribution
          .map((bucket) => {
            const height = Math.max(8, Math.round((bucket.count / max) * 72));
            return `<span style="height: ${height}px" title="${formatDecimal(bucket.min)} - ${formatDecimal(bucket.max)}: ${formatNumber(bucket.count)}"></span>`;
          })
          .join("")}
      </div>
      <div class="profile-axis">
        <span>${formatDecimal(first.min)}</span>
        <span>${formatDecimal(last.max)}</span>
      </div>
    </section>
  `;
}

function renderTopValues(profile: ColumnProfile) {
  if (!profile.top_values.length) return "";
  const max = Math.max(...profile.top_values.map((item) => item.count), 1);

  return `
    <section class="profile-section">
      <h3>Mais frequentes</h3>
      <div class="profile-frequency-list">
        ${profile.top_values.map((item) => renderFrequency(profile.column, item, max)).join("")}
      </div>
    </section>
  `;
}

function renderFrequency(column: string, item: ValueFrequency, max: number) {
  const width = Math.max(4, Math.round((item.count / max) * 100));
  return `
    <button class="profile-frequency" type="button" data-profile-filter-column="${escapeHtml(column)}" data-profile-filter-value="${escapeHtml(item.value)}">
      <span class="profile-frequency-row">
        <strong title="${escapeHtml(item.value)}">${escapeHtml(item.value)}</strong>
        <span>${formatNumber(item.count)}</span>
      </span>
      <span class="profile-bar"><i style="width: ${width}%"></i></span>
    </button>
  `;
}

function renderTypeStats(profile: ColumnProfile) {
  if (profile.numeric_stats) {
    return `
      <section class="profile-section">
        <h3>Estatísticas</h3>
        ${statRows([
          ["Mínimo", formatDecimal(profile.numeric_stats.min)],
          ["Máximo", formatDecimal(profile.numeric_stats.max)],
          ["Média", formatDecimal(profile.numeric_stats.avg)],
          ["Mediana", formatDecimal(profile.numeric_stats.median)],
          ["Desvio padrão", formatDecimal(profile.numeric_stats.stddev)],
        ])}
      </section>
    `;
  }

  if (profile.text_stats) {
    return `
      <section class="profile-section">
        <h3>Comprimento</h3>
        ${statRows([
          ["Mínimo", formatDecimal(profile.text_stats.min_length, 0)],
          ["Médio", formatDecimal(profile.text_stats.avg_length, 1)],
          ["Máximo", formatDecimal(profile.text_stats.max_length, 0)],
        ])}
      </section>
    `;
  }

  if (profile.date_stats) {
    const rows: Array<[string, string]> = [
      ["Mais antiga", profile.date_stats.min ?? "-"],
      ["Mais recente", profile.date_stats.max ?? "-"],
    ];
    if (profile.date_stats.predominant_format) {
      rows.push(["Formato predominante", profile.date_stats.predominant_format]);
    }
    if (profile.date_stats.example_original && profile.date_stats.example_interpreted) {
      rows.push([
        "Exemplo interpretado",
        `${profile.date_stats.example_original} -> ${profile.date_stats.example_interpreted}`,
      ]);
    }

    return `
      <section class="profile-section">
        <h3>Datas</h3>
        ${statRows(rows)}
      </section>
    `;
  }

  if (profile.boolean_stats?.length) {
    const max = Math.max(...profile.boolean_stats.map((item) => item.count), 1);
    return `
      <section class="profile-section">
        <h3>Valores</h3>
        ${profile.boolean_stats
          .map(
            (item) => `
              <div class="profile-boolean-row">
                <span><strong>${escapeHtml(item.label)}</strong> ${formatNumber(item.count)} · ${formatPercent(item.percentage)}</span>
                <span class="profile-bar"><i style="width: ${Math.round((item.count / max) * 100)}%"></i></span>
              </div>
            `,
          )
          .join("")}
      </section>
    `;
  }

  return "";
}

function renderLoading(column: string) {
  return `
    <aside class="profile-drawer open" aria-label="Profiling da coluna">
      <div class="profile-drawer-header">
        <div>
          <p class="eyebrow">Profiling</p>
          <h2>${escapeHtml(column)}</h2>
        </div>
        <button class="icon-button profile-close" type="button" data-profile-close aria-label="Fechar profiling">×</button>
      </div>
      <div class="profile-loading" aria-live="polite">
        <p>Analisando coluna...</p>
        <div class="profile-skeleton line wide"></div>
        <div class="profile-skeleton line"></div>
        <div class="profile-skeleton-grid">
          <div class="profile-skeleton card"></div>
          <div class="profile-skeleton card"></div>
        </div>
        <div class="profile-skeleton chart"></div>
      </div>
    </aside>
  `;
}

function renderTabs(activeTab: "profile" | "quality" | "transform") {
  return `
    <div class="profile-tabs" role="tablist" aria-label="Perspectiva da coluna">
      <button type="button" data-profile-tab="profile" class="${activeTab === "profile" ? "active" : ""}">Perfil</button>
      <button type="button" data-profile-tab="quality" class="${activeTab === "quality" ? "active" : ""}">Qualidade</button>
      <button type="button" data-profile-tab="transform" class="${activeTab === "transform" ? "active" : ""}">Transformar</button>
    </div>
  `;
}

function renderError(state: ProfilingState) {
  const column = state.column ?? "";
  return `
    <aside class="profile-drawer open" aria-label="Profiling da coluna">
      <div class="profile-drawer-header">
        <div>
          <p class="eyebrow">Profiling</p>
          <h2>${escapeHtml(column)}</h2>
        </div>
        <button class="icon-button profile-close" type="button" data-profile-close aria-label="Fechar profiling">×</button>
      </div>
      <div class="profile-error">
        <strong>Não foi possível analisar esta coluna.</strong>
        <p>${escapeHtml(state.error ?? "Erro inesperado.")}</p>
        <button class="ghost-button" type="button" data-profile-retry="${escapeHtml(column)}">Tentar novamente</button>
      </div>
    </aside>
  `;
}

function renderProfileContent(profile: ColumnProfile, activeFilterLabel: string | null) {
  return `
      ${activeFilterLabel ? `<div class="profile-active-filter"><span>Filtro ativo</span><strong>${escapeHtml(activeFilterLabel)}</strong></div>` : ""}

      <div class="profile-count">${formatNumber(profile.total_count)} <span>registros</span></div>

      <section class="profile-metrics">
        ${metric("Preenchidos", formatNumber(profile.filled_count), formatPercent(100 - profile.empty_percentage))}
        ${metric("Vazios", formatNumber(profile.empty_count), formatPercent(profile.empty_percentage), `data-profile-empty-column="${escapeHtml(profile.column)}"`)}
        ${metric("Distintos", formatNumber(profile.distinct_count))}
        ${metric("Duplicados", formatNumber(profile.duplicate_count))}
      </section>

      ${renderDistribution(profile)}
      ${renderTypeStats(profile)}
      ${renderTopValues(profile)}
  `;
}

function renderProfile(
  profile: ColumnProfile,
  activeFilterLabel: string | null,
  activeTab: "profile" | "quality" | "transform",
  qualityState: QualityState,
  transformationState: TransformationState,
) {
  const content =
    activeTab === "quality"
      ? renderQualityDrawer(profile, qualityState)
      : activeTab === "transform"
        ? renderTransformationDrawer(profile, transformationState)
        : renderProfileContent(profile, activeFilterLabel);

  return `
    <aside class="profile-drawer open" aria-label="Analise da coluna">
      <div class="profile-drawer-header">
        <div>
          <p class="eyebrow">Analisar coluna</p>
          <h2>${escapeHtml(profile.column)}</h2>
          <span>${escapeHtml(typeLabel(profile))}</span>
        </div>
        <button class="icon-button profile-close" type="button" data-profile-close aria-label="Fechar analise">×</button>
      </div>

      ${renderTabs(activeTab)}
      <div class="profile-tab-panel">
        ${content}
      </div>
    </aside>
  `;
}

export function renderProfilingDrawer(
  root: HTMLElement,
  state: ProfilingState,
  qualityState: QualityState,
  transformationState: TransformationState,
  actions: DrawerActions,
) {
  if (state.status === "closed") {
    root.innerHTML = "";
    root.classList.add("hidden");
    return;
  }

  root.classList.remove("hidden");

  if (state.status === "loading") {
    root.innerHTML = renderLoading(state.column ?? "");
  } else if (state.status === "error") {
    root.innerHTML = renderError(state);
  } else if (state.profile) {
    root.innerHTML = renderProfile(
      state.profile,
      actions.activeFilterLabel(state.profile.column),
      state.activeTab,
      qualityState,
      transformationState,
    );
  }

  root.querySelector("[data-profile-close]")?.addEventListener("click", actions.onClose);
  root.querySelectorAll<HTMLElement>("[data-profile-tab]").forEach((item) => {
    item.addEventListener("click", () => {
      const tab =
        item.dataset.profileTab === "quality"
          ? "quality"
          : item.dataset.profileTab === "transform"
            ? "transform"
            : "profile";
      actions.onTabChange(tab);
    });
  });
  root.querySelector("[data-profile-retry]")?.addEventListener("click", (event) => {
    const column = (event.currentTarget as HTMLElement).dataset.profileRetry;
    if (column) actions.onRetry(column);
  });
  root.querySelector("[data-profile-empty-column]")?.addEventListener("click", (event) => {
    const column = (event.currentTarget as HTMLElement).dataset.profileEmptyColumn;
    if (column) actions.onFilterEmpty(column);
  });
  root.querySelectorAll("[data-profile-filter-column][data-profile-filter-value]").forEach((item) => {
    item.addEventListener("click", (event) => {
      const target = event.currentTarget as HTMLElement;
      const column = target.dataset.profileFilterColumn;
      const value = target.dataset.profileFilterValue;
      if (column && value !== undefined) actions.onFilterValue(column, value);
    });
  });
  if (state.profile && state.activeTab === "quality") {
    bindQualityDrawer(root, state.profile, qualityState, actions.quality);
  }
  if (state.profile && state.activeTab === "transform") {
    bindTransformationDrawer(root, actions.transformation);
  }
}

export function profileHeaderHint(profile: ColumnProfile) {
  if (profile.empty_percentage > 0) {
    return `${typeLabel(profile).replace(" provável", "")} · ${formatPercent(profile.empty_percentage)} vazio`;
  }

  if (profile.inferred_type === "text") {
    return `Texto · ${formatNumber(profile.distinct_count)} únicos`;
  }

  return typeLabel(profile).replace(" provável", "");
}
