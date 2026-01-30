// State
let pageCount = 0;
let selectedPages = new Set();
let schemaFields = [];
let currentFormData = null;
let currentStationId = null;
let currentStationStatus = null; // 'processed' or 'approved'
let pollingStations = { pending: [], processed: [], approved: [] };
let usedPages = new Set(); // Pages already in polling stations

// DOM Elements
const dashboardSection = document.getElementById('dashboard-section');
const uploadSection = document.getElementById('upload-section');
const schemaSection = document.getElementById('schema-section');
const processSection = document.getElementById('process-section');
const completeSection = document.getElementById('complete-section');

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

async function loadDashboard() {
    try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        renderSessionsList(data.sessions);
    } catch (err) {
        console.error('Failed to load sessions:', err);
        sessionsList.innerHTML = '<p class="empty-state">Failed to load sessions</p>';
    }
}

function renderSessionsList(sessions) {
    if (sessions.length === 0) {
        sessionsList.innerHTML = '<p class="empty-state">No sessions yet. Click "+ New Session" to start.</p>';
        return;
    }

    sessionsList.innerHTML = sessions.map(s => {
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
                    <button class="danger delete-btn" data-id="${s.id}">Delete</button>
                </div>
            </div>
        `;
    }).join('');

    // Add event listeners
    sessionsList.querySelectorAll('.continue-btn').forEach(btn => {
        btn.addEventListener('click', () => switchToSession(btn.dataset.id));
    });

    sessionsList.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteSession(btn.dataset.id));
    });
}

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

        // Show appropriate step
        showStep(session.step);

        if (session.step === 'process') {
            await loadPollingStations();
            renderPageThumbnails();
            updateProgress();
        }

        if (session.pdf_name) {
            uploadStatus.textContent = `Loaded: ${session.pdf_name} (${pageCount} pages)`;
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
    }
}

function goToDashboard() {
    loadDashboard();
    showStep('dashboard');
}

// Initialize on page load
restoreSession();

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

    uploadStatus.textContent = 'Uploading...';
    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        pageCount = data.page_count;
        selectedPages.clear();
        uploadStatus.textContent = `Uploaded: ${data.filename} (${pageCount} pages)`;

        // Move to schema step
        showStep('schema');
    } catch (err) {
        uploadStatus.textContent = `Error: ${err.message}`;
    }
});

// --- Schema Definition ---

saveSchemaBtn.addEventListener('click', async () => {
    const c1Name = document.getElementById('candidate1-name').value.trim();
    const c1Row = parseInt(document.getElementById('candidate1-row').value);
    const c2Name = document.getElementById('candidate2-name').value.trim();
    const c2Row = parseInt(document.getElementById('candidate2-row').value);

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

function renderQueueItem(ps, type) {
    const nameHtml = `
        <span class="queue-item-name" data-id="${ps.id}">${ps.name}</span>
        <button class="rename-btn" data-id="${ps.id}" title="Rename">✎</button>
    `;

    if (type === 'pending') {
        return `
            <div class="queue-item" data-id="${ps.id}">
                <div class="queue-item-header">${nameHtml}</div>
                <div class="queue-item-pages">Pages: ${ps.pages.map(p => p + 1).join(', ')}</div>
                <div class="queue-item-actions">
                    <button class="send-btn" data-id="${ps.id}">Send</button>
                    <button class="danger delete-station-btn" data-id="${ps.id}">Delete</button>
                </div>
            </div>
        `;
    } else if (type === 'processed') {
        return `
            <div class="queue-item" data-id="${ps.id}">
                <div class="queue-item-header">${nameHtml}</div>
                <div class="queue-item-pages">Pages: ${ps.pages.map(p => p + 1).join(', ')}</div>
                <div class="queue-item-actions">
                    <button class="verify-btn" data-id="${ps.id}">Verify</button>
                    <button class="danger delete-station-btn" data-id="${ps.id}">Delete</button>
                </div>
            </div>
        `;
    } else {
        return `
            <div class="queue-item" data-id="${ps.id}">
                <div class="queue-item-header">${nameHtml}</div>
                <div class="queue-item-pages">Pages: ${ps.pages.map(p => p + 1).join(', ')}</div>
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
    if (pollingStations.pending.length === 0) {
        pendingList.innerHTML = '<p class="empty-queue">No pending stations</p>';
        batchProcessBtn.disabled = true;
    } else {
        batchProcessBtn.disabled = false;
        pendingList.innerHTML = pollingStations.pending.map(ps => renderQueueItem(ps, 'pending')).join('');

        // Add event listeners
        pendingList.querySelectorAll('.send-btn').forEach(btn => {
            btn.addEventListener('click', () => processSingleStation(parseInt(btn.dataset.id)));
        });
        pendingList.querySelectorAll('.delete-station-btn').forEach(btn => {
            btn.addEventListener('click', () => deletePollingStation(parseInt(btn.dataset.id)));
        });
        attachRenameListeners(pendingList);
    }

    // Done queue
    if (pollingStations.processed.length === 0) {
        doneList.innerHTML = '<p class="empty-queue">No stations awaiting verification</p>';
        bulkApproveBtn.disabled = true;
    } else {
        bulkApproveBtn.disabled = false;
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
    if (pollingStations.approved.length === 0) {
        approvedList.innerHTML = '<p class="empty-queue">No approved stations</p>';
        exportCsvBtn.disabled = true;
    } else {
        exportCsvBtn.disabled = false;
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

function renderPageThumbnails() {
    pageThumbnails.innerHTML = '';
    for (let i = 0; i < pageCount; i++) {
        // Skip pages that are already in polling stations
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
        if (status === 'approved') {
            approveBtn.textContent = 'Save Changes';
        } else {
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
        renderFormFields(station.form_data);
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

// --- Completion ---

document.getElementById('view-results-btn').addEventListener('click', async () => {
    const res = await fetch('/api/results');
    const data = await res.json();
    console.log('Results:', data);
    alert(`${data.length} records saved. Check console for details.`);
});
