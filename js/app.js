// ============================================================
//  Credit Card Comparison App
//  Pure vanilla JS — no build step required.
//  Data loaded from /data/credit-cards.json and
//  /data/points-valuations.json
// ============================================================

// ── State ────────────────────────────────────────────────────
const state = {
  cards: [],
  currencies: [],
  spending: {           // annual spend by category (dollars)
    dining:     3600,   // $300/mo
    groceries:  4800,   // $400/mo
    flights:    3000,
    hotels:     2000,
    gas:        1800,   // $150/mo
    streaming:   600,   // $50/mo
    telecom:    1200,   // $100/mo
    transit:    1200,
    drugstores:  600,
    rent:       18000,  // $1,500/mo
    other:      6000,
  },
  pointsMode: 'cashback',   // 'cashback' | 'transfer'
  sortKey: 'year1',
  sortDir: 'desc',
  expandedCard: null,
  expandedCreditCategory: null, // which credit category is expanded in Profile tab
  creditOverrides: {},      // { cardId: { creditId: utilization } } — explicit user overrides only
  globalCreditUtilization: {  // null = use each credit's own JSON default
    dining: null, travel: null, subscriptions: null, entertainment: null,
    transit: null, lifestyle: null, cash: null, miles: null,
  },
};

const CREDIT_CATEGORY_META = {
  dining:        { label: 'Dining Credits',        icon: '🍽️', hint: "restaurant credits, Grubhub, Resy, Dunkin'" },
  travel:        { label: 'Travel Credits',         icon: '✈️', hint: 'hotel, airline fee, lounge, companion award' },
  subscriptions: { label: 'Subscription Credits',  icon: '📺', hint: 'streaming, DashPass, Apple services' },
  entertainment: { label: 'Entertainment Credits', icon: '🎭', hint: 'StubHub, concerts, events' },
  transit:       { label: 'Transit Credits',        icon: '🚗', hint: 'Uber Cash, Lyft, rideshare' },
  lifestyle:     { label: 'Lifestyle Credits',      icon: '🏃', hint: 'Lululemon, Oura, Best Buy, fitness' },
  cash:          { label: 'Cash Credits',           icon: '💵', hint: 'annual cash bonuses' },
  miles:         { label: 'Miles Bonuses',          icon: '🌟', hint: 'anniversary miles bonuses' },
};

const CATEGORY_META = {
  dining:     { label: 'Dining & Restaurants',      icon: '🍽️',  hint: 'restaurants, delivery, takeout' },
  groceries:  { label: 'Groceries',                  icon: '🛒',  hint: 'supermarkets, warehouse clubs' },
  flights:    { label: 'Airfare',                    icon: '✈️',  hint: 'booked direct with airlines' },
  hotels:     { label: 'Hotels',                     icon: '🏨',  hint: 'booked direct with hotels' },
  gas:        { label: 'Gas & EV Charging',          icon: '⛽',  hint: 'gas stations & EV chargers' },
  streaming:  { label: 'Streaming Services',         icon: '📺',  hint: 'Netflix, Spotify, etc.' },
  telecom:    { label: 'Phone & Telecom',            icon: '📱',  hint: 'cell plans, internet' },
  transit:    { label: 'Transit & Rideshare',        icon: '🚗',  hint: 'Uber, Lyft, subway, parking' },
  drugstores: { label: 'Drugstores',                 icon: '💊',  hint: 'CVS, Walgreens, Rite Aid' },
  rent:       { label: 'Rent / Mortgage',            icon: '🏠',  hint: 'Bilt cards only — other cards earn 0%' },
  other:      { label: 'Everything Else',            icon: '🛍️',  hint: 'all other purchases' },
};

