/* Peso Passbook — app logic. Data lives in your Google Sheet; this device keeps a cached copy
   plus a queue of changes, so entries save instantly even with no signal and upload later. */
(() => {
'use strict';

/* ================= constants ================= */
const TYPE_LABEL = {expense:'Expense', income:'Income', loan:'Loan payment', savings:'Savings deposit', withdrawal:'Savings withdrawal', transfer:'Transfer'};
const TYPE_SHORT = {expense:'Expense', income:'Income', loan:'Loan', savings:'Saved', withdrawal:'Withdrawn', transfer:'Transfer'};
const KIND_LABEL = {bill:'Bill', loan:'Loan', card:'Card statement', income:'Income', savings:'Savings'};
const PAY_KINDS = ['bill', 'loan', 'card'];
const MODES = [{id:'cash',label:'Cash'},{id:'card',label:'Card'},{id:'bank',label:'Bank'},{id:'ewallet',label:'E-wallet'}];
const MODE_LABEL = {cash:'Cash',card:'Card',bank:'Bank',ewallet:'E-wallet'};
const ADD_ACCT = {cash:'+ Add cash pouch',card:'+ Add card',bank:'+ Add bank',ewallet:'+ Add e-wallet'};
const ACCT_PH = {cash:'e.g. Wallet',card:'e.g. BPI Credit Card',bank:'e.g. BDO Savings',ewallet:'e.g. GCash'};
const FREQ = [
  {id:'monthly',label:'Monthly',f:1},{id:'semimonthly',label:'Every cut-off (twice a month)',f:2},
  {id:'weekly',label:'Weekly',f:52/12},{id:'biweekly',label:'Every 2 weeks',f:26/12},
  {id:'quarterly',label:'Quarterly',f:1/3},{id:'yearly',label:'Yearly',f:1/12}];
const FREQ_BY = Object.fromEntries(FREQ.map(f => [f.id, f]));
const FREQ_SHORT = {monthly:'Monthly',semimonthly:'Every cut-off',weekly:'Weekly',biweekly:'Every 2 weeks',quarterly:'Quarterly',yearly:'Yearly'};
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const ESSENTIAL = ['Bills & utilities','Housing','Health','Transportation','Personal hygiene'];
const SEMI_ESSENTIAL = ['Food'];
const GENERAL_SAVINGS = 'General savings';
const DEFAULT_SETTINGS = {
  currency:'₱',
  accounts:[{name:'Cash',type:'cash'}],
  budgets:{},
  categories:{
    expense:[
      {name:'Food',subs:['Groceries','Dining out','Coffee & snacks','Food delivery']},
      {name:'Transportation',subs:['Commute','Grab / taxi','Fuel','Parking & tolls']},
      {name:'Personal hygiene',subs:['Toiletries','Haircut & grooming','Laundry']},
      {name:'Bills & utilities',subs:['Electricity','Water','Internet','Mobile load / postpaid']},
      {name:'Housing',subs:['Rent','Association dues','Repairs']},
      {name:'Health',subs:['Medicine','Checkups']},
      {name:'Shopping',subs:['Clothes','Household items']},
      {name:'Leisure',subs:['Movies & streaming','Travel','Hobbies']},
      {name:'Family & giving',subs:['Allowance','Gifts','Donations']},
      {name:'Miscellaneous',subs:[]}],
    income:[
      {name:'Salary',subs:['Regular pay','13th month','Bonus']},
      {name:'Side hustle',subs:['Freelance','Online selling','Commissions']},
      {name:'Other income',subs:['Refunds','Gifts','Interest','Loan proceeds']}],
    loan:[
      {name:'Personal loan',subs:[]},
      {name:'Credit card',subs:['Installment','Statement balance']},
      {name:'Government loan',subs:['SSS','Pag-IBIG']},
      {name:'Car loan',subs:[]},
      {name:'Housing loan',subs:[]},
      {name:'Family & friends',subs:[]}]
  }
};

/* ================= helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const ds = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const pd = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const todayStr = () => ds(new Date());
const addDays = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return ds(d); };
const monthEnd = mk => { const [y, m] = mk.split('-').map(Number); return ds(new Date(y, m, 0)); };
const shiftMonth = (mk, n) => { const [y, m] = mk.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); };
const monthLabel = mk => { const [y, m] = mk.split('-').map(Number); return MONTH_FULL[m - 1] + ' ' + y; };
const monthShort = mk => { const [y, m] = mk.split('-').map(Number); return MON[m - 1] + ' ' + String(y).slice(2); };
const monthName = mk => MONTH_FULL[+mk.slice(5) - 1];
const fmtDay = s => { const d = pd(s); return WD[d.getDay()] + ', ' + d.getDate() + ' ' + MON[d.getMonth()]; };
const fmtShort = s => { const d = pd(s); return d.getDate() + ' ' + MON[d.getMonth()]; };
const fmtMonYr = s => { const d = pd(s); return MON[d.getMonth()] + ' ' + d.getFullYear(); };
const fmtFull = s => { const d = pd(s); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); };
const dim = (y, m) => new Date(y, m + 1, 0).getDate();
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => { const n = parseFloat(String(v ?? '').replace(/[,\s₱$]/g, '')); return isFinite(n) ? n : NaN; };
const clone = o => JSON.parse(JSON.stringify(o));
const kindToType = k => ({income:'income', loan:'loan', savings:'savings'}[k] || 'expense');
const isOut = t => t === 'expense' || t === 'loan';
const isSave = t => t === 'savings' || t === 'withdrawal';
/* entry type a recurring item produces. A credit card statement is a transfer from the bank to the card when
   the card's purchases are already logged one by one (so spending isn't counted twice), otherwise a loan payment. */
const recType = r => r.kind === 'card' ? (r.cardLogged === false ? 'loan' : 'transfer') : kindToType(r.kind);
const isStatement = r => r.kind === 'card' || ((r.kind === 'bill' || r.kind === 'loan') && !!r.variable);
const round50 = n => Math.max(0, Math.round(n / 50) * 50);
const floor50 = n => Math.max(0, Math.floor(n / 50) * 50);
const cur = () => settings().currency || '₱';
const money = n => cur() + Math.abs(n || 0).toLocaleString('en-PH', {minimumFractionDigits:2, maximumFractionDigits:2});
const money0 = n => cur() + Math.round(Math.abs(n || 0)).toLocaleString('en-PH');
const sgn = n => (n < 0 ? '−' : '');
const compact = n => { const a = Math.abs(n); return a >= 1e6 ? (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n)); };
const signed = (n, t) => (t === 'transfer' ? '⇄ ' : t === 'income' || t === 'withdrawal' ? '+' : '−') + money(n);
const amtClass = t => t === 'transfer' ? 'xfer' : t === 'income' || t === 'withdrawal' ? 'in' : isSave(t) ? 'save' : 'out';
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const lsJSON = (k, d) => { try { const v = JSON.parse(lsGet(k)); return v == null ? d : v; } catch (e) { return d; } };

/* ================= state ================= */
const cfg = lsJSON('pp.cfg', {url:'', token:''});
let outbox = lsJSON('pp.outbox', []);
const cache = lsJSON('pp.cache', null);
const S = {
  data: {entries:{}, recurring:{}, goals:{}, settings:{}},
  sheetUrl: cache && cache.sheetUrl || '',
  lastSync: cache && cache.syncedAt || 0,
  sync: 'idle', syncError: '', syncing: false, loadedOnce: !!cache,
  tab: ['home','entries','bills','income','insights','settings'].includes(lsGet('pp.tab')) ? lsGet('pp.tab') : 'home',
  month: todayStr().slice(0, 7),
  f: {type:'all', status:'all', account:'all', cat:'all', q:''},
  setType: 'expense', confirmKey: null, showAllDue: false, coOff: 0, openAcct: '', showAllActivity: false,
  serverVersion: cache && cache.serverVersion || 0,
  sheet: null
};
if (cache) {
  for (const t of ['entries','recurring','goals']) for (const r of cache[t] || []) if (r && r.id) S.data[t][r.id] = r;
  S.data.settings = cache.settings || {};
}
outbox.forEach(applyLocal);

function settings(){
  const s = S.data.settings || {};
  return {
    currency: s.currency || DEFAULT_SETTINGS.currency,
    accounts: Array.isArray(s.accounts) ? s.accounts : DEFAULT_SETTINGS.accounts,
    budgets: s.budgets && typeof s.budgets === 'object' ? s.budgets : {},
    categories: Object.assign({expense:[], income:[], loan:[]}, s.categories && typeof s.categories === 'object' ? s.categories : DEFAULT_SETTINGS.categories),
    leadDays: s.leadDays != null && s.leadDays !== '' && isFinite(+s.leadDays) ? Math.max(0, Math.min(15, +s.leadDays)) : 2,
    salaryAccount: s.salaryAccount || ''
  };
}

/* ================= local data ops + sync ================= */
function applyLocal(op){
  if (!op) return;
  if (op.op === 'settings') { S.data.settings = Object.assign({}, S.data.settings, op.value); return; }
  const tbl = S.data[op.table]; if (!tbl) return;
  if (op.op === 'upsert' && op.row && op.row.id) tbl[op.row.id] = op.row;
  if (op.op === 'delete') delete tbl[op.id];
}
function persist(){
  lsSet('pp.outbox', JSON.stringify(outbox));
  lsSet('pp.cache', JSON.stringify({
    entries:Object.values(S.data.entries), recurring:Object.values(S.data.recurring), goals:Object.values(S.data.goals),
    settings:S.data.settings, sheetUrl:S.sheetUrl, syncedAt:S.lastSync, serverVersion:S.serverVersion}));
}
function queue(op){
  op.opId = uid('o');
  applyLocal(op);
  outbox.push(op);
  persist(); render(); renderSync();
  flush();
}
const upsert = (table, row) => queue({op:'upsert', table, row:{...row, updatedAt:Date.now()}});
const remove = (table, id) => queue({op:'delete', table, id});
const saveSettings = value => queue({op:'settings', value});

async function api(body){
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(cfg.url, {method:'POST', redirect:'follow', signal:ctrl.signal,
      headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify({...body, token:cfg.token})});
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (e) { throw {error: /<html/i.test(text) ? 'not_webapp' : 'bad_response'}; }
    return json;
  } catch (e) {
    if (e && e.error) throw e;
    throw {error: e && e.name === 'AbortError' ? 'timeout' : 'network'};
  } finally { clearTimeout(t); }
}
function applyServer(data){
  const d = {entries:{}, recurring:{}, goals:{}, settings:data.settings || {}};
  for (const t of ['entries','recurring','goals']) for (const r of data[t] || []) if (r && r.id) d[t][r.id] = r;
  S.data = d;
  S.sheetUrl = data.sheetUrl || S.sheetUrl;
  S.serverVersion = data.version || 1;
  outbox.forEach(applyLocal);
}
let retryT = null;
async function flush(){
  if (S.syncing) { S.again = true; return; }
  if (!cfg.url || !cfg.token) { S.sync = 'setup'; renderSync(); return; }
  if (navigator.onLine === false) { S.sync = 'offline'; renderSync(); return; }
  S.syncing = true; S.again = false; S.sync = 'busy'; renderSync();
  clearTimeout(retryT);
  try {
    const batch = outbox.slice(0, 40);
    const res = await api(batch.length ? {action:'batch', ops:batch} : {action:'load'});
    if (!res || !res.ok) throw {error: res && res.error || 'bad_response'};
    if (batch.length) { const ids = new Set(batch.map(o => o.opId)); outbox = outbox.filter(o => !ids.has(o.opId)); }
    applyServer(res.data || {});
    S.lastSync = Date.now(); S.loadedOnce = true; S.sync = 'ok'; S.syncError = '';
    const st = S.data.settings || {};
    if (!st.categories && !outbox.some(o => o.op === 'settings')) {
      S.syncing = false;
      queue({op:'settings', value:{currency:DEFAULT_SETTINGS.currency, accounts:DEFAULT_SETTINGS.accounts, categories:DEFAULT_SETTINGS.categories, budgets:{}}});
      return;
    }
    persist();
    S.syncing = false;
    render(); renderSync();
    if (outbox.length || S.again) flush();
  } catch (e) {
    S.syncing = false;
    S.sync = e.error === 'unauthorized' ? 'auth' : 'err';
    S.syncError = e.error || 'network';
    renderSync(); if (S.tab === 'settings') render();
    if (S.sync !== 'auth') retryT = setTimeout(flush, 20000);
  }
}
function renderSync(){
  const el = $('#sync'); if (!el) return;
  const n = outbox.length;
  const map = {
    setup: ['warn', n ? `${n} on this device` : 'Connect sheet'],
    offline: ['warn', n ? `${n} waiting · offline` : 'Offline'],
    busy: ['busy', 'Syncing…'],
    ok: [n ? 'busy' : 'ok', n ? `${n} to upload` : 'Synced'],
    err: ['err', n ? `${n} waiting · retrying` : 'Sync problem'],
    auth: ['err', 'Check secret key'],
    idle: ['', cfg.url ? 'Starting…' : 'Connect sheet']
  };
  const [cls, label] = map[S.sync] || map.idle;
  el.className = 'sync ' + cls;
  el.querySelector('span').textContent = label;
}

/* ================= derivation ================= */
function derive(){
  const entries = Object.values(S.data.entries).filter(e => e && e.date && e.type);
  const logged = new Set(), linked = {}, byMonth = {};
  for (const e of entries) {
    if (e.recurringId) {
      (linked[e.recurringId] = linked[e.recurringId] || []).push(e);
      if (e.dueKey) logged.add(e.recurringId + '|' + e.dueKey);
    }
    const mk = e.date.slice(0, 7);
    const b = byMonth[mk] = byMonth[mk] || {in:0, spent:0, loans:0, saved:0, withdrawn:0, pendIn:0, pendOut:0, count:0};
    const a = +e.amount || 0; b.count++;
    if (e.status !== 'paid') { if (e.type === 'income') b.pendIn += a; else if (isOut(e.type) || (e.type === 'transfer' && e.recurringId)) b.pendOut += a; continue; }
    if (e.type === 'income') b.in += a; else if (e.type === 'expense') b.spent += a; else if (e.type === 'loan') b.loans += a;
    else if (e.type === 'savings') b.saved += a; else if (e.type === 'withdrawal') b.withdrawn += a;
  }
  for (const b of Object.values(byMonth)) { b.out = b.spent + b.loans; b.netSaved = b.saved - b.withdrawn; b.left = b.in - b.out - b.netSaved; }
  return {entries, logged, linked, byMonth, recs:Object.values(S.data.recurring), goals:Object.values(S.data.goals)};
}
const emptyMonth = () => ({in:0, spent:0, loans:0, saved:0, withdrawn:0, pendIn:0, pendOut:0, count:0, out:0, netSaved:0, left:0});

/* all scheduled dates of a recurring item from its start up to `limitTo` */
function occList(r, limitTo){
  const out = [];
  if (!r || !r.start) return out;
  const start = pd(r.start), end = pd(limitTo);
  const max = r.terms > 0 ? Math.max(0, r.terms - (r.paidBefore || 0)) : Infinity;
  const push = d => { if (d > end || out.length >= max) return false; out.push(ds(d)); return true; };
  let guard = 0;
  if (r.freq === 'weekly' || r.freq === 'biweekly') {
    const step = r.freq === 'weekly' ? 7 : 14;
    let d = new Date(start);
    while (guard++ < 3000) { if (!push(d)) break; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step); }
  } else {
    const stepM = {monthly:1, semimonthly:1, quarterly:3, yearly:12}[r.freq] || 1;
    const d1 = r.day1 || start.getDate();
    const days = r.freq === 'semimonthly' ? [d1, r.day2 || 30].sort((a, b) => a - b) : [d1];
    let y = start.getFullYear(), m = start.getMonth();
    outer: while (guard++ < 3000) {
      for (const dd of days) {
        const d = new Date(y, m, Math.min(dd, dim(y, m)));
        if (d < start) continue;
        if (!push(d)) break outer;
      }
      m += stepM; if (m > 11) { y += Math.floor(m / 12); m = m % 12; }
    }
  }
  return out;
}
const occIn = (r, mk) => occList(r, monthEnd(mk)).filter(o => o.startsWith(mk));
function recInfo(r, D){
  const today = todayStr();
  const lk = D.linked[r.id] || [];
  const paidTracked = lk.filter(e => e.status === 'paid').length;
  let terms = null, paid = null, left = null, leftAmt = null, last = null, done = false;
  if (r.terms > 0) {
    terms = r.terms; paid = Math.min(terms, (r.paidBefore || 0) + paidTracked); left = terms - paid;
    leftAmt = left * (+r.amount || 0);
    const all = occList(r, '2199-12-31'); last = all.length ? all[all.length - 1] : null; done = left <= 0;
  }
  let next = null;
  if (!done) next = occList(r, addDays(today, 400)).find(o => !D.logged.has(r.id + '|' + o)) || null;
  return {next, terms, paid, left, leftAmt, last, done, overdue: !!(next && next < today)};
}
function attention(D){
  const today = todayStr(), from = addDays(today, -60);
  const me = monthEnd(today.slice(0, 7)), soon = addDays(today, 10);
  const to = me > soon ? me : soon;
  const items = [];
  for (const e of D.entries) if (e.status === 'pending') items.push({kind:'pending', date:e.date, e});
  for (const r of D.recs) {
    if (r.active === false) continue;
    if (recInfo(r, D).done) continue;
    for (const o of occList(r, to)) if (o >= from && !D.logged.has(r.id + '|' + o)) items.push({kind:'due', date:o, r});
  }
  items.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return items;
}
function goalInfo(g, D){
  const today = todayStr();
  const lk = D.entries.filter(e => e.goalId === g.id && e.status === 'paid' && isSave(e.type));
  let saved = +g.startAmount || 0;
  for (const e of lk) saved += e.type === 'withdrawal' ? -(+e.amount || 0) : (+e.amount || 0);
  const target = +g.target || 0;
  const remaining = Math.max(0, target - saved);
  const done = target > 0 && remaining <= 0;
  const daysLeft = g.targetDate ? Math.round((pd(g.targetDate) - pd(today)) / 86400000) : null;
  const monthsLeft = daysLeft == null ? null : Math.max(0.5, daysLeft / 30.44);
  const needMonth = !done && monthsLeft ? remaining / monthsLeft : 0;
  const plan = D.recs.filter(r => r.kind === 'savings' && r.goalId === g.id && r.active !== false)
    .reduce((s, r) => s + (+r.amount || 0) * (FREQ_BY[r.freq]?.f || 1), 0);
  const since = addDays(today, -90);
  const hist = lk.filter(e => e.date >= since).reduce((s, e) => s + (e.type === 'withdrawal' ? -e.amount : +e.amount), 0) / 3;
  const pace = plan > 0 ? plan : Math.max(0, hist);
  const paceFrom = plan > 0 ? 'plan' : hist > 0 ? 'history' : 'none';
  const etaMonths = done ? 0 : pace > 0 ? remaining / pace : null;
  const eta = etaMonths != null ? addDays(today, Math.round(etaMonths * 30.44)) : null;
  const onTrack = done || (needMonth > 0 && pace >= needMonth * 0.98);
  return {saved, target, remaining, done, pct: target ? Math.min(100, saved / target * 100) : 0, daysLeft, monthsLeft, needMonth,
    needCutoff: needMonth / 2, pace, paceFrom, plan, eta, onTrack, late: daysLeft != null && daysLeft < 0 && !done};
}
function savingsBalance(D){
  let total = 0;
  for (const g of D.goals) total += +g.startAmount || 0;
  for (const e of D.entries) if (e.status === 'paid') { if (e.type === 'savings') total += +e.amount || 0; if (e.type === 'withdrawal') total -= +e.amount || 0; }
  return total;
}
function dueInMonth(D, mk, kinds){
  let sum = 0;
  for (const r of D.recs) {
    if (r.active === false || !kinds.includes(r.kind)) continue;
    for (const o of occIn(r, mk)) if (!D.logged.has(r.id + '|' + o)) sum += +r.amount || 0;
  }
  return sum;
}

