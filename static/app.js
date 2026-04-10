// AI Provider config (persisted in localStorage)
const DEFAULT_PROVIDERS = {
    openrouter: 'google/gemini-3-flash-preview',
    gemini: 'gemini-3-flash-preview',
};
function getAIProvider() {
    return JSON.parse(localStorage.getItem('aiProvider') ||
        JSON.stringify({ provider: 'openrouter', model: DEFAULT_PROVIDERS.openrouter }));
}
function saveAIProvider(config) {
    localStorage.setItem('aiProvider', JSON.stringify(config));
}

// State
let pageCount = 0;
let selectedPages = new Set();
let schemaFields = [];
let currentFormData = null;
let currentStationId = null;
let currentStationStatus = null; // 'pending', 'processed', or 'approved'
let pollingStations = { pending: [], processed: [], approved: [] };
let usedPages = new Set(); // Pages already in polling stations
let pageLabels = null;
let selectedStations = new Set(); // Multi-select in queues
const openAccordions = new Set(JSON.parse(localStorage.getItem('openAccordions') || '[]'));
function saveAccordionState() {
    localStorage.setItem('openAccordions', JSON.stringify([...openAccordions]));
}

// DOM Elements
const dashboardSection = document.getElementById('dashboard-section');
const uploadSection = document.getElementById('upload-section');
const schemaSection = document.getElementById('schema-section');
const processSection = document.getElementById('process-section');
const completeSection = document.getElementById('complete-section');
const chartSection = document.getElementById('chart-section');

const sessionsList = document.getElementById('sessions-list');
const newSessionBtn = document.getElementById('new-session-btn');

const pdfInput = document.getElementById('pdf-input');
const uploadBtn = document.getElementById('upload-btn');
const uploadStatus = document.getElementById('upload-status');

const saveSchemaBtn = document.getElementById('save-schema-btn');

const pageThumbnails = document.getElementById('page-thumbnails');
const selectedPagesText = document.getElementById('selected-pages-text');
const createStationBtn = document.getElementById('create-station-btn');

const pendingList = document.getElementById('pending-list');
const doneList = document.getElementById('done-list');
const approvedList = document.getElementById('approved-list');
const batchProcessBtn = document.getElementById('batch-process-btn');
const bulkApproveBtn = document.getElementById('bulk-approve-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');

const splitView = document.getElementById('split-view');
const pageSelector = document.getElementById('page-selector');
const queueSection = document.getElementById('queue-section');
const pdfImages = document.getElementById('pdf-images');
const formFields = document.getElementById('form-fields');
const approveBtn = document.getElementById('approve-btn');
const splitViewBackBtn = document.getElementById('split-view-back-btn');
const splitViewTitle = document.getElementById('split-view-title');
const prevStationBtn = document.getElementById('prev-station-btn');
const nextStationBtn = document.getElementById('next-station-btn');
const stationNavInfo = document.getElementById('station-nav-info');

// --- Dashboard ---

let dashboardSessions = [];
let sessionSortBy = localStorage.getItem('sessionSortBy') || 'date';

async function loadDashboard() {
    try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        dashboardSessions = data.sessions;
        sortAndRenderSessions();
    } catch (err) {
        console.error('Failed to load sessions:', err);
        sessionsList.innerHTML = '<p class="empty-state">Failed to load sessions</p>';
    }
}

function sortAndRenderSessions() {
    const sorted = [...dashboardSessions];
    if (sessionSortBy === 'name') {
        sorted.sort((a, b) => (a.pdf_name || '').localeCompare(b.pdf_name || ''));
    }
    // 'date' is already the default order from the API (updated_at DESC)
    renderSessionsList(sorted);

    // Update active sort button
    document.getElementById('sort-by-date').classList.toggle('active-sort', sessionSortBy === 'date');
    document.getElementById('sort-by-name').classList.toggle('active-sort', sessionSortBy === 'name');
}

document.getElementById('sort-by-date').addEventListener('click', () => {
    sessionSortBy = 'date';
    localStorage.setItem('sessionSortBy', 'date');
    sortAndRenderSessions();
});

document.getElementById('sort-by-name').addEventListener('click', () => {
    sessionSortBy = 'name';
    localStorage.setItem('sessionSortBy', 'name');
    sortAndRenderSessions();
});

function renderSessionCard(s) {
    const progress = s.page_count > 0
        ? Math.round((s.processed_pages.length / s.page_count) * 100)
        : 0;
    const candidates = [s.candidate_1_name, s.candidate_2_name].filter(Boolean).join(' vs ');

    return `
        <div class="session-card" data-id="${s.id}">
            <div class="session-info">
                <h3>${s.pdf_name || 'New Session'}</h3>
                <p>${candidates || 'No candidates defined'}</p>
                <div class="session-meta">
                    <span class="session-status ${s.step}">${s.step}</span>
                    ${s.matched_count ? `<span class="session-tag matched">${s.matched_count} matched</span>` : ''}
                    ${s.comparison_source ? `<span class="session-tag comparison">${s.comparison_source}</span>` : ''}
                    <span>${s.processed_pages.length} / ${s.page_count} pages</span>
                    <span>${progress}% complete</span>
                </div>
            </div>
            <div class="session-actions">
                <button class="continue-btn" data-id="${s.id}">Continue</button>
                ${s.step === 'process' ? `<button class="chart-btn" data-id="${s.id}">Charts</button>` : ''}
                <button class="danger delete-btn" data-id="${s.id}">Delete</button>
            </div>
        </div>
    `;
}

function renderSessionsList(sessions) {
    // Group sessions: province -> seat_type -> [sessions]
    const grouped = {};
    for (const s of sessions) {
        const prov = s.province || 'Uncategorized';
        const seat = s.seat_type || 'Uncategorized';
        if (!grouped[prov]) grouped[prov] = {};
        if (!grouped[prov][seat]) grouped[prov][seat] = [];
        grouped[prov][seat].push(s);
    }

    // Always show all 4 provinces + Uncategorized if needed
    const allProvinces = ['Punjab', 'Sindh', 'KPK', 'Balochistan'];
    const hasUncategorized = grouped['Uncategorized'];
    const provinces = [...allProvinces];
    if (hasUncategorized) provinces.push('Uncategorized');

    const seatOrder = ['National', 'Provincial', 'Uncategorized'];

    let html = '';
    for (const prov of provinces) {
        const seatTypes = grouped[prov] || {};
        const provCount = Object.values(seatTypes).reduce((sum, arr) => sum + arr.length, 0);

        let seatHtml = '';
        for (const seat of seatOrder) {
            if (!seatTypes[seat]) continue;
            const cards = seatTypes[seat].map(renderSessionCard).join('');
            const seatKey = `${prov}>${seat}`;
            const seatOpen = openAccordions.has(seatKey) ? ' open' : '';
            seatHtml += `
                <div class="accordion seat-accordion${seatOpen}" data-accordion-key="${seatKey}">
                    <div class="accordion-header">
                        <span>${seat} <span class="accordion-count">(${seatTypes[seat].length})</span></span>
                        <span class="accordion-arrow">&#9654;</span>
                    </div>
                    <div class="accordion-body">${cards}</div>
                </div>
            `;
        }

        if (!seatHtml) {
            seatHtml = '<p class="accordion-empty">No sessions</p>';
        }

        const provOpen = openAccordions.has(prov) ? ' open' : '';
        html += `
            <div class="accordion province-accordion${provOpen}" data-accordion-key="${prov}">
                <div class="accordion-header">
                    <span>${prov} <span class="accordion-count">(${provCount})</span></span>
                    <span class="accordion-arrow">&#9654;</span>
                </div>
                <div class="accordion-body">${seatHtml}</div>
            </div>
        `;
    }

    sessionsList.innerHTML = html;

    // Add event listeners for session card buttons
    sessionsList.querySelectorAll('.continue-btn').forEach(btn => {
        btn.addEventListener('click', () => switchToSession(btn.dataset.id));
    });

    sessionsList.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteSession(btn.dataset.id));
    });

    sessionsList.querySelectorAll('.chart-btn').forEach(btn => {
        btn.addEventListener('click', () => openCharts(btn.dataset.id));
    });
}

// Accordion toggle via event delegation
sessionsList.addEventListener('click', (e) => {
    const header = e.target.closest('.accordion-header');
    if (!header) return;
    // Don't toggle if clicking a button inside a session card
    if (e.target.closest('.session-card')) return;
    const accordion = header.parentElement;
    accordion.classList.toggle('open');
    const key = accordion.dataset.accordionKey;
    if (key) {
        if (accordion.classList.contains('open')) {
            openAccordions.add(key);
        } else {
            openAccordions.delete(key);
        }
        saveAccordionState();
    }
});