// ── Boot ─────────────────────────────────────────────────────
async function init() {
  try {
    const [cardsData, valuationsData] = await Promise.all([
      fetch('data/credit-cards.json').then(r => r.json()),
      fetch('data/points-valuations.json').then(r => r.json()),
    ]);
    state.cards = cardsData.cards;
    state.currencies = valuationsData.currencies;

    state.cards.forEach(card => {
      state.creditOverrides[card.id] = {};
    });

    renderAll();
    setupEventListeners();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;color:#f87171;font-family:monospace">
      Failed to load data: ${err.message}<br><small>Make sure you are serving via a local server (not file://).</small></div>`;
  }
}

// ── Helpers ──────────────────────────────────────────────────
function fmt(n, decimals = 0) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

function fmtK(n) {
  if (Math.abs(n) >= 1000) return fmt(n / 1000, 1).replace('$', '') + 'k';
  return fmt(n, 0);
}

function getCurrency(id) {
  return state.currencies.find(c => c.id === id);
}

function getCpp(currencyId) {
  const currency = getCurrency(currencyId);
  if (!currency) return 0.01;
  return state.pointsMode === 'transfer'
    ? currency.transferCpp / 100
    : currency.cashbackCpp / 100;
}

/**
 * Resolves credit utilization with priority:
 * 1. Per-card explicit override (user changed in card expanded row)
 * 2. Global category default (user set in Profile tab)
 * 3. JSON default (credit.defaultUtilization)
 */
function getUtilization(card, credit) {
  const perCard = state.creditOverrides[card.id]?.[credit.id];
  if (perCard !== undefined) return perCard;
  if (credit.category) {
    const global = state.globalCreditUtilization[credit.category];
    if (global !== null && global !== undefined) return global;
  }
  return credit.defaultUtilization;
}

// ── Calculation Engine ────────────────────────────────────────

/**
 * Calculates the annual rewards value from spending.
 * For cash-back cards (isCashBackCard), rate is a % applied directly.
 * For points cards, rate × cpp × annual spend.
 */
function calcSpendRewards(card) {
  const cpp = getCpp(card.pointsCurrencyId);
  let total = 0;
  Object.entries(state.spending).forEach(([cat, spend]) => {
    // Use ?? 0 so an explicit rate of 0 (e.g. rent on non-Bilt cards) is respected,
    // not silently replaced by the || 1 fallback.
    const rate = card.earningRates[cat] ?? 0;
    if (card.isCashBackCard) {
      // rate is a cash-back percentage (e.g., 2 = 2%)
      total += spend * (rate / 100);
    } else {
      // rate is a points multiplier; value = spend × rate × cpp
      total += spend * rate * cpp;
    }
  });
  return total;
}

/**
 * Calculates annual credits value, respecting per-credit utilization overrides.
 */
function calcCreditsValue(card) {
  return (card.credits || []).reduce((sum, credit) => {
    if (credit.oneTime) return sum;
    return sum + credit.annualValue * getUtilization(card, credit);
  }, 0);
}

/**
 * One-time credits (e.g. Amazon Prime from Navy Federal sign-up bonus) only
 * count in Year 1, not recurring years.
 */
function calcOneTimeCreditsValue(card) {
  return (card.credits || []).reduce((sum, credit) => {
    if (!credit.oneTime) return sum;
    return sum + credit.annualValue * getUtilization(card, credit);
  }, 0);
}

/**
 * Year 1 = sign-up bonus value + one-time credits + annual rewards - annual fee
 */
function calcYear1(card) {
  const cpp = getCpp(card.pointsCurrencyId);
  const bonusValue = (card.signupBonus?.points || 0) * cpp;
  const cashBonus = card.signupBonus?.cashBonus || 0;
  const spendRewards = calcSpendRewards(card);
  const creditsValue = calcCreditsValue(card);
  const oneTimeValue = calcOneTimeCreditsValue(card);
  return bonusValue + cashBonus + oneTimeValue + spendRewards + creditsValue - card.annualFee;
}

/**
 * Recurring = annual rewards - annual fee (no sign-up bonus)
 */
function calcRecurring(card) {
  const spendRewards = calcSpendRewards(card);
  const creditsValue = calcCreditsValue(card);
  return spendRewards + creditsValue - card.annualFee;
}

function calcAnnualRewards(card) {
  return calcSpendRewards(card) + calcCreditsValue(card);
}

// ── Tab Navigation ────────────────────────────────────────────
function setupEventListeners() {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
}

// ── Render All ────────────────────────────────────────────────
function renderAll() {
  renderProfile();
  renderCardsTable();
  renderPointsTab();
}

// ── Profile Tab ───────────────────────────────────────────────
function renderProfile() {
  const container = document.getElementById('profile-spending-grid');
  container.innerHTML = '';

  Object.entries(CATEGORY_META).forEach(([key, meta]) => {
    const val = state.spending[key];
    const div = document.createElement('div');
    div.className = 'spend-item';
    div.innerHTML = `
      <span class="spend-icon">${meta.icon}</span>
      <div class="spend-label">
        ${meta.label}
        <small>${meta.hint}</small>
      </div>
      <div class="spend-input-wrap">
        <span class="currency-symbol">$</span>
        <input class="spend-input" type="number" min="0" step="100"
               data-category="${key}" value="${val}" />
      </div>`;
    container.appendChild(div);

    div.querySelector('.spend-input').addEventListener('input', e => {
      state.spending[key] = parseFloat(e.target.value) || 0;
      updateSpendTotal();
      renderCardsTable();
    });
  });

  updateSpendTotal();
  renderCreditDefaults();
}

function updateSpendTotal() {
  const total = Object.values(state.spending).reduce((s, v) => s + v, 0);
  document.getElementById('spend-total').textContent = fmt(total);
}

function renderCreditDefaults() {
  const container = document.getElementById('credit-defaults-grid');
  const subContainer = document.getElementById('credit-sub-list-container');
  if (!container) return;
  container.innerHTML = '';

  // Find credit categories actually used by non-oneTime credits in the loaded data
  const usedCategories = new Set();
  state.cards.forEach(card => {
    (card.credits || []).forEach(credit => {
      if (credit.category && !credit.oneTime) usedCategories.add(credit.category);
    });
  });

  let expandedKeyFound = false;

  Object.entries(CREDIT_CATEGORY_META).forEach(([key, meta]) => {
    if (!usedCategories.has(key)) return;

    // Count how many non-oneTime credits across all cards belong to this category
    let count = 0;
    state.cards.forEach(card => {
      (card.credits || []).forEach(credit => {
        if (credit.category === key && !credit.oneTime) count++;
      });
    });

    const currentVal = state.globalCreditUtilization[key];
    const displayVal = currentVal !== null ? Math.round(currentVal * 100) : '';
    const isExpanded = state.expandedCreditCategory === key;
    if (isExpanded) expandedKeyFound = true;

    const div = document.createElement('div');
    div.className = `credit-default-item${isExpanded ? ' expanded' : ''}`;
    div.innerHTML = `
      <span class="credit-default-icon">${meta.icon}</span>
      <div class="credit-default-label">
        ${meta.label}
        <small>${meta.hint} · ${count} credit${count !== 1 ? 's' : ''} across all cards</small>
      </div>
      <span class="expand-chevron">${isExpanded ? '▼' : '▶'}</span>
      <div class="credit-default-input-wrap">
        <input class="credit-default-input" type="number" min="0" max="100" step="5"
               placeholder="—" value="${displayVal}" data-category="${key}" />
        <span style="font-size:11px;color:var(--text-muted);margin-left:3px">%</span>
        <button class="util-clear-btn" style="visibility:${currentVal !== null ? 'visible' : 'hidden'}"
                data-category="${key}" title="Clear — revert to per-card defaults">×</button>
      </div>`;

    const input = div.querySelector('.credit-default-input');
    const clearBtn = div.querySelector('.util-clear-btn');

    // Click anywhere on the item (except the input/button) to toggle expanded sub-list
    div.addEventListener('click', () => {
      state.expandedCreditCategory = state.expandedCreditCategory === key ? null : key;
      renderCreditDefaults();
    });
    input.addEventListener('click', e => e.stopPropagation());
    clearBtn.addEventListener('click', e => {
      e.stopPropagation();
      state.globalCreditUtilization[key] = null;
      input.value = '';
      clearBtn.style.visibility = 'hidden';
      renderCardsTable();
      if (state.expandedCreditCategory === key && subContainer) {
        renderCreditSubList(subContainer, key);
      }
    });

    input.addEventListener('input', e => {
      const raw = e.target.value.trim();
      state.globalCreditUtilization[key] = raw === ''
        ? null
        : Math.max(0, Math.min(100, parseFloat(raw) || 0)) / 100;
      clearBtn.style.visibility = state.globalCreditUtilization[key] !== null ? 'visible' : 'hidden';
      renderCardsTable();
      // Update sub-list source indicators live if this category is expanded
      if (state.expandedCreditCategory === key && subContainer) {
        renderCreditSubList(subContainer, key);
      }
    });

    container.appendChild(div);
  });

  // Render (or hide) the sub-list for the expanded category
  if (subContainer) {
    if (state.expandedCreditCategory && expandedKeyFound) {
      subContainer.style.display = '';
      renderCreditSubList(subContainer, state.expandedCreditCategory);
    } else {
      subContainer.style.display = 'none';
      subContainer.innerHTML = '';
    }
  }
}

function renderCreditSubList(container, categoryKey) {
  const meta = CREDIT_CATEGORY_META[categoryKey];
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'credit-sub-header';
  header.innerHTML = `
    <span>${meta.icon} ${meta.label} — Individual Credits</span>
    <span>Override per credit below. Blank = use the category default above.</span>`;
  container.appendChild(header);

  const list = document.createElement('div');
  list.className = 'credit-sub-items';

  state.cards.forEach(card => {
    (card.credits || []).forEach(credit => {
      if (credit.category !== categoryKey || credit.oneTime) return;

      const util = getUtilization(card, credit);
      const hasCardOverride = state.creditOverrides[card.id]?.[credit.id] !== undefined;
      const globalVal = state.globalCreditUtilization[credit.category];
      const sourceClass = hasCardOverride ? 'card-override' : (globalVal !== null ? 'global' : 'default');
      const sourceLabel = hasCardOverride ? 'Card override' : (globalVal !== null ? 'Global rule' : 'Default');

      const row = document.createElement('div');
      row.className = 'credit-sub-item';
      row.innerHTML = `
        <span class="credit-sub-card">${card.name}</span>
        <span class="credit-sub-name">${credit.name}
          <span style="color:var(--text-muted);font-size:10px;font-weight:400">${fmt(credit.annualValue)}</span>
        </span>
        <span class="util-source ${sourceClass}" id="sub-src-${card.id}-${credit.id}">${sourceLabel}</span>
        <button class="util-reset" id="sub-rst-${card.id}-${credit.id}"
                style="visibility:${hasCardOverride ? 'visible' : 'hidden'}">reset</button>
        <input class="utilization-input" type="number" min="0" max="100" step="5"
               value="${Math.round(util * 100)}"
               data-card="${card.id}" data-credit="${credit.id}" />
        <span style="font-size:11px;color:var(--text-muted)">%</span>`;

      const subInput = row.querySelector('.utilization-input');
      const resetBtn = row.querySelector('.util-reset');

      subInput.addEventListener('input', e => {
        const pct = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
        if (!state.creditOverrides[card.id]) state.creditOverrides[card.id] = {};
        state.creditOverrides[card.id][credit.id] = pct / 100;
        // Update source indicator live without full re-render
        const srcEl = document.getElementById(`sub-src-${card.id}-${credit.id}`);
        const rstEl = document.getElementById(`sub-rst-${card.id}-${credit.id}`);
        if (srcEl) { srcEl.className = 'util-source card-override'; srcEl.textContent = 'Card override'; }
        if (rstEl) rstEl.style.visibility = 'visible';
        renderCardsTable();
      });

      resetBtn.addEventListener('click', () => {
        delete state.creditOverrides[card.id][credit.id];
        renderCardsTable();
        renderCreditSubList(container, categoryKey); // re-render sub-list only
      });

      list.appendChild(row);
    });
  });

  container.appendChild(list);
}

// ── Cards Table ───────────────────────────────────────────────
function renderCardsTable() {
  updateValueModeUI();

  const sorted = [...state.cards].sort((a, b) => {
    let va, vb;
    switch (state.sortKey) {
      case 'year1':     va = calcYear1(a);        vb = calcYear1(b);        break;
      case 'recurring': va = calcRecurring(a);     vb = calcRecurring(b);    break;
      case 'fee':       va = a.annualFee;          vb = b.annualFee;         break;
      case 'name':      va = a.name;               vb = b.name;              break;
      default:          va = calcYear1(a);         vb = calcYear1(b);
    }
    if (typeof va === 'string') return state.sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return state.sortDir === 'asc' ? va - vb : vb - va;
  });

  const tbody = document.getElementById('cards-tbody');
  tbody.innerHTML = '';

  sorted.forEach(card => {
    const year1 = calcYear1(card);
    const recurring = calcRecurring(card);
    const annualRewards = calcAnnualRewards(card);
    const currency = getCurrency(card.pointsCurrencyId);

    // ── Main row
    const tr = document.createElement('tr');
    tr.className = 'card-row';
    tr.dataset.cardId = card.id;
    if (state.expandedCard === card.id) tr.classList.add('expanded');

    const loungeBadge = card.loungeAccess ? `<span class="perk-tag gold">Lounge</span>` : '';
    const noFxBadge = !card.foreignTransactionFee ? `<span class="perk-tag green">No FX Fee</span>` : '';
    const globalBadge = card.globalEntryCredit ? `<span class="perk-tag">GE/PreCheck</span>` : '';

    tr.innerHTML = `
      <td class="card-name-cell">
        <div class="card-name-main">${card.name}</div>
        <div class="card-name-sub">
          <span class="issuer-badge">${card.issuer}</span>
          &nbsp;${card.network}
          ${card.membershipRequired ? '<span class="badge badge-red" style="margin-left:4px">Members Only</span>' : ''}
        </div>
      </td>
      <td class="fee-cell">${fmt(card.annualFee)}</td>
      <td><span class="${year1 >= 0 ? 'value-pos' : 'value-neg'}">${fmt(year1)}</span></td>
      <td><span class="${recurring >= 0 ? 'value-pos' : 'value-neg'}">${fmt(recurring)}</span></td>
      <td>
        <div style="font-size:12px">
          <span style="color:var(--text)">${fmt(annualRewards)}</span>
          <span style="color:var(--text-muted);font-size:10px;margin-left:4px">
            (${fmt(calcSpendRewards(card))} spend + ${fmt(calcCreditsValue(card))} credits)
          </span>
        </div>
      </td>
      <td>
        <div>${loungeBadge}${noFxBadge}${globalBadge}</div>
        <div style="margin-top:4px">${(card.perks || []).slice(0,3).map(p =>
          `<div style="font-size:11px;color:var(--text-muted);padding:1px 0">✓ ${p}</div>`
        ).join('')}
        ${card.perks?.length > 3 ? `<div style="font-size:10px;color:var(--accent);margin-top:2px">+${card.perks.length - 3} more…</div>` : ''}
        </div>
      </td>`;

    tr.addEventListener('click', () => toggleExpanded(card.id));
    tbody.appendChild(tr);

    // ── Expanded detail row
    const expandTr = document.createElement('tr');
    expandTr.className = 'expanded-row';
    expandTr.id = `expanded-${card.id}`;
    expandTr.style.display = state.expandedCard === card.id ? '' : 'none';

    const td = document.createElement('td');
    td.colSpan = 6;
    td.appendChild(buildDetailPanel(card));
    expandTr.appendChild(td);
    tbody.appendChild(expandTr);
  });

  // update sort icons
  document.querySelectorAll('#cards-table th[data-sort]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
    const icon = th.querySelector('.sort-icon');
    if (icon) {
      icon.textContent = th.dataset.sort === state.sortKey
        ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
    }
  });
}

