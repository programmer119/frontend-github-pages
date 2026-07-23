const API_BASE = (() => {
  if (window.__API_BASE_URL__) return window.__API_BASE_URL__.replace(/\/$/, '');
  if (location.port === '8081') return `${location.protocol}//${location.hostname}:8080`;
  return '';
})();

const form = document.querySelector('#collection-form');
const submitButton = document.querySelector('#submit-button');
const formError = document.querySelector('#form-error');
const prototypeLockMessage = document.querySelector('#prototype-lock-message');
const ownershipNote = document.querySelector('#ownership-note');
const openverseDiagnosticNote = document.querySelector('#openverse-diagnostic-note');
const jobPanel = document.querySelector('#job-panel');
const cancelButton = document.querySelector('#cancel-button');
const resumeButton = document.querySelector('#resume-button');
const downloadButton = document.querySelector('#download-button');
const copyDiagnosticsButton = document.querySelector('#copy-diagnostics-button');
const downloadDiagnosticsButton = document.querySelector('#download-diagnostics-button');
const downloadAuditButton = document.querySelector('#download-audit-button');
const previewSection = document.querySelector('#preview-section');
const previewGrid = document.querySelector('#preview-grid');
const providerResultPanel = document.querySelector('#provider-result-panel');
const providerResultTitle = document.querySelector('#provider-result-title');
const providerResultTotal = document.querySelector('#provider-result-total');
const providerResultList = document.querySelector('#provider-result-list');
const providerStatusCount = document.querySelector('#provider-status-count');
const providerStatusEnabled = document.querySelector('#provider-status-enabled');
const providerStatusDisabled = document.querySelector('#provider-status-disabled');

const PROTOTYPE_MAX_COUNT = 50;
const CLIENT_ID_STORAGE_KEY = 'culture-image-collector-client-id-v1';
const clientID = getOrCreateClientID();

let currentJobId = null;
let pollTimer = null;
let syncTimer = null;
let formLockedByActiveJob = false;
let submitting = false;

boot();

async function boot() {
  await clearLegacyFrontendCaches();
  if (API_BASE.includes('YOUR-BACKEND-HTTPS-DOMAIN')) {
    showError('frontend/config.js에 실제 HTTPS 백엔드 주소를 입력해 주세요.');
    return;
  }
  applyPrototypeLimit(PROTOTYPE_MAX_COUNT);
  try {
    const health = await apiFetch('/api/health', { cache: 'no-store' });
    renderProviderStatus(health);
    applyPrototypeLimit(Number(health.maxCount || PROTOTYPE_MAX_COUNT));
    await syncCurrentJob();
    startGlobalSync();
  } catch (error) {
    showError(`백엔드에 연결할 수 없습니다. 먼저 백엔드를 실행해 주세요. (${error.message})`);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideError();

  const payload = {
    country: form.country.value,
    keyword: form.keyword.value.trim(),
    count: Number(form.count.value),
    openverseDiagnostic: Boolean(form.openverseDiagnostic.checked),
  };

  const validationError = validate(payload);
  if (validationError) {
    showError(validationError);
    return;
  }

  setSubmitting(true);
  try {
    const data = await apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    currentJobId = data.id;
    jobPanel.hidden = false;
    previewSection.hidden = true;
    previewGrid.replaceChildren();
    renderJob(data);
    startPolling();
    jobPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (error.data && error.data.activeJob) {
      adoptActiveJob(error.data.activeJob);
    }
    showError(error.message);
  } finally {
    setSubmitting(false);
  }
});

cancelButton.addEventListener('click', async () => {
  if (!currentJobId) return;
  cancelButton.disabled = true;
  try {
    await apiFetch(`/api/jobs/${currentJobId}/cancel`, { method: 'POST' });
  } catch (error) {
    showError(error.message);
  } finally {
    cancelButton.disabled = false;
  }
});

resumeButton.addEventListener('click', async () => {
  if (!currentJobId) return;
  resumeButton.disabled = true;
  try {
    const data = await apiFetch(`/api/jobs/${currentJobId}/resume`, { method: 'POST' });
    renderJob(data);
    startPolling();
  } catch (error) {
    showError(error.message);
  } finally {
    resumeButton.disabled = false;
  }
});