async function switchToSession(sessionId) {
    try {
        await fetch(`/api/sessions/${sessionId}/switch`, { method: 'POST' });
        await restoreSession();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

async function deleteSession(sessionId) {
    if (!confirm('Delete this session? This cannot be undone.')) return;

    try {
        const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete');
        await loadDashboard();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

newSessionBtn.addEventListener('click', async () => {
    await fetch('/api/session/reset', { method: 'POST' });
    resetLocalState();
    showStep('upload');
});

// --- Bulk Upload ---

const bulkUploadBtn = document.getElementById('bulk-upload-btn');
const bulkUploadInput = document.getElementById('bulk-upload-input');

bulkUploadBtn.addEventListener('click', () => bulkUploadInput.click());

bulkUploadInput.addEventListener('change', async () => {
    const files = bulkUploadInput.files;
    if (!files || files.length === 0) return;

    bulkUploadBtn.disabled = true;
    bulkUploadBtn.textContent = 'Uploading...';

    const formData = new FormData();
    for (const file of files) {
        formData.append('files', file);
    }

    try {
        const data = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload/bulk');
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    bulkUploadBtn.textContent = `Uploading... ${pct}%`;
                }
            });
            xhr.addEventListener('load', () => {
                const resp = JSON.parse(xhr.responseText);
                if (xhr.status >= 400) reject(new Error(resp.detail));
                else resolve(resp);
            });
            xhr.addEventListener('error', () => reject(new Error('Upload failed')));
            xhr.send(formData);
        });

        await loadDashboard();
    } catch (err) {
        alert(`Error: ${err.message}`);
    } finally {
        bulkUploadBtn.disabled = false;
        bulkUploadBtn.textContent = 'Bulk Upload';
        bulkUploadInput.value = '';
    }
});

const importSchemeBtn = document.getElementById('import-scheme-btn');
const importSchemeInput = document.getElementById('import-scheme-input');

importSchemeBtn.addEventListener('click', () => importSchemeInput.click());

importSchemeInput.addEventListener('change', async () => {
    const file = importSchemeInput.files[0];
    if (!file) return;

    if (!confirm(
        `This will REPLACE all existing polling scheme mappings with the ` +
        `contents of ${file.name}. All current NA-to-PA matches will be deleted. Continue?`
    )) {
        importSchemeInput.value = '';
        return;
    }

    const originalText = importSchemeBtn.textContent;
    importSchemeBtn.disabled = true;
    importSchemeBtn.textContent = 'Uploading...';

    try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/polling-scheme/import', {
            method: 'POST',
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);
        alert(
            `Polling scheme imported.\n` +
            `Stations: ${data.stations}\nMatches: ${data.matches}\nRecords: ${data.total_records}`
        );
        await loadDashboard();
    } catch (err) {
        alert(`Error: ${err.message}`);
    } finally {
        importSchemeBtn.disabled = false;
        importSchemeBtn.textContent = originalText;
        importSchemeInput.value = '';
    }
});

function resetLocalState() {
    pdfInput.value = '';
    uploadStatus.textContent = '';
    document.getElementById('candidate1-name').value = '';
    document.getElementById('candidate1-row').value = '';
    document.getElementById('candidate2-name').value = '';
    document.getElementById('candidate2-row').value = '';
    pageCount = 0;
    selectedPages.clear();
    schemaFields = [];
    currentFormData = null;
    currentStationId = null;
    currentStationStatus = null;
    pollingStations = { pending: [], processed: [], approved: [] };
    usedPages.clear();
}

// --- Session Restore ---

async function restoreSession() {
    try {
        const res = await fetch('/api/session');
        const data = await res.json();

        if (!data.session || !data.session.pdf_name) {
            // No active session, show dashboard
            await loadDashboard();
            showStep('dashboard');
            return;
        }

        const session = data.session;
        pageCount = session.page_count;
        document.getElementById('auto-end-page').value = pageCount;
        schemaFields = session.schema_fields;

        // Restore candidate inputs if available
        if (session.candidate_1) {
            document.getElementById('candidate1-name').value = session.candidate_1.name || '';
            document.getElementById('candidate1-row').value = session.candidate_1.row || '';
        }
        if (session.candidate_2) {
            document.getElementById('candidate2-name').value = session.candidate_2.name || '';
            document.getElementById('candidate2-row').value = session.candidate_2.row || '';
        }
        document.getElementById('province-select').value = session.province || '';
        document.getElementById('seat-type-select').value = session.seat_type || '';
        comparisonSource = session.comparison_source || null;

        // Reset page labels state before switching
        pageLabels = null;
        document.getElementById('page-labels-preview').classList.add('hidden');

        // Show appropriate step
        showStep(session.step);

        if (session.step === 'process') {
            await loadPollingStations();
            renderPageThumbnails();
            updateProgress();
            updateComparisonStatus();
        }

        if (session.pdf_name) {
            uploadStatus.textContent = `Loaded: ${session.pdf_name} (${pageCount} pages)`;
            document.getElementById('schema-pdf-name').textContent = `${session.pdf_name} (${pageCount} pages)`;
            document.getElementById('process-pdf-name').textContent = session.pdf_name;
        }
    } catch (err) {
        console.error('Failed to restore session:', err);
        await loadDashboard();
        showStep('dashboard');
    }
}

function showStep(step) {
    // Hide all sections
    dashboardSection.classList.add('hidden');
    uploadSection.classList.add('hidden');
    schemaSection.classList.add('hidden');
    processSection.classList.add('hidden');
    completeSection.classList.add('hidden');
    chartSection.classList.add('hidden');

    // Show the appropriate section
    switch (step) {
        case 'dashboard':
            dashboardSection.classList.remove('hidden');
            break;
        case 'upload':
            uploadSection.classList.remove('hidden');
            break;
        case 'schema':
            schemaSection.classList.remove('hidden');
            break;
        case 'process':
            processSection.classList.remove('hidden');
            break;
        case 'complete':
            completeSection.classList.remove('hidden');
            break;
        case 'chart':
            chartSection.classList.remove('hidden');
            break;
    }

    // Persist current step in URL hash for reload
    location.hash = step;
}

function goToDashboard() {
    loadDashboard();
    showStep('dashboard');
}

// Initialize on page load — restore previous step or default to dashboard
(async () => {
    const hash = location.hash.replace('#', '');
    if (hash && hash !== 'dashboard') {
        await restoreSession();
    } else {
        await loadDashboard();
        showStep('dashboard');
    }
})();

// --- Back Buttons ---

document.getElementById('upload-back-btn').addEventListener('click', goToDashboard);
document.getElementById('schema-back-btn').addEventListener('click', goToDashboard);
document.getElementById('process-back-btn').addEventListener('click', goToDashboard);
document.getElementById('complete-back-btn').addEventListener('click', goToDashboard);

// --- Upload ---

uploadBtn.addEventListener('click', async () => {
    const file = pdfInput.files[0];
    if (!file) {
        uploadStatus.textContent = 'Please select a file';
        return;
    }

    const progressBar = document.getElementById('upload-progress');
    progressBar.classList.remove('hidden');
    progressBar.value = 0;
    uploadStatus.textContent = 'Uploading...';
    uploadBtn.disabled = true;

    const formData = new FormData();
    formData.append('file', file);

    try {
        const data = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload');
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    progressBar.value = (e.loaded / e.total) * 100;
                }
            });
            xhr.addEventListener('load', () => {
                const resp = JSON.parse(xhr.responseText);
                if (xhr.status >= 400) reject(new Error(resp.detail));
                else resolve(resp);
            });
            xhr.addEventListener('error', () => reject(new Error('Upload failed')));
            xhr.send(formData);
        });

        pageCount = data.page_count;
        document.getElementById('auto-end-page').value = pageCount;
        selectedPages.clear();
        uploadStatus.textContent = `Uploaded: ${data.filename} (${pageCount} pages)`;
        document.getElementById('schema-pdf-name').textContent = `${data.filename} (${pageCount} pages)`;
        document.getElementById('process-pdf-name').textContent = data.filename;

        // Move to schema step
        showStep('schema');
    } catch (err) {
        uploadStatus.textContent = `Error: ${err.message}`;
    } finally {
        progressBar.classList.add('hidden');
        uploadBtn.disabled = false;
    }
});

// --- Schema Definition ---