/* ================= cut-off plan =================
   Each payday ("cut-off") you move money into the bank(s) you pay bills from.
   A bill is funded at the last payday that is at least `leadDays` before its due date
   (or split across the paydays in the month before it, if set to split). */
const acctInfo = n => settings().accounts.find(a => a.name === n) || null;
function steadyIncome(D){ return D.recs.filter(r => r.kind === 'income' && !r.variable && r.active !== false); }
function salaryAcct(D){ const st = settings(); if (st.salaryAccount) return st.salaryAccount; const r = steadyIncome(D)[0]; return r ? acctName(r) : ''; }
function paydayList(D, from, to){
  const set = new Set();
  for (const r of steadyIncome(D)) for (const o of occList(r, to)) if (o >= from) set.add(o);
  const fallback = !set.size;
  if (fallback) { let mk = from.slice(0, 7), g = 0; while (mk <= to.slice(0, 7) && g++ < 24) { for (const o of [mk + '-15', monthEnd(mk)]) if (o >= from && o <= to) set.add(o); mk = shiftMonth(mk, 1); } }
  return {days:[...set].sort(), fallback};
}
function fundDays(due, mode, lead, days){
  if (!days.length) return [];
  const target = addDays(due, -lead);
  const elig = days.filter(p => p <= target);
  if (!elig.length) return [days[0]];
  if (mode === 'split') { const from = addDays(target, -30); const w = elig.filter(p => p > from); return w.length ? w : [elig[elig.length - 1]]; }
  return [elig[elig.length - 1]];
}
/* every paid movement in or out of one account, oldest first, with a running total */
function acctLedger(D, acct){
  const rows = [];
  for (const e of D.entries) {
    if (e.status !== 'paid') continue;
    const a = +e.amount || 0, rec = e.recurringId && S.data.recurring[e.recurringId];
    let delta = 0, label = '';
    if (e.type === 'transfer') {
      if (e.toAccount === acct) { delta = a; label = `Transfer in from ${e.account || '?'}`; }
      else if (e.account === acct) { delta = -a; label = rec ? `Paid ${rec.name}` : `Transfer out to ${e.toAccount || '?'}`; }
    } else if (e.account === acct) {
      delta = isOut(e.type) || e.type === 'savings' ? -a : a;
      label = rec ? `${delta < 0 ? 'Paid' : 'Received'} ${rec.name}` : `${e.category || TYPE_SHORT[e.type]}${e.sub ? ' · ' + e.sub : ''}`;
    }
    if (delta) rows.push({e, delta, label});
  }
  rows.sort((x, y) => x.e.date < y.e.date ? -1 : x.e.date > y.e.date ? 1 : (x.e.updatedAt || 0) - (y.e.updatedAt || 0));
  let run = 0; rows.forEach(r => { run += r.delta; r.run = run; });
  return rows;
}
function fundBalance(D, acct){ return (+(acctInfo(acct) || {}).opening || 0) + acctLedger(D, acct).reduce((s, r) => s + r.delta, 0); }
function cutoffPlan(D){
  const st = settings(), today = todayStr(), lead = st.leadDays;
  const {days, fallback} = paydayList(D, addDays(today, -75), addDays(today, 130));
  const from = addDays(today, -45), to = addDays(today, 110);
  const salary = salaryAcct(D);
  const alloc = [];
  for (const r of D.recs) {
    if (r.active === false || !PAY_KINDS.includes(r.kind)) continue;
    if (r.kind !== 'card' && r.mode === 'card') continue; // charged to a credit card: covered by that card's statement
    const info = recInfo(r, D), lk = D.linked[r.id] || [];
    for (const o of occList(r, to)) {
      if (o < from) continue;
      const e = lk.find(x => x.dueKey === o);
      if (info.done && !e) continue;
      const amt = e ? +e.amount || 0 : +r.amount || 0, due = e ? e.date : o;
      const status = e ? (e.status === 'paid' ? 'paid' : 'stmt') : isStatement(r) ? 'est' : 'fixed';
      const ps = fundDays(due, r.fund, lead, days);
      ps.forEach((p, k) => alloc.push({p, acct:(e && e.account) || acctName(r), name:r.name, amt:amt / ps.length, full:amt, split:ps.length > 1, part:k + 1, parts:ps.length,
        due, status, rid:r.id, occ:o, eid:e ? e.id : '', key:r.id + '|' + o}));
    }
  }
  for (const e of D.entries) {
    if (e.status !== 'pending' || e.recurringId || !isOut(e.type) || e.mode === 'card' || e.mode === 'cash') continue;
    fundDays(e.date, 'before', lead, days).forEach(p => alloc.push({p, acct:acctName(e), name:e.category + (e.sub ? ' · ' + e.sub : ''),
      amt:+e.amount || 0, full:+e.amount || 0, split:false, part:1, parts:1, due:e.date, status:'stmt', eid:e.id, key:e.id}));
  }
  let idx0 = 0; days.forEach((p, i) => { if (p <= today) idx0 = i; });
  const curP = days.filter(p => p <= today).pop() || '';
  const nextP = days.find(p => p > today) || '';
  const isTransferAcct = acct => { const ai = acctInfo(acct); return acct !== salary && !(ai && ai.type === 'cash') && acct !== 'Cash'; };
  /* what is in an account now, and which unpaid bills that money is already meant for
     (bills funded at this or an earlier cut-off that are not paid yet, even if they spill into later cut-offs) */
  const acctState = acct => {
    const ai = acctInfo(acct), opening = +(ai && ai.opening) || 0;
    const led = acctLedger(D, acct);
    const inSum = led.filter(r => r.delta > 0).reduce((s, r) => s + r.delta, 0);
    const outSum = -led.filter(r => r.delta < 0).reduce((s, r) => s + r.delta, 0);
    const available = opening + inSum - outSum;
    const byKey = {};
    for (const a of alloc) {
      if (a.acct !== acct || a.status === 'paid' || !curP || a.p > curP) continue;
      const w = byKey[a.key] = byKey[a.key] || {...a, amt:0, funded:0};
      w.amt += a.amt; w.funded++;
    }
    const waiting = Object.values(byKey).sort((a, b) => a.due < b.due ? -1 : 1);
    const reserved = waiting.reduce((s, w) => s + w.amt, 0);
    const upcoming = alloc.filter(a => a.acct === acct && a.status !== 'paid' && a.p === nextP).reduce((s, a) => s + a.amt, 0);
    return {acct, opening, led, inSum, outSum, available, waiting, reserved, free:available - reserved, upcoming, billPay:!!(ai && ai.billPay)};
  };
  const view = off => {
    const i = idx0 + off; if (i < 0 || i >= days.length - 1) return null;
    const p = days[i], next = days[i + 1], current = p === curP;
    const items = alloc.filter(a => a.p === p).sort((a, b) => a.due < b.due ? -1 : a.due > b.due ? 1 : 0);
    const carried = current ? alloc.filter(a => a.p < p && a.status !== 'paid') : [];
    const accts = [...new Set(items.map(a => a.acct).concat(carried.map(a => a.acct)))];
    const groups = accts.map(acct => {
      const its = items.filter(a => a.acct === acct);
      const keys = new Set(its.map(a => a.key));
      const carry = Object.values(carried.filter(a => a.acct === acct && !keys.has(a.key)).reduce((m, a) => { const w = m[a.key] = m[a.key] || {...a, amt:0}; w.amt += a.amt; return m; }, {}));
      const need = its.reduce((s, a) => s + a.amt, 0);
      const moved = D.entries.filter(e => e.type === 'transfer' && !e.recurringId && e.toAccount === acct && e.dueKey === p && e.status === 'paid').reduce((s, e) => s + (+e.amount || 0), 0);
      const ai = acctInfo(acct), transfer = isTransferAcct(acct);
      let remaining = Math.max(0, Math.round(need - moved)), state = null;
      if (current && transfer) { state = acctState(acct); remaining = Math.max(0, Math.round(state.reserved - state.available)); }
      return {acct, items:its, carry, need, moved, remaining, state, transfer, billPay:!!(ai && ai.billPay), cash:!transfer && acct !== salary};
    }).sort((a, b) => b.need - a.need);
    return {p, next, off, current, coversTo:addDays(next, lead - 1), groups, items, total:items.reduce((s, a) => s + a.amt, 0)};
  };
  const bankAccts = () => {
    const names = new Set(st.accounts.filter(a => a.billPay).map(a => a.name));
    D.entries.forEach(e => { if (e.type === 'transfer' && !e.recurringId && e.category === 'Cut-off transfer' && e.toAccount) names.add(e.toAccount); });
    alloc.forEach(a => { if (isTransferAcct(a.acct)) names.add(a.acct); });
    return [...names];
  };
  return {days, fallback, idx0, curP, nextP, view, lead, salary, alloc, acctState, bankAccts, any:alloc.length > 0};
}
function cutoffTitle(off){ return off === 0 ? 'This cut-off' : off === 1 ? 'Next cut-off' : off === -1 ? 'Last cut-off' : off > 1 ? `In ${off} cut-offs` : `${-off} cut-offs ago`; }
function statusTag(a){
  if (a.status !== 'paid' && a.due < todayStr()) return `<span class="pill out">Overdue${a.status === 'est' ? ' · no statement yet' : ''}</span>`;
  return a.status === 'paid' ? '<span class="pill in">Paid</span>' : a.status === 'stmt' ? '<span class="pill warn">Unpaid</span>' : a.status === 'est' ? '<span class="pill neutral">Estimate</span>' : '';
}
function coItem(a, extra){
  return `<button class="co-item" data-act="co-item" data-rid="${esc(a.rid || '')}" data-occ="${esc(a.occ || '')}" data-eid="${esc(a.eid || '')}">
    <span class="row-main"><span class="row-title" style="display:block;font-weight:400">${esc(a.name)}</span><span class="row-meta">Due ${esc(fmtShort(a.due))}${extra || (a.split ? ` · ${a.parts === 2 ? 'half' : `part ${a.part} of ${a.parts}`} of ${money0(a.full)}${a.part > 1 ? ', rest set aside earlier' : ''}` : '')} ${statusTag(a)}</span></span>
    <span class="amt-v">${a.status === 'est' ? '~' : ''}${money0(a.amt)}</span></button>`;
}
function coGroup(D, g, p){
  const s = g.state;
  const items = g.items.map(a => coItem(a)).join('');
  const carry = g.carry.length ? `<div class="lbl" style="margin-top:6px">Still unpaid from earlier cut-offs</div>` + g.carry.map(a => coItem(a, a.split ? ` · ${money0(a.amt)} set aside of ${money0(a.full)}` : '')).join('') : '';
  let foot;
  if (!g.transfer) foot = `<span class="hint">${g.cash ? 'Set this aside in cash' : 'Paid straight from your salary account, no transfer needed'}</span>`;
  else if (g.remaining <= 0) foot = `<span class="pill in">✓ Covered${s && s.free > 0.5 ? ` · ${money0(s.free)} extra in the account` : g.moved ? ` · ${money0(g.moved)} transferred` : ''}</span>`;
  else foot = `<span class="hint"><b style="color:var(--ink)">${money0(g.remaining)}</b> to transfer${s ? `<br>${money0(s.reserved)} of unpaid bills − ${money0(Math.max(0, s.available))} already in the account` : g.moved ? ` · ${money0(g.moved)} moved` : ''}</span><button class="btn sm primary" data-act="co-xfer" data-acct="${esc(g.acct)}" data-p="${p}" data-amt="${g.remaining}">Log transfer</button>`;
  return `<div class="co-group">
    <div class="co-top"><span class="co-acct">${esc(g.acct)}${g.billPay ? ' <span class="pill neutral">Bills account</span>' : ''}</span><span class="amt-v">${money0(g.need)}</span></div>
    ${items}${carry}
    <div class="co-foot">${foot}</div>
    ${s ? `<div class="hint">In this account now: <b style="color:var(--ink)">${sgn(s.available)}${money0(s.available)}</b> · <button class="lnk-inline" data-act="acct-focus" data-v="${esc(g.acct)}">see money in bills accounts</button></div>` : ''}
  </div>`;
}
function cutoffFull(D, CP){
  const nav = `<span style="display:flex;gap:2px"><button class="icon-btn" data-act="co-prev" aria-label="Earlier cut-off" style="width:32px;height:32px">‹</button><button class="icon-btn" data-act="co-next" aria-label="Later cut-off" style="width:32px;height:32px">›</button></span>`;
  let h = `<h2 class="sec">Cut-off plan ${nav}</h2>`;
  if (!CP.any) return h + emptyBox('Nothing to fund yet', 'Add your bills, credit cards and loans below with the bank you pay them from. Each payday, this shows how much to move to each bank.');
  const v = CP.view(S.coOff);
  if (!v) return h + emptyBox('No plan for that cut-off', 'Use the arrows to go back to this cut-off.');
  const salary = CP.salary;
  const moveTotal = v.groups.filter(g => g.transfer).reduce((s, g) => s + g.remaining, 0);
  h += `<div class="plan">
    <div class="co-head"><div><b class="co-title">${cutoffTitle(v.off)} · ${esc(fmtDay(v.p))}</b>
      <div class="hint">Covers bills due through ${esc(fmtDay(v.coversTo))}. Money is planned to be in place ${CP.lead} day${CP.lead === 1 ? '' : 's'} before each due date.</div></div>
      <span class="amt-v">${money0(v.total)}</span></div>
    ${CP.fallback ? `<div class="hint">Using the 15th and the end of the month as paydays. Add your salary under Income to use your real paydays.</div>` : ''}
    ${v.groups.length ? `<div class="eq"><span>To move${salary ? ` out of ${esc(salary)}` : ''}${v.current ? '<br><span class="hint">After counting what is already in each account</span>' : v.off > 0 ? '<br><span class="hint">Before counting leftovers; checked again on that payday</span>' : ''}</span><span class="amt-v ${moveTotal ? 'c-warn' : 'c-in'}">${moveTotal ? money0(moveTotal) : '✓ Done'}</span></div>` : ''}
    ${v.groups.map(g => coGroup(D, g, v.p)).join('') || '<div class="hint">No bills fall on this cut-off.</div>'}
    <div class="hint">~ is the usual amount until you enter the statement. Tap a bill to enter its statement or mark it paid.</div>
  </div>`;
  return h;
}
function cutoffMini(D, CP){
  if (!CP.any) return '';
  const v = CP.view(0); if (!v || !v.groups.length) return '';
  const rows = v.groups.map(g => {
    const right = !g.transfer ? `<span class="pill neutral">${g.cash ? 'Cash' : 'No transfer'}</span>`
      : g.remaining <= 0 ? `<span class="pill in">✓ Covered</span>`
      : `<span class="pill warn act" data-act="co-xfer" data-acct="${esc(g.acct)}" data-p="${v.p}" data-amt="${g.remaining}">Log transfer</span>`;
    const n = g.items.length + g.carry.length;
    return `<button class="row" data-act="tab" data-v="bills"><span class="dot transfer"></span>
      <span class="row-main"><span class="row-title" style="display:block">${esc(g.acct)}</span><span class="row-meta">${n} bill${n === 1 ? '' : 's'} to cover${g.state ? ` · ${money0(g.state.available)} in account` : ''}</span></span>
      <span class="row-end"><span class="amt-v">${money0(g.transfer ? g.remaining : g.need)}</span>${right}</span></button>`;
  }).join('');
  return `<h2 class="sec">This cut-off · ${esc(fmtShort(v.p))} <button class="lnk" data-act="tab" data-v="bills">Full plan</button></h2><div class="ledger">${rows}</div>`;
}

