// State
let pageCount = 0;
let processedPages = new Set();
let selectedPages = new Set();
let schemaFields = [];
let currentFormData = null;

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
const processBtn = document.getElementById('process-btn');
const progressText = document.getElementById('progress-text');
const progressBar = document.getElementById('progress-bar');

const splitView = document.getElementById('split-view');
const pageSelector = document.getElementById('page-selector');
const pdfImages = document.getElementById('pdf-images');
const formFields = document.getElementById('form-fields');
const approveBtn = document.getElementById('approve-btn');
const cancelBtn = document.getElementById('cancel-btn');

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
    processedPages.clear();
    selectedPages.clear();
    schemaFields = [];
    currentFormData = null;
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
        processedPages = new Set(session.processed_pages);
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
            renderPageThumbnails();
            updateProgress();

            // If there's pending verification data, restore the split view
            if (session.pending_pages && session.pending_form_data) {
                selectedPages = new Set(session.pending_pages);
                currentFormData = session.pending_form_data;
                showSplitView(session.pending_pages, session.pending_form_data);
            }
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
        processedPages.clear();
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
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
});

// --- Page Selection ---

function renderPageThumbnails() {
    pageThumbnails.innerHTML = '';
    for (let i = 0; i < pageCount; i++) {
        const div = document.createElement('div');
        div.className = 'page-thumb';
        if (processedPages.has(i)) div.classList.add('processed');
        if (selectedPages.has(i)) div.classList.add('selected');

        div.innerHTML = `
            <img src="/api/page/${i}/thumbnail" alt="Page ${i + 1}">
            <span>Page ${i + 1}</span>
        `;
        div.dataset.page = i;

        div.addEventListener('click', () => {
            if (processedPages.has(i)) return; // Can't select processed pages
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
    } else {
        const sorted = Array.from(selectedPages).sort((a, b) => a - b);
        selectedPagesText.textContent = sorted.map(p => p + 1).join(', ');
    }
}

function updateProgress() {
    const processed = processedPages.size;
    progressText.textContent = `${processed} / ${pageCount} pages processed`;
    progressBar.value = pageCount > 0 ? (processed / pageCount) * 100 : 0;
    progressBar.max = 100;

    // Check if complete
    if (processed >= pageCount && pageCount > 0) {
        showStep('complete');
    }
}

// --- Process Pages ---

processBtn.addEventListener('click', async () => {
    if (selectedPages.size === 0) {
        alert('Please select at least one page');
        return;
    }

    processBtn.disabled = true;
    processBtn.textContent = 'Processing...';

    const pages = Array.from(selectedPages).sort((a, b) => a - b);

    try {
        const res = await fetch('/api/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pages }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        currentFormData = data;
        showSplitView(pages, data);
    } catch (err) {
        alert(`Error: ${err.message}`);
    } finally {
        processBtn.disabled = false;
        processBtn.textContent = 'Process Selected Pages';
    }
});

// --- Split View ---

function showSplitView(pages, formData) {
    pageSelector.classList.add('hidden');
    splitView.classList.remove('hidden');

    // Render PDF images
    pdfImages.innerHTML = '';
    pages.forEach(p => {
        const img = document.createElement('img');
        img.src = `/api/page/${p}/image`;
        img.alt = `Page ${p + 1}`;
        pdfImages.appendChild(img);
    });

    // Render form fields
    renderFormFields(formData);
}

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

// --- Approve / Cancel ---

approveBtn.addEventListener('click', async () => {
    const pages = Array.from(selectedPages).sort((a, b) => a - b);

    try {
        const res = await fetch('/api/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pages, form_data: currentFormData }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);

        // Update processed pages
        data.processed_pages.forEach(p => processedPages.add(p));
        selectedPages.clear();
        currentFormData = null;

        // Go back to page selector
        splitView.classList.add('hidden');
        pageSelector.classList.remove('hidden');
        renderPageThumbnails();
        updateProgress();
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
});

cancelBtn.addEventListener('click', async () => {
    // Clear pending data from backend
    await fetch('/api/session/clear-pending', { method: 'POST' });

    selectedPages.clear();
    currentFormData = null;
    splitView.classList.add('hidden');
    pageSelector.classList.remove('hidden');
    renderPageThumbnails();
});

// --- Completion ---

document.getElementById('view-results-btn').addEventListener('click', async () => {
    const res = await fetch('/api/results');
    const data = await res.json();
    console.log('Results:', data);
    alert(`${data.length} records saved. Check console for details.`);
});