saveSchemaBtn.addEventListener('click', async () => {
    const c1Name = document.getElementById('candidate1-name').value.trim();
    const c1Row = parseInt(document.getElementById('candidate1-row').value);
    const c2Name = document.getElementById('candidate2-name').value.trim();
    const c2Row = parseInt(document.getElementById('candidate2-row').value);

    const province = document.getElementById('province-select').value;
    const seatType = document.getElementById('seat-type-select').value;

    if (!c1Name || !c1Row || !c2Name || !c2Row) {
        alert('Please fill in both candidates with name and row number');
        return;
    }

    try {
        const res = await fetch('/api/schema', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                candidate_1: { name: c1Name, row: c1Row },
                candidate_2: { name: c2Name, row: c2Row },
                province: province || null,
                seat_type: seatType || null,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        // Fetch the generated schema fields for form rendering
        const schemaRes = await fetch('/api/schema');
        const schemaData = await schemaRes.json();
        schemaFields = schemaData.fields;

        showStep('process');
        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
});

// --- Polling Station Queue ---

async function loadPollingStations() {
    try {
        const res = await fetch('/api/polling-stations');
        pollingStations = await res.json();

        // Sort each queue by trailing number (e.g., "Polling Station 2" -> 2)
        const getTrailingNumber = (name) => {
            const match = name.match(/(\d+)\s*$/);
            return match ? parseInt(match[1]) : Infinity;
        };
        const sortByNumber = (a, b) => getTrailingNumber(a.name) - getTrailingNumber(b.name);
        pollingStations.pending.sort(sortByNumber);
        pollingStations.processed.sort(sortByNumber);
        pollingStations.approved.sort(sortByNumber);

        // Calculate used pages
        usedPages.clear();
        [...pollingStations.pending, ...pollingStations.processed, ...pollingStations.approved].forEach(ps => {
            ps.pages.forEach(p => usedPages.add(p));
        });

        renderQueues();
    } catch (err) {
        console.error('Failed to load polling stations:', err);
    }
}

function formatFlag(flag) {
    if (flag.startsWith('vote_mismatch:')) {
        return `Vote mismatch: ${flag.split(':')[1]} (col3 != col6)`;
    }
    if (flag.startsWith('excessive_skew:')) {
        const parts = flag.split(':');
        return `Excessive skew: ${parts[1]} (${parts[2]}°)`;
    }
    return flag;
}

function renderQueueItem(ps, type) {
    const checked = selectedStations.has(ps.id) ? 'checked' : '';
    const checkboxHtml = `<input type="checkbox" class="queue-select-cb" data-id="${ps.id}" ${checked}>`;
    const nameHtml = `
        <span class="queue-item-name" data-id="${ps.id}">${ps.name}</span>
        <button class="rename-btn" data-id="${ps.id}" title="Rename">✎</button>
    `;
    const flaggedClass = ps.flags && ps.flags.length > 0 ? ' flagged' : '';
    const selectedClass = selectedStations.has(ps.id) ? ' selected' : '';
    const flagsHtml = ps.flags && ps.flags.length > 0
        ? `<div class="queue-item-flags">${ps.flags.map(f => `<span class="flag-reason">${formatFlag(f)}</span>`).join('')}</div>`
        : '';

    if (type === 'pending') {
        return `
            <div class="queue-item${flaggedClass}${selectedClass}" data-id="${ps.id}">
                ${checkboxHtml}
                <div class="queue-item-content">
                    <div class="queue-item-header">${nameHtml}</div>
                    <div class="queue-item-pages">Pages: ${ps.pages.map(p => p + 1).join(', ')}</div>
                    <div class="queue-item-actions">
                        <button class="view-pending-btn" data-id="${ps.id}">View</button>
                        <button class="send-btn" data-id="${ps.id}">Send</button>
                        <button class="danger delete-station-btn" data-id="${ps.id}">Delete</button>
                    </div>
                </div>
            </div>
        `;
    } else if (type === 'processed') {
        return `
            <div class="queue-item${flaggedClass}${selectedClass}" data-id="${ps.id}">
                ${checkboxHtml}
                <div class="queue-item-content">
                    <div class="queue-item-header">${nameHtml}</div>
                    <div class="queue-item-pages">Pages: ${ps.pages.map(p => p + 1).join(', ')}</div>
                    ${flagsHtml}
                    <div class="queue-item-actions">
                        <button class="verify-btn" data-id="${ps.id}">Verify</button>
                        <button class="danger delete-station-btn" data-id="${ps.id}">Delete</button>
                    </div>
                </div>
            </div>
        `;
    } else {
        const sourceTag = ps.source && ps.source !== 'ecp'
            ? `<span class="source-tag">${ps.source}</span>`
            : '';
        const matchedTag = ps.pscm_matched
            ? '<span class="session-tag matched">pscm matched</span>'
            : '';
        const pagesText = ps.pages && ps.pages.length > 0
            ? `<div class="queue-item-pages">Pages: ${ps.pages.map(p => p + 1).join(', ')}</div>`
            : '';
        return `
            <div class="queue-item${flaggedClass}${selectedClass}" data-id="${ps.id}">
                ${checkboxHtml}
                <div class="queue-item-content">
                    <div class="queue-item-header">${nameHtml}${sourceTag}${matchedTag}</div>
                    ${pagesText}
                    ${flagsHtml}
                    <div class="queue-item-actions">
                        <button class="view-btn" data-id="${ps.id}">View</button>
                        <button class="danger delete-station-btn" data-id="${ps.id}">Delete</button>
                    </div>
                </div>
            </div>
        `;
    }
}

function attachRenameListeners(container) {
    container.querySelectorAll('.rename-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            startRename(parseInt(btn.dataset.id));
        });
    });
}