function toggleExpanded(cardId) {
  state.expandedCard = state.expandedCard === cardId ? null : cardId;
  renderCardsTable();
}

function buildDetailPanel(card) {
  const panel = document.createElement('div');
  panel.className = 'card-detail-panel';

  // ── Credits section
  const creditsSection = document.createElement('div');
  creditsSection.className = 'detail-section';
  creditsSection.innerHTML = `<h3>Credits & Annual Benefits</h3>`;

  if (card.credits && card.credits.length > 0) {
    card.credits.forEach(credit => {
      const util = getUtilization(card, credit);
      const effectiveValue = credit.annualValue * util;
      const hasCardOverride = state.creditOverrides[card.id]?.[credit.id] !== undefined;
      const globalVal = credit.category ? state.globalCreditUtilization[credit.category] : null;
      const sourceClass = hasCardOverride ? 'card-override' : (globalVal !== null ? 'global' : 'default');
      const sourceLabel = hasCardOverride ? 'Card override' : (globalVal !== null ? 'Global rule' : 'Default');

      const item = document.createElement('div');
      item.className = 'credit-item';
      item.innerHTML = `
        <div class="credit-item-header">
          <span class="credit-item-name">${credit.name}${credit.oneTime ? ' <span style="font-size:10px;color:var(--text-muted)">(sign-up)</span>' : ''}</span>
          <span class="credit-item-value" id="credit-val-${card.id}-${credit.id}">${fmt(effectiveValue)}</span>
        </div>
        <div class="credit-item-desc">${credit.description}</div>
        ${!credit.oneTime ? `
        <div class="utilization-row">
          <span class="utilization-label">Face value: ${fmt(credit.annualValue)}</span>
          <span class="util-source ${sourceClass}">${sourceLabel}</span>
          <button class="util-reset" style="visibility:${hasCardOverride ? 'visible' : 'hidden'}"
                  data-card="${card.id}" data-credit="${credit.id}">reset</button>
          <input class="utilization-input" type="number" min="0" max="100" step="5"
                 value="${Math.round(util * 100)}"
                 data-card="${card.id}" data-credit="${credit.id}" />
          <span style="font-size:11px;color:var(--text-muted)">%</span>
        </div>` : ''}`;

      if (!credit.oneTime) {
        item.querySelector('.utilization-input').addEventListener('input', e => {
          const pct = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
          if (!state.creditOverrides[card.id]) state.creditOverrides[card.id] = {};
          state.creditOverrides[card.id][credit.id] = pct / 100;
          // update displayed value live without full re-render
          const valEl = document.getElementById(`credit-val-${card.id}-${credit.id}`);
          if (valEl) valEl.textContent = fmt(credit.annualValue * (pct / 100));
          // update table values
          refreshCardRowValues(card.id);
        });
        const resetBtn = item.querySelector('.util-reset');
        if (resetBtn) {
          resetBtn.addEventListener('click', () => {
            delete state.creditOverrides[card.id][credit.id];
            renderCardsTable();
          });
        }
      }
      creditsSection.appendChild(item);
    });
  } else {
    creditsSection.innerHTML += `<p style="font-size:12px;color:var(--text-muted)">No recurring credits on this card.</p>`;
  }

  // ── Earning rates section
  const earnSection = document.createElement('div');
  earnSection.className = 'detail-section';
  const cpp = getCpp(card.pointsCurrencyId);
  const currency = getCurrency(card.pointsCurrencyId);

  earnSection.innerHTML = `<h3>Earning Rates (${state.pointsMode === 'transfer' ? 'Transfer' : 'Cash Back'} Value @ ${currency?.name || ''})</h3>`;

  const earnGrid = document.createElement('div');
  earnGrid.className = 'earn-rate-grid';

  const maxRate = Math.max(...Object.entries(CATEGORY_META).map(([k]) => card.earningRates[k] ?? 0));

  Object.entries(CATEGORY_META).forEach(([key, meta]) => {
    const rate = card.earningRates[key] ?? 0;
    let dollarValue;
    if (rate === 0) {
      dollarValue = `<span style="color:var(--text-muted)">N/A</span>`;
    } else if (card.isCashBackCard) {
      dollarValue = `${rate}% back`;
    } else {
      dollarValue = `${rate}x = ${(rate * cpp * 100).toFixed(2)}¢/$`;
    }
    const isBest = rate > 0 && rate === maxRate;
    earnGrid.innerHTML += `
      <div class="earn-rate-item">
        <span class="earn-rate-label">${meta.icon} ${meta.label}</span>
        <span class="earn-rate-value ${isBest ? 'best' : ''}">${dollarValue}</span>
      </div>`;
  });

  if (card.earningRates.portalNotes) {
    earnGrid.innerHTML += `
      <div class="earn-rate-item" style="grid-column:1/-1">
        <span class="earn-rate-label">🌐 Portal Bonus</span>
        <span style="font-size:11px;color:var(--text-muted)">${card.earningRates.portalNotes}</span>
      </div>`;
  }
  earnSection.appendChild(earnGrid);

  // ── All perks
  const perksSection = document.createElement('div');
  perksSection.className = 'detail-section';
  perksSection.innerHTML = `<h3>All Perks & Benefits</h3>
    <ul class="perks-list">
      ${(card.perks || []).map(p => `<li>${p}</li>`).join('')}
    </ul>
    <div class="divider" style="margin:16px 0 12px"></div>
    <div class="calc-breakdown">
      <div class="line"><span>Sign-up Bonus Value</span><span>${fmt((card.signupBonus?.points || 0) * getCpp(card.pointsCurrencyId) + (card.signupBonus?.cashBonus || 0))}</span></div>
      ${calcOneTimeCreditsValue(card) > 0 ? `<div class="line"><span>One-time Sign-up Credits</span><span>${fmt(calcOneTimeCreditsValue(card))}</span></div>` : ''}
      <div class="line"><span>Annual Spend Rewards</span><span>${fmt(calcSpendRewards(card))}</span></div>
      <div class="line"><span>Annual Credits (adjusted)</span><span>${fmt(calcCreditsValue(card))}</span></div>
      <div class="line"><span>Annual Fee</span><span style="color:var(--red)">−${fmt(card.annualFee)}</span></div>
      <div class="line total"><span>Year 1 Net Return</span><span class="${calcYear1(card) >= 0 ? 'text-green' : 'text-red'}">${fmt(calcYear1(card))}</span></div>
      <div class="line total"><span>Recurring Net Return</span><span class="${calcRecurring(card) >= 0 ? 'text-green' : 'text-red'}">${fmt(calcRecurring(card))}</span></div>
    </div>
    ${card.signupBonus?.notes ? `<p style="font-size:10px;color:var(--text-muted);margin-top:8px">ℹ ${card.signupBonus.notes}</p>` : ''}
    ${card.membershipRequired ? `<p style="font-size:10px;color:var(--red);margin-top:6px">⚠ ${card.membershipRequired}</p>` : ''}
    ${'chase-sapphire-reserve,chase-sapphire-preferred'.includes(card.id) ? `
    <p style="font-size:10px;color:var(--text-muted);margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
      If you found this website helpful and decide to get the Chase Sapphire Reserve or Preferred,
      please consider using my
      <a href="https://www.referyourchasecard.com/19v/KK4S46MNMU" target="_blank" rel="noopener"
         style="color:var(--accent);text-decoration:underline">referral link</a>.
    </p>` : ''}`;

  panel.appendChild(creditsSection);
  panel.appendChild(earnSection);
  panel.appendChild(perksSection);
  return panel;
}

