const siaBody = document.querySelector('#sia-body');
const storjBody = document.querySelector('#storj-body');
const overviewSiaTotals = document.querySelector('#overview-sia-totals');
const overviewStorjTotals = document.querySelector('#overview-storj-totals');
const overviewSiaPeriod = document.querySelector('#overview-sia-period');
const overviewProblemsPanel = document.querySelector('#panel-overview-problems');
const overviewProblems = document.querySelector('#overview-problems');
const siaPeriod = document.querySelector('#sia-period');
const refreshButton = document.querySelector('#refresh-button');
const themeButtons = Array.from(document.querySelectorAll('[data-theme]'));
const viewButtons = Array.from(document.querySelectorAll('[data-view]'));
const viewPanels = Array.from(document.querySelectorAll('.view-panel'));
const overviewRangePickers = Array.from(document.querySelectorAll('[data-overview-range-picker]'));
const THEME_STORAGE_KEY = 'storageman-theme';
const VIEW_STORAGE_KEY = 'storageman-view';
const OVERVIEW_RANGE_STORAGE_KEY = 'storageman-sia-overview-range';
const AVAILABLE_THEMES = ['theme-operator', 'theme-daylight'];
const AVAILABLE_VIEWS = ['overview', 'sia', 'storj'];
const CURRENT_MONTH_RANGE_KEY = 'current-month';
const DEFAULT_OVERVIEW_RANGE_KEY = '7d';
const OVERVIEW_RANGE_OPTIONS = [
  { key: '1d', label: 'Today' },
  { key: CURRENT_MONTH_RANGE_KEY, label: 'Current Month', triggerLabel: 'Month' },
  { key: '7d', label: '7D' },
  { key: '1m', label: '1M' },
  { key: '3m', label: '3M' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'ALL' },
];

let overviewRangeKey = '7d';
let latestSiaOverviewData;
let latestStorjOverviewData;
let latestSiaOverviewError;
let latestStorjOverviewError;

function getOverviewRangeOption(key = overviewRangeKey) {
  return (
    OVERVIEW_RANGE_OPTIONS.find((option) => option.key === key) ??
    OVERVIEW_RANGE_OPTIONS.find((option) => option.key === DEFAULT_OVERVIEW_RANGE_KEY) ??
    OVERVIEW_RANGE_OPTIONS[0]
  );
}

function getOverviewRangeTriggerLabel(option = getOverviewRangeOption()) {
  return option.triggerLabel ?? option.label;
}

function getOverviewRangeMenuMarkup() {
  return OVERVIEW_RANGE_OPTIONS.map((option) => {
    const isSelected = option.key === overviewRangeKey;

    return `
      <button
        class="period-picker__option${isSelected ? ' is-selected' : ''}"
        type="button"
        role="menuitemradio"
        aria-checked="${String(isSelected)}"
        data-overview-range="${option.key}"
      >
        <span class="period-picker__check" aria-hidden="true">${isSelected ? '&#10003;' : ''}</span>
        <span class="period-picker__option-label">${option.label}</span>
      </button>
    `;
  }).join('');
}

function setOverviewRangeMenuState(picker, isOpen) {
  const trigger = picker?.querySelector('.period-picker__trigger');
  const menu = picker?.querySelector('.overview-range-menu');
  if (!(trigger instanceof HTMLButtonElement) || !(menu instanceof HTMLElement)) {
    return;
  }

  picker.classList.toggle('is-open', isOpen);
  trigger.setAttribute('aria-expanded', String(isOpen));
  menu.hidden = !isOpen;
}

function closeOverviewRangeMenus() {
  overviewRangePickers.forEach((picker) => {
    setOverviewRangeMenuState(picker, false);
  });
}

function updateOverviewRangePickers() {
  const option = getOverviewRangeOption();
  const menuMarkup = getOverviewRangeMenuMarkup();

  overviewRangePickers.forEach((picker) => {
    const trigger = picker.querySelector('.period-picker__trigger');
    const labelNode = picker.querySelector('.overview-range-label');
    const menu = picker.querySelector('.overview-range-menu');

    if (labelNode) {
      labelNode.textContent = getOverviewRangeTriggerLabel(option);
    }
    if (trigger instanceof HTMLButtonElement) {
      trigger.setAttribute('aria-label', `Select Sia overview range. Current selection ${option.label}`);
      trigger.title = option.label;
    }
    if (menu instanceof HTMLElement) {
      menu.innerHTML = menuMarkup;
    }
  });
}

function initializeOverviewRange() {
  const stored = localStorage.getItem(OVERVIEW_RANGE_STORAGE_KEY);
  overviewRangeKey = getOverviewRangeOption(stored ?? undefined).key;
  updateOverviewRangePickers();
}