copyDiagnosticsButton.addEventListener('click', async () => {
  if (!currentJobId) return;
  copyDiagnosticsButton.disabled = true;
  const original = copyDiagnosticsButton.textContent;
  try {
    const response = await fetch(`${API_BASE}/api/jobs/${currentJobId}/diagnostics`, { cache: 'no-store' });
    if (!response.ok) throw new Error('진단 로그를 가져오지 못했습니다.');
    const text = await response.text();
    await navigator.clipboard.writeText(text);
    copyDiagnosticsButton.textContent = '복사 완료';
  } catch (error) {
    showError(error.message);
  } finally {
    window.setTimeout(() => {
      copyDiagnosticsButton.textContent = original;
      copyDiagnosticsButton.disabled = false;
    }, 1200);
  }
});

async function clearLegacyFrontendCaches() {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn('legacy cache cleanup failed', error);
  }
}

function validate(payload) {
  if (!payload.country) return '국가를 선택해 주세요.';
  if (payload.keyword.length < 2 || payload.keyword.length > 80) return '문화 키워드는 2~80자로 입력해 주세요.';
  if (!Number.isInteger(payload.count) || payload.count < 1 || payload.count > PROTOTYPE_MAX_COUNT) return `무료 프로토타입 수집 수량은 1~${PROTOTYPE_MAX_COUNT}장입니다.`;
  return '';
}

function setSubmitting(value) {
  submitting = value;
  submitButton.disabled = value || formLockedByActiveJob;
  submitButton.textContent = value ? '작업 생성 중…' : (formLockedByActiveJob ? '현재 작업 진행 중' : '수집 시작');
}