/** Refresh just the numeric values in a card row without rebuilding the whole table */
function refreshCardRowValues(cardId) {
  const card = state.cards.find(c => c.id === cardId);
  if (!card) return;
  renderCardsTable(); // simplest: just re-render; fast enough for <20 cards
}

function updateValueModeUI() {
  document.querySelectorAll('.toggle-btn[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.pointsMode);
  });
}

// ── Points Tab ────────────────────────────────────────────────
function renderPointsTab() {
  const grid = document.getElementById('valuations-grid');
  grid.innerHTML = '';

  state.currencies.forEach(cur => {
    const div = document.createElement('div');
    div.className = 'valuation-card';
    const hasTransfers = cur.transferPartners && cur.transferPartners.length > 0;
    div.innerHTML = `
      <div class="valuation-header">
        <div>
          <div class="valuation-name">${cur.name}</div>
          <div class="valuation-issuer">${cur.issuer}</div>
        </div>
      </div>
      <div class="valuation-values">
        <div class="cpp-block">
          <div class="cpp-label">Cash Back</div>
          <div class="cpp-value cash">${cur.cashbackCpp}¢</div>
          <div class="cpp-unit">per point</div>
        </div>
        <div class="cpp-block">
          <div class="cpp-label">Transfer (best)</div>
          <div class="cpp-value transfer">${cur.transferCpp}¢</div>
          <div class="cpp-unit">per point</div>
        </div>
      </div>
      <p class="valuation-notes">${cur.notes}</p>
      ${hasTransfers ? `
      <details class="transfer-partners">
        <summary>▸ ${cur.transferPartners.length} Transfer Partners</summary>
        <div class="partners-list">
          ${cur.transferPartners.map(p => `<span class="partner-chip">${p}</span>`).join('')}
        </div>
      </details>` : ''}`;
    grid.appendChild(div);
  });
}

// ── Wire up static controls (table sort, mode toggle) ─────────
document.addEventListener('DOMContentLoaded', () => {
  // Sort headers
  document.querySelectorAll('#cards-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      if (state.sortKey === th.dataset.sort) {
        state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        state.sortKey = th.dataset.sort;
        state.sortDir = 'desc';
      }
      renderCardsTable();
    });
  });

  // Value mode toggle
  document.querySelectorAll('.toggle-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.pointsMode = btn.dataset.mode;
      renderCardsTable();
      renderPointsTab();
    });
  });

  init();
});
