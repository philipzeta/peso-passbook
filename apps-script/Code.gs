/**
 * Peso Passbook — Google Sheets backend
 * -------------------------------------
 * Paste this whole file into Extensions → Apps Script of your Google Sheet.
 * 1. Run the `setup` function once (Run ▶, pick "setup"). Approve the permissions.
 *    Open "Execution log" to copy your SECRET KEY.
 * 2. Deploy → New deployment → type "Web app"
 *      Execute as: Me
 *      Who has access: Anyone
 *    Copy the Web app URL (ends with /exec).
 * 3. Paste the URL and the secret key into the app (Settings → Google Sheet).
 *
 * The secret key is what keeps other people out, so don't share it.
 * To change it, run `resetKey` and update the app on every device.
 */

var TABLES = {
  entries: {
    tab: 'Entries',
    cols: ['id', 'date', 'type', 'category', 'sub', 'amount', 'mode', 'account', 'status', 'note', 'recurringId', 'dueKey', 'goalId', 'updatedAt', 'toAccount'],
    headers: ['ID', 'Date', 'Type', 'Category', 'Subcategory', 'Amount', 'Payment mode', 'Account / card (from)', 'Status', 'Note', 'Recurring ID', 'Due date / cut-off covered', 'Goal ID', 'Updated', 'Transfer to'],
    dates: ['date'], numbers: ['amount', 'updatedAt'], bools: []
  },
  recurring: {
    tab: 'Recurring',
    cols: ['id', 'kind', 'name', 'amount', 'variable', 'freq', 'start', 'day1', 'day2', 'terms', 'paidBefore', 'category', 'sub', 'mode', 'account', 'goalId', 'active', 'updatedAt', 'toAccount', 'fund', 'cardLogged'],
    headers: ['ID', 'Kind', 'Name', 'Amount', 'Amount varies', 'Frequency', 'Schedule starts', 'Day 1', 'Day 2', 'Total payments', 'Paid before tracking', 'Category', 'Subcategory', 'Payment mode', 'Paid from / paid into', 'Goal ID', 'Active', 'Updated', 'Credit card', 'Set aside', 'Card purchases logged'],
    dates: ['start'], numbers: ['amount', 'day1', 'day2', 'terms', 'paidBefore', 'updatedAt'], bools: ['variable', 'active', 'cardLogged']
  },
  goals: {
    tab: 'Savings Goals',
    cols: ['id', 'name', 'target', 'targetDate', 'startAmount', 'active', 'createdAt', 'updatedAt'],
    headers: ['ID', 'Goal', 'Target amount', 'Target date', 'Saved before tracking', 'Active', 'Created', 'Updated'],
    dates: ['targetDate', 'createdAt'], numbers: ['target', 'startAmount', 'updatedAt'], bools: ['active']
  }
};
var API_VERSION = 2;
var SETTINGS_TAB = 'Settings';
var SUMMARY_TAB = 'Monthly Summary';
var SUMMARY_NOTE = 'Paid / received totals by month (updates automatically). Types: expense, income, loan, savings, withdrawal. Transfers between your own accounts are left out.';

/* ---------------- one-time setup ---------------- */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  props.setProperty('SHEET_ID', ss.getId());
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', newKey_());
  ensureSheets_(ss);
  Logger.log('Setup complete.');
  Logger.log('YOUR SECRET KEY: ' + props.getProperty('TOKEN'));
  Logger.log('Next: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).');
}
function resetKey() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('TOKEN', newKey_());
  Logger.log('NEW SECRET KEY: ' + props.getProperty('TOKEN'));
}
function showKey() {
  Logger.log('YOUR SECRET KEY: ' + PropertiesService.getScriptProperties().getProperty('TOKEN'));
}
function newKey_() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8); }