async function startRename(stationId) {
    const nameSpan = document.querySelector(`.queue-item-name[data-id="${stationId}"]`);
    if (!nameSpan) return;

    const currentName = nameSpan.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'rename-input';

    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const finishRename = async () => {
        const newName = input.value.trim();
        if (!newName || newName === currentName) {
            // Restore original
            await loadPollingStations();
            return;
        }

        try {
            const res = await fetch(`/api/polling-station/${stationId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail);

            await loadPollingStations();
        } catch (err) {
            alert(`Error: ${err.message}`);
            await loadPollingStations();
        }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        } else if (e.key === 'Escape') {
            input.value = currentName;
            input.blur();
        }
    });
}

document.getElementById('renumber-btn').addEventListener('click', async () => {
    const fromStr = prompt('Renumber stations starting from station #:');
    if (fromStr === null) return;
    const fromNumber = parseInt(fromStr);
    if (isNaN(fromNumber) || fromNumber < 1) {
        alert('Please enter a valid station number');
        return;
    }

    const offsetStr = prompt('Offset (e.g., 1 to increment, -1 to decrement):');
    if (offsetStr === null) return;
    const offset = parseInt(offsetStr);
    if (isNaN(offset) || offset === 0) {
        alert('Please enter a non-zero offset');
        return;
    }

    try {
        const res = await fetch('/api/polling-stations/renumber', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from_number: fromNumber, offset }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        alert(`Renumbered ${data.renamed} stations`);
        await loadPollingStations();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
});

let lastCheckedCb = null;

function attachQueueCheckboxListeners(container) {
    const checkboxes = [...container.querySelectorAll('.queue-select-cb')];
    checkboxes.forEach(cb => {
        cb.addEventListener('click', (e) => {
            if (e.shiftKey && lastCheckedCb && lastCheckedCb !== cb) {
                // Find all checkboxes across all queues in DOM order
                const allCbs = [...document.querySelectorAll('.queue-select-cb')];
                const startIdx = allCbs.indexOf(lastCheckedCb);
                const endIdx = allCbs.indexOf(cb);
                const from = Math.min(startIdx, endIdx);
                const to = Math.max(startIdx, endIdx);
                const checked = cb.checked;
                for (let i = from; i <= to; i++) {
                    allCbs[i].checked = checked;
                    const id = parseInt(allCbs[i].dataset.id);
                    const item = allCbs[i].closest('.queue-item');
                    if (checked) {
                        selectedStations.add(id);
                        item.classList.add('selected');
                    } else {
                        selectedStations.delete(id);
                        item.classList.remove('selected');
                    }
                }
            } else {
                const id = parseInt(cb.dataset.id);
                const item = cb.closest('.queue-item');
                if (cb.checked) {
                    selectedStations.add(id);
                    item.classList.add('selected');
                } else {
                    selectedStations.delete(id);
                    item.classList.remove('selected');
                }
            }
            lastCheckedCb = cb;
            updateSelectionButtons();
        });
    });
}

function getSelectedInQueue(status) {
    const key = status === 'processed' ? 'processed' : status;
    const queueIds = new Set(pollingStations[key].map(ps => ps.id));
    return [...selectedStations].filter(id => queueIds.has(id));
}

function updateSelectionButtons() {
    const pendingSel = getSelectedInQueue('pending');
    const processedSel = getSelectedInQueue('processed');
    const approvedSel = getSelectedInQueue('approved');

    const deleteAllPendingBtn = document.getElementById('delete-all-pending-btn');
    const deleteAllProcessedBtn = document.getElementById('delete-all-processed-btn');
    const deleteAllApprovedBtn = document.getElementById('delete-all-approved-btn');

    if (pollingStations.pending.length > 0) {
        if (pendingSel.length > 0) {
            batchProcessBtn.textContent = `Process Selected (${pendingSel.length})`;
            deleteAllPendingBtn.textContent = `Delete Selected (${pendingSel.length})`;
        } else {
            batchProcessBtn.textContent = 'Process All';
            deleteAllPendingBtn.textContent = 'Delete All';
        }
    }

    if (pollingStations.processed.length > 0) {
        if (processedSel.length > 0) {
            bulkApproveBtn.textContent = `Approve Selected (${processedSel.length})`;
            deleteAllProcessedBtn.textContent = `Delete Selected (${processedSel.length})`;
        } else {
            bulkApproveBtn.textContent = 'Approve All';
            deleteAllProcessedBtn.textContent = 'Delete All';
        }
    }

    if (pollingStations.approved.length > 0) {
        if (approvedSel.length > 0) {
            deleteAllApprovedBtn.textContent = `Delete Selected (${approvedSel.length})`;
        } else {
            deleteAllApprovedBtn.textContent = 'Delete All';
        }
    }
}

function renderQueues() {
    // Prune selectedStations: remove IDs that no longer exist in any queue
    const allIds = new Set([
        ...pollingStations.pending.map(ps => ps.id),
        ...pollingStations.processed.map(ps => ps.id),
        ...pollingStations.approved.map(ps => ps.id),
    ]);
    for (const id of selectedStations) {
        if (!allIds.has(id)) selectedStations.delete(id);
    }

    // Pending queue
    const deleteAllPendingBtn = document.getElementById('delete-all-pending-btn');
    if (pollingStations.pending.length === 0) {
        pendingList.innerHTML = '<p class="empty-queue">No pending stations</p>';
        batchProcessBtn.disabled = true;
        deleteAllPendingBtn.disabled = true;
    } else {
        batchProcessBtn.disabled = false;
        deleteAllPendingBtn.disabled = false;
        pendingList.innerHTML = pollingStations.pending.map(ps => renderQueueItem(ps, 'pending')).join('');

        // Add event listeners
        pendingList.querySelectorAll('.view-pending-btn').forEach(btn => {
            btn.addEventListener('click', () => openStation(parseInt(btn.dataset.id), 'pending'));
        });
        pendingList.querySelectorAll('.send-btn').forEach(btn => {
            btn.addEventListener('click', () => processSingleStation(parseInt(btn.dataset.id)));
        });
        pendingList.querySelectorAll('.delete-station-btn').forEach(btn => {
            btn.addEventListener('click', () => deletePollingStation(parseInt(btn.dataset.id)));
        });
        attachRenameListeners(pendingList);
        attachQueueCheckboxListeners(pendingList);
    }

    // Done queue
    const deleteAllProcessedBtn = document.getElementById('delete-all-processed-btn');
    if (pollingStations.processed.length === 0) {
        doneList.innerHTML = '<p class="empty-queue">No stations awaiting verification</p>';
        bulkApproveBtn.disabled = true;
        deleteAllProcessedBtn.disabled = true;
    } else {
        bulkApproveBtn.disabled = false;
        deleteAllProcessedBtn.disabled = false;
        doneList.innerHTML = pollingStations.processed.map(ps => renderQueueItem(ps, 'processed')).join('');

        // Add click listeners to open verification
        doneList.querySelectorAll('.verify-btn').forEach(btn => {
            btn.addEventListener('click', () => openStation(parseInt(btn.dataset.id), 'processed'));
        });
        doneList.querySelectorAll('.delete-station-btn').forEach(btn => {
            btn.addEventListener('click', () => deletePollingStation(parseInt(btn.dataset.id)));
        });
        attachRenameListeners(doneList);
        attachQueueCheckboxListeners(doneList);
    }

    // Approved queue
    const deleteAllApprovedBtn = document.getElementById('delete-all-approved-btn');
    if (pollingStations.approved.length === 0) {
        approvedList.innerHTML = '<p class="empty-queue">No approved stations</p>';
        exportCsvBtn.disabled = true;
        deleteAllApprovedBtn.disabled = true;
    } else {
        exportCsvBtn.disabled = false;
        deleteAllApprovedBtn.disabled = false;
        approvedList.innerHTML = pollingStations.approved.map(ps => renderQueueItem(ps, 'approved')).join('');
        approvedList.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', () => openStation(parseInt(btn.dataset.id), 'approved'));
        });
        approvedList.querySelectorAll('.delete-station-btn').forEach(btn => {
            btn.addEventListener('click', () => deletePollingStation(parseInt(btn.dataset.id)));
        });
        attachRenameListeners(approvedList);
        attachQueueCheckboxListeners(approvedList);
    }

    updateSelectionButtons();
}

// --- Page Selection ---

let thumbnailsVisible = false;
let thumbnailsLoaded = false;

document.getElementById('toggle-thumbnails-btn').addEventListener('click', () => {
    thumbnailsVisible = !thumbnailsVisible;
    const btn = document.getElementById('toggle-thumbnails-btn');
    if (thumbnailsVisible) {
        btn.textContent = 'Hide Thumbnails';
        pageThumbnails.classList.remove('hidden');
        if (!thumbnailsLoaded) {
            loadThumbnails();
            thumbnailsLoaded = true;
        }
    } else {
        btn.textContent = 'Show Thumbnails';
        pageThumbnails.classList.add('hidden');
    }
});

function loadThumbnails() {
    pageThumbnails.innerHTML = '';
    for (let i = 0; i < pageCount; i++) {
        if (usedPages.has(i)) continue;

        const div = document.createElement('div');
        div.className = 'page-thumb';
        if (selectedPages.has(i)) div.classList.add('selected');

        div.innerHTML = `
            <img src="/api/page/${i}/thumbnail" alt="Page ${i + 1}">
            <span>Page ${i + 1}</span>
        `;
        div.dataset.page = i;

        div.addEventListener('click', () => {
            if (selectedPages.has(i)) {
                selectedPages.delete(i);
                div.classList.remove('selected');
            } else {
                selectedPages.add(i);
                div.classList.add('selected');
            }
            updateSelectedText();
        });

        pageThumbnails.appendChild(div);
    }
    updateSelectedText();
}

function renderPageThumbnails() {
    thumbnailsLoaded = false;
    if (thumbnailsVisible) {
        loadThumbnails();
        thumbnailsLoaded = true;
    } else {
        pageThumbnails.innerHTML = '';
    }
    updateSelectedText();
}

function updateSelectedText() {
    if (selectedPages.size === 0) {
        selectedPagesText.textContent = 'None';
        createStationBtn.disabled = true;
    } else {
        const sorted = Array.from(selectedPages).sort((a, b) => a - b);
        selectedPagesText.textContent = sorted.map(p => p + 1).join(', ');
        createStationBtn.disabled = false;
    }
}

function updateProgress() {
    const processed = pollingStations.approved.length;
    const total = pollingStations.pending.length + pollingStations.processed.length + pollingStations.approved.length;
    const progressText = document.getElementById('progress-text');
    const progressBar = document.getElementById('progress-bar');

    if (total === 0) {
        progressText.textContent = 'No polling stations created yet';
        progressBar.value = 0;
    } else {
        progressText.textContent = `${processed} / ${total} polling stations approved`;
        progressBar.value = (processed / total) * 100;
    }
}

// --- Create Polling Station ---

createStationBtn.addEventListener('click', async () => {
    if (selectedPages.size === 0) return;

    const pages = Array.from(selectedPages).sort((a, b) => a - b);

    try {
        const res = await fetch('/api/polling-station', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pages }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        // Clear selection and refresh
        selectedPages.clear();
        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
});

// --- Auto-create Polling Stations ---

document.getElementById('auto-create-btn').addEventListener('click', async () => {
    const step = parseInt(document.getElementById('pages-per-station').value);
    if (!step || step < 1) {
        alert('Please enter a valid number of pages per station');
        return;
    }

    const startPage = parseInt(document.getElementById('auto-start-page').value) || 1;
    const endPage = parseInt(document.getElementById('auto-end-page').value) || pageCount;

    if (startPage < 1 || endPage > pageCount || startPage > endPage) {
        alert(`Invalid range. Pages must be between 1 and ${pageCount}.`);
        return;
    }

    // Collect unused pages within range (UI is 1-based, internal is 0-based)
    const unusedPages = [];
    for (let i = startPage - 1; i < endPage; i++) {
        if (!usedPages.has(i)) unusedPages.push(i);
    }

    if (unusedPages.length === 0) {
        alert('No unused pages in the specified range');
        return;
    }

    // Chunk into groups of `step`
    const chunks = [];
    for (let i = 0; i < unusedPages.length; i += step) {
        chunks.push(unusedPages.slice(i, i + step));
    }

    const btn = document.getElementById('auto-create-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
        const res = await fetch('/api/polling-stations/batch-create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_groups: chunks }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        selectedPages.clear();
        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
    } finally {
        btn.disabled = false;
        btn.textContent = 'Automatically Create All Polling Stations';
    }
});

// --- Detect Page Labels ---

function renderPageLabelsPreview(labels, maxPages, startPage) {
    const container = document.getElementById('page-labels-grid');
    container.innerHTML = '';

    // Step 1: Group labels into forms by splitting on label === 1
    const groups = [];
    let current = null;
    for (let i = 0; i < labels.length; i++) {
        if (labels[i] === 1 || current === null) {
            if (current) groups.push(current);
            current = { pages: [], startIdx: i };
        }
        current.pages.push(labels[i]);
    }
    if (current) groups.push(current);

    // Step 2: Separate complete vs anomalous
    const expected = Array.from({ length: maxPages }, (_, i) => i + 1);
    const expectedKey = JSON.stringify(expected);
    let completeCount = 0;
    const anomalous = [];
    for (const g of groups) {
        if (JSON.stringify(g.pages) === expectedKey) {
            completeCount++;
        } else {
            const imgStart = startPage + g.startIdx;
            const imgEnd = imgStart + g.pages.length - 1;
            anomalous.push({
                images: imgStart === imgEnd ? `${imgStart}` : `${imgStart}\u2013${imgEnd}`,
                pages: g.pages,
            });
        }
    }

    // Step 3: Categorize anomalous by pattern
    const categories = {};
    for (const item of anomalous) {
        const key = JSON.stringify(item.pages);
        if (!categories[key]) {
            categories[key] = { pages: item.pages, description: describeAnomaly(item.pages, maxPages), items: [] };
        }
        categories[key].items.push(item);
    }

    // Step 4: Render
    document.getElementById('labels-summary').textContent =
        `${groups.length} forms: ${completeCount} complete, ${anomalous.length} anomalous`;

    if (anomalous.length === 0) return;

    // Render each anomaly category
    const sortedCats = Object.values(categories).sort((a, b) => b.items.length - a.items.length);
    for (const cat of sortedCats) {
        const div = document.createElement('div');
        div.className = 'anomaly-category';

        const heading = document.createElement('h4');
        heading.textContent = `${cat.description} (${cat.items.length})`;
        div.appendChild(heading);

        const table = document.createElement('table');
        table.className = 'anomaly-table';
        table.innerHTML = `<thead><tr><th>Images</th><th>Pages</th></tr></thead>`;
        const tbody = document.createElement('tbody');
        for (const item of cat.items) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${item.images}</td><td>${item.pages.join(', ')}</td>`;
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        div.appendChild(table);
        container.appendChild(div);
    }
}

function describeAnomaly(pages, maxPages) {
    const expected = Array.from({ length: maxPages }, (_, i) => i + 1);

    if (pages.length === 1) return `Solo page ${pages[0]}`;

    // Find missing and duplicate pages
    const countMap = {};
    for (const p of pages) countMap[p] = (countMap[p] || 0) + 1;

    const missing = expected.filter(p => !countMap[p]);
    const duplicates = Object.entries(countMap).filter(([, c]) => c > 1).map(([p]) => parseInt(p));
    const extras = pages.filter(p => p > maxPages);

    const parts = [];
    if (missing.length) parts.push(`Missing page${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`);
    if (duplicates.length) parts.push(`Duplicate page${duplicates.length > 1 ? 's' : ''} ${duplicates.join(', ')}`);
    if (extras.length) parts.push(`Extra page${extras.length > 1 ? 's' : ''} ${extras.join(', ')}`);

    if (parts.length) return parts.join('; ');
    return `Unexpected pattern [${pages.join(', ')}]`;
}

document.getElementById('detect-labels-btn').addEventListener('click', async () => {
    const maxPages = parseInt(document.getElementById('pages-per-station').value);
    const maxRows = parseInt(document.getElementById('max-rows-input').value) || 0;
    const startPage = parseInt(document.getElementById('auto-start-page').value) || 1;
    const endPage = parseInt(document.getElementById('auto-end-page').value) || pageCount;

    if (!maxPages || maxPages < 1) {
        alert('Please enter a valid number of pages per station');
        return;
    }

    const btn = document.getElementById('detect-labels-btn');
    btn.disabled = true;
    btn.textContent = 'Detecting...';

    try {
        const aiProvider = getAIProvider();
        const res = await fetch('/api/detect-page-labels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                max_pages: maxPages,
                max_rows: maxRows,
                start_page: startPage - 1,
                end_page: endPage,
                provider: aiProvider.provider,
                model: aiProvider.model,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        pageLabels = data.page_labels;
        renderPageLabelsPreview(pageLabels, maxPages, startPage);
        document.getElementById('page-labels-preview').classList.remove('hidden');
    } catch (err) {
        alert(`Error: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Detect Page Labels';
    }
});

document.getElementById('smart-create-btn').addEventListener('click', async () => {
    const maxPages = parseInt(document.getElementById('pages-per-station').value);
    const startPage = parseInt(document.getElementById('auto-start-page').value) || 1;
    const endPage = parseInt(document.getElementById('auto-end-page').value) || pageCount;

    const btn = document.getElementById('smart-create-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
        const res = await fetch('/api/polling-stations/smart-create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                max_pages: maxPages,
                start_page: startPage - 1,
                end_page: endPage,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        alert(`Created ${data.stations.length} stations (${data.anomaly_count} anomalous)`);
        selectedPages.clear();
        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
        document.getElementById('page-labels-preview').classList.add('hidden');
        pageLabels = null;
    } catch (err) {
        alert(`Error: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create Stations from Labels';
    }
});

// --- Process Polling Stations ---

async function processSingleStation(stationId) {
    const btn = pendingList.querySelector(`.send-btn[data-id="${stationId}"]`);
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Processing...';
    }

    try {
        const res = await fetch(`/api/polling-station/${stationId}/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(getAIProvider()),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Send';
        }
    }
}

batchProcessBtn.addEventListener('click', async () => {
    const selectedIds = getSelectedInQueue('pending');
    batchProcessBtn.disabled = true;
    batchProcessBtn.textContent = 'Processing...';

    // Disable all individual send buttons
    pendingList.querySelectorAll('.send-btn').forEach(btn => {
        btn.disabled = true;
        btn.textContent = 'Processing...';
    });

    try {
        const body = { ...getAIProvider() };
        if (selectedIds.length > 0) body.ids = selectedIds;
        const res = await fetch('/api/polling-stations/batch-process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        if (data.errors.length > 0) {
            alert(`Some stations failed to process: ${data.errors.map(e => e.error).join(', ')}`);
        }

        if (selectedIds.length > 0) selectedIds.forEach(id => selectedStations.delete(id));
        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
    } finally {
        batchProcessBtn.disabled = false;
        batchProcessBtn.textContent = 'Process All';
    }
});

bulkApproveBtn.addEventListener('click', async () => {
    const selectedIds = getSelectedInQueue('processed');
    const count = selectedIds.length > 0 ? selectedIds.length : pollingStations.processed.length;
    const label = selectedIds.length > 0 ? `${count} selected` : `all ${count}`;
    if (!confirm(`Approve ${label} stations with their current extracted data?`)) return;

    bulkApproveBtn.disabled = true;
    bulkApproveBtn.textContent = 'Approving...';

    try {
        const body = selectedIds.length > 0 ? { ids: selectedIds } : {};
        const res = await fetch('/api/polling-stations/bulk-approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
    } finally {
        bulkApproveBtn.disabled = false;
        bulkApproveBtn.textContent = 'Approve All';
    }
});

exportCsvBtn.addEventListener('click', () => {
    window.location.href = '/api/polling-stations/export';
});

// --- Comparison Upload ---

let comparisonSource = null;

function updateComparisonStatus() {
    const statusDiv = document.getElementById('comparison-status');
    if (comparisonSource) {
        const comparisonStations = [...pollingStations.approved].filter(ps => ps.source === comparisonSource);
        statusDiv.innerHTML = `<p class="comparison-info">Comparison: <strong>${comparisonSource}</strong> (${comparisonStations.length} stations) <button class="danger remove-comparison-btn">Remove</button></p>`;
        statusDiv.querySelector('.remove-comparison-btn').addEventListener('click', removeComparison);
    } else {
        statusDiv.innerHTML = '';
    }
}

async function removeComparison() {
    if (!confirm(`Remove all ${comparisonSource} comparison data?`)) return;

    const sessionRes = await fetch('/api/session');
    const sessionData = await sessionRes.json();
    if (!sessionData.session) return;

    try {
        const res = await fetch(`/api/sessions/${sessionData.session.id}/comparison`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        comparisonSource = null;
        updateComparisonStatus();
        await loadPollingStations();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

document.getElementById('comparison-upload-btn').addEventListener('click', async () => {
    const sourceInput = document.getElementById('comparison-source-name');
    const fileInput = document.getElementById('comparison-file-input');
    const sourceName = sourceInput.value.trim();

    if (!sourceName) {
        alert('Please enter a source name');
        return;
    }
    if (!fileInput.files.length) {
        alert('Please select a CSV file');
        return;
    }

    const sessionRes = await fetch('/api/session');
    const sessionData = await sessionRes.json();
    if (!sessionData.session) {
        alert('No active session');
        return;
    }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('source_name', sourceName);

    const btn = document.getElementById('comparison-upload-btn');
    btn.disabled = true;
    btn.textContent = 'Uploading...';

    try {
        const res = await fetch(`/api/sessions/${sessionData.session.id}/comparison-upload`, {
            method: 'POST',
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        comparisonSource = data.source_name;
        updateComparisonStatus();
        await loadPollingStations();
        fileInput.value = '';
        alert(`Uploaded ${data.stations_inserted} stations from ${data.source_name}`);
    } catch (err) {
        alert(`Error: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Upload Comparison';
    }
});

// --- Delete Polling Station ---

async function deletePollingStation(stationId) {
    if (!confirm('Delete this polling station? Its pages will be available for reselection.')) return;

    try {
        const res = await fetch(`/api/polling-station/${stationId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

async function deleteAllByStatus(status) {
    const selectedIds = getSelectedInQueue(status);
    if (selectedIds.length > 0) {
        if (!confirm(`Delete ${selectedIds.length} selected ${status} polling stations?`)) return;
        try {
            const res = await fetch('/api/polling-stations/batch-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: selectedIds }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail);
            selectedIds.forEach(id => selectedStations.delete(id));
            await loadPollingStations();
            renderPageThumbnails();
            updateProgress();
        } catch (err) {
            alert(`Error: ${err.message}`);
        }
        return;
    }

    const count = pollingStations[status].length;
    if (!count) return;
    if (!confirm(`Delete all ${count} ${status} polling stations?`)) return;

    try {
        const res = await fetch(`/api/polling-stations/by-status/${status}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

document.getElementById('delete-all-pending-btn').addEventListener('click', () => deleteAllByStatus('pending'));
document.getElementById('delete-all-processed-btn').addEventListener('click', () => deleteAllByStatus('processed'));
document.getElementById('delete-all-approved-btn').addEventListener('click', () => deleteAllByStatus('approved'));

// --- View/Edit Station ---

async function openStation(stationId, status) {
    try {
        const res = await fetch(`/api/polling-station/${stationId}`);
        const station = await res.json();
        if (!res.ok) throw new Error(station.detail);

        currentStationId = stationId;
        currentFormData = station.form_data;
        currentStationStatus = status;

        // Show split view, hide other elements
        pageSelector.classList.add('hidden');
        queueSection.classList.add('hidden');
        document.getElementById('process-back-btn').classList.add('hidden');
        splitView.classList.remove('hidden');

        // Set title
        splitViewTitle.textContent = station.name;

        // Update button text based on status
        if (status === 'pending') {
            approveBtn.classList.add('hidden');
        } else if (status === 'approved') {
            approveBtn.classList.remove('hidden');
            approveBtn.textContent = 'Save Changes';
        } else {
            approveBtn.classList.remove('hidden');
            approveBtn.textContent = 'Approve & Save';
        }

        // Update prev/next navigation for approved stations
        updateStationNav(stationId, status);

        // Render PDF images
        pdfImages.innerHTML = '';
        station.pages.forEach(p => {
            const img = document.createElement('img');
            img.src = `/api/page/${p}/image`;
            img.alt = `Page ${p + 1}`;
            pdfImages.appendChild(img);
        });

        // Render form fields
        if (status === 'pending') {
            formFields.innerHTML = '<p class="empty-queue">Not yet processed</p>';
        } else {
            renderFormFields(station.form_data);
        }
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

function updateStationNav(stationId, status) {
    if (status !== 'approved') {
        // Hide navigation for non-approved stations
        prevStationBtn.classList.add('hidden');
        nextStationBtn.classList.add('hidden');
        stationNavInfo.textContent = '';
        return;
    }

    prevStationBtn.classList.remove('hidden');
    nextStationBtn.classList.remove('hidden');

    const approvedIds = pollingStations.approved.map(ps => ps.id);
    const currentIndex = approvedIds.indexOf(stationId);

    // Update nav info
    stationNavInfo.textContent = `${currentIndex + 1} of ${approvedIds.length}`;

    // Update button states
    prevStationBtn.disabled = currentIndex <= 0;
    nextStationBtn.disabled = currentIndex >= approvedIds.length - 1;
}

prevStationBtn.addEventListener('click', () => {
    if (currentStationStatus !== 'approved') return;

    const approvedIds = pollingStations.approved.map(ps => ps.id);
    const currentIndex = approvedIds.indexOf(currentStationId);

    if (currentIndex > 0) {
        openStation(approvedIds[currentIndex - 1], 'approved');
    }
});

nextStationBtn.addEventListener('click', () => {
    if (currentStationStatus !== 'approved') return;

    const approvedIds = pollingStations.approved.map(ps => ps.id);
    const currentIndex = approvedIds.indexOf(currentStationId);

    if (currentIndex < approvedIds.length - 1) {
        openStation(approvedIds[currentIndex + 1], 'approved');
    }
});

function renderFormFields(formData) {
    formFields.innerHTML = '';

    schemaFields.forEach(schema => {
        const fieldData = formData[schema.name] || { type: 'blank', value: null };

        const div = document.createElement('div');
        div.className = 'form-field';
        div.innerHTML = `
            <label>${schema.alias}</label>
            <div class="field-inputs">
                <select data-field="${schema.name}" data-prop="type">
                    <option value="regular" ${fieldData.type === 'regular' ? 'selected' : ''}>Regular</option>
                    <option value="crossed" ${fieldData.type === 'crossed' ? 'selected' : ''}>Crossed</option>
                    <option value="crossedAndCorrected" ${fieldData.type === 'crossedAndCorrected' ? 'selected' : ''}>Crossed & Corrected</option>
                    <option value="overwritten" ${fieldData.type === 'overwritten' ? 'selected' : ''}>Overwritten</option>
                    <option value="illegible" ${fieldData.type === 'illegible' ? 'selected' : ''}>Illegible</option>
                    <option value="blank" ${fieldData.type === 'blank' ? 'selected' : ''}>Blank</option>
                </select>
                <input type="number" data-field="${schema.name}" data-prop="value"
                       value="${fieldData.value ?? ''}" placeholder="Value">
            </div>
        `;
        formFields.appendChild(div);
    });

    // Listen for changes
    formFields.querySelectorAll('select, input').forEach(el => {
        el.addEventListener('change', (e) => {
            const field = e.target.dataset.field;
            const prop = e.target.dataset.prop;
            if (!currentFormData[field]) {
                currentFormData[field] = { type: 'blank', value: null };
            }
            if (prop === 'value') {
                currentFormData[field][prop] = e.target.value ? parseInt(e.target.value) : null;
            } else {
                currentFormData[field][prop] = e.target.value;
            }
        });
    });
}

// --- Approve / Save / Back ---

approveBtn.addEventListener('click', async () => {
    if (!currentStationId) return;

    try {
        let res;
        if (currentStationStatus === 'approved') {
            // Update existing approved station
            res = await fetch(`/api/polling-station/${currentStationId}/form-data`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ form_data: currentFormData }),
            });
        } else {
            // Approve a processed station
            res = await fetch(`/api/polling-station/${currentStationId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ form_data: currentFormData }),
            });
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        currentStationId = null;
        currentFormData = null;
        currentStationStatus = null;

        // Go back to queue view
        splitView.classList.add('hidden');
        pageSelector.classList.remove('hidden');
        queueSection.classList.remove('hidden');
        document.getElementById('process-back-btn').classList.remove('hidden');

        await loadPollingStations();
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
});

splitViewBackBtn.addEventListener('click', () => {
    currentStationId = null;
    currentFormData = null;
    currentStationStatus = null;
    splitView.classList.add('hidden');
    pageSelector.classList.remove('hidden');
    queueSection.classList.remove('hidden');
    document.getElementById('process-back-btn').classList.remove('hidden');
});

// --- Charts ---

let voteChart = null;
let stationsWonChart = null;
let highTurnoutChart = null;
let winnerScatterChart = null;
let turnoutByStationChart = null;
let naPaTurnoutDiffChart = null;
let naPaDiffHistChart = null;
let naPaTurnoutViolinChart = null;
let naPaTurnoutDiffData = null;
let chartData = null;
let chartSessionId = null;

function destroyCharts() {
    if (voteChart) { voteChart.destroy(); voteChart = null; }
    if (stationsWonChart) { stationsWonChart.destroy(); stationsWonChart = null; }
    if (highTurnoutChart) { highTurnoutChart.destroy(); highTurnoutChart = null; }
    if (winnerScatterChart) { winnerScatterChart.destroy(); winnerScatterChart = null; }
    if (turnoutByStationChart) { turnoutByStationChart.destroy(); turnoutByStationChart = null; }
    if (naPaTurnoutDiffChart) { naPaTurnoutDiffChart.destroy(); naPaTurnoutDiffChart = null; }
    if (naPaDiffHistChart) { naPaDiffHistChart.destroy(); naPaDiffHistChart = null; }
    if (naPaTurnoutViolinChart) { naPaTurnoutViolinChart.destroy(); naPaTurnoutViolinChart = null; }
    naPaTurnoutDiffData = null;
}

function renderVoteTotalsChart(data) {
    if (voteChart) { voteChart.destroy(); voteChart = null; }
    const ctx = document.getElementById('vote-chart').getContext('2d');
    voteChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.candidates,
            datasets: [{
                label: 'Total Votes',
                data: data.totals,
                backgroundColor: ['#3b82f6', '#ef4444'],
            }],
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true } },
        },
    });
}

function renderStationsWonChart(data) {
    if (stationsWonChart) { stationsWonChart.destroy(); stationsWonChart = null; }

    // Count stations won per candidate (highest votes wins)
    const wins = data.candidates.map(() => 0);
    let ties = 0;
    for (const station of data.per_station) {
        const maxVotes = Math.max(...station.votes);
        if (maxVotes === 0) continue;
        const winners = station.votes.filter(v => v === maxVotes);
        if (winners.length > 1) {
            ties++;
        } else {
            wins[station.votes.indexOf(maxVotes)]++;
        }
    }

    const ctx = document.getElementById('stations-won-chart').getContext('2d');
    const labels = [...data.candidates];
    const barData = [...wins];
    const colors = ['#3b82f6', '#ef4444'];
    if (ties > 0) {
        labels.push('Tied');
        barData.push(ties);
        colors.push('#9ca3af');
    }

    stationsWonChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Stations Won',
                data: barData,
                backgroundColor: colors,
            }],
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
        },
    });
}

function renderHighTurnoutChart(data) {
    if (highTurnoutChart) { highTurnoutChart.destroy(); highTurnoutChart = null; }

    // Count stations with turnout > 60% won by each candidate
    const wins = data.candidates.map(() => 0);
    let ties = 0;
    for (const station of data.per_station) {
        if (station.turnout === null || station.turnout <= 0.6) continue;
        const maxVotes = Math.max(...station.votes);
        if (maxVotes === 0) continue;
        const winners = station.votes.filter(v => v === maxVotes);
        if (winners.length > 1) {
            ties++;
        } else {
            wins[station.votes.indexOf(maxVotes)]++;
        }
    }

    const ctx = document.getElementById('high-turnout-chart').getContext('2d');
    const labels = [...data.candidates];
    const barData = [...wins];
    const colors = ['#3b82f6', '#ef4444'];
    if (ties > 0) {
        labels.push('Tied');
        barData.push(ties);
        colors.push('#9ca3af');
    }

    highTurnoutChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Stations Won (Turnout > 60%)',
                data: barData,
                backgroundColor: colors,
            }],
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
        },
    });
}

function renderWinnerScatterChart(data) {
    if (winnerScatterChart) { winnerScatterChart.destroy(); winnerScatterChart = null; }

    // Build datasets: one per candidate + ties
    const datasets = data.candidates.map((name, i) => ({
        label: name,
        data: [],
        backgroundColor: i === 0 ? '#06b6d4' : '#ec4899',
        pointRadius: 7,
        pointHoverRadius: 9,
    }));
    const tieDataset = { label: 'Tied', data: [], backgroundColor: '#9ca3af', pointRadius: 7, pointHoverRadius: 9 };

    for (const station of data.per_station) {
        if (station.turnout === null) continue;
        const turnoutPct = Math.round(station.turnout * 100 * 10) / 10; // e.g. 65.3%
        const maxVotes = Math.max(...station.votes);
        if (maxVotes === 0) continue;

        const winners = station.votes.filter(v => v === maxVotes);
        if (winners.length > 1) {
            tieDataset.data.push({ x: turnoutPct, y: -1, stationName: station.name });
        } else {
            const winnerIdx = station.votes.indexOf(maxVotes);
            // y = 1 for candidate 1 (top), y = 0 for candidate 2 (bottom)
            datasets[winnerIdx].data.push({ x: turnoutPct, y: winnerIdx === 0 ? 1 : 0, stationName: station.name });
        }
    }

    const allDatasets = [...datasets];
    if (tieDataset.data.length > 0) allDatasets.push(tieDataset);

    const ctx = document.getElementById('winner-scatter-chart').getContext('2d');
    winnerScatterChart = new Chart(ctx, {
        type: 'scatter',
        data: { datasets: allDatasets },
        options: {
            responsive: true,
            plugins: {
                legend: { display: true, position: 'top' },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const point = ctx.dataset.data[ctx.dataIndex];
                            return `${point.stationName} — ${ctx.parsed.x}% turnout`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    title: { display: true, text: 'Turnout Percentage (%)' },
                },
                y: {
                    min: -0.5,
                    max: 1.5,
                    afterBuildTicks: (axis) => {
                        axis.ticks = [{ value: 0 }, { value: 1 }];
                    },
                    ticks: {
                        callback: (value) => {
                            if (value === 1) return data.candidates[0];
                            if (value === 0) return data.candidates[1];
                            return '';
                        },
                    },
                    title: { display: false },
                    grid: { display: false },
                },
            },
        },
    });
}

function renderTurnoutByStationChart(data) {
    if (turnoutByStationChart) { turnoutByStationChart.destroy(); turnoutByStationChart = null; }

    // Sort stations by station number
    const sorted = [...data.per_station]
        .map(s => {
            const numMatch = s.name.match(/(\d+)/);
            return { ...s, num: numMatch ? parseInt(numMatch[1]) : 0 };
        })
        .sort((a, b) => a.num - b.num);

    const labels = sorted.map(s => s.num);
    const c1Pct = sorted.map(s => s.registered ? (s.votes[0] / s.registered) * 100 : 0);
    const c2Pct = sorted.map(s => s.registered ? (s.votes[1] / s.registered) * 100 : 0);

    const ctx = document.getElementById('turnout-by-station-chart').getContext('2d');
    turnoutByStationChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: data.candidates[0],
                    data: c1Pct,
                    backgroundColor: '#06b6d4',
                },
                {
                    label: data.candidates[1],
                    data: c2Pct,
                    backgroundColor: '#dc2626',
                },
            ],
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: true, position: 'top' },
                tooltip: {
                    callbacks: {
                        title: (items) => `Station ${items[0].label}`,
                        label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
                    },
                },
            },
            scales: {
                x: {
                    title: { display: true, text: 'Polling Station Number' },
                },
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Turnout Percentage (%)' },
                },
            },
        },
    });
}

function renderNaPaTurnoutDiffChart(data) {
    if (naPaTurnoutDiffChart) { naPaTurnoutDiffChart.destroy(); naPaTurnoutDiffChart = null; }

    if (!data.stations || data.stations.length === 0) return;

    const labels = data.stations.map(s => s.na_station_num);
    const diffs = data.stations.map(s => s.diff);

    const ctx = document.getElementById('na-pa-turnout-diff-chart').getContext('2d');
    naPaTurnoutDiffChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Turnout Difference',
                data: diffs,
                backgroundColor: '#8b5cf6',
            }],
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => `NA Station ${items[0].label}`,
                        label: (ctx) => {
                            const station = data.stations[ctx.dataIndex];
                            return [
                                `Diff: ${ctx.parsed.y} votes`,
                                `NA: ${station.na_turnout} | PA (${station.pa_seat_name} #${station.pa_station_num}): ${station.pa_turnout}`,
                            ];
                        },
                    },
                },
            },
            scales: {
                x: { title: { display: true, text: 'Polling Station Number' } },
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Votes Cast Difference' },
                },
            },
        },
    });
}

function renderNaPaDiffHistChart(data) {
    if (naPaDiffHistChart) { naPaDiffHistChart.destroy(); naPaDiffHistChart = null; }

    if (!data.stations || data.stations.length === 0) return;

    // Bucket each station's diff to the nearest 10, count occurrences.
    const counts = new Map();
    const stationsByBucket = new Map();
    for (const s of data.stations) {
        const bucket = Math.round(s.diff / 10) * 10;
        counts.set(bucket, (counts.get(bucket) || 0) + 1);
        if (!stationsByBucket.has(bucket)) stationsByBucket.set(bucket, []);
        stationsByBucket.get(bucket).push(s);
    }

    const buckets = [...counts.keys()].sort((a, b) => a - b);
    const labels = buckets.map(b => b.toString());
    const counts_arr = buckets.map(b => counts.get(b));

    const ctx = document.getElementById('na-pa-diff-hist-chart').getContext('2d');
    naPaDiffHistChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Polling Stations',
                data: counts_arr,
                backgroundColor: '#8b5cf6',
            }],
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => `Diff bucket: ${items[0].label}`,
                        label: (ctx) => {
                            const bucket = buckets[ctx.dataIndex];
                            const stations = stationsByBucket.get(bucket) || [];
                            const lines = [`${ctx.parsed.y} polling station(s)`];
                            // Show up to 5 example stations for context (useful for outlier buckets).
                            for (const s of stations.slice(0, 5)) {
                                lines.push(`NA #${s.na_station_num} vs ${s.pa_seat_name} #${s.pa_station_num}: diff ${s.diff}`);
                            }
                            if (stations.length > 5) lines.push(`…and ${stations.length - 5} more`);
                            return lines;
                        },
                    },
                },
            },
            scales: {
                x: { title: { display: true, text: 'NA-PA Diff (votes, bucketed to nearest 10)' } },
                y: {
                    beginAtZero: true,
                    title: { display: true, text: '# of Polling Stations' },
                    ticks: { precision: 0 },
                },
            },
        },
    });
}

