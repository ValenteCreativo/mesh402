import './style.css';
import { createChamber } from './chamber.js';

type Evidence = {
  request: string; tool: string; prompt: string; model: string; initialHttpStatus: number; finalHttpStatus: number;
  network: string; amount: string; payer: string; recipient: string; transactionId: string; hashscan: string;
  verified: boolean; settled: boolean; taskId: string; bytes: number; credits: number; assetUrl: string;
  finalAnswer: string | null; finalizationRecovered: boolean; generationMs: number; createdAt: string; completedAt: string;
};
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const icon = `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M4 24V8l12 8L28 8v16M4 8l12 16L28 8" stroke="currentColor" stroke-width="1.8"/></svg>`;
$('#app').innerHTML = `
<header class="topbar"><a class="brand" href="#" aria-label="Mesh402 home">${icon}<span>MESH402</span></a><nav aria-label="Main navigation"><a href="#machine" class="nav-active">THE MACHINE</a><a href="#protocol">THE PROTOCOL ↗</a></nav><span class="system-status"><i></i> SYSTEM OPERATIONAL</span></header>
<main>
<section class="hero-heading"><div><div class="eyebrow">AUTONOMOUS FABRICATION PROTOCOL <span>/ 001</span></div><h1>MESH<span>402</span></h1></div><div class="hero-description"><p>3D infrastructure<br>for autonomous agents.</p><span class="mono">INTENT IN. <b>ASSET OUT.</b></span></div></section>
<section class="machine replay-view" id="machine" aria-label="Mesh402 execution machine">
  <div class="machine-bar"><span><i class="signal"></i> FABRICATION UNIT <b>M—01</b></span><div class="mode-switch" role="group" aria-label="Execution source"><button id="replay-mode" aria-pressed="true">REPLAY</button><button id="live-mode" aria-pressed="false">LIVE <i></i></button></div><span id="source-label">VERIFIED RUN · NO NEW PAYMENT</span></div>
  <div class="machine-body">
    <div class="intent-panel">
      <div class="section-label"><span>01 / AGENT INTENT</span><span class="agent-label">NEBIUS / QWEN</span></div>
      <label for="intent" class="request-label">What does your agent need?</label>
      <textarea id="intent" readonly aria-describedby="mode-note" spellcheck="false">Loading verified request…</textarea>
      <div class="request-footer"><span class="small-square">↳</span><span id="mode-note">Original natural-language request</span></div>
      <div id="live-consent" hidden><label><input type="checkbox" id="consent"> Authorize one 0.001 HBAR payment + one Tripo generation if the agent selects the tool.</label></div>
      <button class="run-button" id="run" disabled><span id="run-label">LOADING VERIFIED ASSET</span><span id="run-icon">↗</span></button>
      <div class="run-subline"><span id="run-hint">CAPTURED EXECUTION / ACCELERATED REPLAY</span><span>AGENT MODE</span></div>
    </div>
    <div class="trace-panel">
      <div class="section-label"><span>02 / EXECUTION TRACE</span><span id="trace-count">05 / 05</span></div>
      <ol class="trace">
        <li data-step="1"><span class="step-index">01</span><div><div class="step-heading">Capability selected <span class="step-check">✓</span></div><code>generate_3d_asset()</code><span class="step-note">Selected by the agent, autonomously.</span></div></li>
        <li data-step="2" class="payment-step"><span class="step-index">02</span><div><div class="step-heading">Payment required <span class="step-check">✓</span></div><div class="http-payment"><strong>402</strong><div><span>PAYMENT REQUIRED</span><b id="payment-price">0.001 HBAR</b></div></div></div></li>
        <li data-step="3"><span class="step-index">03</span><div><div class="step-heading">Settlement <span class="settled-badge">SETTLED ✓</span></div><code id="accounts">— → —</code><a id="transaction" target="_blank" rel="noopener noreferrer">VIEW HEDERA TRANSACTION ↗</a></div></li>
        <li data-step="4"><span class="step-index">04</span><div><div class="step-heading">Fabrication <span class="step-check">✓</span></div><div class="progress-info"><code>TRIPO V3</code><span id="progress">100% / SUCCESS</span></div><div class="progress-track"><div id="progress-fill"></div></div></div></li>
        <li data-step="5"><span class="step-index">05</span><div><div class="step-heading">Asset delivered <span class="delivery-code">200 OK</span></div><code id="delivery-meta">GLB · — MB · PBR TEXTURES</code></div></li>
      </ol>
    </div>
    <div class="chamber-panel">
      <div class="chamber-top"><span class="mono">03 / FABRICATION CHAMBER</span><span class="view-label">PERSPECTIVE <span>⊕</span></span></div>
      <div class="chamber" id="chamber"><div id="viewport"></div><span class="corner c1"></span><span class="corner c2"></span><span class="corner c3"></span><span class="corner c4"></span>
        <div class="chamber-side"><span>Y ↑</span><span>OBJECT SPACE / NORMALIZED</span></div>
        <div class="chamber-mark">M<span>—</span>01</div>
        <div class="load-status" id="load-status"><span class="load-cross">+</span><strong>LOADING VERIFIED GLB</strong><span id="load-progress">LOCAL ASSET / 41.3 MB</span></div>
        <div class="machine-state" id="machine-state" aria-live="polite"><span class="state-dot"></span><span id="state-label">VERIFIED ASSET</span></div>
        <div class="object-caption"><span id="object-id">OBJECT / FB48A85C</span><span id="object-type">ROBOTIC STREET FOOD CART</span></div>
        <div class="viewer-controls" aria-label="3D viewer controls"><button id="rotate" aria-label="Toggle auto rotation" aria-pressed="true">↻</button><button id="wire" aria-label="Toggle wireframe" aria-pressed="false">▧</button><button id="reset" aria-label="Reset camera">⌖</button></div>
      </div>
      <div class="chamber-bottom"><span><i></i> <span id="chamber-note">THE ACTUAL ASSET PURCHASED BY THE AGENT</span></span><span>DRAG TO ORBIT <b>↔</b> SCROLL TO ZOOM</span></div>
    </div>
  </div>
  <div class="machine-footer"><div class="status-result"><div class="http-transition" id="http-transition" data-phase="fulfilled" aria-label="HTTP request status"><span class="http-start">402</span><span class="http-arrow" aria-hidden="true">→</span><span class="result-code" id="http-code">200</span></div><div><strong id="result-title">REQUEST FULFILLED</strong><span id="result-note">One agent. One payment. One real asset.</span></div></div><div class="run-facts"><div><span>NETWORK</span><strong>HEDERA TESTNET</strong></div><div><span>GENERATION</span><strong id="duration">— S</strong></div><div><span>PROVIDER USAGE</span><strong id="credits">20 CREDITS</strong></div></div><a class="download" id="download" download>DOWNLOAD GLB <span>↓</span></a></div>
</section>
<div class="evidence-strip"><span><i></i> REAL TRANSACTION. REAL GENERATION. REAL GLB.</span><button id="evidence-toggle" aria-expanded="false">INSPECT EXECUTION RECEIPT <span>+</span></button></div>
<section class="evidence-detail" id="evidence-detail" hidden><div><span class="eyebrow">VERIFIABLE EXECUTION</span><h3>Nothing here is hypothetical.</h3><p id="final-answer"></p><small id="finalization-note"></small></div><dl><dt>TRANSACTION</dt><dd id="receipt-transaction"></dd><dt>TRIPO TASK</dt><dd id="receipt-task"></dd><dt>ORIGINAL INTENT</dt><dd id="receipt-intent"></dd><dt>AGENT ARGUMENT</dt><dd id="receipt-prompt"></dd><dt>LOCAL ASSET</dt><dd id="receipt-asset"></dd></dl><a href="/demo/receipt" class="text-link">DOWNLOAD PUBLIC RECEIPT ↗</a></section>
<section class="protocol" id="protocol"><div class="protocol-heading"><span class="eyebrow">THE PROTOCOL / 002</span><h2>One capability.<br><span>Any agent.</span></h2><p>Agents shouldn't subscribe to tools.<br>They should buy capabilities.</p></div><div class="protocol-content"><div class="architecture"><div class="arch-agent">${icon}<span>YOUR AGENT</span><small>INTENT + PAYMENT</small></div><span class="arch-arrow">→</span><div class="arch-mesh"><strong>MESH402</strong><span>PAID CAPABILITY</span></div><div class="arch-branches"><div><span>x402</span><b>HEDERA</b><small>SETTLE</small></div><div><span>generation</span><b>TRIPO</b><small>FABRICATE</small></div></div><span class="arch-arrow">→</span><div class="arch-glb"><span>↗</span><strong>.GLB</strong><small>CONSUME</small></div></div><div class="principles"><div><span>01</span><h3>No subscription.</h3><p>Pay per generation.</p></div><div><span>02</span><h3>No provider key.</h3><p>The agent needs no Tripo credential.</p></div><div><span>03</span><h3>Machine-native.</h3><p>Discover. Pay. Consume.</p></div></div><div class="code-example"><div><span class="mono">THE CAPABILITY</span><span>HTTP / x402 v2</span></div><pre><span class="code-green">POST</span> /api/generate-3d
{ "prompt": "low-poly robotic street food cart" }
<span class="code-dim">402 → sign payment → retry →</span> <span class="code-green">200 + GLB</span></pre></div></div></section>
<footer class="footer"><div class="footer-brand">${icon}<span>MESH402</span><small>INFRASTRUCTURE, NOT AN INTERFACE.</small></div><div class="stack"><span>POWERED BY</span><p>Nebius / Qwen <i>REASON</i> <b>·</b> Blocky402 <i>VERIFY</i> <b>·</b> Hedera <i>SETTLE</i> <b>·</b> Tripo <i>CREATE</i></p></div><span class="footer-end">BUILT FOR MACHINES.<br>UNDERSTOOD BY HUMANS.</span></footer>
</main><div class="error-banner" id="error" role="alert" hidden></div>`;