function applyTheme(themeName) {
  const resolvedTheme = AVAILABLE_THEMES.includes(themeName) ? themeName : 'theme-operator';
  document.body.classList.remove(...AVAILABLE_THEMES);
  document.body.classList.add(resolvedTheme);
  document.documentElement.classList.remove(...AVAILABLE_THEMES);
  document.documentElement.classList.add(resolvedTheme);
  themeButtons.forEach((button) => {
    const isActive = button.dataset.theme === resolvedTheme;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
  localStorage.setItem(THEME_STORAGE_KEY, resolvedTheme);
}

function initializeTheme() {
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  const initialTheme =
    storedTheme && AVAILABLE_THEMES.includes(storedTheme)
      ? storedTheme
      : AVAILABLE_THEMES.find((themeName) => document.body.classList.contains(themeName)) ??
        'theme-operator';

  applyTheme(initialTheme);
}

function applyView(viewName) {
  const resolvedView = AVAILABLE_VIEWS.includes(viewName) ? viewName : 'overview';

  viewButtons.forEach((button) => {
    const isActive = button.dataset.view === resolvedView;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
    button.tabIndex = isActive ? 0 : -1;
  });

  viewPanels.forEach((panel) => {
    const isActive = panel.id === `view-${resolvedView}`;
    panel.hidden = !isActive;
    panel.classList.toggle('is-active', isActive);
  });

  closeOverviewRangeMenus();
  localStorage.setItem(VIEW_STORAGE_KEY, resolvedView);
}

function initializeView() {
  const storedView = localStorage.getItem(VIEW_STORAGE_KEY);
  applyView(storedView);
}

function formatUsd(value) {
  return `$${value.toFixed(2)}`;
}

function formatSc(value) {
  const absValue = Math.abs(value);
  if (absValue >= 1000) {
    return `${(value / 1000).toFixed(2)} KS`;
  }
  return `${value.toFixed(2)} SC`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const step = 1000;
  let value = bytes;
  let unitIndex = 0;

  while (value >= step && unitIndex < units.length - 1) {
    value /= step;
    unitIndex += 1;
  }

  let precision = 0;
  if (unitIndex > 0) {
    precision = value >= 10 ? 0 : 2;
  }

  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatGigabytes(bytes, options = { signed: false }) {
  if (!Number.isFinite(bytes)) {
    return options.signed ? '+0 GB' : '0 GB';
  }

  const gigabytes = bytes / 1000 ** 3;
  const absGigabytes = Math.abs(gigabytes);
  const useTerabytes = absGigabytes >= 1000;
  const value = useTerabytes ? gigabytes / 1000 : gigabytes;
  const unit = useTerabytes ? 'TB' : 'GB';
  const sign = value > 0 && options.signed ? '+' : '';
  return `${sign}${value.toFixed(2)} ${unit}`;
}

function formatSignedBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '0 B';
  }

  const absBytes = Math.abs(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const step = 1000;
  let value = absBytes;
  let unitIndex = 0;

  while (value >= step && unitIndex < units.length - 1) {
    value /= step;
    unitIndex += 1;
  }

  const sign = bytes > 0 ? '+' : bytes < 0 ? '-' : '';
  let precision = 0;
  if (unitIndex > 0) {
    precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  }

  return `${sign}${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatScore(score) {
  if (!Number.isFinite(score)) {
    return '—';
  }
  return `${(score * 100).toFixed(2)}%`;
}

function getNodeStatusMeta(status, message) {
  if (status !== 'error') {
    return {
      label: 'Online',
      className: 'status-pill--online',
    };
  }

  const text = `${message ?? ''}`.toLowerCase();
  const offlineSignals = [
    'econnrefused',
    'enotfound',
    'etimedout',
    'ehostunreach',
    'econnreset',
    'network',
  ];
  const misconfiguredSignals = [
    'unauthorized',
    'forbidden',
    'status 401',
    'status 403',
    'not json',
    'invalid',
  ];

  const isOffline = offlineSignals.some((signal) => text.includes(signal));
  const label = isOffline ? 'Offline' : 'Misconfigured';

  return {
    label,
    className: isOffline ? 'status-pill--offline' : 'status-pill--misconfigured',
  };
}

function renderStatusBadge(status, message) {
  const meta = getNodeStatusMeta(status, message);
  if (!meta) {
    return '';
  }

  return `
    <span class="status-pill ${meta.className}">
      <span class="status-pill__dot"></span>
      <span>${meta.label}</span>
    </span>
  `;
}

function getQuicStatusMeta(quicStatus) {
  if (!quicStatus) {
    return null;
  }

  const text = String(quicStatus).toLowerCase();
  if (text.includes('ok') || text.includes('healthy') || text.includes('enabled')) {
    return { isOk: true, className: 'status-pill--online' };
  }
  return { isOk: false, className: 'status-pill--offline' };
}

function renderQuicBadge(quicStatus) {
  const meta = getQuicStatusMeta(quicStatus);
  if (!meta) {
    return '';
  }

  const icon = meta.isOk ? '✓' : '✕';
  return `
    <span class="status-pill status-pill--quic ${meta.className}">
      <span class="status-pill__icon">${icon}</span>
      <span>QUIC</span>
    </span>
  `;
}

function getScoreClass(score) {
  if (!Number.isFinite(score)) {
    return 'is-muted';
  }
  if (score >= 0.99) {
    return 'is-good';
  }
  if (score >= 0.95) {
    return 'is-warn';
  }
  return 'is-bad';
}

function renderHealthBadge(label, score) {
  if (!Number.isFinite(score)) {
    return '';
  }
  const className = getScoreClass(score);
  return `
    <span class="health-badge ${className}">
      <span>${label}</span>
      <strong>${formatScore(score)}</strong>
    </span>
  `;
}

function collectOverviewProblems(system, data) {
  if (!data || !Array.isArray(data.nodes)) {
    return [];
  }

  return data.nodes.flatMap((node) => {
    if (node.status === 'error') {
      const meta = getNodeStatusMeta(node.status, node.message);
      return [
        {
          type: meta.label.toLowerCase(),
          label: meta.label,
          className: meta.className,
          system,
          host: node.host,
        },
      ];
    }

    const quicMeta = getQuicStatusMeta(node.quicStatus);
    if (quicMeta && !quicMeta.isOk) {
      return [
        {
          type: 'quic',
          label: 'QUIC',
          className: 'status-pill--offline',
          system,
          host: node.host,
        },
      ];
    }

    return [];
  });
}

function collectOverviewApiProblem(system, errorMessage) {
  if (!errorMessage) {
    return [];
  }

  const meta = getNodeStatusMeta('error', errorMessage);
  return [
    {
      type: meta.label.toLowerCase(),
      label: `${system} API`,
      className: meta.className,
      system,
      host: 'API',
    },
  ];
}

function renderOverviewProblems() {
  if (!overviewProblemsPanel || !overviewProblems) {
    return;
  }

  const issues = [
    ...collectOverviewApiProblem('Sia', latestSiaOverviewError),
    ...collectOverviewApiProblem('Storj', latestStorjOverviewError),
    ...collectOverviewProblems('Sia', latestSiaOverviewData),
    ...collectOverviewProblems('Storj', latestStorjOverviewData),
  ];

  const hasLoadedState =
    latestSiaOverviewData !== undefined ||
    latestStorjOverviewData !== undefined ||
    latestSiaOverviewError !== undefined ||
    latestStorjOverviewError !== undefined;

  if (!hasLoadedState) {
    overviewProblemsPanel.setAttribute('hidden', 'hidden');
    overviewProblems.innerHTML = '';
    return;
  }

  overviewProblemsPanel.removeAttribute('hidden');

  if (issues.length === 0) {
    overviewProblems.innerHTML = `
      <div class="problems-board problems-board--clear">
        <div class="problems-board__summary">
          <span class="status-pill status-pill--online">
            <span class="status-pill__dot"></span>
            <span>All Clear</span>
          </span>
        </div>
        <p class="problems-board__note">No offline, misconfigured, or QUIC issues detected.</p>
      </div>
    `;
    return;
  }

  const groups = [
    {
      type: 'offline',
      label: 'Offline',
      className: 'status-pill--offline',
    },
    {
      type: 'misconfigured',
      label: 'Misconfigured',
      className: 'status-pill--misconfigured',
    },
    {
      type: 'quic',
      label: 'QUIC',
      className: 'status-pill--offline',
    },
  ]
    .map((group) => ({
      ...group,
      entries: issues.filter((issue) => issue.type === group.type),
    }))
    .filter((group) => group.entries.length > 0);

  const summary = groups
    .map(
      (group) => `
        <span class="status-pill ${group.className}">
          <span class="status-pill__dot"></span>
          <span>${group.label} ${group.entries.length}</span>
        </span>
      `,
    )
    .join('');

  const details = groups
    .map(
      (group) => `
        <div class="problems-board__group">
          <div class="problems-board__group-header">
            <span class="status-pill ${group.className}">
              <span class="status-pill__dot"></span>
              <span>${group.label}</span>
            </span>
            <strong>${group.entries.length}</strong>
          </div>
          <div class="problems-board__items">
            ${group.entries
              .map(
                (entry) => `
                  <span class="problem-node ${group.className}">
                    <span class="problem-node__system">${entry.system}</span>
                    <span class="problem-node__host">${entry.host}</span>
                  </span>
                `,
              )
              .join('')}
          </div>
        </div>
      `,
    )
    .join('');

  overviewProblems.innerHTML = `
    <div class="problems-board">
      <div class="problems-board__summary">
        ${summary}
      </div>
      <p class="problems-board__note">${issues.length} issue${issues.length === 1 ? '' : 's'} need attention.</p>
      <div class="problems-board__groups">
        ${details}
      </div>
    </div>
  `;
}

function getMetricRangeLabel(label) {
  if (!label) {
    return '';
  }

  const normalized = String(label).toUpperCase();
  if (normalized === '1D') {
    return 'Today';
  }
  if (normalized === 'CURRENT') {
    return 'Current Month';
  }

  return label;
}

function isCurrentMonthMetricLabel(label) {
  return String(label).trim().toLowerCase() === 'current month';
}

function buildOverviewApiUrl(endpoint) {
  const option = getOverviewRangeOption();
  if (option.key === CURRENT_MONTH_RANGE_KEY) {
    return endpoint;
  }

  return `${endpoint}?range=${encodeURIComponent(option.key)}`;
}

function getStorageChangeEntries(storage) {
  if (!storage) {
    return [];
  }

  if (Number.isFinite(storage.changeRangeBytes)) {
    const value = storage.changeRangeBytes;
    const rangeLabel = getMetricRangeLabel(storage.changeRangeLabel);
    const label = rangeLabel ? (rangeLabel === 'Today' ? rangeLabel : `Last ${rangeLabel}`) : 'Range';
    return [
      {
        label,
        value: formatGigabytes(value, { signed: true }),
        className: value < 0 ? 'is-negative' : 'is-positive',
        detail:
          Number.isFinite(storage.changeRangeSampleHours) && storage.changeRangeSampleHours > 0
            ? `${storage.changeRangeSampleHours.toFixed(1)}h sample`
            : undefined,
      },
    ];
  }

  const entries = [];
  if (Number.isFinite(storage.changeDayBytes)) {
    const value = storage.changeDayBytes;
    entries.push({
      label: 'Today',
      value: formatGigabytes(value, { signed: true }),
      className: value < 0 ? 'is-negative' : 'is-positive',
      detail:
        Number.isFinite(storage.changeDaySampleHours) && storage.changeDaySampleHours > 0
          ? `${storage.changeDaySampleHours.toFixed(1)}h sample`
          : undefined,
    });
  }

  if (Number.isFinite(storage.changeMonthCalendarBytes)) {
    const value = storage.changeMonthCalendarBytes;
    entries.push({
      label: 'This Month',
      value: formatGigabytes(value, { signed: true }),
      className: value < 0 ? 'is-negative' : 'is-positive',
    });
  }

  if (Number.isFinite(storage.changeMonthBytes)) {
    const value = storage.changeMonthBytes;
    let label = '30d';
    if (storage.changeMonthBaselineStart) {
      const from = new Date(storage.changeMonthBaselineStart);
      label = `Since ${from.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
    }
    entries.push({
      label,
      value: formatGigabytes(value, { signed: true }),
      className: value < 0 ? 'is-negative' : 'is-positive',
    });
  }

  return entries;
}

function getStorjStorageSummaryEntries(storage) {
  if (!storage) {
    return [];
  }

  const entries = [];
  if (Number.isFinite(storage.satelliteDailyAverageBytes)) {
    entries.push({
      label: 'Avg Today',
      value: formatBytes(storage.satelliteDailyAverageBytes),
    });
  }

  if (Number.isFinite(storage.satelliteDayChangeBytes)) {
    entries.push({
      label: 'Today Δ',
      value: formatGigabytes(storage.satelliteDayChangeBytes, { signed: true }),
      className: getMetricToneClass(storage.satelliteDayChangeBytes),
      detail:
        Number.isFinite(storage.satelliteDaySampleHours) && storage.satelliteDaySampleHours > 0
          ? `${storage.satelliteDaySampleHours.toFixed(1)}h sample`
          : undefined,
    });
  }

  if (Number.isFinite(storage.satelliteMonthAverageBytes)) {
    entries.push({
      label: 'Avg Month',
      value: formatBytes(storage.satelliteMonthAverageBytes),
    });
  }

  if (Number.isFinite(storage.satelliteMonthChangeBytes)) {
    entries.push({
      label: 'Month Δ',
      value: formatGigabytes(storage.satelliteMonthChangeBytes, { signed: true }),
      className: getMetricToneClass(storage.satelliteMonthChangeBytes),
    });
  }

  return entries;
}

function getStorjBandwidthMonthMetrics(bandwidthMonth) {
  if (!bandwidthMonth) {
    return [];
  }

  return [
    Number.isFinite(bandwidthMonth.totalBytes)
      ? { label: 'Total', value: formatBytes(bandwidthMonth.totalBytes) }
      : null,
    Number.isFinite(bandwidthMonth.ingressBytes)
      ? { label: 'Ingress', value: formatBytes(bandwidthMonth.ingressBytes) }
      : null,
    Number.isFinite(bandwidthMonth.egressBytes)
      ? { label: 'Egress', value: formatBytes(bandwidthMonth.egressBytes) }
      : null,
  ].filter(Boolean);
}

function getStorjBandwidthTodayMetrics(bandwidth) {
  if (!bandwidth) {
    return [];
  }

  return [
    Number.isFinite(bandwidth.totalBytes)
      ? { label: 'Total', value: formatBytes(bandwidth.totalBytes ?? 0) }
      : null,
    Number.isFinite(bandwidth.ingressBytes)
      ? { label: 'Ingress', value: formatBytes(bandwidth.ingressBytes ?? 0) }
      : null,
    Number.isFinite(bandwidth.egressBytes)
      ? { label: 'Egress', value: formatBytes(bandwidth.egressBytes ?? 0) }
      : null,
    Number.isFinite(bandwidth.repairBytes) && bandwidth.repairBytes > 0
      ? { label: 'Repair part', value: formatBytes(bandwidth.repairBytes ?? 0) }
      : null,
    Number.isFinite(bandwidth.auditBytes) && bandwidth.auditBytes > 0
      ? { label: 'Audit part', value: formatBytes(bandwidth.auditBytes ?? 0) }
      : null,
  ].filter(Boolean);
}

function getStorjBandwidthTrendMetrics(bandwidth) {
  if (!bandwidth) {
    return [];
  }

  return [
    Number.isFinite(bandwidth.changeTotalBytes)
      ? {
          label: 'Total',
          value: formatSignedBytes(bandwidth.changeTotalBytes),
          className: getMetricToneClass(bandwidth.changeTotalBytes),
        }
      : null,
    Number.isFinite(bandwidth.changeIngressBytes)
      ? {
          label: 'In',
          value: formatSignedBytes(bandwidth.changeIngressBytes),
          className: getMetricToneClass(bandwidth.changeIngressBytes),
        }
      : null,
    Number.isFinite(bandwidth.changeEgressBytes)
      ? {
          label: 'Eg',
          value: formatSignedBytes(bandwidth.changeEgressBytes),
          className: getMetricToneClass(bandwidth.changeEgressBytes),
        }
      : null,
    Number.isFinite(bandwidth.changeRepairBytes) && bandwidth.changeRepairBytes !== 0
      ? {
          label: 'Repair part',
          value: formatSignedBytes(bandwidth.changeRepairBytes),
          className: getMetricToneClass(bandwidth.changeRepairBytes),
        }
      : null,
    Number.isFinite(bandwidth.changeAuditBytes) && bandwidth.changeAuditBytes !== 0
      ? {
          label: 'Audit part',
          value: formatSignedBytes(bandwidth.changeAuditBytes),
          className: getMetricToneClass(bandwidth.changeAuditBytes),
        }
      : null,
  ].filter(Boolean);
}

function getStorjBandwidthTrendLabel(bandwidth) {
  if (!Number.isFinite(bandwidth?.changeSampleHours) || bandwidth.changeSampleHours <= 0) {
    return 'Trend';
  }

  const hours = bandwidth.changeSampleHours;
  const label = Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace(/\.0$/, '');
  return `${label}HΔ`;
}

function getMetricToneClass(value) {
  if (!Number.isFinite(value) || value === 0) {
    return '';
  }

  return value < 0 ? 'is-negative' : 'is-positive';
}

function renderStorageChangeInline(storage, extraEntries = []) {
  const entries = [...getStorageChangeEntries(storage), ...extraEntries.filter(Boolean)];
  if (entries.length === 0) {
    if (Number.isFinite(storage?.changeDaySampleHours) && storage.changeDaySampleHours < 23.5) {
      return `
        <div class="storage-change storage-change--inline storage-change--pending">
          <span>Collecting data… ${storage.changeDaySampleHours.toFixed(1)}h sample so far</span>
        </div>
      `;
    }
    return '';
  }

  const content = entries
    .map(
      (entry) => `
        <span class="storage-change__entry">
          <span>${entry.label}</span>
          <span class="storage-change__value ${entry.className ?? ''}">${entry.value}</span>
          ${entry.detail ? `<small>${entry.detail}</small>` : ''}
        </span>
      `,
    )
    .join('<span class="storage-change__divider">•</span>');

  return `<div class="storage-change storage-change--inline">${content}</div>`;
}

function buildStorageCell(used, total, options = {}) {
  const settings =
    typeof options === 'boolean'
      ? { hideLegend: options, legendClass: '' }
      : {
          hideLegend: Boolean(options.hideLegend),
          legendClass: options.legendClass ?? '',
        };

  const legendClasses = ['storage-legend'];
  if (settings.legendClass) {
    legendClasses.push(settings.legendClass);
  }

  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return `<div class="${legendClasses.join(' ')}"><span>Storage data unavailable</span></div>`;
  }

  const free = Math.max(total - used, 0);
  const percentUsed = Math.max(0, Math.min(100, (used / total) * 100));
  const roundedPercent = Math.round(percentUsed * 10) / 10;

  return `
    <div
      class="storage-bar"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="${roundedPercent}"
      aria-label="Storage used ${formatBytes(used)} of ${formatBytes(total)}"
    >
      <div class="storage-bar__fill" style="width: ${percentUsed}%"></div>
    </div>
    ${
      settings.hideLegend
        ? ''
        : `<div class="${legendClasses.join(' ')}">
            <span>Used ${formatBytes(used)}</span>
            <span>Free ${formatBytes(free)}</span>
            <span>Total ${formatBytes(total)}</span>
          </div>`
    }
  `;
}