/* ---------- money sitting in bills accounts ---------- */
function acctCard(D, CP, acct){
  const s = CP.acctState(acct);
  const open = S.openAcct === acct;
  const waiting = s.waiting.map(w => coItem(w, w.parts > 1 ? (w.funded < w.parts ? ` · ${money0(w.amt)} set aside so far of ${money0(w.full)}` : ' · fully set aside across cut-offs') : ' ')).join('');
  const status = s.free >= -0.5
    ? `<span class="pill in">${s.waiting.length ? `✓ Enough · ${money0(s.free)} extra` : `${money0(s.free)} not set aside for anything`}</span>`
    : `<span class="pill out">Short ${money0(-s.free)} · top up</span>`;
  const rows = s.led.slice().reverse();
  const shown = S.showAllActivity ? rows : rows.slice(0, 8);
  const activity = open ? `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>What</th><th>Amount</th><th>Balance</th></tr></thead><tbody>` +
      (shown.map(r => `<tr><td>${esc(fmtShort(r.e.date))}</td><td style="text-align:left;font-family:var(--f-body);white-space:normal">${esc(r.label)}</td><td class="${r.delta > 0 ? 'c-in' : 'c-out'}">${r.delta > 0 ? '+' : '−'}${money0(Math.abs(r.delta))}</td><td>${sgn(r.run + s.opening)}${money0(r.run + s.opening)}</td></tr>`).join('') || `<tr><td colspan="4" style="text-align:left">No transfers or payments yet.</td></tr>`) +
      (s.opening ? `<tr><td></td><td style="text-align:left;font-family:var(--f-body)">Starting balance</td><td></td><td>${sgn(s.opening)}${money0(s.opening)}</td></tr>` : '') +
      `</tbody></table></div>${rows.length > 8 ? `<button class="btn sm ghost" data-act="toggle-activity">${S.showAllActivity ? 'Show fewer' : `Show all ${rows.length}`}</button>` : ''}` : '';
  return `<div class="card" id="acct-${esc(acct.replace(/[^A-Za-z0-9]/g, '_'))}">
    <div class="card-top">
      <div class="card-name">${esc(acct)}<span class="card-sub" style="display:block">${s.billPay ? 'Bills account' : 'Receives bill money'}</span></div>
      <div class="row-end"><span class="amt-v" style="font-size:18px">${sgn(s.available)}${money0(s.available)}</span><span class="card-sub">in the account now</span></div>
    </div>
    <div class="kv"><span>Transferred in <b>${money0(s.inSum)}</b></span><span>Paid out <b>${money0(s.outSum)}</b></span>${s.opening ? `<span>Starting balance <b>${sgn(s.opening)}${money0(s.opening)}</b></span>` : ''}</div>
    ${s.waiting.length ? `<div class="co-group"><div class="co-top"><span>Waiting to be paid from it</span><span class="amt-v">${money0(s.reserved)}</span></div>${waiting}</div>` : ''}
    ${s.upcoming ? `<div class="hint">Next cut-off (${esc(fmtShort(CP.nextP))}) adds about ${money0(s.upcoming)} more in bills.</div>` : ''}
    <div class="card-foot">${status}<span class="btn-row" style="gap:6px"><button class="btn sm ghost" data-act="acct-bal" data-v="${esc(acct)}">Match my bank</button><button class="btn sm" data-act="acct-open" data-v="${esc(acct)}">${open ? 'Hide activity' : 'Activity'}</button></span></div>
    ${activity}
  </div>`;
}
function billAcctsSection(D, CP){
  const accts = CP.bankAccts();
  let h = `<h2 class="sec">Money in bills accounts</h2>`;
  if (!accts.length) return h + emptyBox('No bills accounts yet', 'Mark the banks you transfer bill money into as Bills account in Settings, or log a cut-off transfer. You\'ll see what is in each one and what it is waiting to pay.');
  const tot = accts.map(a => CP.acctState(a));
  const sum = tot.reduce((s, x) => s + x.available, 0), res = tot.reduce((s, x) => s + x.reserved, 0);
  h += `<div class="tiles" style="margin-bottom:10px">
    <div class="tile"><span class="k">In bills accounts</span><span class="v">${sgn(sum)}${money0(sum)}</span><span class="s">Transfers in minus payments out</span></div>
    <div class="tile"><span class="k">Waiting to be paid</span><span class="v c-warn">${money0(res)}</span><span class="s">Unpaid bills already funded</span></div></div>`;
  return h + `<div class="cards">${accts.map(a => acctCard(D, CP, a)).join('')}</div>`;
}
function billAcctsMini(CP){
  const accts = CP.bankAccts(); if (!accts.length) return '';
  const rows = accts.map(a => {
    const s = CP.acctState(a);
    const pill = s.free >= -0.5 ? `<span class="pill in">${money0(s.free)} free</span>` : `<span class="pill out">Short ${money0(-s.free)}</span>`;
    return `<button class="row" data-act="acct-focus" data-v="${esc(a)}"><span class="dot transfer"></span>
      <span class="row-main"><span class="row-title" style="display:block">${esc(a)}</span><span class="row-meta">${money0(s.reserved)} waiting for ${s.waiting.length} bill${s.waiting.length === 1 ? '' : 's'}</span></span>
      <span class="row-end"><span class="amt-v">${sgn(s.available)}${money0(s.available)}</span>${pill}</span></button>`;
  }).join('');
  return `<h2 class="sec">Money in bills accounts <button class="lnk" data-act="acct-focus" data-v="">Details</button></h2><div class="ledger">${rows}</div>`;
}
function balSheet(){
  const d = S.sheet.data, D = derive();
  const opening = +(acctInfo(d.acct) || {}).opening || 0, tracked = fundBalance(D, d.acct);
  return `<div class="grab"></div>
  <div class="sheet-head"><h3>Match ${esc(d.acct)} to your bank</h3>${closeBtn}</div>
  <div class="preview">The app counts <b class="num">${sgn(tracked)}${money0(tracked)}</b> in this account${opening ? ` (including a starting balance of ${money0(opening)})` : ''}.</div>
  <div class="field"><label class="lbl" for="bal-actual">Balance shown in your bank app</label><input id="bal-actual" inputmode="decimal" data-bind="actual" value="${esc(d.actual)}" placeholder="0.00"></div>
  <div class="hint">Use this once when you start, or whenever money moved that you didn't log. The difference is saved as the account's starting balance, so every figure after this matches your bank.</div>
  <div class="sheet-actions"><button class="btn primary" data-act="bal-save">Save balance</button></div>`;
}

/* ================= insights engine ================= */
const maxCut = c => ESSENTIAL.includes(c) ? 0.10 : SEMI_ESSENTIAL.includes(c) ? 0.20 : 0.40;
function flexSpend(D, mk){
  const cat = {}, sub = {};
  for (const e of D.entries) {
    if (e.type !== 'expense' || e.recurringId || !e.date.startsWith(mk)) continue;
    const c = e.category || 'Uncategorized', a = +e.amount || 0;
    cat[c] = (cat[c] || 0) + a;
    if (e.sub) { const k = c + '›' + e.sub; sub[k] = (sub[k] || 0) + a; }
  }
  return {cat, sub};
}
function insightsCalc(D){
  const today = todayStr(), cm = today.slice(0, 7), nm = shiftMonth(cm, 1);
  const hist = [1, 2, 3].map(i => shiftMonth(cm, -i)).filter(mk => D.byMonth[mk] && D.byMonth[mk].count > 0);
  const avgCat = {}, avgSub = {};
  let avgIncome = 0, avgOut = 0, avgSaved = 0, basis = '', basisShort = '', noData = false;
  if (hist.length) {
    for (const mk of hist) {
      const f = flexSpend(D, mk), b = D.byMonth[mk];
      for (const [k, v] of Object.entries(f.cat)) avgCat[k] = (avgCat[k] || 0) + v / hist.length;
      for (const [k, v] of Object.entries(f.sub)) avgSub[k] = (avgSub[k] || 0) + v / hist.length;
      avgIncome += b.in / hist.length; avgOut += b.out / hist.length; avgSaved += b.netSaved / hist.length;
    }
    basis = hist.length === 1 ? `your spending in ${monthLabel(hist[0])}` : `your average over the last ${hist.length} months`;
    basisShort = hist.length === 1 ? monthShort(hist[0]) : `${hist.length}-month avg`;
  } else {
    const now = new Date(), day = now.getDate(), days = dim(now.getFullYear(), now.getMonth());
    const scale = days / Math.max(day, 1), f = flexSpend(D, cm), b = D.byMonth[cm] || emptyMonth();
    for (const [k, v] of Object.entries(f.cat)) avgCat[k] = v * scale;
    for (const [k, v] of Object.entries(f.sub)) avgSub[k] = v * scale;
    avgIncome = b.in; avgOut = b.out * scale; avgSaved = b.netSaved;
    basis = `this month so far (${day} day${day === 1 ? '' : 's'}), stretched to a full month`;
    basisShort = 'this month, projected';
    if (!Object.keys(f.cat).length) noData = true;
  }

  // next month: income, fixed commitments, savings
  const incomeRecs = D.recs.filter(r => r.kind === 'income' && r.active !== false);
  let expIncome = 0; const incomeItems = [];
  for (const r of incomeRecs) { const n = occIn(r, nm).length; if (n) { expIncome += n * (+r.amount || 0); incomeItems.push({name:r.name, amt:n * (+r.amount || 0), variable:r.variable}); } }
  let incomeSource = 'schedule';
  if (!expIncome && avgIncome) { expIncome = avgIncome; incomeSource = 'history'; }
  if (!expIncome) incomeSource = 'none';

  const fixedItems = [];
  let fixed = 0;
  for (const r of D.recs) {
    if (r.active === false || !(r.kind === 'bill' || r.kind === 'loan' || (r.kind === 'card' && r.cardLogged === false))) continue;
    const n = occIn(r, nm).length; if (!n) continue;
    fixed += n * (+r.amount || 0); fixedItems.push({name:r.name, amt:n * (+r.amount || 0), kind:r.kind});
  }

  const goals = D.goals.filter(g => g.active !== false).map(g => ({g, i:goalInfo(g, D)})).filter(x => !x.i.done);
  const goalNeed = goals.reduce((s, x) => s + x.i.needMonth, 0);
  const planSave = D.recs.filter(r => r.kind === 'savings' && r.active !== false).reduce((s, r) => s + occIn(r, nm).length * (+r.amount || 0), 0);
  let savingsTarget, savingsReason;
  if (goals.length) { savingsTarget = Math.max(goalNeed, planSave); savingsReason = goalNeed >= planSave ? 'what your goals need to finish on time' : 'your planned savings'; }
  else { savingsTarget = Math.max(planSave, expIncome * 0.2); savingsReason = planSave >= expIncome * 0.2 ? 'your planned savings' : '20% of income (the 50/30/20 guideline)'; }
  savingsTarget = Math.ceil(savingsTarget / 50) * 50;

  const flexBudget = expIncome - fixed - savingsTarget;
  const cats = Object.entries(avgCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const flexTotal = cats.reduce((s, [, v]) => s + v, 0);
  let rows = cats.map(([cat, avg]) => ({cat, avg, cap:round50(avg), cut:0}));
  let extra = 0, shortfall = 0;
  if (flexBudget >= flexTotal) {
    extra = flexBudget - rows.reduce((s, r) => s + r.cap, 0);
  } else {
    const need = flexTotal - Math.max(0, flexBudget);
    const capacity = rows.reduce((s, r) => s + r.avg * maxCut(r.cat), 0);
    const ratio = capacity > 0 ? Math.min(1, need / capacity) : 0;
    rows = rows.map(r => { const cap = round50(r.avg - r.avg * maxCut(r.cat) * ratio); return {...r, cap, cut:Math.max(0, r.avg - cap)}; });
    const capSum = rows.reduce((s, r) => s + r.cap, 0);
    shortfall = Math.max(0, capSum - Math.max(0, flexBudget));
    if (shortfall < 200) shortfall = 0; // rounding noise
  }
  // if short even after cuts: how much can really be saved, and when would goals finish
  let realistic = null;
  if (shortfall > 0 && expIncome > 0) {
    const canSave = Math.max(0, expIncome - fixed - rows.reduce((s, r) => s + r.cap, 0));
    const remainingAll = goals.reduce((s, x) => s + x.i.remaining, 0);
    realistic = {canSave, finish: canSave > 0 && remainingAll > 0 ? addDays(today, Math.round(remainingAll / canSave * 30.44)) : null};
  }
  return {cm, nm, hist, basis, basisShort, noData, avgIncome, avgOut, avgSaved, expIncome, incomeSource, incomeItems,
    fixed, fixedItems, goals, goalNeed, planSave, savingsTarget, savingsReason, flexBudget, flexTotal, rows, extra, shortfall, realistic, avgSub};
}
function tipsCalc(D, P){
  const tips = [];
  const today = todayStr(), cm = P.cm, now = new Date(), day = now.getDate(), days = dim(now.getFullYear(), now.getMonth());
  const b = D.byMonth[cm] || emptyMonth();
  const st = settings();
  // 1 savings rate
  if (b.in > 0) {
    const rate = b.netSaved / b.in * 100;
    if (rate >= 20) tips.push({lvl:'good', ic:'✓', t:`You've saved ${rate.toFixed(0)}% of this month's income`, p:`That's at or above the 20% guideline. ${money0(b.netSaved)} saved from ${money0(b.in)} received.`});
    else tips.push({lvl:'warn', ic:'%', t:`Savings rate this month: ${rate.toFixed(0)}%`, p:`To reach 20%, set aside ${money0(Math.max(0, b.in * 0.2 - b.netSaved))} more from what you've received so far.`});
  }
  // 2 goals
  for (const {g, i} of P.goals) {
    if (i.late) tips.push({lvl:'bad', ic:'!', t:`${g.name} passed its target date`, p:`${money0(i.remaining)} still to go. Pick a new date in Income → Savings goals so the plan can pace it again.`});
    else if (!i.onTrack && i.needMonth > 0) tips.push({lvl:'warn', ic:'↗', t:`${g.name} needs ${money0(i.needCutoff)} per cut-off`, p:`That's ${money0(i.needMonth)} a month to reach ${money0(i.target)} by ${fmtFull(g.targetDate)}. ${i.pace > 0 ? `At your current ${money0(i.pace)} a month you'd finish around ${fmtMonYr(i.eta)}.` : `You haven't saved toward it in the last 3 months.`}`});
    else if (i.onTrack) tips.push({lvl:'good', ic:'✓', t:`${g.name} is on track`, p:`${money0(i.pace)} a month gets you to ${money0(i.target)} around ${i.eta ? fmtMonYr(i.eta) : 'on time'}.`});
  }
  if (!D.goals.length) {
    const monthly = P.avgOut || P.fixed;
    tips.push({lvl:'idea', ic:'+', t:'Set up an emergency fund goal', p: monthly ? `A common target is 3 to 6 months of expenses: about ${money0(monthly * 3)} to ${money0(monthly * 6)} for you. Add it under Income → Savings goals.` : 'A common target is 3 to 6 months of expenses. Add it under Income → Savings goals.'});
  }
  // 3 spending pace this month
  const f = flexSpend(D, cm), spentFlex = Object.values(f.cat).reduce((s, v) => s + v, 0);
  if (P.hist.length && spentFlex > 0 && day >= 5) {
    const proj = spentFlex / day * days, avg = P.flexTotal;
    if (avg > 0) {
      const diff = (proj - avg) / avg * 100;
      if (diff > 10) tips.push({lvl:'warn', ic:'↑', t:`Day-to-day spending is running ${diff.toFixed(0)}% above normal`, p:`At this pace you'll spend about ${money0(proj)} this month versus your usual ${money0(avg)}.`});
      else if (diff < -10) tips.push({lvl:'good', ic:'↓', t:`Day-to-day spending is ${Math.abs(diff).toFixed(0)}% below normal`, p:`On pace for about ${money0(proj)} versus your usual ${money0(avg)}. Consider moving the difference to savings.`});
    }
  }
  // 4 budgets
  const budgets = st.budgets || {};
  for (const [cat, cap] of Object.entries(budgets)) {
    if (!(cap > 0)) continue;
    const spent = f.cat[cat] || 0;
    if (spent > cap) tips.push({lvl:'bad', ic:'!', t:`${cat} is over budget`, p:`${money0(spent)} spent against a ${money0(cap)} budget this month.`});
    else if (day < days && spent / day * days > cap * 1.05 && spent > cap * 0.5) tips.push({lvl:'warn', ic:'→', t:`${cat} may go over budget`, p:`${money0(spent)} of ${money0(cap)} used with ${days - day} days left.`});
  }
  // 5 biggest change between the last two complete months
  const m1 = shiftMonth(cm, -1), m2 = shiftMonth(cm, -2);
  if (D.byMonth[m1] && D.byMonth[m2]) {
    const a = flexSpend(D, m1).cat, bb = flexSpend(D, m2).cat;
    let best = null;
    for (const k of Object.keys(a)) { const inc = a[k] - (bb[k] || 0); if (inc > 500 && (!best || inc > best.inc)) best = {k, inc, now:a[k], before:bb[k] || 0}; }
    if (best) tips.push({lvl:'warn', ic:'↑', t:`${best.k} went up ${money0(best.inc)} in ${monthName(m1)}`, p:`${money0(best.before)} in ${monthName(m2)} → ${money0(best.now)} in ${monthName(m1)}.`});
  }
  // 6 biggest discretionary subcategory
  const subs = Object.entries(P.avgSub).filter(([k]) => !ESSENTIAL.includes(k.split('›')[0]) && !['Food›Groceries','Housing›Rent'].includes(k)).sort((x, y) => y[1] - x[1]);
  if (subs.length && subs[0][1] >= 1000) {
    const [k, v] = subs[0], [c, s] = k.split('›');
    tips.push({lvl:'idea', ic:'½', t:`${s} is your biggest flexible expense`, p:`About ${money0(v)} a month (${c}). Cutting it in half frees ${money0(v / 2)} a month, or ${money0(v * 6)} a year.`});
  }
  // 7 loans ending soon
  for (const r of D.recs) {
    if (r.kind !== 'loan' || r.active === false) continue;
    const i = recInfo(r, D);
    if (!i.done && i.last && i.left > 0 && i.last <= addDays(today, 100)) {
      const perMonth = (+r.amount || 0) * (FREQ_BY[r.freq]?.f || 1);
      tips.push({lvl:'idea', ic:'→', t:`${r.name} ends ${fmtMonYr(i.last)}`, p:`That frees ${money0(perMonth)} a month. Redirect it to ${P.goals[0] ? P.goals[0].g.name : 'savings'} so it doesn't disappear into spending.`});
    }
  }
  // 8 unpaid / overdue
  const overdue = attention(D).filter(x => x.date < today && x.kind === 'due' && x.r.kind !== 'income' && x.r.kind !== 'savings');
  if (overdue.length) tips.push({lvl:'bad', ic:'!', t:`${overdue.length} overdue payment${overdue.length === 1 ? '' : 's'}`, p:overdue.slice(0, 3).map(x => `${x.r.name} (${fmtShort(x.date)})`).join(', ') + '. Late fees add up; log them once paid.'});
  const CP = cutoffPlan(D), v0 = CP.view(0);
  if (v0) {
    const need = v0.groups.filter(g => g.transfer && g.remaining > 0);
    if (need.length) tips.unshift({lvl:'warn', ic:'⇄', t:`Move ${money0(need.reduce((s, g) => s + g.remaining, 0))} to your bill accounts this cut-off`, p:need.map(g => `${g.acct}: ${money0(g.remaining)}`).join(' · ') + `. Covers bills due through ${fmtShort(v0.coversTo)}.`});
  }
  const loads = [0, 1, 2, 3].map(i => CP.view(i)).filter(Boolean);
  if (loads.length >= 2) {
    const tot = loads.map(x => x.total), hi = Math.max(...tot), lo = Math.min(...tot);
    if (hi > 0 && (lo === 0 || hi / lo > 1.6)) {
      const heavy = loads[tot.indexOf(hi)];
      const big = heavy.items.filter(x => x.rid && !x.split).sort((a, b) => b.amt - a.amt)[0];
      if (big && big.amt >= (hi - lo) / 3) tips.push({lvl:'idea', ic:'⚖', t:`Your ${ord(pd(heavy.p).getDate())} cut-off carries most of the bills`, p:`${money0(hi)} to set aside then vs ${money0(lo)} on the lightest cut-off. Set ${big.name} to "Split across cut-offs" (tap it in Bills) so each payday covers about half.`});
    }
  }
  const pend = D.entries.filter(e => e.status === 'pending' && isOut(e.type));
  if (pend.length) tips.push({lvl:'warn', ic:'•', t:`${pend.length} unpaid entr${pend.length === 1 ? 'y' : 'ies'}: ${money0(pend.reduce((s, e) => s + (+e.amount || 0), 0))}`, p:'Mark them paid from Summary → Needs attention once settled.'});
  return tips;
}

/* ================= toast ================= */
let toastT;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2800); }