let evidence: Evidence;
let replayEvidence: Evidence;
let mode: 'replay' | 'live' = 'replay';
let running = false;
let replayTimer = 0;
let step = 5;
let liveUsed = false;
let loaded = false;
let rotating = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let chamber: ReturnType<typeof createChamber>;
const stateNames = ['AWAITING INTENT', 'CAPABILITY SELECTED', '402 / PAYMENT REQUIRED', 'PAYMENT SETTLED', 'FABRICATION IN PROGRESS', 'ASSET DELIVERED'];
function error(message: string) { $('#error').textContent = message; $('#error').hidden = false; }
function applyEvidence(data: Evidence) {
  evidence = data;
  $<HTMLTextAreaElement>('#intent').value = mode === 'replay' ? '“I need a robotic street food cart for my retro-futuristic browser game.”' : data.request;
  $('#intent').setAttribute('title', data.request);
  $('#payment-price').textContent = data.amount;
  $('#accounts').textContent = `${data.payer} → ${data.recipient}`;
  const transaction = $<HTMLAnchorElement>('#transaction'); transaction.href = data.hashscan; transaction.title = data.transactionId;
  $('#delivery-meta').textContent = `GLB · ${(data.bytes / 1e6).toFixed(1)} MB · PBR TEXTURES`;
  $('#duration').textContent = `${(data.generationMs / 1000).toFixed(1)} S`;
  $('#credits').textContent = `${data.credits} CREDITS`;
  $<HTMLAnchorElement>('#download').href = data.assetUrl;
  $('#object-id').textContent = `OBJECT / ${data.taskId.slice(0, 8).toUpperCase()}`;
  $('#object-type').textContent = data.taskId === replayEvidence?.taskId ? 'ROBOTIC STREET FOOD CART' : 'AGENT-REQUESTED ASSET';
  $('#final-answer').textContent = data.finalAnswer ?? 'Asset delivered. Final agent response pending.';
  $('#finalization-note').textContent = data.finalizationRecovered ? 'Final agent wording recovered in a separate, non-spending finalization. No payment or generation repeated.' : '';
  $('#receipt-transaction').textContent = data.transactionId;
  $('#receipt-task').textContent = data.taskId;
  $('#receipt-intent').textContent = data.request;
  $('#receipt-prompt').textContent = data.prompt;
  $('#receipt-asset').textContent = `${data.taskId}.glb / ${data.bytes.toLocaleString()} bytes`;
}
function renderStage(value: number) {
  step = value;
  document.querySelectorAll<HTMLElement>('[data-step]').forEach(row => {
    const n = Number(row.dataset.step);
    row.classList.toggle('done', n <= value);
    row.classList.toggle('active', n === value && running);
  });
  $('#trace-count').textContent = `${String(value).padStart(2, '0')} / 05`;
  $('#state-label').textContent = stateNames[value];
  $('#machine-state').classList.toggle('working', value < 5);
  $('#http-transition').dataset.phase = value === 5 ? 'fulfilled' : value >= 2 ? 'required' : 'awaiting';
  $('#http-code').textContent = value === 5 ? '200' : value >= 2 ? '402' : '—';
  $('#http-code').classList.toggle('waiting', value < 5);
  $('#result-title').textContent = value === 5 ? 'REQUEST FULFILLED' : value === 4 ? 'CAPABILITY EXECUTING' : value === 3 ? 'PAYMENT ACCEPTED' : value === 2 ? 'PAYMENT REQUIRED' : running ? 'AGENT AT WORK' : 'AWAITING REQUEST';
  $('#result-note').textContent = value === 5 ? 'One agent. One payment. One real asset.' : value === 4 ? 'Payment unlocked generation. Awaiting delivery.' : value === 3 ? 'Payment settled. Capability unlocked.' : value === 2 ? 'Payment unlocks this capability.' : 'Intent → capability → payment → asset';
  $('#download').classList.toggle('unavailable', value !== 5);
  $('#download').setAttribute('aria-disabled', String(value !== 5));
  $('#download').tabIndex = value === 5 ? 0 : -1;
  chamber?.setState(value === 5, value >= 2 && value < 5);
  $('#chamber-note').textContent = value === 5 ? 'THE ACTUAL ASSET PURCHASED BY THE AGENT' : mode === 'replay' ? 'MACHINE-STATE VISUALIZATION / NOT GEOMETRY STREAMING' : 'WAITING FOR TRIPO / NOT GEOMETRY STREAMING';
  if (value < 4) { $('#progress').textContent = 'STANDBY'; $('#progress-fill').style.width = '0%'; }
  if (value === 4) { $('#progress').textContent = mode === 'replay' ? 'CAPTURED TASK / REPLAY' : 'RUNNING'; $('#progress-fill').style.width = '50%'; }
  if (value === 5) { $('#progress').textContent = '100% / SUCCESS'; $('#progress-fill').style.width = '100%'; }
}
function finishReplay() {
  clearTimeout(replayTimer); running = false; renderStage(5);
  $('#run-label').textContent = 'REPLAY VERIFIED RUN'; $('#run-icon').textContent = '↻';
  $('#source-label').textContent = 'VERIFIED RUN · NO NEW PAYMENT';
  toggleModeButtons(false);
}
function toggleModeButtons(disabled: boolean) {
  $<HTMLButtonElement>('#replay-mode').disabled = disabled;
  $<HTMLButtonElement>('#live-mode').disabled = disabled;
}
function startReplay() {
  if (running) { finishReplay(); return; }
  $('#error').hidden = true; applyEvidence(replayEvidence);
  running = true; toggleModeButtons(true); chamber.setRotate(rotating);
  $('#source-label').textContent = 'REPLAYING VERIFIED RUN';
  $('#run-label').textContent = 'SKIP TO DELIVERED ASSET'; $('#run-icon').textContent = '→';
  renderStage(0);
  // Accelerated narrative of recorded stages, not original event timestamps or live progress.
  const stages = [{ at: 700, stage: 1 }, { at: 2600, stage: 2 }, { at: 5800, stage: 3 }, { at: 8300, stage: 4 }, { at: 14500, stage: 5 }];
  let index = 0;
  function next() {
    if (!running || mode !== 'replay') return;
    const item = stages[index];
    replayTimer = window.setTimeout(() => {
      renderStage(item.stage);
      if (item.stage === 5) finishReplay();
      else { index++; next(); }
    }, item.at - (index ? stages[index - 1].at : 0));
  }
  next();
}
function switchMode(next: 'replay' | 'live') {
  if (running) return;
  mode = next;
  const live = mode === 'live';
  $('#machine').classList.toggle('replay-view', !live);
  if (live) $<HTMLTextAreaElement>('#intent').value = replayEvidence.request;
  $('#replay-mode').setAttribute('aria-pressed', String(!live)); $('#live-mode').setAttribute('aria-pressed', String(live));
  $<HTMLTextAreaElement>('#intent').readOnly = !live;
  $('#live-consent').hidden = !live;
  $<HTMLInputElement>('#consent').checked = false;
  $('#mode-note').textContent = live ? 'Your agent decides whether to purchase a 3D asset.' : 'Original natural-language request';
  $('#source-label').textContent = live ? 'LIVE MODE · AWAITING AUTHORIZATION' : 'VERIFIED RUN · NO NEW PAYMENT';
  $('#run-hint').textContent = live ? 'ONE ATTEMPT / APPROX. 2–3 MINUTES' : 'CAPTURED EXECUTION / ACCELERATED REPLAY';
  $('#run-label').textContent = live ? liveUsed ? 'LIVE ATTEMPT USED' : 'RUN AGENT' : 'REPLAY VERIFIED RUN';
  $('#run-icon').textContent = live ? '↗' : '↻';
  $<HTMLButtonElement>('#run').disabled = live || !loaded;
  if (!live) { applyEvidence(replayEvidence); void chamber.load(replayEvidence.assetUrl); renderStage(5); }
  else { renderStage(0); $('#object-type').textContent = 'AWAITING A NEW AGENT REQUEST'; $('#accounts').textContent = 'AWAITING PAYMENT'; $('#duration').textContent = '—'; $('#credits').textContent = '—'; $('#transaction').removeAttribute('href'); $('#transaction').title = 'No live transaction yet'; }
}
async function runLive() {
  if (liveUsed || !$<HTMLInputElement>('#consent').checked) return;
  const intent = $<HTMLTextAreaElement>('#intent').value.trim();
  if (!intent) { error('Enter an intent for your agent.'); return; }
  running = true; liveUsed = true; toggleModeButtons(true);
  $<HTMLButtonElement>('#run').disabled = true; $<HTMLTextAreaElement>('#intent').readOnly = true;
  $('#source-label').textContent = 'LIVE EXECUTION · REAL PAYMENT + GENERATION'; $('#run-label').textContent = 'AGENT RUNNING'; $('#error').hidden = true; renderStage(0);
  try {
    const response = await fetch('/demo/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent, confirm: true }) });
    if (!response.ok) throw new Error((await response.json()).error);
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; let completed = false;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop()!;
      for (const line of lines) {
        if (!line) continue; const { event, data } = JSON.parse(line);
        if (event === 'tool') { renderStage(1); $('#receipt-prompt').textContent = data.arguments.prompt; }
        if (event === 'signed') { $('#accounts').textContent = `${data.payer} → ${data.recipient}`; $<HTMLAnchorElement>('#transaction').href = `https://hashscan.io/testnet/transaction/${encodeURIComponent(data.transactionId)}`; $('#transaction').title = data.transactionId; renderStage(2); $('#result-note').textContent = 'Exact requirements checked. Payment signed.'; }
        if (event === 'settled' && data.success) renderStage(3);
        if (event === 'created') { renderStage(4); $('#object-id').textContent = `TASK / ${data.data.task_id.slice(0, 8).toUpperCase()}`; }
        if (event === 'progress') { $('#progress').textContent = `${data.progress}% / ${data.status.toUpperCase()}`; $('#progress-fill').style.width = `${data.progress}%`; }
        if (event === 'delivered') { applyEvidence(data); $('#load-status').hidden = false; await chamber.load(data.assetUrl); renderStage(5); }
        if (event === 'complete') { completed = true; $('#final-answer').textContent = data.answer; }
        if (event === 'answer') { completed = true; $('#result-title').textContent = 'ANSWERED WITHOUT SPENDING'; $('#result-note').textContent = data.answer; $('#state-label').textContent = 'NO ASSET REQUESTED'; }
        if (event === 'failed') throw new Error(data.error);
      }
    }
    if (!completed) throw new Error('Execution stream ended. Check the local receipt before any further action. No automatic retry.');
  } catch (cause) { error(cause instanceof Error ? cause.message : 'Live run failed. No automatic retry.'); $('#result-title').textContent = 'EXECUTION NEEDS ATTENTION'; }
  finally { running = false; toggleModeButtons(false); $('#run-label').textContent = 'LIVE ATTEMPT COMPLETE'; }
}
$('#run').addEventListener('click', () => { if (mode === 'replay') startReplay(); else void runLive(); });
$('#replay-mode').addEventListener('click', () => switchMode('replay'));
$('#live-mode').addEventListener('click', () => switchMode('live'));
$('#consent').addEventListener('change', () => { $<HTMLButtonElement>('#run').disabled = !$<HTMLInputElement>('#consent').checked || liveUsed; });
$('#download').addEventListener('click', event => { if (step !== 5) event.preventDefault(); });
$('#rotate').addEventListener('click', () => { rotating = !rotating; chamber.setRotate(rotating); $('#rotate').setAttribute('aria-pressed', String(rotating)); });
$('#wire').addEventListener('click', () => { const value = $('#wire').getAttribute('aria-pressed') !== 'true'; chamber.setWire(value); $('#wire').setAttribute('aria-pressed', String(value)); });
$('#reset').addEventListener('click', () => chamber.reset());
$('#evidence-toggle').addEventListener('click', () => { const opened = $('#evidence-detail').hidden; $('#evidence-detail').hidden = !opened; $('#evidence-toggle').setAttribute('aria-expanded', String(opened)); $('#evidence-toggle span').textContent = opened ? '−' : '+'; });
async function boot() {
  try {
    const response = await fetch('/demo/evidence'); if (!response.ok) throw new Error('Could not read the verified local receipt.');
    replayEvidence = await response.json(); applyEvidence(replayEvidence);
    chamber = createChamber($('#viewport'), fraction => {
      $('#load-progress').textContent = fraction === 1 ? 'DECODED / READY' : `LOCAL GLB / ${Math.round(fraction * 100)}%`;
      if (fraction === 1) $('#load-status').hidden = true;
    });
    await chamber.load(replayEvidence.assetUrl); loaded = true;
    $('#object-type').textContent = 'ROBOTIC STREET FOOD CART';
    $<HTMLButtonElement>('#run').disabled = false;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finishReplay(); else startReplay();
  } catch (cause) { error(cause instanceof Error ? cause.message : 'Viewer could not initialize.'); $('#load-progress').textContent = 'VIEWER UNAVAILABLE — GLB DOWNLOAD STILL AVAILABLE'; }
}
void boot();
