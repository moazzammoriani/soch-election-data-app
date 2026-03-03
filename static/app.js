// State
let pageCount = 0;
let selectedPages = new Set();
let schemaFields = [];
let currentFormData = null;
let currentStationId = null;
let currentStationStatus = null; // 'pending', 'processed', or 'approved'
let pollingStations = { pending: [], processed: [], approved: [] };
let usedPages = new Set(); // Pages already in polling stations

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
            seatHtml += `
                <div class="accordion seat-accordion">
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

        html += `
            <div class="accordion province-accordion">
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
    const nameHtml = `
        <span class="queue-item-name" data-id="${ps.id}">${ps.name}</span>
        <button class="rename-btn" data-id="${ps.id}" title="Rename">✎</button>
    `;
    const flaggedClass = ps.flags && ps.flags.length > 0 ? ' flagged' : '';
    const flagsHtml = ps.flags && ps.flags.length > 0
        ? `<div class="queue-item-flags">${ps.flags.map(f => `<span class="flag-reason">${formatFlag(f)}</span>`).join('')}</div>`
        : '';

    if (type === 'pending') {
        return `
            <div class="queue-item${flaggedClass}" data-id="${ps.id}">
                <div class="queue-item-header">${nameHtml}</div>
                <div class="queue-item-pages">Pages: ${ps.pages.map(p => p + 1).join(', ')}</div>
                <div class="queue-item-actions">
                    <button class="view-pending-btn" data-id="${ps.id}">View</button>
                    <button class="send-btn" data-id="${ps.id}">Send</button>
                    <button class="danger delete-station-btn" data-id="${ps.id}">Delete</button>
                </div>
            </div>
        `;
    } else if (type === 'processed') {
        return `
            <div class="queue-item${flaggedClass}" data-id="${ps.id}">
                <div class="queue-item-header">${nameHtml}</div>
                <div class="queue-item-pages">Pages: ${ps.pages.map(p => p + 1).join(', ')}</div>
                ${flagsHtml}
                <div class="queue-item-actions">
                    <button class="verify-btn" data-id="${ps.id}">Verify</button>
                    <button class="danger delete-station-btn" data-id="${ps.id}">Delete</button>
                </div>
            </div>
        `;
    } else {
        const sourceTag = ps.source && ps.source !== 'ecp'
            ? `<span class="source-tag">${ps.source}</span>`
            : '';
        const pagesText = ps.pages && ps.pages.length > 0
            ? `<div class="queue-item-pages">Pages: ${ps.pages.map(p => p + 1).join(', ')}</div>`
            : '';
        return `
            <div class="queue-item${flaggedClass}" data-id="${ps.id}">
                <div class="queue-item-header">${nameHtml}${sourceTag}</div>
                ${pagesText}
                ${flagsHtml}
                <div class="queue-item-actions">
                    <button class="view-btn" data-id="${ps.id}">View</button>
                    <button class="danger delete-station-btn" data-id="${ps.id}">Delete</button>
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

function renderQueues() {
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
    }
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

    // Collect unused pages, sorted ascending
    const unusedPages = [];
    for (let i = 0; i < pageCount; i++) {
        if (!usedPages.has(i)) unusedPages.push(i);
    }

    if (unusedPages.length === 0) {
        alert('No unused pages remaining');
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

// --- Process Polling Stations ---

async function processSingleStation(stationId) {
    const btn = pendingList.querySelector(`.send-btn[data-id="${stationId}"]`);
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Processing...';
    }

    try {
        const res = await fetch(`/api/polling-station/${stationId}/process`, { method: 'POST' });
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
    batchProcessBtn.disabled = true;
    batchProcessBtn.textContent = 'Processing...';

    // Disable all individual send buttons
    pendingList.querySelectorAll('.send-btn').forEach(btn => {
        btn.disabled = true;
        btn.textContent = 'Processing...';
    });

    try {
        const res = await fetch('/api/polling-stations/batch-process', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        if (data.errors.length > 0) {
            alert(`Some stations failed to process: ${data.errors.map(e => e.error).join(', ')}`);
        }

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
    const count = pollingStations.processed.length;
    if (!confirm(`Approve all ${count} stations with their current extracted data?`)) return;

    bulkApproveBtn.disabled = true;
    bulkApproveBtn.textContent = 'Approving...';

    try {
        const res = await fetch('/api/polling-stations/bulk-approve', { method: 'POST' });
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
let chartData = null;
let chartSessionId = null;

function destroyCharts() {
    if (voteChart) { voteChart.destroy(); voteChart = null; }
    if (stationsWonChart) { stationsWonChart.destroy(); stationsWonChart = null; }
    if (highTurnoutChart) { highTurnoutChart.destroy(); highTurnoutChart = null; }
    if (winnerScatterChart) { winnerScatterChart.destroy(); winnerScatterChart = null; }
    if (turnoutByStationChart) { turnoutByStationChart.destroy(); turnoutByStationChart = null; }
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

function switchChartTab(tab) {
    document.querySelectorAll('.chart-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.getElementById('chart-votes').classList.toggle('hidden', tab !== 'votes');
    document.getElementById('chart-stations-won').classList.toggle('hidden', tab !== 'stations-won');
    document.getElementById('chart-high-turnout').classList.toggle('hidden', tab !== 'high-turnout');
    document.getElementById('chart-winner-scatter').classList.toggle('hidden', tab !== 'winner-scatter');
    document.getElementById('chart-turnout-by-station').classList.toggle('hidden', tab !== 'turnout-by-station');

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

        // Use provided tab or default to votes
        const activeTab = tab || document.querySelector('.chart-tab.active')?.dataset.tab || 'votes';
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