function book_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function ensureSheets_(ss) {
  Object.keys(TABLES).forEach(function (k) {
    var t = TABLES[k];
    var sh = ss.getSheetByName(t.tab);
    if (!sh) sh = ss.insertSheet(t.tab);
    var have = sh.getLastColumn() > 0 ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
    if (!have.length || !have[0] || have.length < t.headers.length) {
      sh.getRange(1, 1, 1, t.headers.length).setValues([t.headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    t.dates.forEach(function (c) {
      var i = t.cols.indexOf(c) + 1;
      sh.getRange(2, i, sh.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
    });
    if (k === 'entries') sh.getRange(2, t.cols.indexOf('amount') + 1, sh.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');
  });
  var st = ss.getSheetByName(SETTINGS_TAB);
  if (!st) {
    st = ss.insertSheet(SETTINGS_TAB);
    st.getRange(1, 1, 1, 2).setValues([['Key', 'Value (managed by the app)']]).setFontWeight('bold');
    st.setFrozenRows(1);
  }
  var sm = ss.getSheetByName(SUMMARY_TAB);
  if (!sm) sm = ss.insertSheet(SUMMARY_TAB);
  if (sm.getRange('A1').getValues()[0][0] !== SUMMARY_NOTE) {
    sm.getRange('A1').setValue(SUMMARY_NOTE);
    sm.getRange('A3').setFormula(
      "=IFERROR(QUERY(Entries!A2:O, \"select year(B), month(B)+1, sum(F) where B is not null and I = 'paid' and C <> 'transfer' " +
      "group by year(B), month(B)+1 pivot C label year(B) 'Year', month(B)+1 'Month'\", 0), \"No paid entries yet\")");
  }
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
}

/* ---------------- web app ---------------- */
function doGet() {
  return json_({ ok: true, message: 'Peso Passbook is connected to this sheet. The app talks to it with POST requests.' });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_request' }); }
  var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || !req || req.token !== token) return json_({ ok: false, error: 'unauthorized' });
  try {
    var ss = book_();
    if (req.action === 'ping') return json_({ ok: true });
    if (req.action === 'load') return json_({ ok: true, data: loadAll_(ss) });
    if (req.action === 'batch') {
      var ops = Array.isArray(req.ops) ? req.ops : [];
      var lock = LockService.getScriptLock();
      lock.waitLock(25000);
      var done = [];
      try {
        ensureSheets_(ss);
        ops.forEach(function (op) { applyOp_(ss, op); done.push(op.opId || null); });
        SpreadsheetApp.flush();
      } finally { lock.releaseLock(); }
      return json_({ ok: true, applied: done, data: loadAll_(ss) });
    }
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- reads ---------------- */
function loadAll_(ss) {
  var out = { version: API_VERSION, sheetUrl: ss.getUrl(), tz: ss.getSpreadsheetTimeZone() };
  Object.keys(TABLES).forEach(function (k) { out[k] = readTable_(ss, k); });
  out.settings = readSettings_(ss);
  return out;
}

function readTable_(ss, key) {
  var t = TABLES[key], sh = ss.getSheetByName(t.tab);
  if (!sh || sh.getLastRow() < 2) return [];
  var tz = ss.getSpreadsheetTimeZone();
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, t.cols.length).getValues();
  var rows = [];
  values.forEach(function (r) {
    if (!r[0]) return;
    var o = {};
    t.cols.forEach(function (c, i) {
      var v = r[i];
      if (t.dates.indexOf(c) >= 0) {
        if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        else v = v ? String(v).slice(0, 10) : '';
      } else if (t.numbers.indexOf(c) >= 0) {
        v = (v === '' || v === null) ? null : Number(v);
      } else if (t.bools.indexOf(c) >= 0) {
        v = v === true || String(v).toUpperCase() === 'TRUE';
      } else {
        v = (v === null || v === undefined) ? '' : String(v);
      }
      o[c] = v;
    });
    rows.push(o);
  });
  return rows;
}

function readSettings_(ss) {
  var sh = ss.getSheetByName(SETTINGS_TAB), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    if (!r[0]) return;
    try { out[r[0]] = JSON.parse(r[1]); } catch (e) { out[r[0]] = r[1]; }
  });
  return out;
}

/* ---------------- writes ---------------- */
var TZ_ = 'Asia/Manila';
function applyOp_(ss, op) {
  if (!op || !op.op) return;
  TZ_ = ss.getSpreadsheetTimeZone();
  if (op.op === 'settings') { writeSettings_(ss, op.value || {}); return; }
  var t = TABLES[op.table];
  if (!t) return;
  var sh = ss.getSheetByName(t.tab);
  if (op.op === 'upsert') {
    var row = op.row || {};
    if (!row.id) return;
    var cells = t.cols.map(function (c) { return toCell_(t, c, row[c]); });
    var r = findRow_(sh, row.id);
    if (r) sh.getRange(r, 1, 1, cells.length).setValues([cells]);
    else sh.getRange(sh.getLastRow() + 1, 1, 1, cells.length).setValues([cells]);
  } else if (op.op === 'delete') {
    var d = findRow_(sh, op.id);
    if (d) sh.deleteRow(d);
  }
}

function findRow_(sh, id) {
  if (!id || sh.getLastRow() < 2) return 0;
  var hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function toCell_(t, c, v) {
  if (v === undefined || v === null) return '';
  if (t.dates.indexOf(c) >= 0) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    return m ? Utilities.parseDate(m[0], TZ_, 'yyyy-MM-dd') : '';
  }
  if (t.numbers.indexOf(c) >= 0) { var n = Number(v); return isFinite(n) ? n : ''; }
  if (t.bools.indexOf(c) >= 0) return !!v;
  var s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // never let text become a formula
  return s;
}

function writeSettings_(ss, value) {
  var sh = ss.getSheetByName(SETTINGS_TAB);
  Object.keys(value).forEach(function (k) {
    var text = JSON.stringify(value[k]);
    var r = findRow_(sh, k);
    if (r) sh.getRange(r, 2).setValue(text);
    else sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setValues([[k, text]]);
  });
}