/* ================= render shell ================= */
function render(){
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.v === S.tab));
  $('#gear').classList.toggle('on', S.tab === 'settings');
  const mb = $('#monthbar');
  if (S.tab === 'home' || S.tab === 'entries') {
    mb.hidden = false;
    const isNow = S.month === todayStr().slice(0, 7);
    mb.innerHTML = `<button class="icon-btn" data-act="m-prev" aria-label="Previous month"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg></button>
      <button class="m" data-act="m-now">${monthLabel(S.month)}${isNow ? '<small>this month</small>' : '<small>tap for today</small>'}</button>
      <button class="icon-btn" data-act="m-next" aria-label="Next month"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg></button>`;
  } else mb.hidden = true;

  const main = $('#main');
  const ae = document.activeElement;
  const aid = ae && ae.id && main.contains(ae) ? ae.id : null;
  let sel = null; try { if (aid && ae.selectionStart != null) sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) {}
  const kept = {}; main.querySelectorAll('.keep').forEach(i => { if (i.id) kept[i.id] = i.value; });

  const D = derive();
  let html = '';
  if (!cfg.url && S.tab !== 'settings') html += `<div class="banner info"><span>Entries are saved on this device only. Connect your Google Sheet to back them up and use them on your laptop too.</span><button class="btn sm primary" data-act="tab" data-v="settings">Connect</button></div>`;
  else if (S.sync === 'auth' && S.tab !== 'settings') html += `<div class="banner"><span>Your Google Sheet refused the secret key. Your entries are safe on this device.</span><button class="btn sm" data-act="tab" data-v="settings">Fix</button></div>`;
  else if (S.serverVersion && S.serverVersion < 2) html += `<div class="banner"><span>Your Google Sheet runs an older script, so transfers and card statements won't save their "to" account. Paste the new Code.gs and deploy a new version (see the guide).</span></div>`;
  html += ({home:homeView, entries:entriesView, bills:billsView, income:incomeView, insights:insightsView, settings:settingsView}[S.tab] || homeView)(D);
  main.innerHTML = html;

  for (const [k, v] of Object.entries(kept)) { const el = document.getElementById(k); if (el) el.value = v; }
  if (aid) { const el = document.getElementById(aid); if (el) { el.focus({preventScroll:true}); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) {} } }
}

/* ================= shared renderers ================= */
function acctName(e){ return e.account || (e.mode === 'cash' ? 'Cash' : MODE_LABEL[e.mode] || ''); }
function entryRow(e){
  const title = e.type === 'transfer'
    ? `${esc(e.category || 'Transfer')} <span class="sub">· to ${esc(e.toAccount || '?')}</span>`
    : isSave(e.type)
    ? `${esc(e.category || GENERAL_SAVINGS)} <span class="sub">· ${e.type === 'withdrawal' ? 'Withdrawal' : 'Deposit'}</span>`
    : `${esc(e.category || 'Uncategorized')}${e.sub ? ` <span class="sub">· ${esc(e.sub)}</span>` : ''}`;
  const rec = e.recurringId && S.data.recurring[e.recurringId];
  const meta = [`<span class="acct">${esc(acctName(e))}</span>`, rec ? `<span>↻ ${esc(rec.name)}</span>` : '', e.note ? `<span>${esc(e.note)}</span>` : ''].join('');
  const pend = e.status === 'pending';
  const pendLabel = e.type === 'income' ? 'Expected · mark received' : isSave(e.type) ? 'Planned · mark done' : 'Unpaid · mark paid';
  return `<button class="row" data-act="edit-entry" data-id="${esc(e.id)}">
    <span class="dot ${esc(e.type)}" title="${esc(TYPE_SHORT[e.type])}"></span>
    <span class="row-main"><span class="row-title" style="display:block">${title}</span><span class="row-meta">${meta}</span></span>
    <span class="row-end"><span class="amt-v ${amtClass(e.type)}">${signed(e.amount, e.type)}</span>
      ${pend ? `<span class="pill warn act" data-act="mark-paid" data-id="${esc(e.id)}">${pendLabel}</span>` : ''}</span>
  </button>`;
}
function groupedList(list){
  if (!list.length) return '';
  let html = '<div class="ledger">', last = '';
  for (const e of list) {
    if (e.date !== last) { html += `<div class="day">${esc(fmtDay(e.date))}</div>`; last = e.date; }
    html += entryRow(e);
  }
  return html + '</div>';
}
const byDateDesc = (a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : (b.updatedAt || 0) - (a.updatedAt || 0);
const emptyBox = (t, p) => `<div class="ledger"><div class="empty"><b>${t}</b>${p}</div></div>`;

function dueRow(it){
  const r = it.r, t = recType(r), today = todayStr(), over = it.date < today;
  const verb = r.kind === 'income' ? 'Payday' : r.kind === 'savings' ? 'Save on' : 'Due';
  const when = over ? `<span class="pill out">${r.kind === 'income' ? 'Not logged' : 'Overdue'} · ${esc(fmtShort(it.date))}</span>`
    : it.date === today ? `<span class="pill warn">${verb} today</span>` : `<span>${verb} ${esc(fmtDay(it.date))}</span>`;
  const quick = r.kind === 'income' ? '✓ Received' : r.kind === 'savings' ? '✓ Saved' : '✓ Paid';
  const btn = (r.kind === 'income' && r.variable)
    ? `<span class="pill in act" data-act="due-open" data-id="${esc(r.id)}" data-d="${it.date}">Log amount</span>`
    : isStatement(r) ? `<span class="pill warn act" data-act="due-stmt" data-id="${esc(r.id)}" data-d="${it.date}">Enter statement</span>`
    : `<span class="pill ${r.kind === 'income' ? 'in' : r.kind === 'savings' ? 'save' : 'neutral'} act" data-act="due-quick" data-id="${esc(r.id)}" data-d="${it.date}">${quick}</span>`;
  const sub = r.kind === 'savings' ? (goalName(r.goalId) || 'Savings') : KIND_LABEL[r.kind];
  return `<button class="row" data-act="due-open" data-id="${esc(r.id)}" data-d="${it.date}">
    <span class="dot ${t}"></span>
    <span class="row-main"><span class="row-title" style="display:block">${esc(r.name)} <span class="sub">· ${esc(sub)}</span></span><span class="row-meta">${when}</span></span>
    <span class="row-end"><span class="amt-v ${amtClass(t)}">${r.variable ? '~' : ''}${money(r.amount)}</span>${btn}</span></button>`;
}
const goalName = id => (id && S.data.goals[id] && S.data.goals[id].name) || '';

/* ================= Summary ================= */
function homeView(D){
  const mk = S.month, N = D.byMonth[mk] || emptyMonth();
  const dueBills = dueInMonth(D, mk, PAY_KINDS);
  const rate = N.in > 0 ? N.netSaved / N.in * 100 : null;
  let h = `<div class="tiles">
    <div class="tile hero"><span class="k">Cash left in ${esc(monthName(mk))}</span><span class="v">${sgn(N.left)}${money(N.left)}</span><span class="s">Received minus spending, loan payments and savings</span></div>
    <div class="tile"><span class="k">Money in</span><span class="v c-in">${money(N.in)}</span><span class="s">${N.pendIn ? money(N.pendIn) + ' still expected' : 'Received'}</span></div>
    <div class="tile"><span class="k">Spent</span><span class="v c-out">${money(N.spent)}</span><span class="s">Expenses</span></div>
    <div class="tile"><span class="k">Loans paid</span><span class="v c-warn">${money(N.loans)}</span><span class="s">Loan payments</span></div>
    <div class="tile"><span class="k">Saved</span><span class="v c-save">${sgn(N.netSaved)}${money(N.netSaved)}</span><span class="s">${rate != null ? rate.toFixed(0) + '% of income' : 'Deposits minus withdrawals'}</span></div>
    <div class="tile wide"><span class="k">Still to pay in ${esc(monthName(mk))}</span><span class="v c-warn">${money(N.pendOut + dueBills)}</span><span class="s">${money(N.pendOut)} unpaid entries · ${money(dueBills)} bills and loans not logged yet</span></div>
  </div>`;

  if (mk === todayStr().slice(0, 7)) { const CP = cutoffPlan(D); h += cutoffMini(D, CP) + billAcctsMini(CP); }
  const att = attention(D);
  const shown = S.showAllDue ? att : att.slice(0, 6);
  h += `<h2 class="sec">Needs attention ${att.length > 6 ? `<button class="lnk" data-act="toggle-due">${S.showAllDue ? 'Show fewer' : 'Show all ' + att.length}</button>` : ''}</h2>`;
  h += att.length ? '<div class="ledger">' + shown.map(it => it.kind === 'pending' ? entryRow(it.e) : dueRow(it)).join('') + '</div>'
    : emptyBox("You're all caught up", 'Unpaid entries, bills, loan payments, paydays and savings dates show up here.');

  // budget / categories
  const outs = D.entries.filter(e => e.date.startsWith(mk) && e.type === 'expense');
  const byCat = {}; outs.forEach(e => { const k = e.category || 'Uncategorized'; byCat[k] = (byCat[k] || 0) + (+e.amount || 0); });
  const budgets = settings().budgets || {};
  for (const k of Object.keys(budgets)) if (budgets[k] > 0 && !(k in byCat)) byCat[k] = 0;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1] || ((budgets[b[0]] || 0) - (budgets[a[0]] || 0)));
  const hasBudget = Object.values(budgets).some(v => v > 0);
  h += `<h2 class="sec">${hasBudget ? 'Spending vs budget' : 'Where it went'} <button class="lnk" data-act="tab" data-v="insights">${hasBudget ? 'Adjust' : 'Get a budget'}</button></h2>`;
  if (!cats.length) h += `<div class="bars"><div class="empty" style="padding:8px">No expenses logged for ${esc(monthLabel(mk))} yet.</div></div>`;
  else {
    const max = Math.max(...cats.map(([k, v]) => Math.max(v, budgets[k] || 0)), 1);
    h += `<div class="bars">` + cats.slice(0, 12).map(([k, v]) => {
      const cap = budgets[k] || 0;
      const base = cap > 0 ? cap : max;
      const pct = Math.min(100, v / base * 100);
      const cls = cap > 0 ? (v > cap ? 'over' : v > cap * 0.85 ? 'near' : '') : '';
      return `<div class="bar-row"><span>${esc(k)}</span><span class="amt-v">${money0(v)}${cap > 0 ? ` <small>of ${money0(cap)}</small>` : ''}</span><span class="track"><i class="${cls}" style="width:${Math.max(v > 0 ? 2 : 0, pct).toFixed(1)}%"></i></span></div>`;
    }).join('') + `</div>`;
  }

  // running totals since start
  h += runningSection(D);

  // paid with
  const mOut = D.entries.filter(e => e.date.startsWith(mk) && isOut(e.type));
  if (mOut.length) {
    const byAcct = {}; mOut.forEach(e => { const k = acctName(e); byAcct[k] = (byAcct[k] || 0) + (+e.amount || 0); });
    h += `<h2 class="sec">Paid with in ${esc(monthName(mk))}</h2><div class="bars">` + Object.entries(byAcct).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="bar-row"><span>${esc(k)}</span><span class="amt-v">${money(v)}</span></div>`).join('') + `</div>`;
  }

  const recent = D.entries.filter(e => e.date.startsWith(mk)).sort(byDateDesc).slice(0, 5);
  h += `<h2 class="sec">Latest entries ${recent.length ? '<button class="lnk" data-act="tab" data-v="entries">See all</button>' : ''}</h2>`;
  h += recent.length ? groupedList(recent) : emptyBox(`No entries in ${esc(monthLabel(mk))}`, 'Tap + to log an expense, income, loan payment or savings.');
  return h;
}

function historyRows(D){
  const mks = Object.keys(D.byMonth).sort();
  if (!mks.length) return [];
  const cm = todayStr().slice(0, 7);
  const last = mks[mks.length - 1] > cm ? cm : cm;
  const rows = []; let run = 0, mk = mks[0], guard = 0;
  while (mk <= last && guard++ < 600) {
    const b = D.byMonth[mk] || emptyMonth();
    run += b.left;
    rows.push({mk, in:b.in, out:b.out, saved:b.netSaved, left:b.left, run});
    mk = shiftMonth(mk, 1);
  }
  return rows;
}
function runningSection(D){
  const rows = historyRows(D);
  let h = `<h2 class="sec">Since you started</h2>`;
  if (!rows.length) return h + emptyBox('Your running totals start with your first entry', 'Every month adds to this record, so you can see how far you have come.');
  const tot = rows.reduce((a, r) => ({in:a.in + r.in, out:a.out + r.out, saved:a.saved + r.saved}), {in:0, out:0, saved:0});
  const all = Object.values(D.byMonth).reduce((a, b) => ({spent:a.spent + b.spent, loans:a.loans + b.loans}), {spent:0, loans:0});
  const first = D.entries.reduce((m, e) => e.date < m ? e.date : m, '9999');
  const bal = savingsBalance(D);
  const net = rows[rows.length - 1].run;
  h += `<div class="tiles">
    <div class="tile"><span class="k">Total received</span><span class="v c-in">${money0(tot.in)}</span><span class="s">Since ${esc(fmtFull(first))}</span></div>
    <div class="tile"><span class="k">Total spent</span><span class="v c-out">${money0(all.spent)}</span><span class="s">${money0(all.loans)} more on loans</span></div>
    <div class="tile"><span class="k">Savings balance</span><span class="v c-save">${sgn(bal)}${money0(bal)}</span><span class="s">Includes amounts saved before tracking</span></div>
    <div class="tile"><span class="k">Cash kept</span><span class="v">${sgn(net)}${money0(net)}</span><span class="s">Left over across ${rows.length} month${rows.length === 1 ? '' : 's'}</span></div>
  </div>`;
  const recent = rows.slice(-12);
  h += `<h2 class="sec">Month by month</h2>` + chartSVG(recent);
  h += `<div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>Month</th><th>In</th><th>Out</th><th>Saved</th><th class="hide-sm">Left</th><th>Cash kept</th></tr></thead><tbody>` +
    rows.slice().reverse().map(r => `<tr><td>${esc(monthShort(r.mk))}</td><td>${money0(r.in)}</td><td>${money0(r.out)}</td><td>${sgn(r.saved)}${money0(r.saved)}</td><td class="hide-sm">${sgn(r.left)}${money0(r.left)}</td><td>${sgn(r.run)}${money0(r.run)}</td></tr>`).join('') +
    `</tbody></table></div>`;
  return h;
}
function chartSVG(rows){
  const W = 600, H = 210, L = 44, R = 8, T = 10, B = 26;
  const max = Math.max(1, ...rows.map(r => Math.max(r.in, r.out)));
  const step = niceStep(max / 3), top = Math.ceil(max / step) * step;
  const y = v => T + (H - T - B) * (1 - v / top);
  const gw = (W - L - R) / rows.length, bw = Math.min(22, gw * 0.34), gap = 2;
  let g = '';
  for (let v = 0; v <= top + 0.001; v += step) g += `<line class="${v === 0 ? 'base' : 'grid'}" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ax" x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${compact(v)}</text>`;
  const bar = (x, v, color) => {
    const h = Math.max(0, y(0) - y(v)); if (h < 0.5) return '';
    const r = Math.min(4, h, bw / 2), x2 = x + bw, yb = y(0), yt = yb - h;
    return `<path d="M${x},${yb} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x2 - r} Q${x2},${yt} ${x2},${yt + r} V${yb} Z" fill="${color}"/>`;
  };
  rows.forEach((r, i) => {
    const cx = L + gw * i + gw / 2;
    g += bar(cx - bw - gap / 2, r.in, 'var(--ch-in)') + bar(cx + gap / 2, r.out, 'var(--ch-out)');
    const show = rows.length <= 6 || i % 2 === (rows.length - 1) % 2;
    if (show) g += `<text class="ax" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(MON[+r.mk.slice(5) - 1])}</text>`;
    g += `<rect class="hit" x="${(L + gw * i).toFixed(1)}" y="${T}" width="${gw.toFixed(1)}" height="${H - T - B}" data-tt="${i}"/>`;
  });
  S.chartRows = rows;
  return `<div class="chart" id="chart"><div class="legend"><span><i style="background:var(--ch-in)"></i>Money in</span><span><i style="background:var(--ch-out)"></i>Money out (spending + loans)</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Money in and out for the last ${rows.length} months">${g}</svg></div>`;
}
function niceStep(raw){ const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1)))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }

