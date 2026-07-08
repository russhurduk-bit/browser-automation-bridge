/* [bridge-popup] Popup UI for Browser Automation Bridge */

const wsDot = document.getElementById('ws-dot');
const wsStatus = document.getElementById('ws-status');
const verEl = document.getElementById('ver');
const idleMsg = document.getElementById('idle-msg');
const jobCard = document.getElementById('job-card');
const jobDetail = document.getElementById('job-detail');

function updateUI(state) {
  if (!state) return;

  verEl.textContent = 'v' + (state.version || '1.0.0');

  if (state.wsAlive) {
    wsDot.className = 'dot green';
    wsStatus.textContent = 'Connected';
  } else {
    wsDot.className = 'dot red';
    wsStatus.textContent = 'Disconnected';
  }

  if (state.currentJob) {
    idleMsg.style.display = 'none';
    jobCard.style.display = 'block';
    const j = state.currentJob;
    jobDetail.textContent = `#${j.job_id} [${j.step || ''}] ${j.slug || ''}`;
  } else {
    idleMsg.style.display = 'block';
    jobCard.style.display = 'none';
  }
}

// Get initial state
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
  updateUI(resp);
});

// Listen for live updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') {
    updateUI(msg);
  }
});