function getSiaPeriodText(data) {
  if (!data) {
    return '';
  }

  if (!data.periodStart) {
    return data.periodLabel ?? '';
  }

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const formatShortDate = (date) =>
    `${String(date.getUTCDate()).padStart(2, '0')} ${monthNames[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

  if (data.periodMode === 'range') {
    if (data.periodEnd) {
      return `${data.periodLabel ?? data.periodShortLabel ?? 'Range'}: ${formatShortDate(
        new Date(data.periodStart),
      )} → ${formatShortDate(new Date(data.periodEnd))}`;
    }

    return data.periodLabel ?? data.periodShortLabel ?? 'Range';
  }

  const currentStart = new Date(data.periodStart);
  const previousStart = data.previousPeriodStart ? new Date(data.previousPeriodStart) : undefined;
  const currentEnd = data.periodEnd
    ? new Date(Date.parse(data.periodEnd) - 1)
    : new Date(currentStart.getFullYear(), currentStart.getMonth() + 1, 0);

  if (previousStart) {
    return `Current: ${formatShortDate(currentStart)} → ${formatShortDate(
      currentEnd,
    )} | Baseline: ${formatShortDate(previousStart)}`;
  }

  return `Current starting ${formatShortDate(currentStart)}`;
}

function renderSiaTotals(target, data, options = {}) {
  if (!target) {
    return;
  }

  if (!data || !data.aggregate) {
    target.innerHTML = '';
    target.className = 'totals-card';
    target.setAttribute('hidden', 'hidden');
    return;
  }

  const aggregate = data.aggregate ?? {};
  const aggregateCurrent = aggregate.current ?? { earned: 0 };
  const aggregateCurrentMonth = aggregate.currentMonth;
  const aggregateTotal = aggregate.total ?? { earned: 0 };
  const aggregateStorage = aggregate.storage;
  const aggregateContracts = aggregate.contracts;
  const currentLabel = options.currentLabel ?? 'Current';
  const showCurrentMonthMetric =
    aggregateCurrentMonth && !isCurrentMonthMetricLabel(currentLabel);
  const subtitle = options.subtitle ?? 'Current period and lifetime totals';

  target.removeAttribute('hidden');
  target.className = 'totals-card totals-card--sia';

  const storageMarkup =
    Number.isFinite(aggregateStorage?.capacityBytes) && (aggregateStorage?.capacityBytes ?? 0) > 0
      ? `
          <div class="totals-card__section totals-card__storage">
            <div class="heading-title">Aggregate Storage</div>
            <div class="heading-storage heading-storage--compact">
              ${renderStorageChangeInline(aggregateStorage)}
              ${buildStorageCell(aggregateStorage.usedBytes, aggregateStorage.capacityBytes, {
                legendClass: 'storage-legend--compact',
              })}
            </div>
          </div>
        `
      : '';

  const earnedTotalsMarkup = `
    <div class="totals-card__section totals-card__wallet totals-card__summary">
      <div class="heading-title">Earned</div>
          ${renderSummaryMetricLine(
        [
          {
            label: currentLabel,
            value: formatSc(aggregateCurrent.earned ?? 0),
            className: getMetricToneClass(aggregateCurrent.earned ?? 0),
          },
          ...(showCurrentMonthMetric
            ? [
                {
                  label: 'Current Month',
                  value: formatSc(aggregateCurrentMonth.earned ?? 0),
                  className: getMetricToneClass(aggregateCurrentMonth.earned ?? 0),
                },
              ]
            : []),
          {
            label: 'Lifetime',
            value: formatSc(aggregateTotal.earned ?? 0),
            className: getMetricToneClass(aggregateTotal.earned ?? 0),
          },
        ],
        'summary-metrics--totals',
      )}
    </div>
  `;

  const walletTotals = data.nodes.reduce(
    (accumulator, node) => {
      if (node.status !== 'ok' || !node.wallet) {
        return accumulator;
      }

      accumulator.balance += node.wallet.confirmed ?? 0;
      accumulator.spendable += node.wallet.spendable ?? 0;
      accumulator.unconfirmed +=
        (node.wallet.unconfirmedIncoming ?? 0) - (node.wallet.unconfirmedOutgoing ?? 0);
      if (Number.isFinite(node.wallet.lockedCollateral)) {
        accumulator.collateral += node.wallet.lockedCollateral ?? 0;
      }
      accumulator.hasWallets = true;
      accumulator.hasCollateral =
        accumulator.hasCollateral || Number.isFinite(node.wallet.lockedCollateral);
      return accumulator;
    },
    {
      balance: 0,
      spendable: 0,
      unconfirmed: 0,
      collateral: 0,
      hasWallets: false,
      hasCollateral: false,
    },
  );

  const walletTotalsMarkup = walletTotals.hasWallets
    ? `
        <div class="totals-card__section totals-card__wallet totals-card__summary">
          <div class="heading-title">Wallet</div>
          ${renderSummaryMetricLine([
            {
              label: 'Balance',
              value: formatSc(walletTotals.balance),
              className: getMetricToneClass(walletTotals.balance),
            },
            {
              label: 'Spendable',
              value: formatSc(walletTotals.spendable),
              className: getMetricToneClass(walletTotals.spendable),
            },
            {
              label: 'Unconfirmed',
              value: formatSc(walletTotals.unconfirmed),
              className: getMetricToneClass(walletTotals.unconfirmed),
            },
            ...(walletTotals.hasCollateral
              ? [
                  {
                    label: 'Collateral',
                    value: formatSc(walletTotals.collateral),
                    className: getMetricToneClass(walletTotals.collateral),
                  },
                ]
              : []),
          ], 'summary-metrics--totals')}
        </div>
      `
    : '';

  const contractsMarkup = aggregateContracts
    ? `
        <div class="totals-card__section totals-card__wallet totals-card__summary">
          <div class="heading-title">Contracts</div>
          ${renderContractSummary(aggregateContracts, 'summary-metrics--totals')}
        </div>
      `
    : '';

  target.innerHTML = `
    <div class="totals-card__header">
      <span class="totals-card__title">Totals</span>
      <span class="totals-card__subtitle">${subtitle}</span>
    </div>
    ${earnedTotalsMarkup}
    ${walletTotalsMarkup}
    ${contractsMarkup}
    ${storageMarkup}
  `;
}

function renderStorjTotals(target, data) {
  if (!target) {
    return;
  }

  if (!data || !data.aggregate) {
    target.innerHTML = '';
    target.className = 'totals-card';
    target.setAttribute('hidden', 'hidden');
    return;
  }

  const aggregate = data.aggregate ?? {
    current: { grossUsd: 0, heldUsd: 0, netUsd: 0 },
    total: { grossUsd: 0, heldUsd: 0, netUsd: 0 },
    disk: { usedBytes: 0, availableBytes: 0, trashBytes: 0, freeBytes: 0 },
  };
  const aggregateCurrent = aggregate.current ?? { grossUsd: 0, heldUsd: 0, netUsd: 0 };
  const aggregateTotal = aggregate.total ?? { grossUsd: 0, heldUsd: 0, netUsd: 0 };
  const aggregateDisk = aggregate.disk ?? {
    usedBytes: 0,
    availableBytes: 0,
    trashBytes: 0,
    freeBytes: 0,
  };

  const aggregateCapacity =
    aggregateDisk.availableBytes ?? (aggregateDisk.usedBytes ?? 0) + (aggregateDisk.freeBytes ?? 0);
  const aggregateStorageEntries = getStorjStorageSummaryEntries(aggregateDisk);
  const aggregateBandwidthMonthMetrics = getStorjBandwidthMonthMetrics(aggregate.bandwidthMonth);
  const aggregateBandwidthTodayMetrics = getStorjBandwidthTodayMetrics(aggregate.bandwidth);
  const aggregateBandwidthTrendMetrics = getStorjBandwidthTrendMetrics(aggregate.bandwidth);

  target.removeAttribute('hidden');
  target.className = 'totals-card totals-card--storj';

  const revenueMarkup = `
    <div class="totals-card__section totals-card__wallet totals-card__summary">
      <div class="heading-title">Revenue (USD)</div>
      ${renderStorjRevenueSummary(aggregateCurrent, aggregateTotal, 'storj-summary-stack--totals')}
    </div>
  `;

  const storageMarkup =
    Number.isFinite(aggregateCapacity) && (aggregateCapacity ?? 0) > 0
      ? `
          <div class="totals-card__section totals-card__storage">
            <div class="heading-title">Aggregate Storage</div>
            <div class="heading-storage heading-storage--compact">
              ${renderStorageChangeInline(undefined, aggregateStorageEntries)}
              ${buildStorageCell(aggregateDisk.usedBytes ?? 0, aggregateCapacity ?? 0, {
                legendClass: 'storage-legend--compact',
              })}
            </div>
          </div>
        `
      : '';
  const bandwidthMarkup =
    aggregateBandwidthMonthMetrics.length > 0 ||
    aggregateBandwidthTodayMetrics.length > 0 ||
    aggregateBandwidthTrendMetrics.length > 0
      ? `
          <div class="totals-card__section totals-card__wallet totals-card__summary">
            <div class="heading-title">Aggregate Bandwidth</div>
            <div class="inline-metrics-stack storj-summary-stack">
              ${
                aggregateBandwidthMonthMetrics.length > 0
                  ? `
                    <div class="inline-metrics-row storj-summary-row">
                      <span class="inline-metrics-row__label">Month</span>
                      ${renderSummaryMetricLine(
                        aggregateBandwidthMonthMetrics,
                        'summary-metrics--node-wallet',
                      )}
                    </div>
                  `
                  : ''
              }
              ${
                aggregateBandwidthTodayMetrics.length > 0
                  ? `
                    <div class="inline-metrics-row storj-summary-row">
                      <span class="inline-metrics-row__label">Today</span>
                      ${renderSummaryMetricLine(
                        aggregateBandwidthTodayMetrics,
                        'summary-metrics--node-wallet',
                      )}
                    </div>
                  `
                  : ''
              }
              ${
                aggregateBandwidthTrendMetrics.length > 0
                  ? `
                    <div class="inline-metrics-row storj-summary-row">
                      <span class="inline-metrics-row__label">${getStorjBandwidthTrendLabel(aggregate.bandwidth)}</span>
                      ${renderSummaryMetricLine(
                        aggregateBandwidthTrendMetrics,
                        'summary-metrics--node-wallet',
                      )}
                    </div>
                  `
                  : ''
              }
            </div>
          </div>
        `
      : '';

  target.innerHTML = `
    <div class="totals-card__header">
      <span class="totals-card__title">Totals</span>
    </div>
    ${revenueMarkup}
    ${bandwidthMarkup}
    ${storageMarkup}
  `;
}

function setPlaceholder(body, message) {
  body.innerHTML = `
    <tr class="placeholder">
      <td colspan="${body.dataset.columns ?? body.closest('table').tHead.rows[0].cells.length}">
        ${message}
      </td>
    </tr>
  `;
}

function createRow(columns, options = {}) {
  const row = document.createElement('tr');
  if (options.className) {
    row.className = options.className;
  }

  columns.forEach((column) => {
    const cell = document.createElement(options.header ? 'th' : 'td');
    if (column.colspan) {
      cell.colSpan = column.colspan;
    }
    if (column.className) {
      cell.classList.add(column.className);
    }
    cell.innerHTML = column.content;
    row.appendChild(cell);
  });

  return row;
}

function renderCompactMetricGroup(items, extraClass = '') {
  const classes = ['wallet-compact', 'wallet-compact--totals'];
  if (extraClass) {
    classes.push(extraClass);
  }

  return `<div class="${classes.join(' ')}">${items
    .map(
      (item) => `
        <div class="wallet-compact__item">
          <span class="wallet-compact__label">${item.label}</span>
          <span class="wallet-compact__value">${item.value}</span>
        </div>
      `,
    )
    .join('')}</div>`;
}

function renderSummaryMetricLine(items, extraClass = '') {
  const classes = ['storage-change', 'storage-change--inline', 'summary-metrics'];
  if (extraClass) {
    classes.push(extraClass);
  }

  return `<div class="${classes.join(' ')}">${items
    .map((item) => {
      const valueClasses = ['storage-change__value', 'summary-metrics__value'];
      if (item.className) {
        valueClasses.push(item.className);
      } else if (item.emphasis) {
        valueClasses.push('is-positive', 'summary-metrics__value--emphasis');
      }

      return `
        <span class="storage-change__entry summary-metrics__entry">
          <span class="summary-metrics__label">${item.label}</span>
          <span class="${valueClasses.join(' ')}">${item.value}</span>
        </span>
      `;
    })
    .join('<span class="storage-change__divider">•</span>')}</div>`;
}

function renderContractSummary(summary, extraClass = '') {
  if (!summary) {
    return '';
  }

  const formatDelta = (value) => {
    if (!Number.isFinite(value) || value === 0) {
      return '0';
    }
    return value > 0 ? `+${value}` : String(value);
  };

  return renderSummaryMetricLine(
    [
      {
        label: 'Active',
        value: `${summary.active?.currentCount ?? 0} (${formatDelta(summary.active?.deltaCount ?? 0)})`,
      },
      {
        label: 'Successful',
        value: `${summary.successful?.currentCount ?? 0} (${formatDelta(summary.successful?.deltaCount ?? 0)})`,
        className:
          (summary.successful?.deltaCount ?? 0) > 0 ? 'is-positive' : '',
      },
      {
        label: 'Renewed',
        value: `${summary.renewed?.currentCount ?? 0} (${formatDelta(summary.renewed?.deltaCount ?? 0)})`,
        className:
          (summary.renewed?.deltaCount ?? 0) > 0 ? 'is-positive' : '',
      },
      {
        label: 'Failed',
        value: `${summary.failed?.currentCount ?? 0} (${formatDelta(summary.failed?.deltaCount ?? 0)})`,
        className:
          (summary.failed?.deltaCount ?? 0) > 0 ? 'is-negative' : '',
      },
    ],
    extraClass,
  );
}

function renderStorjRevenueSummary(currentSnapshot, totalSnapshot, extraClass = '') {
  const classes = ['inline-metrics-stack', 'storj-summary-stack'];
  if (extraClass) {
    classes.push(extraClass);
  }

  return `
    <div class="${classes.join(' ')}">
      <div class="inline-metrics-row storj-summary-row">
        <span class="inline-metrics-row__label">Current</span>
        ${renderSummaryMetricLine(
          [
            { label: 'Gross', value: formatUsd(currentSnapshot.grossUsd ?? 0) },
            { label: 'Held', value: formatUsd(currentSnapshot.heldUsd ?? 0) },
            { label: 'Net', value: formatUsd(currentSnapshot.netUsd ?? 0), className: 'value-net' },
          ],
          'summary-metrics--node-wallet',
        )}
      </div>
      <div class="inline-metrics-row storj-summary-row">
        <span class="inline-metrics-row__label">Lifetime</span>
        ${renderSummaryMetricLine(
          [
            { label: 'Gross', value: formatUsd(totalSnapshot.grossUsd ?? 0) },
            { label: 'Held', value: formatUsd(totalSnapshot.heldUsd ?? 0) },
            { label: 'Net', value: formatUsd(totalSnapshot.netUsd ?? 0), className: 'value-net' },
          ],
          'summary-metrics--node-wallet',
        )}
      </div>
    </div>
  `;
}

function renderSiaAnnounceButton(host) {
  return `
    <button
      class="node-action-button"
      type="button"
      data-action="sia-announce"
      data-host="${host}"
      title="Broadcast this host announcement to the Sia network"
    >
      Announce
    </button>
  `;
}

function renderSiaNodeCard(node, index, currentLabel = 'Current') {
  const link = `<a href="http://${node.host}" target="_blank" rel="noreferrer noopener">${node.host}</a>`;
  const showCurrentMonthMetric =
    node.totals?.currentMonth && !isCurrentMonthMetricLabel(currentLabel);
  const sections = [
    `
      <div class="totals-card__section sia-node-card__heading">
        ${renderNodeHeading(
          'Sia Node',
          index + 1,
          link,
          node.storage?.usedBytes,
          node.storage?.capacityBytes,
          false,
          node.storage,
          node.status,
          node.status === 'error' ? node.message : '',
          node.quicStatus,
          [],
          renderSiaAnnounceButton(node.host),
        )}
      </div>
    `,
  ];

  if (node.status === 'error') {
    sections.push(`
      <div class="totals-card__section sia-node-card__message">
        <div class="wallet-card__message">⚠️ ${node.message}</div>
      </div>
    `);

    return `<div class="totals-card totals-card--sia sia-node-card">${sections.join('')}</div>`;
  }

  const summarySections = [];

  summarySections.push(`
    <div class="totals-card__section totals-card__wallet totals-card__summary node-card__summary">
      <div class="heading-title">Earned</div>
      ${renderSummaryMetricLine(
        [
          {
            label: currentLabel,
            value: formatSc(node.totals?.current?.earned ?? 0),
            className: getMetricToneClass(node.totals?.current?.earned ?? 0),
          },
          ...(showCurrentMonthMetric
            ? [
                {
                  label: 'Current Month',
                  value: formatSc(node.totals.currentMonth.earned ?? 0),
                  className: getMetricToneClass(node.totals.currentMonth.earned ?? 0),
                },
              ]
            : []),
          {
            label: 'Lifetime',
            value: formatSc(node.totals?.total?.earned ?? 0),
            className: getMetricToneClass(node.totals?.total?.earned ?? 0),
          },
        ],
        'summary-metrics--node-wallet',
      )}
    </div>
  `);

  if (node.wallet) {
    const netUnconfirmed =
      (node.wallet.unconfirmedIncoming ?? 0) - (node.wallet.unconfirmedOutgoing ?? 0);
    const walletItems = [
      {
        label: 'Balance',
        value: formatSc(node.wallet.confirmed),
        className: getMetricToneClass(node.wallet.confirmed),
      },
      {
        label: 'Spendable',
        value: formatSc(node.wallet.spendable),
        className: getMetricToneClass(node.wallet.spendable),
      },
      {
        label: 'Unconfirmed',
        value: formatSc(netUnconfirmed),
        className: getMetricToneClass(netUnconfirmed),
      },
    ];

    if (Number.isFinite(node.wallet.lockedCollateral)) {
      walletItems.push({
        label: 'Collateral',
        value: formatSc(node.wallet.lockedCollateral),
        className: getMetricToneClass(node.wallet.lockedCollateral),
      });
    }

    summarySections.push(`
      <div class="totals-card__section totals-card__wallet totals-card__summary node-card__summary">
        <div class="heading-title">Wallet</div>
        ${renderSummaryMetricLine(walletItems, 'summary-metrics--node-wallet')}
      </div>
    `);
  }

  if (node.contracts) {
    summarySections.push(`
      <div class="totals-card__section totals-card__wallet totals-card__summary node-card__summary">
        <div class="heading-title">Contracts</div>
        ${renderContractSummary(node.contracts, 'summary-metrics--node-wallet')}
      </div>
    `);
  }

  const metricsRows = (node.metrics ?? [])
    .map(
      (metric, metricIndex) => `
        <div class="node-details-grid__row${metricIndex % 2 === 1 ? ' is-alt' : ''}" role="row">
          <span class="node-details-grid__cell node-details-grid__cell--label" role="rowheader">${metric.metric}</span>
          <span class="node-details-grid__cell node-details-grid__cell--metric" role="cell">${formatSc(metric.current.earned)}</span>
          <span class="node-details-grid__cell node-details-grid__cell--metric" role="cell">${formatSc(metric.total.earned)}</span>
        </div>
      `,
    )
    .join('');

  const metricsContent =
    metricsRows.length > 0
      ? `
          <div class="node-detail-panel node-detail-panel--sia">
            <div class="node-detail-panel__header">
              <div class="heading-title">Metrics</div>
            </div>
            <div class="node-detail-panel__body">
              <div class="node-details-grid node-details-grid--sia-metrics" role="table" aria-label="Sia metrics current and lifetime earned">
                <div class="node-details-grid__row node-details-grid__row--head" role="row">
                  <span class="node-details-grid__cell node-details-grid__cell--label" role="columnheader">Metric</span>
                  <span class="node-details-grid__cell node-details-grid__cell--metric" role="columnheader">Current</span>
                  <span class="node-details-grid__cell node-details-grid__cell--metric" role="columnheader">Lifetime</span>
                </div>
                ${metricsRows}
              </div>
            </div>
          </div>
        `
      : `
          <div class="node-detail-panel node-detail-panel--sia">
            <div class="node-detail-panel__header">
              <div class="heading-title">Metrics</div>
            </div>
            <div class="node-detail-panel__body">
              <div class="wallet-card__message">No metrics available.</div>
            </div>
          </div>
        `;

  sections.push(`
    <div class="totals-card__section node-card__content-grid-shell">
      <div class="node-card__content-grid node-card__content-grid--sia">
        <div class="node-card__content-column node-card__content-column--summary">
          ${summarySections.join('')}
        </div>
        <div class="node-card__content-column node-card__content-column--details">
          <div class="totals-card__section sia-node-card__details">
            ${metricsContent}
          </div>
        </div>
      </div>
    </div>
  `);

  return `<div class="totals-card totals-card--sia sia-node-card">${sections.join('')}</div>`;
}

function renderStorjNodeCard(node, index) {
  const link = `<a href="http://${node.host}" target="_blank" rel="noreferrer noopener">${node.host}</a>`;
  const storageEntries = getStorjStorageSummaryEntries(node.disk);
  const sections = [
    `
      <div class="totals-card__section storj-node-card__heading">
        ${renderNodeHeading(
          'Storj Node',
          index + 1,
          link,
          node.disk?.usedBytes,
          node.disk?.availableBytes,
          false,
          undefined,
          node.status,
          node.status === 'error' ? node.message : '',
          node.quicStatus,
          storageEntries,
        )}
      </div>
    `,
  ];

  if (node.status === 'error') {
    sections.push(`
      <div class="totals-card__section storj-node-card__message">
        <div class="wallet-card__message">⚠️ ${node.message}</div>
      </div>
    `);

    return `<div class="totals-card totals-card--storj storj-node-card">${sections.join('')}</div>`;
  }

  const currentSnapshot = node.current ?? {
    grossUsd: node.grossUsd ?? 0,
    heldUsd: node.heldUsd ?? 0,
    netUsd: node.netUsd ?? 0,
  };
  const totalSnapshot = node.total ?? {
    grossUsd: node.grossUsd ?? 0,
    heldUsd: node.heldUsd ?? 0,
    netUsd: node.netUsd ?? 0,
  };
  const monthMetrics = getStorjBandwidthMonthMetrics(node.bandwidthMonth);

  const summaryBadges = [
    renderHealthBadge('Audit', node.auditSummary?.auditScore),
    renderHealthBadge('Suspension', node.auditSummary?.suspensionScore),
    renderHealthBadge('Online', node.auditSummary?.onlineScore),
  ]
    .filter(Boolean)
    .join('');

  const dayMetrics = getStorjBandwidthTodayMetrics(node.bandwidth);
  const trendMetrics = getStorjBandwidthTrendMetrics(node.bandwidth);

  const auditRows = Array.isArray(node.audits)
    ? node.audits
        .map(
          (audit, auditIndex) => `
            <div class="node-details-grid__row${auditIndex % 2 === 1 ? ' is-alt' : ''}" role="row">
              <span class="node-details-grid__cell node-details-grid__cell--label" role="cell">${audit.satelliteName}</span>
              <span class="node-details-grid__cell node-details-grid__cell--metric score-value ${getScoreClass(
                audit.auditScore,
              )}" role="cell">${formatScore(audit.auditScore)}</span>
              <span class="node-details-grid__cell node-details-grid__cell--metric score-value ${getScoreClass(
                audit.suspensionScore,
              )}" role="cell">${formatScore(audit.suspensionScore)}</span>
              <span class="node-details-grid__cell node-details-grid__cell--metric score-value ${getScoreClass(
                audit.onlineScore,
              )}" role="cell">${formatScore(audit.onlineScore)}</span>
            </div>
          `,
        )
        .join('')
    : '';

  const auditSection = auditRows
    ? `
        <div class="storj-details__section">
          <div class="node-details-grid node-details-grid--storj-audits" role="table" aria-label="Storj satellite audit scores">
            <div class="node-details-grid__row node-details-grid__row--head" role="row">
              <span class="node-details-grid__cell node-details-grid__cell--label" role="columnheader">Satellite</span>
              <span class="node-details-grid__cell node-details-grid__cell--metric" role="columnheader">Audit</span>
              <span class="node-details-grid__cell node-details-grid__cell--metric" role="columnheader">Suspension</span>
              <span class="node-details-grid__cell node-details-grid__cell--metric" role="columnheader">Online</span>
            </div>
            ${auditRows}
          </div>
        </div>
      `
    : '';

  const summarySections = [
    `
      <div class="totals-card__section totals-card__wallet totals-card__summary node-card__summary">
        <div class="heading-title">Revenue (USD)</div>
        ${renderStorjRevenueSummary(currentSnapshot, totalSnapshot)}
      </div>
    `,
  ];

  if (monthMetrics.length > 0 || dayMetrics.length > 0 || trendMetrics.length > 0) {
    summarySections.push(`
      <div class="totals-card__section totals-card__wallet totals-card__summary node-card__summary">
        <div class="heading-title">Bandwidth</div>
        <div class="inline-metrics-stack storj-summary-stack">
          ${
            monthMetrics.length > 0
              ? `
                <div class="inline-metrics-row storj-summary-row">
                  <span class="inline-metrics-row__label">Month</span>
                  ${renderSummaryMetricLine(monthMetrics, 'summary-metrics--node-wallet')}
                </div>
              `
              : ''
          }
          ${
            dayMetrics.length > 0
              ? `
                <div class="inline-metrics-row storj-summary-row">
                  <span class="inline-metrics-row__label">Today</span>
                  ${renderSummaryMetricLine(dayMetrics, 'summary-metrics--node-wallet')}
                </div>
              `
              : ''
          }
          ${
            trendMetrics.length > 0
              ? `
                <div class="inline-metrics-row storj-summary-row">
                  <span class="inline-metrics-row__label">${getStorjBandwidthTrendLabel(node.bandwidth)}</span>
                  ${renderSummaryMetricLine(trendMetrics, 'summary-metrics--node-wallet')}
                </div>
              `
              : ''
          }
        </div>
      </div>
    `);
  }

  const detailsContent = `
    <div class="node-detail-panel node-detail-panel--storj">
      <div class="node-detail-panel__header">
        <div class="heading-title">Audits</div>
        <div class="health-badges">${summaryBadges || '<span class="health-badge is-muted">No audit data</span>'}</div>
      </div>
      <div class="node-detail-panel__body">
        ${auditSection || '<div class="wallet-card__message">No audit history available.</div>'}
      </div>
    </div>
  `;

  sections.push(`
    <div class="totals-card__section node-card__content-grid-shell">
      <div class="node-card__content-grid node-card__content-grid--storj">
        <div class="node-card__content-column node-card__content-column--summary">
          ${summarySections.join('')}
        </div>
        <div class="node-card__content-column node-card__content-column--details">
          <div class="totals-card__section storj-node-card__details">
            ${detailsContent}
          </div>
        </div>
      </div>
    </div>
  `);

  return `<div class="totals-card totals-card--storj storj-node-card">${sections.join('')}</div>`;
}

function appendNodeSeparator(body, columns) {
  body.appendChild(
    createRow(
      [{ content: '<div class="node-separator__line"></div>', colspan: columns }],
      { className: 'node-separator' },
    ),
  );
}

function renderSiaOverview(data) {
  overviewSiaPeriod.textContent = '';
  renderSiaTotals(overviewSiaTotals, data, {
    currentLabel: getMetricRangeLabel(data?.periodShortLabel) || 'Current',
    subtitle: getSiaPeriodText(data),
  });
}

function renderStorjOverview(data) {
  renderStorjTotals(overviewStorjTotals, data);
}

function renderSiaNodes(data) {
  siaBody.innerHTML = '';
  siaPeriod.textContent = getSiaPeriodText(data);
  const currentLabel = getMetricRangeLabel(data?.periodShortLabel) || 'Current';

  if (!data || data.nodes.length === 0) {
    setPlaceholder(siaBody, 'No Sia hosts configured.');
    return;
  }

  data.nodes.forEach((node, index) => {
    siaBody.appendChild(
      createRow(
        [
          {
            content: renderSiaNodeCard(node, index, currentLabel),
            colspan: 3,
          },
        ],
        { className: 'sia-node-card-row' },
      ),
    );
  });
}

function renderStorjNodes(data) {
  storjBody.innerHTML = '';

  if (!data || data.nodes.length === 0) {
    setPlaceholder(storjBody, 'No Storj nodes configured.');
    return;
  }

  data.nodes.forEach((node, index) => {
    storjBody.appendChild(
      createRow(
        [
          {
            content: renderStorjNodeCard(node, index),
            colspan: 4,
          },
        ],
        { className: 'storj-node-card-row' },
      ),
    );
  });
}

async function loadSia() {
  overviewSiaPeriod.textContent = '';
  setPlaceholder(siaBody, 'Loading…');
  siaPeriod.textContent = '';
  try {
    const url = buildOverviewApiUrl('/api/sia');
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const data = await response.json();
    latestSiaOverviewData = data;
    latestSiaOverviewError = undefined;
    renderSiaOverview(data);
    renderSiaNodes(data);
    renderOverviewProblems();
    return true;
  } catch (error) {
    latestSiaOverviewData = undefined;
    latestSiaOverviewError = error.message;
    overviewSiaPeriod.textContent = `⚠️ ${error.message}`;
    siaPeriod.textContent = `⚠️ ${error.message}`;
    renderSiaTotals(overviewSiaTotals);
    setPlaceholder(siaBody, `⚠️ Unable to load data: ${error.message}`);
    renderOverviewProblems();
    return false;
  }
}

async function loadStorj() {
  setPlaceholder(storjBody, 'Loading…');
  try {
    const url = buildOverviewApiUrl('/api/storj');
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    const data = await response.json();
    latestStorjOverviewData = data;
    latestStorjOverviewError = undefined;
    renderStorjOverview(data);
    renderStorjNodes(data);
    renderOverviewProblems();
    return true;
  } catch (error) {
    latestStorjOverviewData = undefined;
    latestStorjOverviewError = error.message;
    renderStorjTotals(overviewStorjTotals);
    setPlaceholder(storjBody, `⚠️ Unable to load data: ${error.message}`);
    renderOverviewProblems();
    return false;
  }
}

async function loadAll() {
  return Promise.all([loadSia(), loadStorj()]);
}

refreshButton?.addEventListener('click', () => {
  loadAll().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Unable to refresh data', error);
  });
});

themeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    applyTheme(button.dataset.theme);
  });
});

viewButtons.forEach((button, index) => {
  button.addEventListener('click', () => {
    applyView(button.dataset.view);
  });

  button.addEventListener('keydown', (event) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % viewButtons.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + viewButtons.length) % viewButtons.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = viewButtons.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextButton = viewButtons[nextIndex];
    nextButton.focus();
    applyView(nextButton.dataset.view);
  });
});

async function announceSiaHost(button) {
  const host = button?.dataset.host?.trim();
  if (!host || button.disabled) {
    return;
  }

  const originalLabel = button.textContent;
  button.disabled = true;
  button.classList.remove('is-success', 'is-error');
  button.classList.add('is-pending');
  button.textContent = 'Announcing';

  try {
    const response = await fetch('/api/sia/announce', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ host }),
    });

    if (!response.ok) {
      const raw = await response.text();
      throw new Error(raw || `Request failed with status ${response.status}`);
    }

    button.classList.remove('is-pending');
    button.classList.add('is-success');
    button.textContent = 'Announced';
  } catch (error) {
    button.classList.remove('is-pending');
    button.classList.add('is-error');
    button.textContent = 'Failed';
    // eslint-disable-next-line no-console
    console.error(`Unable to announce ${host}`, error);
  }

  window.setTimeout(() => {
    button.disabled = false;
    button.classList.remove('is-pending', 'is-success', 'is-error');
    button.textContent = originalLabel;
  }, 1800);
}

siaBody?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="sia-announce"]');
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  announceSiaHost(button).catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Unable to trigger announce action', error);
  });
});

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const option = event.target.closest('.period-picker__option');
  if (option instanceof HTMLButtonElement) {
    closeOverviewRangeMenus();

    const nextRange = option.dataset.overviewRange?.trim();
    if (!nextRange) {
      return;
    }
    const resolved = getOverviewRangeOption(nextRange);
    if (resolved.key === overviewRangeKey) {
      return;
    }

    overviewRangeKey = resolved.key;
    localStorage.setItem(OVERVIEW_RANGE_STORAGE_KEY, overviewRangeKey);
    updateOverviewRangePickers();
    loadAll().catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Unable to reload data', error);
    });
    return;
  }

  const trigger = event.target.closest('.period-picker__trigger');
  if (trigger instanceof HTMLButtonElement) {
    const picker = trigger.closest('[data-overview-range-picker]');
    if (!picker) {
      return;
    }

    const shouldOpen = !picker.classList.contains('is-open');
    closeOverviewRangeMenus();
    setOverviewRangeMenuState(picker, shouldOpen);
    if (shouldOpen) {
      const selectedOption = picker.querySelector(
        `.period-picker__option[data-overview-range="${overviewRangeKey}"]`,
      );
      if (selectedOption instanceof HTMLButtonElement) {
        selectedOption.focus();
      }
    }
    return;
  }

  if (!event.target.closest('[data-overview-range-picker]')) {
    closeOverviewRangeMenus();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeOverviewRangeMenus();
  }
});

initializeTheme();
initializeView();
initializeOverviewRange();
loadAll().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Unable to load initial data', error);
});
function renderNodeHeading(
  label,
  index,
  link,
  usedBytes,
  totalBytes,
  hideLegend = false,
  storageMeta,
  status = 'ok',
  statusMessage = '',
  quicStatus,
  extraStorageEntries = [],
  actionMarkup = '',
) {
  const title = `${label.toUpperCase()}${typeof index === 'number' ? ` #${index}` : ''}: ${link}`;
  const usedRaw = Number(usedBytes);
  const totalRaw = Number(totalBytes);
  const numericUsed = Number.isFinite(usedRaw) ? Math.max(usedRaw, 0) : 0;
  const numericTotal = Number.isFinite(totalRaw) ? Math.max(totalRaw, 0) : NaN;
  const hasStorage = Number.isFinite(numericTotal) && numericTotal > 0;
  const badges = [renderStatusBadge(status, statusMessage), renderQuicBadge(quicStatus)]
    .filter(Boolean)
    .join('');
  const adornments = [actionMarkup, badges ? `<span class="heading-title__badges-list">${badges}</span>` : '']
    .filter(Boolean)
    .join('');
  const badgeMarkup = adornments ? `<span class="heading-title__badges">${adornments}</span>` : '';

  if (!hasStorage) {
    return `<div class="heading-title"><span class="heading-title__text">${title}</span>${badgeMarkup}</div>`;
  }

  const storageChange = renderStorageChangeInline(storageMeta, extraStorageEntries);

  return `
    <div class="heading-title"><span class="heading-title__text">${title}</span>${badgeMarkup}</div>
    <div class="heading-storage ${hideLegend ? 'heading-storage--compact' : ''}">
      ${storageChange}
      ${buildStorageCell(numericUsed, numericTotal, {
        hideLegend,
        legendClass: 'storage-legend--compact',
      })}
    </div>
  `;
}