/* ================= Entries ================= */
function entriesView(D){
  const st = settings(), f = S.f;
  let list = D.entries.filter(e => e.date.startsWith(S.month));
  if (f.type === 'savings') list = list.filter(e => isSave(e.type));
  else if (f.type !== 'all') list = list.filter(e => e.type === f.type);
  if (f.status !== 'all') list = list.filter(e => e.status === f.status);
  if (f.account !== 'all') list = list.filter(e => acctName(e) === f.account || e.toAccount === f.account);
  if (f.cat !== 'all') list = list.filter(e => (e.category || '') === f.cat);
  if (f.q) { const q = f.q.toLowerCase(); list = list.filter(e => [e.category, e.sub, e.note, e.account, TYPE_LABEL[e.type]].join(' ').toLowerCase().includes(q)); }
  list.sort(byDateDesc);
  const fchip = (k, v, l) => `<button class="fchip ${f[k] === v ? 'on' : ''}" data-act="f" data-k="${k}" data-v="${v}">${l}</button>`;
  const accts = [...new Set(D.entries.map(acctName).concat(st.accounts.map(a => a.name)))].filter(Boolean).sort();
  const catNames = [...new Set(D.entries.map(e => e.category).filter(Boolean))].sort();
  let tin = 0, tout = 0, tsave = 0;
  list.forEach(e => { const a = +e.amount || 0; if (e.type === 'income') tin += a; else if (isOut(e.type)) tout += a; else if (isSave(e.type)) tsave += e.type === 'withdrawal' ? -a : a; });
  return `<div class="filters">
    <div class="hscroll">${fchip('type','all','All')}${fchip('type','expense','Expenses')}${fchip('type','income','Income')}${fchip('type','loan','Loans')}${fchip('type','savings','Savings')}${fchip('type','transfer','Transfers')}<span style="width:8px;flex:none"></span>${fchip('status','all','Any status')}${fchip('status','pending','Unpaid / planned')}${fchip('status','paid','Done')}</div>
    <div class="frow">
      <select id="f-acct" data-f="account" aria-label="Account"><option value="all">All accounts</option>${accts.map(a => `<option ${f.account === a ? 'selected' : ''} value="${esc(a)}">${esc(a)}</option>`).join('')}</select>
      <select id="f-cat" data-f="cat" aria-label="Category"><option value="all">All categories</option>${catNames.map(c => `<option ${f.cat === c ? 'selected' : ''} value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
    </div>
    <input type="search" id="f-q" data-f="q" placeholder="Search notes, categories, cards" value="${esc(f.q)}">
  </div>
  ${list.length ? groupedList(list) : emptyBox('Nothing here', `No entries match these filters for ${esc(monthLabel(S.month))}.`)}
  <div class="totals"><span>${list.length} ${list.length === 1 ? 'entry' : 'entries'}</span><span>In <b class="num c-in">${money(tin)}</b> · Out <b class="num c-out">${money(tout)}</b>${tsave ? ` · Saved <b class="num c-save">${sgn(tsave)}${money(tsave)}</b>` : ''}</span></div>`;
}

/* ================= Bills & loans ================= */
function recCard(r, D){
  const i = recInfo(r, D), t = recType(r);
  const paused = r.active === false;
  const pendStmt = PAY_KINDS.includes(r.kind) ? (D.linked[r.id] || []).filter(e => e.status === 'pending').sort((a, b) => a.date < b.date ? -1 : 1)[0] : null;
  let status = '';
  if (paused) status = `<span class="pill neutral">Paused</span>`;
  else if (i.done) status = `<span class="pill in">${r.kind === 'loan' ? 'Paid off' : 'Finished'}</span>`;
  else if (i.next) status = i.overdue ? `<span class="pill out">${r.kind === 'income' ? 'Not logged' : 'Overdue'} · ${esc(fmtShort(i.next))}</span>`
    : `<span class="pill ${r.kind === 'income' ? 'in' : r.kind === 'savings' ? 'save' : 'warn'}">${r.kind === 'income' ? 'Next payday' : r.kind === 'savings' ? 'Next' : 'Next due'} ${esc(fmtShort(i.next))}</span>`;
  let body = '';
  if (i.terms) {
    const pct = i.paid / i.terms * 100;
    body = `<div class="progress" role="img" aria-label="${i.paid} of ${i.terms} paid"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="kv"><span><b>${i.paid}</b> of ${i.terms} paid</span><span><b>${i.left}</b> left</span><span><b>${money0(i.leftAmt)}</b> to go</span>${i.last && !i.done ? `<span>Last payment <b>${esc(fmtMonYr(i.last))}</b></span>` : ''}</div>`;
  }
  const cm = todayStr().slice(0, 7);
  if (r.kind === 'income' || r.kind === 'savings') {
    const got = (D.linked[r.id] || []).filter(e => e.status === 'paid' && e.date.startsWith(cm)).reduce((s, e) => s + (e.type === 'withdrawal' ? -e.amount : +e.amount || 0), 0);
    body = `<div class="kv"><span>${r.kind === 'income' ? 'Received' : 'Saved'} this month <b>${money0(got)}</b></span><span>About <b>${money0((+r.amount || 0) * (FREQ_BY[r.freq]?.f || 1))}</b> a month</span></div>`;
  }
  if (pendStmt) body += `<div class="kv"><span>Statement <b>${money0(pendStmt.amount)}</b></span><span>due <b>${esc(fmtShort(pendStmt.date))}</b></span><span class="pill warn">Unpaid</span></div>`;
  const sub = r.kind === 'savings' ? `→ ${esc(goalName(r.goalId) || GENERAL_SAVINGS)} · ${esc(acctName(r))}`
    : r.kind === 'card' ? `${esc(r.toAccount || 'Credit card')} · paid from ${esc(acctName(r))}`
    : `${esc(r.category || KIND_LABEL[r.kind])}${r.sub ? ' · ' + esc(r.sub) : ''} · ${PAY_KINDS.includes(r.kind) ? 'from ' : ''}${esc(acctName(r))}`;
  const logLabel = r.kind === 'income' ? 'Log income' : r.kind === 'savings' ? 'Log savings' : 'Log payment';
  const action = pendStmt ? `<button class="btn sm primary" data-act="mark-paid" data-id="${esc(pendStmt.id)}">Mark paid</button>`
    : isStatement(r) ? `<button class="btn sm" data-act="rec-stmt" data-id="${esc(r.id)}">Enter statement</button>`
    : `<button class="btn sm" data-act="rec-log" data-id="${esc(r.id)}">${logLabel}</button>`;
  return `<div class="card">
    <div class="card-top">
      <button class="card-name" data-act="edit-rec" data-id="${esc(r.id)}">${esc(r.name)}<span class="card-sub" style="display:block">${sub}</span></button>
      <div class="row-end"><span class="amt-v ${amtClass(t)}">${r.variable ? '~' : ''}${money(r.amount)}</span><span class="card-sub">${esc(FREQ_SHORT[r.freq] || '')}${isStatement(r) ? ' · typical' : ''}</span></div>
    </div>
    ${body}
    <div class="card-foot">${status || '<span></span>'}
      ${!paused && !i.done ? action : `<button class="btn sm ghost" data-act="edit-rec" data-id="${esc(r.id)}">Edit</button>`}
    </div>
  </div>`;
}
function billsView(D){
  const recs = D.recs.filter(r => PAY_KINDS.includes(r.kind));
  const cards = recs.filter(r => r.kind === 'card').sort((a, b) => a.name.localeCompare(b.name));
  const loans = recs.filter(r => r.kind === 'loan').sort((a, b) => a.name.localeCompare(b.name));
  const bills = recs.filter(r => r.kind === 'bill').sort((a, b) => a.name.localeCompare(b.name));
  let monthly = 0, loanLeft = 0, loanCount = 0, lastPay = null;
  for (const r of recs) {
    if (r.active === false) continue;
    const i = recInfo(r, D); if (i.done) continue;
    monthly += (+r.amount || 0) * (FREQ_BY[r.freq]?.f || 1);
    if (r.kind === 'loan' && i.leftAmt != null) { loanLeft += i.leftAmt; loanCount++; if (i.last && (!lastPay || i.last > lastPay)) lastPay = i.last; }
  }
  let h = `<div class="tiles">
    <div class="tile"><span class="k">Monthly commitments</span><span class="v c-out">${money0(monthly)}</span><span class="s">Bills, card statements and loans (typical)</span></div>
    <div class="tile"><span class="k">Loans left to pay</span><span class="v c-warn">${money0(loanLeft)}</span><span class="s">${loanCount ? `${loanCount} loan${loanCount === 1 ? '' : 's'} · debt-free ${esc(fmtMonYr(lastPay))}` : 'No active loans'}</span></div>
  </div>`;
  const CP = cutoffPlan(D);
  h += billAcctsSection(D, CP) + cutoffFull(D, CP);
  h += `<h2 class="sec">Credit card statements <button class="lnk" data-act="new-rec" data-v="card">+ Add card</button></h2>`;
  h += cards.length ? `<div class="cards">${cards.map(r => recCard(r, D)).join('')}</div>` : emptyBox('No credit cards yet', 'Add each card with its usual due date and the bank you pay it from. When the statement arrives, enter the amount and it goes into your cut-off plan.');
  h += `<h2 class="sec">Loans <button class="lnk" data-act="new-rec" data-v="loan">+ Add loan</button></h2>`;
  h += loans.length ? `<div class="cards">${loans.map(r => recCard(r, D)).join('')}</div>` : emptyBox('No loans set up', 'Add a loan with its payment amount and number of payments to see how much and how long you have left.');
  h += `<h2 class="sec">Recurring bills <button class="lnk" data-act="new-rec" data-v="bill">+ Add bill</button></h2>`;
  h += bills.length ? `<div class="cards">${bills.map(r => recCard(r, D)).join('')}</div>` : emptyBox('No recurring bills yet', "Rent, electricity, internet, subscriptions: add them once and they'll remind you when due.");
  return h;
}

/* ================= Income & savings ================= */
function goalCard(g, D){
  const i = goalInfo(g, D);
  let status;
  if (g.active === false) status = `<span class="pill neutral">Paused</span>`;
  else if (i.done) status = `<span class="pill in">Reached</span>`;
  else if (i.late) status = `<span class="pill out">Past target date</span>`;
  else if (i.onTrack) status = `<span class="pill in">On track</span>`;
  else status = `<span class="pill warn">Behind pace</span>`;
  const paceTxt = i.paceFrom === 'plan' ? 'savings plan' : i.paceFrom === 'history' ? 'last 3 months' : '';
  return `<div class="card">
    <div class="card-top">
      <button class="card-name" data-act="edit-goal" data-id="${esc(g.id)}">${esc(g.name)}<span class="card-sub" style="display:block">${g.targetDate ? 'Target ' + esc(fmtFull(g.targetDate)) : 'No target date'}</span></button>
      <div class="row-end"><span class="amt-v save">${money0(i.saved)}</span><span class="card-sub">of ${money0(i.target)}</span></div>
    </div>
    <div class="progress save" role="img" aria-label="${i.pct.toFixed(0)} percent saved"><i style="width:${i.pct.toFixed(1)}%"></i></div>
    <div class="kv">
      <span><b>${i.pct.toFixed(0)}%</b> saved</span><span><b>${money0(i.remaining)}</b> to go</span>
      ${!i.done && i.needMonth ? `<span>Needs <b>${money0(i.needCutoff)}</b> per cut-off</span>` : ''}
      ${!i.done && i.pace ? `<span>Pace <b>${money0(i.pace)}</b>/mo (${paceTxt})</span>` : ''}
      ${!i.done && i.eta ? `<span>Finish ~<b>${esc(fmtMonYr(i.eta))}</b></span>` : ''}
    </div>
    <div class="card-foot">${status}<button class="btn sm" data-act="goal-save" data-id="${esc(g.id)}">Add savings</button></div>
  </div>`;
}
function incomeView(D){
  const recs = D.recs.filter(r => r.kind === 'income');
  const fixed = recs.filter(r => !r.variable).sort((a, b) => a.name.localeCompare(b.name));
  const vari = recs.filter(r => r.variable).sort((a, b) => a.name.localeCompare(b.name));
  const plans = D.recs.filter(r => r.kind === 'savings').sort((a, b) => a.name.localeCompare(b.name));
  const cm = todayStr().slice(0, 7), b = D.byMonth[cm] || emptyMonth();
  let fixedM = 0, varM = 0, planM = 0;
  recs.forEach(r => { if (r.active === false) return; const m = (+r.amount || 0) * (FREQ_BY[r.freq]?.f || 1); if (r.variable) varM += m; else fixedM += m; });
  plans.forEach(r => { if (r.active !== false) planM += (+r.amount || 0) * (FREQ_BY[r.freq]?.f || 1); });
  const bal = savingsBalance(D);
  let h = `<div class="tiles">
    <div class="tile hero"><span class="k">Received in ${esc(monthName(cm))}</span><span class="v">${money(b.in)}</span><span class="s">${b.netSaved ? `${money(b.netSaved)} of it saved (${b.in ? (b.netSaved / b.in * 100).toFixed(0) : 0}%)` : 'All income entries marked received'}</span></div>
    <div class="tile"><span class="k">Steady per month</span><span class="v c-in">${money0(fixedM)}</span><span class="s">Salary and fixed pay</span></div>
    <div class="tile"><span class="k">Side income, est.</span><span class="v c-in">${money0(varM)}</span><span class="s">Varies month to month</span></div>
    <div class="tile"><span class="k">Savings balance</span><span class="v c-save">${sgn(bal)}${money0(bal)}</span><span class="s">All goals + general savings</span></div>
    <div class="tile"><span class="k">Planned savings</span><span class="v c-save">${money0(planM)}</span><span class="s">Per month from your plans</span></div>
  </div>`;
  h += `<h2 class="sec">Steady income <button class="lnk" data-act="new-rec" data-v="income" data-var="0">+ Add</button></h2>`;
  h += fixed.length ? `<div class="cards">${fixed.map(r => recCard(r, D)).join('')}</div>` : emptyBox('Add your salary', 'Set the amount and your cut-off paydays (for example the 15th and 30th) and it shows up on payday.');
  h += `<h2 class="sec">Side hustles <button class="lnk" data-act="new-rec" data-v="income" data-var="1">+ Add</button></h2>`;
  h += vari.length ? `<div class="cards">${vari.map(r => recCard(r, D)).join('')}</div>` : emptyBox('No side hustles yet', 'Add freelance work, online selling or commissions with a rough estimate. You log the real amount each time.');
  h += `<h2 class="sec">Savings goals <button class="lnk" data-act="new-goal">+ Add goal</button></h2>`;
  h += D.goals.length ? `<div class="cards">${D.goals.slice().sort((a, b) => (a.targetDate || '9') < (b.targetDate || '9') ? -1 : 1).map(g => goalCard(g, D)).join('')}</div>`
    : emptyBox('Set a savings target', 'Name a goal, the amount and the date you want it by. The app works out how much to set aside every cut-off and tracks your progress.');
  h += `<h2 class="sec">Savings plan <button class="lnk" data-act="new-rec" data-v="savings">+ Add</button></h2>`;
  h += plans.length ? `<div class="cards">${plans.map(r => recCard(r, D)).join('')}</div>` : emptyBox('Save every cut-off', 'Add the amount you set aside each payday. It reminds you on the day and counts toward your goal.');
  return h;
}

/* ================= Insights ================= */
function insightsView(D){
  const P = insightsCalc(D);
  const tips = tipsCalc(D, P);
  let h = `<h2 class="sec">Plan for ${esc(monthLabel(P.nm))}</h2>`;
  if (P.incomeSource === 'none') {
    h += emptyBox('Add your income first', 'Set up your salary and side hustles in the Income tab (or log a month of income) so the plan knows what you have to work with.') ;
  } else {
    const inc = P.incomeSource === 'schedule' ? `From your income schedule${P.incomeItems.some(x => x.variable) ? ' (side hustles at their estimates)' : ''}` : `Your average received (${P.basisShort})`;
    h += `<div class="plan">
      <div class="eq">
        <span>Expected income<br><span class="hint">${esc(inc)}</span></span><span class="amt-v c-in">${money0(P.expIncome)}</span>
        <span>Bills and loan payments due<br><span class="hint">${P.fixedItems.length ? esc(P.fixedItems.map(x => x.name).slice(0, 4).join(', ')) + (P.fixedItems.length > 4 ? ` +${P.fixedItems.length - 4} more` : '') : 'None scheduled'}</span></span><span class="amt-v c-out">−${money0(P.fixed)}</span>
        <span>Set aside for savings<br><span class="hint">${esc(P.savingsReason)} · ${money0(P.savingsTarget / 2)} per cut-off</span></span><span class="amt-v c-save">−${money0(P.savingsTarget)}</span>
        <span class="tot">Left for day-to-day spending</span><span class="amt-v tot ${P.flexBudget < 0 ? 'c-out' : ''}">${sgn(P.flexBudget)}${money0(P.flexBudget)}</span>
      </div>
    </div>`;
    if (P.noData) {
      h += `<div class="tips" style="margin-top:10px"><div class="tip idea"><span class="ic">i</span><b class="t">Log a couple of weeks of spending</b><p>Once there are expenses to learn from, you'll get a budget for each category here.</p></div></div>`;
    } else {
      const capSum = P.rows.reduce((s, r) => s + r.cap, 0);
      h += `<h2 class="sec">Suggested budget by category</h2><div class="tbl-wrap"><table><thead><tr><th>Category</th><th>Usual</th><th>Suggested</th></tr></thead><tbody>` +
        P.rows.map(r => `<tr><td>${esc(r.cat)}</td><td>${money0(r.avg)}</td><td><b>${money0(r.cap)}</b>${r.cap < r.avg - 1 ? `<small class="c-out">−${money0(r.avg - r.cap)}</small>` : ''}</td></tr>`).join('') +
        `<tr><td><b>Total</b></td><td>${money0(P.flexTotal)}</td><td><b>${money0(capSum)}</b></td></tr></tbody></table></div>
        <p class="hint" style="margin:8px 2px 0">Based on ${esc(P.basis)}. Bills and loans you set up are counted above, not here. Essentials like housing, health and transport are trimmed the least.</p>`;
      let verdict;
      if (P.flexBudget >= P.flexTotal) verdict = `<div class="tip good"><span class="ic">✓</span><b class="t">Your usual spending fits, with ${money0(Math.max(0, P.extra))} to spare</b><p>${P.extra >= 500 ? `Move the extra ${money0(P.extra)} to ${P.goals[0] ? esc(P.goals[0].g.name) : 'savings'} to get there sooner. That's ${money0(P.extra / 2)} more per cut-off.` : 'Stick to these amounts and you will hit your savings target.'}</p></div>`;
      else if (P.shortfall <= 0) verdict = `<div class="tip warn"><span class="ic">✂</span><b class="t">Trim about ${money0(Math.max(50, P.flexTotal - capSum))} from your usual spending</b><p>The suggested amounts above are what it takes to cover bills and still save ${money0(P.savingsTarget)} next month.</p></div>`;
      else verdict = `<div class="tip bad"><span class="ic">!</span><b class="t">Even with these cuts you're ${money0(P.shortfall)} short</b><p>${P.realistic && P.realistic.canSave > 0 ? `Realistically you can save about ${money0(P.realistic.canSave)} next month (${money0(P.realistic.canSave / 2)} per cut-off)${P.realistic.finish ? `, which finishes your goals around ${fmtMonYr(P.realistic.finish)}` : ''}. Consider moving a goal's target date, adding side income, or cutting a bill.` : 'Your bills and loans take up most of your income. Look for a bill to cut or renegotiate, or add side income before raising savings.'}</p></div>`;
      h += `<div class="tips" style="margin-top:12px">${verdict}</div>
        <div class="btn-row" style="margin-top:12px"><button class="btn primary" data-act="apply-budget">Use these as my monthly budgets</button>${Object.keys(settings().budgets || {}).length ? `<button class="btn" data-act="tab" data-v="settings">Edit budgets</button>` : ''}</div>`;
    }
  }
  h += `<h2 class="sec">What to work on</h2>`;
  h += tips.length ? `<div class="tips">${tips.map(t => `<div class="tip ${t.lvl}"><span class="ic">${esc(t.ic)}</span><b class="t">${esc(t.t)}</b><p>${esc(t.p)}</p></div>`).join('')}</div>`
    : emptyBox('Nothing to flag yet', 'Keep logging. Suggestions appear as your history grows.');
  if (P.hist.length) {
    h += `<h2 class="sec">Your usual month (${esc(P.basisShort)})</h2><div class="tiles">
      <div class="tile"><span class="k">Income</span><span class="v c-in">${money0(P.avgIncome)}</span></div>
      <div class="tile"><span class="k">Spending + loans</span><span class="v c-out">${money0(P.avgOut)}</span></div>
      <div class="tile"><span class="k">Saved</span><span class="v c-save">${sgn(P.avgSaved)}${money0(P.avgSaved)}</span></div>
      <div class="tile"><span class="k">Savings rate</span><span class="v">${P.avgIncome ? (P.avgSaved / P.avgIncome * 100).toFixed(0) : 0}%</span><span class="s">Guideline: 20% or more</span></div></div>`;
  }
  return h;
}