function getOrCreateClientID() {
  try {
    let value = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (!value) {
      value = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, value);
    }
    return value;
  } catch (_) {
    return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function applyPrototypeLimit(maxCount) {
  const limit = Math.max(1, Math.min(PROTOTYPE_MAX_COUNT, Number(maxCount || PROTOTYPE_MAX_COUNT)));
  form.count.max = String(limit);
  if (!Number.isFinite(Number(form.count.value)) || Number(form.count.value) > limit) form.count.value = String(limit);
}

function setFormLocked(locked, jobData = null) {
  formLockedByActiveJob = Boolean(locked);
  form.classList.toggle('is-locked', formLockedByActiveJob);
  for (const control of form.querySelectorAll('input, select')) control.disabled = formLockedByActiveJob;
  submitButton.disabled = submitting || formLockedByActiveJob;
  submitButton.textContent = submitting ? '작업 생성 중…' : (formLockedByActiveJob ? '현재 작업 진행 중' : '수집 시작');
  if (formLockedByActiveJob) {
    prototypeLockMessage.hidden = false;
    const ownerText = jobData && jobData.canControl
      ? '이 화면에서 시작한 작업이 백엔드에서 실행 중입니다.'
      : '다른 화면에서 시작한 작업이 백엔드에서 실행 중입니다.';
    prototypeLockMessage.textContent = `${ownerText} 무료 프로토타입은 서버당 작업 1개만 실행하므로 새 요청은 막고 동일한 진행 상황만 표시합니다.`;
  } else {
    prototypeLockMessage.hidden = true;
    prototypeLockMessage.textContent = '';
  }
}

function adoptActiveJob(jobData) {
  if (!jobData || !jobData.id) return;
  const changed = currentJobId !== jobData.id;
  currentJobId = jobData.id;
  jobPanel.hidden = false;
  if (changed) {
    previewSection.hidden = true;
    previewGrid.replaceChildren();
  }
  renderJob(jobData);
  if (['running', 'queued'].includes(jobData.state) && !pollTimer) startPolling();
}

async function syncCurrentJob() {
  const state = await apiFetch('/api/jobs/current', { cache: 'no-store' });
  applyPrototypeLimit(Number(state.maxCount || PROTOTYPE_MAX_COUNT));
  if (state.active && state.activeJob) {
    adoptActiveJob(state.activeJob);
    return;
  }
  if (!currentJobId) setFormLocked(false);
}

function startGlobalSync() {
  if (syncTimer) window.clearInterval(syncTimer);
  syncTimer = window.setInterval(() => {
    syncCurrentJob().catch((error) => console.warn('current job sync failed', error));
  }, 1500);
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function hideError() {
  formError.hidden = true;
  formError.textContent = '';
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(fetchJob, 1000);
  fetchJob();
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
}

async function fetchJob() {
  if (!currentJobId) return;
  try {
    const data = await apiFetch(`/api/jobs/${currentJobId}`, { cache: 'no-store' });
    renderJob(data);
    if (['completed', 'failed', 'cancelled', 'paused'].includes(data.state)) stopPolling();
  } catch (error) {
    stopPolling();
    showError(error.message);
  }
}

function renderJob(data) {
  const exclusive = ['queued', 'running', 'paused'].includes(data.state);
  setFormLocked(exclusive, data);
  const canControl = Boolean(data.canControl);
  if (exclusive && !canControl) {
    ownershipNote.hidden = false;
    ownershipNote.textContent = '읽기 전용 화면입니다. 현재 작업의 진행 상황과 결과는 동일하게 표시되지만, 새 수집·일시중지·이어받기는 할 수 없습니다.';
  } else {
    ownershipNote.hidden = true;
    ownershipNote.textContent = '';
  }
  const labels = {
    queued: ['대기', '수집 준비 중'],
    running: ['진행 중', '이미지 수집 중'],
    completed: ['완료', '수집 완료'],
    failed: ['실패', '수집 실패'],
    paused: ['일시중지', '작업 일시중지됨'],
    cancelled: ['취소', '작업 취소됨'],
  };
  const [badge, title] = labels[data.state] || ['확인', '작업 상태'];
  document.querySelector('#status-title').textContent = title;
  const badgeElement = document.querySelector('#status-badge');
  badgeElement.textContent = badge;
  badgeElement.className = `status-badge ${data.state}`;
  const processed = data.counters.processed || 0;
  const candidates = data.counters.candidates || 0;
  document.querySelector('#status-message').textContent = data.message || '작업을 처리하고 있습니다.';
  const diagnosticMode = Boolean(data.request && data.request.openverseDiagnostic);
  openverseDiagnosticNote.hidden = !diagnosticMode;
  openverseDiagnosticNote.textContent = diagnosticMode
    ? 'Openverse 사이트 동일조건 진단 모드: API 원시 조회에서는 라이선스·사진 유형을 선필터하지 않으며, 아래 단계별 탈락 수량으로 차이를 확인합니다.'
    : '';

  const runtime = data.runtime || {};
  document.querySelector('#runtime-summary').textContent = buildRuntimeSummary(runtime, data.counters || {});
  document.querySelector('#runtime-search').textContent = `${runtime.searchersDone || 0} / ${runtime.searchersTotal || 0}`;
  document.querySelector('#runtime-workers').textContent = `${runtime.activeWorkers || 0}`;
  document.querySelector('#runtime-queue').textContent = `${runtime.queueDepth || 0}`;
  document.querySelector('#runtime-last-accepted').textContent = formatRuntimeTime(runtime.lastAcceptedAt);
  document.querySelector('#runtime-memory').textContent = `${formatRate(runtime.memoryAllocMb, 1)} MB`;
  document.querySelector('#runtime-processed-rate').textContent = `${formatRate(runtime.processedPerMinute, 1)} /분`;
  document.querySelector('#runtime-collected-rate').textContent = `${formatRate(runtime.collectedPerMinute, 1)} /분`;
  document.querySelector('#runtime-host-cooldowns').textContent = Number(runtime.hostCooldowns || 0).toLocaleString();
  document.querySelector('#runtime-last-event').textContent = `최근 상태: ${runtime.lastEvent || '-'}`;
  const runtimeError = document.querySelector('#runtime-last-error');
  if (runtime.lastError) {
    runtimeError.hidden = false;
    runtimeError.textContent = `최근 오류: ${runtime.lastError}`;
  } else {
    runtimeError.hidden = true;
    runtimeError.textContent = '최근 오류: -';
  }
  document.querySelector('#diag-last-gap').textContent = formatDurationSeconds(runtime.lastAcceptGapSeconds);
  document.querySelector('#diag-average-gap').textContent = formatDurationSeconds(runtime.averageAcceptGapSeconds);
  document.querySelector('#diag-max-gap').textContent = formatDurationSeconds(runtime.maxAcceptGapSeconds);
  document.querySelector('#diag-failures-since-last').textContent = Number(runtime.failuresSinceLastAccept || 0).toLocaleString();
  document.querySelector('#diag-provider-errors-since-last').textContent = Number(runtime.providerErrorsSinceLast || 0).toLocaleString();
  document.querySelector('#diag-download-failures-since-last').textContent = Number(runtime.downloadErrorsSinceLast || 0).toLocaleString();
  document.querySelector('#diag-rate-limited-since-last').textContent = Number(runtime.rateLimitedSinceLast || 0).toLocaleString();
  document.querySelector('#diag-rejected-since-last').textContent = Number(runtime.rejectedSinceLast || 0).toLocaleString();
  document.querySelector('#diag-duplicates-since-last').textContent = Number(runtime.duplicatesSinceLast || 0).toLocaleString();

  const collected = data.counters.collected || 0;
  const target = data.request.count || 0;
  const percent = target ? Math.min(100, Math.round((collected / target) * 100)) : 0;
  document.querySelector('#progress-bar').style.width = `${percent}%`;
  document.querySelector('#progress-number').textContent = `${collected.toLocaleString()} / ${target.toLocaleString()}장`;
  document.querySelector('#progress-percent').textContent = `${percent}%`;
  document.querySelector('#metric-candidates').textContent = candidates.toLocaleString();
  document.querySelector('#metric-processed').textContent = processed.toLocaleString();
  document.querySelector('#metric-collected').textContent = collected.toLocaleString();
  document.querySelector('#metric-filtered').textContent = ((data.counters.rejectedAi || 0) + (data.counters.rejectedNonPhoto || 0)).toLocaleString();
  document.querySelector('#metric-country').textContent = (data.counters.rejectedCountry || 0).toLocaleString();
  document.querySelector('#metric-relevance').textContent = (data.counters.rejectedRelevance || 0).toLocaleString();
  document.querySelector('#metric-policy').textContent = ((data.counters.rejectedSize || 0) + (data.counters.rejectedLicense || 0)).toLocaleString();
  document.querySelector('#metric-unavailable').textContent = (data.counters.skippedUnavailable || 0).toLocaleString();
  document.querySelector('#metric-provider-errors').textContent = (data.counters.providerErrors || 0).toLocaleString();
  document.querySelector('#metric-download-errors').textContent = (data.counters.downloadErrors || 0).toLocaleString();
  document.querySelector('#metric-rate-limited').textContent = (data.counters.rateLimited || 0).toLocaleString();
  document.querySelector('#metric-series-duplicates').textContent = (data.counters.seriesDuplicates || 0).toLocaleString();
  document.querySelector('#metric-duplicates').textContent = ((data.counters.duplicateExact || 0) + (data.counters.duplicateVisual || 0) + (data.counters.sourceDuplicates || 0) + (data.counters.seriesDuplicates || 0)).toLocaleString();

  const active = ['queued', 'running'].includes(data.state);
  cancelButton.hidden = !active || !canControl;
  resumeButton.hidden = data.state !== 'paused' || !canControl;
  const diagnosticsReady = Boolean(data.id);
  copyDiagnosticsButton.disabled = !diagnosticsReady;
  if (diagnosticsReady) {
    downloadDiagnosticsButton.href = `${API_BASE}/api/jobs/${data.id}/diagnostics`;
    downloadDiagnosticsButton.setAttribute('download', `diagnostic_trace_${data.id}.log`);
    downloadDiagnosticsButton.classList.remove('disabled-link');
    downloadDiagnosticsButton.setAttribute('aria-disabled', 'false');
    downloadAuditButton.href = `${API_BASE}/api/jobs/${data.id}/audit`;
    downloadAuditButton.setAttribute('download', `candidate_audit_${data.id}.ndjson`);
    downloadAuditButton.classList.remove('disabled-link');
    downloadAuditButton.setAttribute('aria-disabled', 'false');
  } else {
    downloadDiagnosticsButton.href = '#';
    downloadDiagnosticsButton.classList.add('disabled-link');
    downloadDiagnosticsButton.setAttribute('aria-disabled', 'true');
    downloadAuditButton.href = '#';
    downloadAuditButton.classList.add('disabled-link');
    downloadAuditButton.setAttribute('aria-disabled', 'true');
  }
  downloadButton.hidden = !data.canDownload;
  if (data.canDownload) downloadButton.href = `${API_BASE}/api/jobs/${data.id}/download`;
  renderProviderCounts(data.providerCounts || [], data.state, data.providerProgress || []);
  renderPreviews(data.id, data.previews || []);
}

function renderProviderCounts(items, state, progressItems = []) {
  const collectedByProvider = new Map();
  for (const item of items) {
    if (!item || !item.provider) continue;
    const base = String(item.provider).split(' / ')[0].trim();
    collectedByProvider.set(base, (collectedByProvider.get(base) || 0) + Number(item.collected || 0));
  }
  const progressByProvider = new Map();
  for (const item of progressItems) {
    if (!item || !item.provider) continue;
    progressByProvider.set(String(item.provider), item);
  }
  const providerNames = [...new Set([...collectedByProvider.keys(), ...progressByProvider.keys()])]
    .sort((a, b) => a.localeCompare(b, 'ko'));

  if (!providerNames.length) {
    providerResultPanel.hidden = true;
    providerResultList.replaceChildren();
    providerResultTotal.textContent = '총 0장';
    return;
  }

  providerResultPanel.hidden = false;
  providerResultTitle.textContent = state === 'completed' ? '제공처별 최종 수집·검색 결과' : '제공처별 실시간 검색·검수 현황';
  const total = [...collectedByProvider.values()].reduce((sum, value) => sum + value, 0);
  providerResultTotal.textContent = `총 ${total.toLocaleString()}장`;
  providerResultList.replaceChildren(...providerNames.map((providerName) => {
    const progress = progressByProvider.get(providerName) || {};
    const collected = Number(collectedByProvider.get(providerName) || progress.accepted || 0);
    const card = document.createElement('article');
    card.className = 'provider-result-item';
    const header = document.createElement('div');
    header.className = 'provider-result-item-header';
    const name = document.createElement('span');
    name.textContent = providerName;
    const count = document.createElement('strong');
    count.textContent = `${collected.toLocaleString()}장`;
    header.append(name, count);

    const metrics = document.createElement('p');
    metrics.className = 'provider-result-metrics';
    const queueDepth = Number(progress.queueDepth || 0);
    const queueCapacity = Number(progress.queueCapacity || 0);
    const queueWaitMs = Number(progress.queueWaitMillis || 0);
    metrics.textContent = [
      `검색어 ${Number(progress.queries || 0).toLocaleString()}개 · ${Number(progress.pages || 0).toLocaleString()}페이지`,
      `API 원시 ${Number(progress.rawResults || 0).toLocaleString()}건`,
      Number(progress.reportedAvailable || 0) > 0 ? `API 보고 총합 ${Number(progress.reportedAvailable || 0).toLocaleString()}건(검색어 간 중복 가능)` : '',
      Number(progress.providerFiltered || 0) > 0 ? `제공처 선필터 ${Number(progress.providerFiltered || 0).toLocaleString()}건` : '',
      `검색어 종료 ${Number(progress.completedQueries || 0).toLocaleString()}/${Number(progress.queries || 0).toLocaleString()}`,
      Number(progress.emptyQueries || 0) > 0 ? `빈 검색어 ${Number(progress.emptyQueries || 0).toLocaleString()}개` : '',
      Number(progress.skippedQueries || 0) > 0 ? `오류·제한 종료 ${Number(progress.skippedQueries || 0).toLocaleString()}개` : '',
      `고유 후보 ${Number(progress.uniqueCandidates || 0).toLocaleString()}건`,
      Number(progress.evidenceMerged || 0) > 0 ? `검색 근거 병합 ${Number(progress.evidenceMerged || 0).toLocaleString()}회` : '',
      Number(progress.pendingEvidence || 0) > 0 ? `추가 근거 대기 ${Number(progress.pendingEvidence || 0).toLocaleString()}건` : '',
      `라이선스 탈락 ${Number(progress.rejectedLicense || 0).toLocaleString()}건`,
      `국가 탈락 ${Number(progress.rejectedCountry || 0).toLocaleString()}건`,
      `관련성 탈락 ${Number(progress.rejectedRelevance || 0).toLocaleString()}건`,
      `사진·AI·크기 탈락 ${(Number(progress.rejectedAi || 0) + Number(progress.rejectedNonPhoto || 0) + Number(progress.rejectedSize || 0)).toLocaleString()}건`,
      `큐 투입 ${Number(progress.queued || 0).toLocaleString()}건`,
      `현재 대기 ${queueDepth.toLocaleString()}/${queueCapacity.toLocaleString()}`,
      queueWaitMs > 0 ? `큐 막힘 누적 ${(queueWaitMs / 1000).toFixed(1)}초` : '',
      `실검수 ${Number(progress.validated || 0).toLocaleString()}건`,
      `중복 ${Number(progress.duplicates || 0).toLocaleString()}건`,
      `오류 ${Number(progress.errors || 0).toLocaleString()}건`,
    ].filter(Boolean).join(' · ');
    const reason = document.createElement('p');
    reason.className = 'provider-result-reason';
    const readiness = progress.initialReady ? '초기 탐색 완료' : '초기 탐색 중';
    const blocked = progress.queueBlocked ? '후보 큐 공간 대기 중' : '';
    const waitReason = progress.workerWaitReason || blocked;
    reason.textContent = [readiness, progress.endReason || '검색 진행 중', waitReason].filter(Boolean).join(' · ');
    card.append(header, metrics, reason);
    return card;
  }));
}

function renderPreviews(jobId, previews) {
  if (!previews.length) {
    previewSection.hidden = true;
    return;
  }
  previewSection.hidden = false;
  const existing = new Set([...previewGrid.children].map((node) => node.dataset.file));
  for (const item of previews) {
    if (existing.has(item.fileName)) continue;
    const card = document.createElement('article');
    card.className = 'preview-card';
    card.dataset.file = item.fileName;

    const image = document.createElement('img');
    image.src = `${API_BASE}/api/jobs/${jobId}/files/${encodeURIComponent(item.fileName)}`;
    image.alt = item.title || '수집 이미지';
    image.loading = 'lazy';

    const body = document.createElement('div');
    body.className = 'preview-card-body';
    const heading = document.createElement('h3');
    const source = document.createElement('a');
    source.href = item.sourceUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = item.title || item.fileName;
    heading.append(source);

    const meta = document.createElement('p');
    const keywordEvidence = Array.isArray(item.keywordEvidence) ? item.keywordEvidence.filter(Boolean) : [];
    const keywordText = keywordEvidence.length
      ? ` · 핵심 키워드 확인 (${keywordEvidence.slice(0, 3).join(', ')})`
      : '';
    const countryEvidence = Array.isArray(item.countryEvidence) ? item.countryEvidence.filter(Boolean) : [];
    const countryText = Number(item.countryScore || 0) >= 1
      ? ` · 국가 확인${countryEvidence.length ? ` (${countryEvidence.slice(0, 3).join(', ')})` : ''}`
      : ' · 국가 미확인';
    meta.textContent = `${item.width}×${item.height} · ${item.license || '라이선스 확인 필요'}${keywordText}${countryText}`;
    body.append(heading, meta);
    card.append(image, body);
    previewGrid.append(card);
  }
}


function renderProviderStatus(health) {
  const enabled = Array.isArray(health.providers) ? health.providers : [];
  const disabled = Array.isArray(health.disabledProviders) ? health.disabledProviders : [];
  const supported = Number(health.supportedProviderCount || enabled.length + disabled.length || 0);
  providerStatusCount.textContent = `${enabled.length.toLocaleString()} / ${supported.toLocaleString()} 활성`;
  providerStatusEnabled.textContent = enabled.length
    ? `현재 검색: ${enabled.join(' · ')}`
    : '활성화된 검색 제공처가 없습니다.';
  if (disabled.length) {
    providerStatusDisabled.hidden = false;
    providerStatusDisabled.textContent = `무료 API 키를 .env에 입력하면 추가 활성화: ${disabled.join(' · ')}`;
  } else {
    providerStatusDisabled.hidden = true;
    providerStatusDisabled.textContent = '';
  }
}

function formatRate(value, digits = 0) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return number.toLocaleString('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatDurationSeconds(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  if (seconds < 1) return `${seconds.toFixed(2)}초`;
  if (seconds < 60) return `${seconds.toFixed(1)}초`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds - minutes * 60;
  return `${minutes}분 ${remain.toFixed(1)}초`;
}

function formatRuntimeTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildRuntimeSummary(runtime, counters) {
  const processed = Number(counters.processed || 0).toLocaleString();
  const candidates = Number(counters.candidates || 0).toLocaleString();
  const done = Number(runtime.searchersDone || 0);
  const total = Number(runtime.searchersTotal || 0);
  const workers = Number(runtime.activeWorkers || 0);
  const queue = Number(runtime.queueDepth || 0);
  let tail = `워커 ${workers}개 동작 중 · 큐 ${queue}건 대기`;
  if (workers === 0 && queue === 0 && done < total) {
    tail = '남은 제공처의 검색 응답을 기다리는 중';
  } else if (workers === 0 && queue === 0 && done >= total) {
    tail = '모든 후보 처리가 끝나 결과를 정리하는 중';
  }
  const processedRate = formatRate(runtime.processedPerMinute, 1);
  const collectedRate = formatRate(runtime.collectedPerMinute, 1);
  const memory = formatRate(runtime.memoryAllocMb, 1);
  return `후보 처리 ${processed} / ${candidates} · 검색 ${done}/${total} · ${tail} · ${processedRate}건/분 처리 · ${collectedRate}장/분 저장 · 메모리 ${memory}MB`;
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Collector-Client-ID', clientID);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const error = new Error((data && data.error) || '요청 처리 중 오류가 발생했습니다.');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