function renderNaPaTurnoutViolinChart(data) {
    if (naPaTurnoutViolinChart) { naPaTurnoutViolinChart.destroy(); naPaTurnoutViolinChart = null; }
    if (!data.stations || data.stations.length === 0) return;
    if (!data.candidates || data.candidates.length < 2) return;

    const [c1Name, c2Name] = data.candidates;

    // Group matched-pair stations by NA winner index.
    const groups = {
        0: { na: [], pa: [] },
        1: { na: [], pa: [] },
    };
    for (const s of data.stations) {
        if (s.winner_idx !== 0 && s.winner_idx !== 1) continue;
        if (s.na_turnout_pct == null || s.pa_turnout_pct == null) continue;
        groups[s.winner_idx].na.push(s.na_turnout_pct * 100);
        groups[s.winner_idx].pa.push(s.pa_turnout_pct * 100);
    }

    const labels = [c1Name, c2Name];
    const naData = [groups[0].na, groups[1].na];
    const paData = [groups[0].pa, groups[1].pa];

    const ctx = document.getElementById('na-pa-turnout-violin-chart').getContext('2d');
    naPaTurnoutViolinChart = new Chart(ctx, {
        type: 'violin',
        data: {
            labels,
            datasets: [
                {
                    label: 'NA Turnout',
                    data: naData,
                    backgroundColor: 'rgba(20, 150, 160, 0.55)',
                    borderColor: 'rgba(20, 150, 160, 1)',
                    borderWidth: 1,
                    itemRadius: 2,
                    itemStyle: 'circle',
                    itemBackgroundColor: 'rgba(20, 150, 160, 0.8)',
                },
                {
                    label: 'PA Turnout',
                    data: paData,
                    backgroundColor: 'rgba(220, 100, 120, 0.55)',
                    borderColor: 'rgba(220, 100, 120, 1)',
                    borderWidth: 1,
                    itemRadius: 2,
                    itemStyle: 'circle',
                    itemBackgroundColor: 'rgba(220, 100, 120, 0.8)',
                },
            ],
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: true, position: 'top' },
                tooltip: {
                    callbacks: {
                        title: (items) => items[0].label,
                        label: (ctx) => {
                            const stats = ctx.parsed;
                            const fmt = (v) => (typeof v === 'number' ? v.toFixed(1) : '?');
                            const n = stats.items ? stats.items.length : '?';
                            return [
                                `${ctx.dataset.label}: n=${n}`,
                                `min=${fmt(stats.min)}  q1=${fmt(stats.q1)}  median=${fmt(stats.median)}  q3=${fmt(stats.q3)}  max=${fmt(stats.max)}`,
                            ];
                        },
                    },
                },
            },
            scales: {
                x: { title: { display: true, text: 'Winning Candidate' } },
                y: {
                    beginAtZero: true,
                    max: 100,
                    title: { display: true, text: 'Turnout Percentage (%)' },
                },
            },
        },
    });
}