/* ================= Settings ================= */
function settingsView(D){
  const st = settings(), ck = S.confirmKey;
  const statusTxt = !cfg.url ? 'Not connected' : S.sync === 'ok' ? `Connected · last synced ${new Date(S.lastSync).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'})}`
    : S.sync === 'auth' ? 'The sheet refused the secret key. Check it and connect again.'
    : S.sync === 'err' ? `Can't reach the sheet (${esc(S.syncError)}). Retrying automatically.` : S.sync === 'offline' ? 'Offline. Changes upload when you are back online.' : 'Connecting…';
  let h = `<h2 class="sec">Google Sheet</h2><div class="panel">
    <div class="hint"><b style="color:var(--ink)">${statusTxt}</b>${outbox.length ? ` · ${outbox.length} change${outbox.length === 1 ? '' : 's'} waiting to upload` : ''}</div>
    <div class="field"><label class="lbl" for="s-url">Web app URL</label><input id="s-url" class="keep" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg.url)}" autocomplete="off"></div>
    <div class="field"><label class="lbl" for="s-token">Secret key</label><input id="s-token" class="keep" type="password" placeholder="From the Apps Script execution log" value="${esc(cfg.token)}" autocomplete="off"></div>
    <div class="btn-row"><button class="btn primary" data-act="connect">${cfg.url ? 'Save and reconnect' : 'Connect'}</button>${cfg.url ? `<button class="btn" data-act="sync-now">Sync now</button>` : ''}${S.sheetUrl ? `<a class="btn" href="${esc(S.sheetUrl)}" target="_blank" rel="noopener">Open my sheet</a>` : ''}</div>
    ${cfg.url && cfg.token ? `<div class="field"><div class="lbl">Set up your other phone or laptop</div><div class="hint">Copy this link and open it on the other device. It contains your secret key, so only send it to yourself.</div><div class="btn-row"><button class="btn" data-act="copy-link">Copy setup link</button></div><input id="s-link" readonly hidden></div>` : ''}
    ${!cfg.url ? `<details><summary class="hint" style="cursor:pointer">How do I get these?</summary><ol class="steps" style="margin-top:8px">
      <li>Open a new Google Sheet, then <b>Extensions → Apps Script</b>.</li>
      <li>Replace the code with <code>Code.gs</code> from this app's files and save.</li>
      <li>Choose <code>setup</code> and press <b>Run</b>. Approve access. Copy the secret key from the execution log.</li>
      <li><b>Deploy → New deployment → Web app</b>. Execute as <b>Me</b>, access <b>Anyone</b>. Copy the URL.</li>
      <li>Paste both here and press Connect.</li></ol></details>` : ''}
  </div>`;

  const typeOpts = MODES.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
  h += `<h2 class="sec">Cards, banks and wallets</h2><div class="panel">`;
  for (const m of MODES) {
    const list = st.accounts.map((a, i) => ({...a, i})).filter(a => a.type === m.id);
    if (!list.length) continue;
    h += `<div class="lbl">${m.label}</div>` + list.map(a => `<div class="set-row"><span>${esc(a.name)}</span><span class="btn-row" style="gap:4px">${m.id === 'bank' || m.id === 'ewallet' ? `<button class="btn sm ${a.billPay ? 'primary' : ''}" data-act="bill-acct" data-i="${a.i}">${a.billPay ? '✓ Bills account' : 'Use for bills'}</button>` : ''}<button class="btn sm ghost ${ck === 'acct' + a.i ? 'danger confirm' : ''}" data-act="acct-del" data-i="${a.i}">${ck === 'acct' + a.i ? 'Tap to remove' : 'Remove'}</button></span></div>`).join('');
  }
  h += `<div class="add-row"><input id="s-acct-name" class="keep" placeholder="e.g. BPI Credit Card, GCash" data-enter="acct-add"><select id="s-acct-type" class="keep" style="width:auto">${typeOpts}</select><button class="btn sm primary" data-act="acct-add">Add</button></div>
  <div class="hint">Mark the banks you transfer bill money into as <b>Bills account</b>. Removing an account keeps the entries that used it.</div></div>`;

  const autoSal = (() => { const r = D.recs.find(x => x.kind === 'income' && !x.variable && x.active !== false); return r ? acctName(r) : ''; })();
  h += `<h2 class="sec">Paying bills each cut-off</h2><div class="panel">
    <div class="field"><label class="lbl" for="s-salary">Salary lands in</label><select id="s-salary" class="keep"><option value="">${autoSal ? `Same as my salary setup (${esc(autoSal)})` : 'Pick an account'}</option>${st.accounts.filter(a => a.type !== 'card').map(a => `<option value="${esc(a.name)}" ${st.salaryAccount === a.name ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
    <div class="field"><label class="lbl" for="s-lead">Days before the due date the money should be in the bills account</label><input id="s-lead" class="keep" type="number" min="0" max="15" inputmode="numeric" value="${st.leadDays}" style="max-width:110px"></div>
    <div class="hint">Transfers between banks can take a day or two. With 2 days, a bill due on the 17th is funded from your 15th cut-off; one due on the 16th comes from the cut-off before.</div>
    <div class="btn-row"><button class="btn primary" data-act="pay-save">Save</button></div></div>`;

  const cats = st.categories[S.setType] || [];
  h += `<h2 class="sec">Categories</h2><div class="seg small" style="margin-bottom:10px">${['expense', 'income', 'loan'].map(t => `<button class="seg-b ${S.setType === t ? 'on' : ''} t-${t}" data-act="set-type" data-v="${t}">${TYPE_SHORT[t]}</button>`).join('')}</div><div class="panel">`;
  h += cats.map((c, i) => `<div class="cat-block">
      <div class="cat-head"><span>${esc(c.name)}</span><button class="btn sm ghost ${ck === 'cat' + i ? 'danger confirm' : ''}" data-act="cat-del" data-i="${i}">${ck === 'cat' + i ? 'Tap to remove' : 'Remove'}</button></div>
      <div class="chips">${(c.subs || []).map((s, j) => `<span class="subchip">${esc(s)}<button data-act="sub-del" data-i="${i}" data-j="${j}" aria-label="Remove ${esc(s)}">×</button></span>`).join('') || '<span class="hint">No subcategories</span>'}</div>
      <div class="add-row"><input id="s-sub-${S.setType}-${i}" class="keep" placeholder="Add subcategory under ${esc(c.name)}" data-enter="sub-add"><button class="btn sm" data-act="sub-add" data-i="${i}">Add</button></div>
    </div>`).join('');
  h += `<div class="add-row"><input id="s-cat-name" class="keep" placeholder="New ${TYPE_SHORT[S.setType].toLowerCase()} category" data-enter="cat-add"><button class="btn sm primary" data-act="cat-add">Add category</button></div></div>`;

  const bud = st.budgets || {};
  h += `<h2 class="sec">Monthly budgets</h2><div class="panel"><div class="hint">Leave blank for no limit. Insights can fill these in for you.</div>` +
    (st.categories.expense || []).map((c, i) => `<div class="budget-row"><label for="b-${i}">${esc(c.name)}</label><input id="b-${i}" class="keep" inputmode="decimal" data-bcat="${esc(c.name)}" value="${bud[c.name] > 0 ? bud[c.name] : ''}" placeholder="No limit"></div>`).join('') +
    `<div class="btn-row"><button class="btn primary" data-act="budget-save">Save budgets</button></div></div>`;

  h += `<h2 class="sec">Currency</h2><div class="panel"><div class="add-row" style="margin:0"><input id="s-cur" class="keep" value="${esc(st.currency)}" maxlength="4" style="max-width:90px"><button class="btn sm" data-act="cur-save">Save symbol</button></div></div>`;
  h += `<h2 class="sec">Put it on your home screen</h2><div class="panel"><ol class="steps">
    <li><b>iPhone:</b> open this page in Safari, tap Share, then <b>Add to Home Screen</b>.</li>
    <li><b>Android:</b> open it in Chrome, tap ⋮, then <b>Add to Home screen</b> or <b>Install app</b>.</li>
    <li><b>Laptop:</b> in Chrome or Edge, click the install icon in the address bar, or just bookmark it.</li></ol>
    <div class="hint">Entries you add without signal are kept on the device and upload automatically later.</div></div>`;
  return h;
}

/* ================= sheets (forms) ================= */
function chip(label, on, act, val){ return `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${esc(val ?? label)}">${esc(label)}</button>`; }
function addChip(kind, label){ return S.sheet.adding === kind ? '' : `<button class="chip add" data-act="adding" data-v="${kind}">${esc(label || '+ New')}</button>`; }
function addingRow(kind, ph){ return S.sheet.adding === kind ? `<div class="add-row"><input id="add-input" placeholder="${esc(ph)}" data-enter="add-ok"><button class="btn sm primary" data-act="add-ok">Add</button><button class="btn sm ghost" data-act="add-cancel">Cancel</button></div>` : ''; }
const closeBtn = `<button class="icon-btn" data-act="close" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
function acctPicker(d, label, hint){
  const accts = settings().accounts.filter(a => a.type === d.mode);
  return `<div class="field"><div class="lbl">${label}</div>
    <div class="seg small">${MODES.map(m => `<button class="seg-b ${d.mode === m.id ? 'on' : ''}" data-act="e-mode" data-v="${m.id}">${m.label}</button>`).join('')}</div>
    ${(d.mode !== 'cash' || accts.length > 1) ? `<div class="chips mt">${accts.map(a => chip(a.name + (a.billPay ? ' ★' : ''), d.account === a.name, 'e-acct', a.name)).join('')}${addChip('acct', ADD_ACCT[d.mode])}</div>${addingRow('acct', ACCT_PH[d.mode])}` : ''}
    ${hint ? `<span class="hint">${hint}</span>` : ''}
  </div>`;
}
function acctChips(sel, act, addKind, exclude){
  const accts = settings().accounts.filter(a => a.type !== 'cash' && a.name !== exclude);
  return `<div class="chips">${accts.map(a => chip(a.name + (a.billPay ? ' ★' : ''), sel === a.name, act, a.name)).join('')}${addChip(addKind, '+ Add account')}</div>${addingRow(addKind, 'e.g. BPI Savings, UnionBank')}`;
}
function entrySheet(){
  const d = S.sheet.data, st = settings();
  const seg = isSave(d.type) ? 'savings' : d.type;
  const isIn = d.type === 'income', sav = isSave(d.type), xfer = d.type === 'transfer';
  const rec = d.recurringId && S.data.recurring[d.recurringId];
  let catBlock = '', payBlock = '';
  if (xfer) {
    payBlock = `<div class="field"><div class="lbl">From</div>${acctChips(d.account, 'e-from', 'from', '')}</div>
      <div class="field"><div class="lbl">To</div>${acctChips(d.toAccount, 'e-to', 'to', d.account)}
      ${d.dueKey && !d.recurringId ? `<span class="hint">Money for bills on the ${esc(fmtDay(d.dueKey))} cut-off.</span>` : ''}
      ${rec && rec.kind === 'card' ? `<span class="hint">Paying a credit card counts as a transfer because its purchases are already logged, so nothing is counted twice.</span>` : ''}</div>`;
  } else if (sav) {
    const goals = Object.values(S.data.goals).filter(g => g.active !== false || g.id === d.goalId);
    catBlock = `<div class="seg small">
        <button class="seg-b ${d.type === 'savings' ? 'on' : ''}" data-act="e-savedir" data-v="savings">Deposit</button>
        <button class="seg-b ${d.type === 'withdrawal' ? 'on' : ''}" data-act="e-savedir" data-v="withdrawal">Withdrawal</button></div>
      <div class="field"><div class="lbl">Goal</div><div class="chips">${goals.map(g => chip(g.name, d.goalId === g.id, 'e-goal', g.id)).join('')}${chip(GENERAL_SAVINGS, !d.goalId, 'e-goal', '')}</div>
      ${!goals.length ? '<span class="hint">Tip: add a goal under Income → Savings goals to track progress toward it.</span>' : ''}</div>`;
  } else {
    const cats = st.categories[d.type] || [];
    const cat = cats.find(c => c.name === d.category);
    catBlock = `<div class="field"><div class="lbl">Category</div><div class="chips">${cats.map(c => chip(c.name, d.category === c.name, 'e-cat')).join('')}${addChip('cat')}</div>${addingRow('cat', 'New category name')}</div>
      ${cat ? `<div class="field"><div class="lbl">Subcategory <span class="opt">(optional)</span></div><div class="chips">${(cat.subs || []).map(s => chip(s, d.sub === s, 'e-sub')).join('')}${addChip('sub')}</div>${addingRow('sub', 'New subcategory under ' + cat.name)}</div>` : ''}`;
  }
  if (!xfer) payBlock = acctPicker(d, isIn ? 'Received through' : sav ? (d.type === 'withdrawal' ? 'Taken from' : 'Saved in') : 'Paid with',
    isOut(d.type) && d.mode === 'card' ? 'Charged to a credit card. It gets paid when you pay that card\'s statement.' : '');
  const recs = Object.values(S.data.recurring).filter(r => recType(r) === (sav ? 'savings' : d.type));
  const doneL = isIn ? 'Received' : sav || xfer ? 'Done' : 'Paid', pendL = isIn ? 'Expected' : sav ? 'Planned' : xfer ? 'Not yet' : 'Unpaid';
  const title = S.sheet.stmt && rec ? `${esc(rec.name)} statement` : S.sheet.isNew ? (xfer ? 'New transfer' : 'New entry') : 'Edit entry';
  return `<div class="grab"></div>
  <div class="sheet-head"><h3>${title}</h3>${closeBtn}</div>
  ${S.sheet.stmt ? '' : `<div class="seg small">${['expense', 'income', 'loan', 'savings', 'transfer'].map(t => `<button class="seg-b t-${t} ${seg === t ? 'on' : ''}" data-act="e-type" data-v="${t}">${{expense:'Expense', income:'Income', loan:'Loan', savings:'Savings', transfer:'Transfer'}[t]}</button>`).join('')}</div>`}
  <label class="amt"><span class="cur">${esc(cur())}</span><input id="e-amount" inputmode="decimal" placeholder="${S.sheet.stmt ? 'Statement amount' : '0.00'}" value="${esc(d.amount)}" data-bind="amount" autocomplete="off" aria-label="Amount"></label>
  ${S.sheet.stmt ? `<span class="hint" style="margin-top:-8px">Enter the total amount due from the statement. It goes into your cut-off plan as unpaid until you mark it paid.</span>` : ''}
  ${catBlock}
  ${payBlock}
  <div class="row2">
    <div class="field"><div class="lbl">Status</div><div class="seg small">
      <button class="seg-b ${d.status === 'paid' ? 'on' : ''}" data-act="e-status" data-v="paid">${doneL}</button>
      <button class="seg-b ${d.status === 'pending' ? 'on' : ''}" data-act="e-status" data-v="pending">${pendL}</button></div></div>
    <div class="field"><label class="lbl" for="e-date">${d.status === 'pending' ? (isIn ? 'Expected on' : 'Due on') : 'Date'}</label><input type="date" id="e-date" data-bind="date" value="${esc(d.date)}"></div>
  </div>
  ${recs.length ? `<div class="field"><label class="lbl" for="e-rec">Part of</label><select id="e-rec" data-bind="recurringId"><option value="">Nothing, it's a one-off</option>${recs.map(r => `<option value="${esc(r.id)}" ${d.recurringId === r.id ? 'selected' : ''}>${esc(r.name)} (${KIND_LABEL[r.kind].toLowerCase()})</option>`).join('')}</select></div>` : ''}
  <div class="field"><label class="lbl" for="e-note">Note <span class="opt">(optional)</span></label><input id="e-note" data-bind="note" value="${esc(d.note)}" placeholder="${isIn ? 'e.g. Logo project for client' : sav ? 'e.g. 15th cut-off' : xfer ? 'e.g. Bills money for 15th cut-off' : 'e.g. Lunch with officemates'}"></div>
  <div class="sheet-actions">${!S.sheet.isNew ? `<button class="btn danger ${S.sheet.confirmDel ? 'confirm' : ''}" data-act="e-del">${S.sheet.confirmDel ? 'Tap again to delete' : 'Delete'}</button>` : ''}<button class="btn primary" data-act="e-save">${S.sheet.stmt ? 'Save statement' : 'Save entry'}</button></div>`;
}
function recPreview(d){
  if (d.kind === 'income' || d.kind === 'savings') return '';
  const terms = parseInt(d.terms, 10), before = parseInt(d.paidBefore, 10) || 0, amt = num(d.amount);
  if (!(terms > 0) || !d.start) return d.variable ? 'Ongoing. Each statement\'s amount is entered when it arrives.' : d.kind === 'loan' ? 'Enter the total number of payments to see how long you have left.' : 'Leave total payments blank if this bill keeps going.';
  const tracked = S.sheet.isNew ? 0 : ((derive().linked[d.id] || []).filter(e => e.status === 'paid').length);
  const left = Math.max(0, terms - before - tracked);
  const tmp = {start:d.start, freq:d.freq, day1:pd(d.start).getDate(), day2:parseInt(d.day2, 10) || 30, terms, paidBefore:before};
  const all = occList(tmp, '2199-12-31');
  return `<b>${left}</b> payment${left === 1 ? '' : 's'} left${isFinite(amt) ? ` · <b class="num">${money0(left * amt)}</b> to go` : ''}${all.length && left ? ` · last one around <b>${esc(fmtMonYr(all[all.length - 1]))}</b>` : ''}`;
}
function recSheet(){
  const d = S.sheet.data, st = settings();
  const isIn = d.kind === 'income', isSav = d.kind === 'savings', isCard = d.kind === 'card', pays = PAY_KINDS.includes(d.kind);
  const stmt = isCard || ((d.kind === 'bill' || d.kind === 'loan') && d.variable);
  const t = isCard ? (d.cardLogged === false ? 'loan' : '') : kindToType(d.kind);
  const cats = t ? st.categories[t] || [] : [];
  const cat = cats.find(c => c.name === d.category);
  const namePh = {bill:'e.g. Electricity, Internet, Rent', loan:'e.g. Phone installment, SSS salary loan', card:'e.g. BPI Credit Card', income:d.variable ? 'e.g. Freelance design, Shopee store' : 'e.g. Salary', savings:'e.g. Cut-off savings'}[d.kind];
  const goals = Object.values(S.data.goals);
  const title = isIn ? (d.variable ? 'side hustle' : 'income') : isSav ? 'savings plan' : isCard ? 'credit card' : KIND_LABEL[d.kind].toLowerCase();
  const cardAccts = st.accounts.filter(a => a.type === 'card');
  const billAccts = st.accounts.filter(a => a.billPay).map(a => a.name);
  const amtLabel = isIn && d.variable ? 'Typical amount' : isIn ? 'Amount each payday' : stmt ? 'Typical statement' : 'Amount each time';
  return `<div class="grab"></div>
  <div class="sheet-head"><h3>${S.sheet.isNew ? 'New ' : 'Edit '}${title}</h3>${closeBtn}</div>
  <div class="seg small">${['bill', 'loan', 'card', 'income', 'savings'].map(k => `<button class="seg-b t-${kindToType(k)} ${d.kind === k ? 'on' : ''}" data-act="r-kind" data-v="${k}">${{bill:'Bill', loan:'Loan', card:'Card', income:'Income', savings:'Savings'}[k]}</button>`).join('')}</div>
  <div class="field"><label class="lbl" for="r-name">Name</label><input id="r-name" data-bind="name" value="${esc(d.name)}" placeholder="${esc(namePh)}"></div>
  ${isCard ? `<div class="field"><div class="lbl">Which card</div><div class="chips">${cardAccts.map(a => chip(a.name, d.toAccount === a.name, 'r-card', a.name)).join('')}${addChip('card', '+ Add card')}</div>${addingRow('card', 'e.g. BPI Credit Card')}</div>
    <label class="check"><input type="checkbox" id="r-logged" data-bind="cardLogged" data-rerender="1" ${d.cardLogged !== false ? 'checked' : ''}><span>I log each purchase on this card in the app<br><span class="hint">${d.cardLogged !== false ? 'Paying the statement is then a transfer from your bank to the card, so the spending isn\'t counted twice.' : 'The statement payment will count as spending (a loan payment), since the purchases aren\'t logged one by one.'}</span></span></label>` : ''}
  ${isIn ? `<label class="check"><input type="checkbox" id="r-var" data-bind="variable" data-rerender="1" ${d.variable ? 'checked' : ''}><span>The amount changes each time<br><span class="hint">For side hustles. Use a typical amount; you enter the real one when it comes in.</span></span></label>` : ''}
  ${d.kind === 'bill' || d.kind === 'loan' ? `<label class="check"><input type="checkbox" id="r-var" data-bind="variable" data-rerender="1" ${d.variable ? 'checked' : ''}><span>The amount changes with every statement<br><span class="hint">Like electricity or water. You enter the amount when the bill arrives; until then the plan uses the typical amount.</span></span></label>` : ''}
  <div class="row2">
    <div class="field"><label class="lbl" for="r-amt">${amtLabel}</label><input id="r-amt" inputmode="decimal" data-bind="amount" data-preview="1" value="${esc(d.amount)}" placeholder="0.00"></div>
    <div class="field"><label class="lbl" for="r-freq">How often</label><select id="r-freq" data-bind="freq" data-rerender="1">${FREQ.map(f => `<option value="${f.id}" ${d.freq === f.id ? 'selected' : ''}>${f.label}</option>`).join('')}</select></div>
  </div>
  <div class="row2">
    <div class="field"><label class="lbl" for="r-start">${S.sheet.isNew ? (isIn ? 'Next payday' : pays ? 'Next due date' : 'Next date') : 'Schedule starts'}</label><input type="date" id="r-start" data-bind="start" data-preview="1" data-rerender="1" value="${esc(d.start)}"></div>
    ${d.freq === 'semimonthly' ? `<div class="field"><label class="lbl" for="r-day2">Other day each month</label><input id="r-day2" type="number" min="1" max="31" inputmode="numeric" data-bind="day2" data-preview="1" value="${esc(d.day2)}"></div>` : '<div></div>'}
  </div>
  ${d.freq === 'semimonthly' && d.start ? `<div class="hint" style="margin-top:-6px">Repeats on the ${ord(pd(d.start).getDate())} and ${ord(parseInt(d.day2, 10) || 30)} of every month (last day in shorter months).</div>` : ''}
  ${d.kind === 'bill' || d.kind === 'loan' ? `<div class="row2">
    <div class="field"><label class="lbl" for="r-terms">Total payments ${d.kind === 'bill' || d.variable ? '<span class="opt">(optional)</span>' : ''}</label><input id="r-terms" type="number" min="1" inputmode="numeric" data-bind="terms" data-preview="1" value="${esc(d.terms)}" placeholder="${d.kind === 'loan' && !d.variable ? 'e.g. 24' : 'Ongoing'}"></div>
    <div class="field"><label class="lbl" for="r-before">Already paid</label><input id="r-before" type="number" min="0" inputmode="numeric" data-bind="paidBefore" data-preview="1" value="${esc(d.paidBefore)}" placeholder="0"></div>
  </div>
  <div class="preview" id="r-preview">${recPreview(d)}</div>` : ''}
  ${isSav ? `<div class="field"><div class="lbl">Goes toward</div><div class="chips">${goals.map(g => chip(g.name, d.goalId === g.id, 'r-goal', g.id)).join('')}${chip(GENERAL_SAVINGS, !d.goalId, 'r-goal', '')}</div></div>`
    : t ? `<div class="field"><div class="lbl">Category</div><div class="chips">${cats.map(c => chip(c.name, d.category === c.name, 'r-cat')).join('')}${addChip('cat')}</div>${addingRow('cat', 'New category name')}</div>
  ${cat && (cat.subs || []).length ? `<div class="field"><div class="lbl">Subcategory <span class="opt">(optional)</span></div><div class="chips">${cat.subs.map(s => chip(s, d.sub === s, 'r-sub')).join('')}</div></div>` : ''}` : ''}
  ${acctPicker(d, isIn ? 'Paid into' : isSav ? 'Saved in' : 'Paid from',
    pays ? (d.mode === 'card' && !isCard ? 'Auto-charged to a credit card: it is paid through that card\'s statement, so it is left out of the cut-off transfers.' : `The bank you pay this from.${billAccts.length ? ' ★ = your bills accounts.' : ' Mark your bills banks in Settings.'}`) : '')}
  ${pays ? `<div class="field"><label class="lbl" for="r-fund">Set aside the money</label><select id="r-fund" data-bind="fund">
      <option value="before" ${d.fund !== 'split' ? 'selected' : ''}>All at the cut-off before it's due</option>
      <option value="split" ${d.fund === 'split' ? 'selected' : ''}>Split across the cut-offs before it's due</option></select></div>` : ''}
  ${!S.sheet.isNew ? `<label class="check"><input type="checkbox" id="r-paused" data-bind="paused" ${d.paused ? 'checked' : ''}><span>Paused<br><span class="hint">Stops reminders without deleting the history.</span></span></label>` : ''}
  <div class="sheet-actions">${!S.sheet.isNew ? `<button class="btn danger ${S.sheet.confirmDel ? 'confirm' : ''}" data-act="r-del">${S.sheet.confirmDel ? 'Tap again to delete' : 'Delete'}</button>` : ''}<button class="btn primary" data-act="r-save">Save</button></div>`;
}
const ord = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

function goalPreview(d){
  const target = num(d.target), start = num(d.startAmount) || 0;
  if (!(target > 0) || !d.targetDate) return 'Enter an amount and a date to see what to save each cut-off.';
  const rem = Math.max(0, target - start);
  const days = (pd(d.targetDate) - pd(todayStr())) / 86400000;
  if (days <= 0) return 'Pick a date in the future.';
  const months = Math.max(0.5, days / 30.44);
  return `Save <b class="num">${money0(rem / months)}</b> a month, or <b class="num">${money0(rem / months / 2)}</b> every cut-off, to reach it on time.`;
}
function goalSheet(){
  const d = S.sheet.data;
  return `<div class="grab"></div>
  <div class="sheet-head"><h3>${S.sheet.isNew ? 'New savings goal' : 'Edit goal'}</h3>${closeBtn}</div>
  <div class="field"><label class="lbl" for="g-name">Goal</label><input id="g-name" data-bind="name" value="${esc(d.name)}" placeholder="e.g. Emergency fund, New laptop, Japan trip"></div>
  <div class="row2">
    <div class="field"><label class="lbl" for="g-target">Target amount</label><input id="g-target" inputmode="decimal" data-bind="target" data-gpreview="1" value="${esc(d.target)}" placeholder="0.00"></div>
    <div class="field"><label class="lbl" for="g-date">Reach it by</label><input type="date" id="g-date" data-bind="targetDate" data-gpreview="1" value="${esc(d.targetDate)}"></div>
  </div>
  <div class="field"><label class="lbl" for="g-start">Already saved for it <span class="opt">(before using this app)</span></label><input id="g-start" inputmode="decimal" data-bind="startAmount" data-gpreview="1" value="${esc(d.startAmount)}" placeholder="0.00"></div>
  <div class="preview" id="g-preview">${goalPreview(d)}</div>
  ${!S.sheet.isNew ? `<label class="check"><input type="checkbox" id="g-paused" data-bind="paused" ${d.paused ? 'checked' : ''}><span>Paused<br><span class="hint">Leaves it out of next month's plan.</span></span></label>` : ''}
  <div class="sheet-actions">${!S.sheet.isNew ? `<button class="btn danger ${S.sheet.confirmDel ? 'confirm' : ''}" data-act="g-del">${S.sheet.confirmDel ? 'Tap again to delete' : 'Delete'}</button>` : ''}<button class="btn primary" data-act="g-save">Save goal</button></div>`;
}

function renderSheet(focusId){
  const host = $('#sheet');
  if (!S.sheet) { host.innerHTML = ''; document.body.style.overflow = ''; return; }
  const old = host.querySelector('.sheet'); const top = old ? old.scrollTop : 0;
  const body = S.sheet.kind === 'entry' ? entrySheet() : S.sheet.kind === 'rec' ? recSheet() : S.sheet.kind === 'bal' ? balSheet() : goalSheet();
  host.innerHTML = `<div class="overlay" data-act="overlay"><div class="sheet" role="dialog" aria-modal="true">${body}</div></div>`;
  document.body.style.overflow = 'hidden';
  host.querySelector('.sheet').scrollTop = top;
  const f = focusId && document.getElementById(focusId);
  if (f) f.focus();
}
function closeSheet(){ S.sheet = null; renderSheet(); }

function newEntry(preset){
  const cash = settings().accounts.find(a => a.type === 'cash');
  return Object.assign({id:uid('e'), type:'expense', amount:'', category:'', sub:'', date:todayStr(), mode:'cash', account:cash ? cash.name : 'Cash',
    status:'paid', note:'', recurringId:'', dueKey:'', goalId:'', toAccount:''}, preset || {});
}
function openEntry(e, isNew){
  S.sheet = {kind:'entry', isNew, prevDate:isNew ? null : e.date, adding:null, confirmDel:false,
    data:{goalId:'', ...e, amount:e.amount === '' || e.amount == null ? '' : String(e.amount)}};
  renderSheet(isNew && !e.amount ? 'e-amount' : null);
}
function entryFromRec(r, occ){
  const type = recType(r);
  const category = type === 'savings' ? (goalName(r.goalId) || GENERAL_SAVINGS) : type === 'transfer' ? 'Credit card payment' : r.category || (r.kind === 'card' ? 'Credit card' : '');
  return newEntry({type, amount:isStatement(r) || r.variable ? '' : r.amount, category, sub:r.sub || '',
    mode:r.mode || 'cash', account:r.account || (r.mode === 'cash' || !r.mode ? 'Cash' : ''), toAccount:r.kind === 'card' ? r.toAccount || '' : '',
    status:'paid', recurringId:r.id, dueKey:occ || '', goalId:r.goalId || ''});
}
function openStatement(r, occ){
  const e = entryFromRec(r, occ);
  e.status = 'pending'; e.date = occ || todayStr(); e.note = 'Statement';
  openEntry(e, true); S.sheet.stmt = true; renderSheet('e-amount');
}
function openRec(r, isNew){
  S.sheet = {kind:'rec', isNew, adding:null, confirmDel:false,
    data:{...r, amount:r.amount === '' || r.amount == null ? '' : String(r.amount), terms:r.terms ? String(r.terms) : '', paidBefore:r.paidBefore ? String(r.paidBefore) : '',
      day2:String(r.day2 || 30), paused:r.active === false, goalId:r.goalId || '', fund:r.fund || 'before', toAccount:r.toAccount || '', cardLogged:r.cardLogged !== false}};
  renderSheet(isNew ? 'r-name' : null);
}
function newRec(kind, variable){
  const st = settings();
  const firstGoal = Object.values(S.data.goals).find(g => g.active !== false);
  const billAcct = st.accounts.find(a => a.billPay);
  const pays = PAY_KINDS.includes(kind);
  return {id:uid('r'), kind, name:kind === 'savings' ? 'Cut-off savings' : '', amount:'', variable:kind === 'card' ? true : !!variable,
    freq:(kind === 'income' && !variable) || kind === 'savings' ? 'semimonthly' : 'monthly',
    start:todayStr(), day2:30, terms:'', paidBefore:'', category:kind === 'income' ? (variable ? 'Side hustle' : 'Salary') : '', sub:'',
    mode:pays && billAcct ? billAcct.type : kind === 'income' || kind === 'savings' || kind === 'card' ? 'bank' : 'cash',
    account:pays && billAcct ? billAcct.name : '', active:true, goalId:kind === 'savings' && firstGoal ? firstGoal.id : '',
    fund:'before', toAccount:'', cardLogged:true};
}
function openGoal(g, isNew){
  S.sheet = {kind:'goal', isNew, confirmDel:false, data:{...g, target:g.target ? String(g.target) : '', startAmount:g.startAmount ? String(g.startAmount) : '', paused:g.active === false}};
  renderSheet(isNew ? 'g-name' : null);
}

/* ================= actions ================= */
function quickLog(r, occ){
  const e = entryFromRec(r, occ);
  if (!e.category) e.category = r.kind === 'loan' ? 'Personal loan' : r.kind === 'income' ? 'Salary' : 'Miscellaneous';
  saveEntryRow(e);
  toast(`Logged ${money(e.amount)} · ${r.name}`);
}
function saveEntryRow(e){
  const row = {id:e.id, date:e.date, type:e.type, category:e.category || '', sub:e.sub || '', amount:+e.amount, mode:e.mode || 'cash', account:e.account || '',
    status:e.status || 'paid', note:e.note || '', recurringId:e.recurringId || '', dueKey:e.dueKey || '', goalId:e.goalId || '', toAccount:e.type === 'transfer' ? e.toAccount || '' : ''};
  upsert('entries', row);
}
function nearestDue(rid, date){
  const r = S.data.recurring[rid]; if (!r) return '';
  const D = derive();
  return occList(r, addDays(date, 45)).find(o => !D.logged.has(rid + '|' + o)) || '';
}
function submitEntry(){
  const sh = S.sheet, d = sh.data;
  const amt = num(d.amount), xfer = d.type === 'transfer';
  if (!(amt > 0)) { toast(sh.stmt ? 'Enter the statement amount' : 'Enter an amount'); document.getElementById('e-amount')?.focus(); return; }
  if (xfer) {
    if (!d.account) { toast('Pick the account the money comes from'); return; }
    if (!d.toAccount) { toast('Pick the account the money goes to'); return; }
    if (d.account === d.toAccount) { toast('Pick two different accounts'); return; }
  } else if (!isSave(d.type) && !d.category) { toast('Pick a category'); return; }
  if (!d.date) { toast('Pick a date'); return; }
  const e = {...d, amount:Math.round(amt * 100) / 100, note:(d.note || '').trim(),
    account:d.account || (d.mode === 'cash' ? 'Cash' : ''),
    category:isSave(d.type) ? (goalName(d.goalId) || GENERAL_SAVINGS) : xfer ? (d.category || (d.recurringId ? 'Credit card payment' : 'Transfer')) : d.category,
    sub:isSave(d.type) || xfer ? '' : d.sub, goalId:isSave(d.type) ? d.goalId || '' : ''};
  if (xfer) e.mode = (acctInfo(e.account) || {}).type || 'bank';
  if (e.recurringId && !e.dueKey) e.dueKey = nearestDue(e.recurringId, e.date);
  if (!e.recurringId && !xfer) e.dueKey = '';
  closeSheet();
  saveEntryRow(e);
  toast(sh.stmt ? 'Statement saved. It is in your cut-off plan.' : sh.isNew ? (xfer ? 'Transfer saved' : 'Entry saved') : 'Entry updated');
}
function submitRec(){
  const d = S.sheet.data, isNew = S.sheet.isNew;
  const amt = num(d.amount), isCard = d.kind === 'card';
  if (!String(d.name || '').trim()) { toast('Give it a name'); return; }
  if (!(amt > 0)) { toast(isCard ? 'Enter a typical statement amount' : 'Enter an amount'); return; }
  if (!d.start) { toast('Pick the next date'); return; }
  if (isCard && !d.toAccount) { toast('Pick which card this is'); return; }
  const terms = parseInt(d.terms, 10), before = parseInt(d.paidBefore, 10) || 0;
  const hasTerms = (d.kind === 'loan' || d.kind === 'bill') && terms > 0;
  if (d.kind === 'loan' && !d.variable && !(terms > 0)) { toast('Enter the total number of payments for this loan'); return; }
  if (hasTerms && before >= terms) { toast('Already paid must be less than total payments'); return; }
  const pays = PAY_KINDS.includes(d.kind);
  const r = {id:d.id, kind:d.kind, name:d.name.trim(), amount:Math.round(amt * 100) / 100,
    variable:isCard || ((d.kind === 'income' || d.kind === 'bill' || d.kind === 'loan') && !!d.variable),
    freq:d.freq, start:d.start, day1:pd(d.start).getDate(), day2:Math.min(31, Math.max(1, parseInt(d.day2, 10) || 30)),
    terms:hasTerms ? terms : null, paidBefore:hasTerms ? before : 0,
    category:d.kind === 'savings' ? (goalName(d.goalId) || GENERAL_SAVINGS) : isCard ? (d.cardLogged === false ? d.category || 'Credit card' : 'Credit card payment') : d.category || '',
    sub:d.kind === 'savings' || (isCard && d.cardLogged !== false) ? '' : d.sub || '',
    mode:d.mode, account:d.account || (d.mode === 'cash' ? 'Cash' : ''), goalId:d.kind === 'savings' ? d.goalId || '' : '', active:!d.paused,
    toAccount:isCard ? d.toAccount : '', fund:pays ? d.fund || 'before' : '', cardLogged:isCard ? d.cardLogged !== false : false};
  closeSheet();
  upsert('recurring', r);
  toast(isNew ? `${r.name} added` : `${r.name} updated`);
}
function submitGoal(){
  const d = S.sheet.data, isNew = S.sheet.isNew;
  const target = num(d.target), start = num(d.startAmount) || 0;
  if (!String(d.name || '').trim()) { toast('Name your goal'); return; }
  if (!(target > 0)) { toast('Enter a target amount'); return; }
  if (!d.targetDate) { toast('Pick the date you want to reach it'); return; }
  const g = {id:d.id, name:d.name.trim(), target:Math.round(target * 100) / 100, targetDate:d.targetDate, startAmount:Math.round(start * 100) / 100,
    active:!d.paused, createdAt:d.createdAt || todayStr()};
  closeSheet();
  upsert('goals', g);
  toast(isNew ? `${g.name} goal added` : `${g.name} updated`);
}
function doAddInline(){
  const sh = S.sheet, d = sh.data, inp = document.getElementById('add-input');
  const val = (inp && inp.value || '').trim(); if (!val) { inp?.focus(); return; }
  const st = clone(settings());
  const type = sh.kind === 'entry' ? d.type : kindToType(d.kind);
  if (sh.adding === 'cat') {
    const list = st.categories[type] = st.categories[type] || [];
    if (!list.some(c => c.name.toLowerCase() === val.toLowerCase())) list.push({name:val, subs:[]});
    d.category = list.find(c => c.name.toLowerCase() === val.toLowerCase()).name; d.sub = '';
    saveSettings({categories:st.categories});
  } else if (sh.adding === 'sub') {
    const c = (st.categories[type] || []).find(c => c.name === d.category);
    if (c) { c.subs = c.subs || []; if (!c.subs.includes(val)) c.subs.push(val); d.sub = val; saveSettings({categories:st.categories}); }
  } else if (sh.adding === 'acct' || sh.adding === 'from' || sh.adding === 'to' || sh.adding === 'card') {
    const type = sh.adding === 'acct' ? d.mode : sh.adding === 'card' ? 'card' : 'bank';
    if (!st.accounts.some(a => a.name.toLowerCase() === val.toLowerCase())) st.accounts.push({name:val, type});
    const name = st.accounts.find(a => a.name.toLowerCase() === val.toLowerCase()).name;
    if (sh.adding === 'to' || sh.adding === 'card') d.toAccount = name; else d.account = name;
    saveSettings({accounts:st.accounts});
  }
  sh.adding = null; renderSheet();
}
function armConfirm(key){ S.confirmKey = key; render(); clearTimeout(armConfirm.t); armConfirm.t = setTimeout(() => { S.confirmKey = null; render(); }, 3500); }
function setupLink(){
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify({u:cfg.url, t:cfg.token})))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return location.origin + location.pathname + '#setup=' + payload;
}
function readSetupHash(){
  const m = /#setup=([A-Za-z0-9_-]+)/.exec(location.hash || '');
  if (!m) return false;
  try {
    let b = m[1].replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
    const o = JSON.parse(decodeURIComponent(escape(atob(b))));
    if (o.u && o.t) { cfg.url = o.u; cfg.token = o.t; lsSet('pp.cfg', JSON.stringify(cfg)); }
  } catch (e) {}
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
  return true;
}

/* ================= events ================= */
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, v = el.dataset.v;
  if (act === 'overlay') { if (ev.target === el) closeSheet(); return; }
  if (el.tagName === 'A') return;
  ev.preventDefault();
  const sh = S.sheet, d = sh && sh.data;
  switch (act) {
    case 'tab': S.tab = v; lsSet('pp.tab', v); S.confirmKey = null; render(); window.scrollTo(0, 0); break;
    case 'm-prev': S.month = shiftMonth(S.month, -1); render(); break;
    case 'm-next': S.month = shiftMonth(S.month, 1); render(); break;
    case 'm-now': S.month = todayStr().slice(0, 7); render(); break;
    case 'toggle-due': S.showAllDue = !S.showAllDue; render(); break;
    case 'new-entry': openEntry(newEntry(), true); break;
    case 'edit-entry': { const e = S.data.entries[el.dataset.id]; if (e) openEntry(e, false); break; }
    case 'mark-paid': { const e = S.data.entries[el.dataset.id]; if (e) { saveEntryRow({...e, status:'paid'}); toast(e.type === 'income' ? 'Marked received' : isSave(e.type) ? 'Marked done' : 'Marked paid'); } break; }
    case 'due-quick': { const r = S.data.recurring[el.dataset.id]; if (r) quickLog(r, el.dataset.d); break; }
    case 'due-open': { const r = S.data.recurring[el.dataset.id]; if (r) { if (isStatement(r)) openStatement(r, el.dataset.d); else openEntry(entryFromRec(r, el.dataset.d), true); } break; }
    case 'due-stmt': { const r = S.data.recurring[el.dataset.id]; if (r) openStatement(r, el.dataset.d); break; }
    case 'rec-stmt': { const r = S.data.recurring[el.dataset.id]; if (r) openStatement(r, recInfo(r, derive()).next || todayStr()); break; }
    case 'acct-open': S.openAcct = S.openAcct === v ? '' : v; S.showAllActivity = false; render(); break;
    case 'toggle-activity': S.showAllActivity = !S.showAllActivity; render(); break;
    case 'acct-focus': {
      S.tab = 'bills'; lsSet('pp.tab', 'bills'); if (v) S.openAcct = v; render();
      const t = v && document.getElementById('acct-' + v.replace(/[^A-Za-z0-9]/g, '_'));
      if (t) t.scrollIntoView({block:'start'}); else window.scrollTo(0, 0);
      break; }
    case 'acct-bal': S.sheet = {kind:'bal', isNew:false, data:{acct:v, actual:''}}; renderSheet('bal-actual'); break;
    case 'bal-save': {
      const actual = num(d.actual); if (!isFinite(actual)) { toast('Enter the balance from your bank app'); return; }
      const st = clone(settings()); let a = st.accounts.find(x => x.name === d.acct);
      if (!a) { a = {name:d.acct, type:'bank'}; st.accounts.push(a); }
      const opening = +(a.opening) || 0, tracked = fundBalance(derive(), d.acct);
      a.opening = Math.round((actual - (tracked - opening)) * 100) / 100;
      closeSheet(); saveSettings({accounts:st.accounts}); toast(`${d.acct} now matches your bank: ${money0(actual)}`); break; }
    case 'co-prev': S.coOff = Math.max(-3, S.coOff - 1); render(); break;
    case 'co-next': S.coOff = Math.min(6, S.coOff + 1); render(); break;
    case 'co-item': {
      const e = el.dataset.eid && S.data.entries[el.dataset.eid];
      if (e) { openEntry(e, false); break; }
      const r = S.data.recurring[el.dataset.rid]; if (!r) break;
      if (isStatement(r)) openStatement(r, el.dataset.occ); else openEntry(entryFromRec(r, el.dataset.occ), true);
      break; }
    case 'co-xfer': {
      const D = derive(), from = salaryAcct(D), fi = acctInfo(from);
      openEntry(newEntry({type:'transfer', amount:+el.dataset.amt || '', account:from, mode:fi ? fi.type : 'bank', toAccount:el.dataset.acct,
        category:'Cut-off transfer', dueKey:el.dataset.p, note:`Bills for the ${fmtShort(el.dataset.p)} cut-off`}), true);
      break; }
    case 'rec-log': { const r = S.data.recurring[el.dataset.id]; if (r) openEntry(entryFromRec(r, recInfo(r, derive()).next), true); break; }
    case 'new-rec': openRec(newRec(v, el.dataset.var === '1'), true); break;
    case 'edit-rec': { const r = S.data.recurring[el.dataset.id]; if (r) openRec(r, false); break; }
    case 'new-goal': openGoal({id:uid('g'), name:'', target:'', targetDate:shiftMonth(todayStr().slice(0, 7), 12) + '-01', startAmount:'', active:true}, true); break;
    case 'edit-goal': { const g = S.data.goals[el.dataset.id]; if (g) openGoal(g, false); break; }
    case 'goal-save': { const g = S.data.goals[el.dataset.id]; if (g) openEntry(newEntry({type:'savings', goalId:g.id, category:g.name, mode:'bank', account:''}), true); break; }
    case 'close': closeSheet(); break;
    case 'f': S.f[el.dataset.k] = v; render(); break;
    /* entry form */
    case 'e-type': {
      const cur = isSave(d.type) ? 'savings' : d.type;
      if (cur !== v) {
        d.type = v; d.category = ''; d.sub = ''; d.recurringId = ''; d.dueKey = ''; d.goalId = ''; d.toAccount = '';
        if ((v === 'savings' || v === 'transfer') && d.mode === 'cash') { d.mode = 'bank'; d.account = ''; }
        if (v === 'transfer') { const sa = salaryAcct(derive()); if (sa && acctInfo(sa)) { d.account = sa; d.mode = acctInfo(sa).type; } else if (d.mode === 'card' || d.mode === 'cash') d.account = ''; }
      }
      sh.adding = null; renderSheet(); break; }
    case 'e-savedir': d.type = v; renderSheet(); break;
    case 'e-from': d.account = v; if (d.toAccount === v) d.toAccount = ''; renderSheet(); break;
    case 'e-to': d.toAccount = v; renderSheet(); break;
    case 'r-card': d.toAccount = v; if (!d.name) d.name = v; renderSheet(); break;
    case 'e-goal': d.goalId = v; renderSheet(); break;
    case 'r-goal': d.goalId = v; renderSheet(); break;
    case 'e-cat': case 'r-cat': d.category = d.category === v ? '' : v; d.sub = ''; renderSheet(); break;
    case 'e-sub': case 'r-sub': d.sub = d.sub === v ? '' : v; renderSheet(); break;
    case 'e-mode': { d.mode = v; const a = settings().accounts.filter(x => x.type === v); d.account = v === 'cash' ? (a[0]?.name || 'Cash') : a.length === 1 ? a[0].name : ''; sh.adding = null; renderSheet(); break; }
    case 'e-acct': d.account = v; renderSheet(); break;
    case 'e-status': d.status = v; renderSheet(); break;
    case 'adding': sh.adding = v; renderSheet('add-input'); break;
    case 'add-cancel': sh.adding = null; renderSheet(); break;
    case 'add-ok': doAddInline(); break;
    case 'e-save': submitEntry(); break;
    case 'e-del': if (!sh.confirmDel) { sh.confirmDel = true; renderSheet(); } else { const id = d.id; closeSheet(); remove('entries', id); toast('Entry deleted'); } break;
    /* recurring form */
    case 'r-kind': if (d.kind !== v) {
                d.kind = v; d.sub = ''; d.category = v === 'income' ? (d.variable ? 'Side hustle' : 'Salary') : '';
        if (v === 'card') { d.variable = true; d.freq = 'monthly'; d.cardLogged = true; if (d.mode === 'cash') { d.mode = 'bank'; d.account = ''; } }
        else d.variable = false;
        if (v === 'savings') { d.freq = 'semimonthly'; if (!d.name) d.name = 'Cut-off savings'; }
      } sh.adding = null; renderSheet(); break;
    case 'r-save': submitRec(); break;
    case 'r-del': if (!sh.confirmDel) { sh.confirmDel = true; renderSheet(); } else { const id = d.id, n = d.name; closeSheet(); remove('recurring', id); toast(`${n} deleted. Past entries stay.`); } break;
    /* goal form */
    case 'g-save': submitGoal(); break;
    case 'g-del': if (!sh.confirmDel) { sh.confirmDel = true; renderSheet(); } else { const id = d.id, n = d.name; closeSheet(); remove('goals', id); toast(`${n} deleted. Savings entries stay.`); } break;
    /* insights */
    case 'apply-budget': {
      const P = insightsCalc(derive()); const b = {...settings().budgets};
      P.rows.forEach(r => { if (r.cap > 0) b[r.cat] = r.cap; });
      saveSettings({budgets:b}); toast('Budgets saved. Summary now tracks them.'); break; }
    /* settings */
    case 'connect': {
      const u = $('#s-url').value.trim(), t = $('#s-token').value.trim();
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(u)) { toast('Paste the Web app URL from Apps Script (starts with https://script.google.com/)'); return; }
      if (!t) { toast('Paste your secret key'); return; }
      cfg.url = u; cfg.token = t; lsSet('pp.cfg', JSON.stringify(cfg));
      S.sync = 'busy'; renderSync(); flush().then(() => { if (S.sync === 'ok') toast('Connected to your Google Sheet'); render(); });
      break; }
    case 'sync-now': flush(); break;
    case 'copy-link': {
      const link = setupLink();
      const done = () => toast('Setup link copied. Open it on your other device.');
      const fallback = () => { const i = $('#s-link'); if (i) { i.hidden = false; i.value = link; i.select(); toast('Copy the selected link'); } };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, fallback); else fallback();
      break; }
    case 'set-type': S.setType = v; render(); break;
    case 'acct-add': {
      const n = $('#s-acct-name'), ty = $('#s-acct-type'); const val = n.value.trim(); if (!val) { n.focus(); return; }
      const st = clone(settings()); if (!st.accounts.some(a => a.name.toLowerCase() === val.toLowerCase())) st.accounts.push({name:val, type:ty.value});
      n.value = ''; saveSettings({accounts:st.accounts}); toast(`${val} added`); break; }
    case 'acct-del': { const i = +el.dataset.i; if (S.confirmKey !== 'acct' + i) { armConfirm('acct' + i); return; } S.confirmKey = null; const st = clone(settings()); st.accounts.splice(i, 1); saveSettings({accounts:st.accounts}); break; }
    case 'cat-add': {
      const n = $('#s-cat-name'); const val = n.value.trim(); if (!val) { n.focus(); return; }
      const st = clone(settings()); const list = st.categories[S.setType] = st.categories[S.setType] || [];
      if (!list.some(c => c.name.toLowerCase() === val.toLowerCase())) list.push({name:val, subs:[]});
      n.value = ''; saveSettings({categories:st.categories}); break; }
    case 'cat-del': { const i = +el.dataset.i; if (S.confirmKey !== 'cat' + i) { armConfirm('cat' + i); return; } S.confirmKey = null; const st = clone(settings()); st.categories[S.setType].splice(i, 1); saveSettings({categories:st.categories}); break; }
    case 'sub-add': {
      const i = +el.dataset.i, n = document.getElementById(`s-sub-${S.setType}-${i}`); const val = n.value.trim(); if (!val) { n.focus(); return; }
      const st = clone(settings()); const c = st.categories[S.setType][i]; c.subs = c.subs || []; if (!c.subs.includes(val)) c.subs.push(val);
      n.value = ''; saveSettings({categories:st.categories}); break; }
    case 'sub-del': { const st = clone(settings()); st.categories[S.setType][+el.dataset.i].subs.splice(+el.dataset.j, 1); saveSettings({categories:st.categories}); break; }
    case 'budget-save': {
      const b = {}; document.querySelectorAll('[data-bcat]').forEach(i => { const n = num(i.value); if (n > 0) b[i.dataset.bcat] = Math.round(n * 100) / 100; i.value = n > 0 ? String(b[i.dataset.bcat]) : ''; });
      saveSettings({budgets:b}); toast('Budgets saved'); break; }
    case 'bill-acct': { const st = clone(settings()); const a = st.accounts[+el.dataset.i]; if (a) { a.billPay = !a.billPay; saveSettings({accounts:st.accounts}); } break; }
    case 'pay-save': {
      const lead = parseInt($('#s-lead').value, 10);
      saveSettings({salaryAccount:$('#s-salary').value, leadDays:isFinite(lead) ? Math.max(0, Math.min(15, lead)) : 2});
      toast('Saved. Your cut-off plan is updated.'); break; }
    case 'cur-save': { const val = $('#s-cur').value.trim() || '₱'; saveSettings({currency:val}); toast('Currency updated'); break; }
  }
});
function bindInput(el){
  const d = S.sheet.data, k = el.dataset.bind;
  d[k] = el.type === 'checkbox' ? el.checked : el.value;
  if (k === 'recurringId') d.dueKey = '';
}
document.addEventListener('input', ev => {
  const el = ev.target;
  if (el.dataset.f === 'q') { S.f.q = el.value; render(); return; }
  if (!S.sheet || !el.dataset.bind) return;
  bindInput(el);
  if (el.dataset.rerender && el.tagName !== 'INPUT') { renderSheet(el.id); return; }
  if (el.dataset.rerender && el.type === 'checkbox') { renderSheet(el.id); return; }
  if (el.dataset.preview) { const p = document.getElementById('r-preview'); if (p) p.innerHTML = recPreview(S.sheet.data); }
  if (el.dataset.gpreview) { const p = document.getElementById('g-preview'); if (p) p.innerHTML = goalPreview(S.sheet.data); }
});
document.addEventListener('change', ev => {
  const el = ev.target;
  if (el.dataset.f && el.dataset.f !== 'q') { S.f[el.dataset.f] = el.value; render(); return; }
  if (S.sheet && el.dataset.bind) {
    bindInput(el);
    if (el.dataset.rerender) renderSheet();
    if (el.dataset.gpreview) { const p = document.getElementById('g-preview'); if (p) p.innerHTML = goalPreview(S.sheet.data); }
  }
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && S.sheet) { closeSheet(); return; }
  if (ev.key !== 'Enter') return;
  const el = ev.target;
  if (el.dataset && el.dataset.enter) {
    ev.preventDefault();
    const btn = el.parentElement.querySelector(`[data-act="${el.dataset.enter}"]`);
    if (btn) btn.click();
  }
});
/* chart tooltip */
document.addEventListener('pointerover', ev => {
  const t = ev.target.closest && ev.target.closest('[data-tt]');
  const tt = $('#tt');
  if (!t) { tt.hidden = true; return; }
  const r = S.chartRows && S.chartRows[+t.dataset.tt]; if (!r) return;
  tt.innerHTML = `<b>${esc(monthLabel(r.mk))}</b><span class="num">In ${money0(r.in)}</span><span class="num">Out ${money0(r.out)}</span><span class="num">Saved ${sgn(r.saved)}${money0(r.saved)}</span>`;
  tt.hidden = false;
  const box = t.getBoundingClientRect();
  const w = tt.offsetWidth, x = Math.min(window.innerWidth - w - 8, Math.max(8, box.left + box.width / 2 - w / 2));
  tt.style.position = 'fixed'; tt.style.left = x + 'px'; tt.style.top = Math.max(8, box.top - tt.offsetHeight + 20) + 'px';
});
window.addEventListener('scroll', () => { const tt = $('#tt'); if (tt) tt.hidden = true; }, {passive:true});

/* ================= boot ================= */
window.addEventListener('online', () => flush());
window.addEventListener('offline', () => { S.sync = 'offline'; renderSync(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
setInterval(() => { if (document.visibilityState === 'visible') flush(); }, 180000);

const fromLink = readSetupHash();
render(); renderSync();
if (fromLink && cfg.url) toast('This device is now linked to your Google Sheet');
flush();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
})();