async function fetchNaPaTurnoutDiff(sessionId) {
    try {
        const res = await fetch(`/api/sessions/${sessionId}/na-pa-turnout-diff`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Failed to load data');
        naPaTurnoutDiffData = data;
        const activeTab = document.querySelector('.chart-tab.active')?.dataset.tab;
        if (activeTab === 'na-pa-diff-hist') {
            renderNaPaDiffHistChart(data);
        } else if (activeTab === 'na-pa-turnout-violin') {
            renderNaPaTurnoutViolinChart(data);
        } else {
            renderNaPaTurnoutDiffChart(data);
        }
    } catch (err) {
        console.error('NA-PA turnout diff error:', err);
    }
}

function switchChartTab(tab) {
    document.querySelectorAll('.chart-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.getElementById('chart-votes').classList.toggle('hidden', tab !== 'votes');
    document.getElementById('chart-stations-won').classList.toggle('hidden', tab !== 'stations-won');
    document.getElementById('chart-high-turnout').classList.toggle('hidden', tab !== 'high-turnout');
    document.getElementById('chart-winner-scatter').classList.toggle('hidden', tab !== 'winner-scatter');
    document.getElementById('chart-turnout-by-station').classList.toggle('hidden', tab !== 'turnout-by-station');
    document.getElementById('chart-na-pa-turnout-diff').classList.toggle('hidden', tab !== 'na-pa-turnout-diff');
    document.getElementById('chart-na-pa-diff-hist').classList.toggle('hidden', tab !== 'na-pa-diff-hist');
    document.getElementById('chart-na-pa-turnout-violin').classList.toggle('hidden', tab !== 'na-pa-turnout-violin');

    const titleBase = chartData ? chartData.pdf_name : '';
    if (tab === 'votes') {
        document.getElementById('chart-title').textContent = `Vote Totals — ${titleBase}`;
        renderVoteTotalsChart(chartData);
    } else if (tab === 'stations-won') {
        document.getElementById('chart-title').textContent = `Stations Won — ${titleBase}`;
        renderStationsWonChart(chartData);
    } else if (tab === 'high-turnout') {
        document.getElementById('chart-title').textContent = `High Turnout Stations Won — ${titleBase}`;
        renderHighTurnoutChart(chartData);
    } else if (tab === 'winner-scatter') {
        document.getElementById('chart-title').textContent = `Winner by Station — ${titleBase}`;
        renderWinnerScatterChart(chartData);
    } else if (tab === 'turnout-by-station') {
        document.getElementById('chart-title').textContent = `Turnout by Station — ${titleBase}`;
        renderTurnoutByStationChart(chartData);
    } else if (tab === 'na-pa-turnout-diff') {
        document.getElementById('chart-title').textContent = `NA-PA Turnout Difference — ${titleBase}`;
        if (naPaTurnoutDiffData) {
            renderNaPaTurnoutDiffChart(naPaTurnoutDiffData);
        } else if (chartSessionId) {
            fetchNaPaTurnoutDiff(chartSessionId);
        }
    } else if (tab === 'na-pa-diff-hist') {
        document.getElementById('chart-title').textContent = `NA-PA Diff Distribution — ${titleBase}`;
        if (naPaTurnoutDiffData) {
            renderNaPaDiffHistChart(naPaTurnoutDiffData);
        } else if (chartSessionId) {
            fetchNaPaTurnoutDiff(chartSessionId);
        }
    } else if (tab === 'na-pa-turnout-violin') {
        document.getElementById('chart-title').textContent = `NA-PA Turnout Violin — ${titleBase}`;
        if (naPaTurnoutDiffData) {
            renderNaPaTurnoutViolinChart(naPaTurnoutDiffData);
        } else if (chartSessionId) {
            fetchNaPaTurnoutDiff(chartSessionId);
        }
    }
}

async function openCharts(sessionId, source = 'ecp', tab = null) {
    try {
        chartSessionId = sessionId;
        const res = await fetch(`/api/sessions/${sessionId}/chart-data?source=${encodeURIComponent(source)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        chartData = data;
        destroyCharts();
        showStep('chart');

        // Show/hide source toggles
        const toggleIds = ['chart-source-toggle-votes', 'chart-source-toggle-stations-won'];
        const radioNames = ['chart-source-votes', 'chart-source-stations-won'];
        if (data.comparison_source) {
            document.querySelectorAll('.chart-source-label').forEach(el => {
                el.textContent = data.comparison_source;
            });
            toggleIds.forEach(id => document.getElementById(id).classList.remove('hidden'));
            radioNames.forEach(name => {
                document.querySelectorAll(`input[name="${name}"]`).forEach(r => {
                    if (r.value === 'ecp') r.checked = (source === 'ecp');
                    else r.checked = (source !== 'ecp');
                });
            });
        } else {
            toggleIds.forEach(id => document.getElementById(id).classList.add('hidden'));
        }

        // Show/hide NA-only tabs based on seat type
        const naOnlyTabs = [
            '.chart-tab[data-tab="na-pa-turnout-diff"]',
            '.chart-tab[data-tab="na-pa-diff-hist"]',
            '.chart-tab[data-tab="na-pa-turnout-violin"]',
        ];
        naOnlyTabs.forEach(sel => {
            const el = document.querySelector(sel);
            if (el) el.style.display = (data.seat_type === 'National') ? '' : 'none';
        });

        // Use provided tab or default to votes
        let activeTab = tab || document.querySelector('.chart-tab.active')?.dataset.tab || 'votes';
        const naOnlyActiveTabs = ['na-pa-turnout-diff', 'na-pa-diff-hist', 'na-pa-turnout-violin'];
        if (naOnlyActiveTabs.includes(activeTab) && data.seat_type !== 'National') {
            activeTab = 'votes';
        }
        switchChartTab(activeTab);
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

document.querySelectorAll('.chart-tab').forEach(tab => {
    tab.addEventListener('click', () => switchChartTab(tab.dataset.tab));
});
document.getElementById('chart-back-btn').addEventListener('click', goToDashboard);

['chart-source-votes', 'chart-source-stations-won'].forEach(name => {
    document.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
        radio.addEventListener('change', () => {
            if (!chartSessionId) return;
            const source = radio.value === 'ecp' ? 'ecp' : chartData.comparison_source;
            const currentTab = document.querySelector('.chart-tab.active')?.dataset.tab || 'votes';
            openCharts(chartSessionId, source, currentTab);
        });
    });
});

// --- Completion ---

document.getElementById('view-results-btn').addEventListener('click', async () => {
    const res = await fetch('/api/results');
    const data = await res.json();
    console.log('Results:', data);
    alert(`${data.length} records saved. Check console for details.`);
});

// --- AI Settings Modal ---

const aiSettingsBtn = document.getElementById('ai-settings-btn');
const aiSettingsModal = document.getElementById('ai-settings-modal');
const aiProviderSelect = document.getElementById('ai-provider-select');
const aiModelInput = document.getElementById('ai-model-input');

aiSettingsBtn.addEventListener('click', () => {
    const config = getAIProvider();
    aiProviderSelect.value = config.provider;
    aiModelInput.value = config.model;
    aiSettingsModal.classList.remove('hidden');
});

aiProviderSelect.addEventListener('change', () => {
    aiModelInput.value = DEFAULT_PROVIDERS[aiProviderSelect.value] || '';
});

document.getElementById('ai-settings-save').addEventListener('click', () => {
    saveAIProvider({ provider: aiProviderSelect.value, model: aiModelInput.value });
    aiSettingsModal.classList.add('hidden');
});

document.getElementById('ai-settings-cancel').addEventListener('click', () => {
    aiSettingsModal.classList.add('hidden');
});

aiSettingsModal.addEventListener('click', (e) => {
    if (e.target === aiSettingsModal) aiSettingsModal.classList.add('hidden');
});
