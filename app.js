(function () {
  "use strict";

  // ---------- 常量 ----------
  const CATS = [
    { key: "bank", label: "银行", color: "#5B8DEF", bg: "rgba(91,141,239,0.14)" },
    { key: "platform", label: "平台", color: "#B084E8", bg: "rgba(176,132,232,0.14)" },
    { key: "card", label: "信用卡", color: "#E2725B", bg: "rgba(226,114,91,0.14)" },
    { key: "other", label: "其他", color: "#4FB286", bg: "rgba(79,178,134,0.14)" },
  ];
  const catInfo = (key) => CATS.find((c) => c.key === key) || CATS[3];

  const CURRENCIES = [
    { key: "SGD", label: "新币", symbol: "S$" },
    { key: "MYR", label: "令吉", symbol: "RM" },
  ];
  const curInfo = (key) => CURRENCIES.find((c) => c.key === key) || CURRENCIES[0];
  const BASE_CURRENCY = "MYR";

  const pad2 = (n) => String(n).padStart(2, "0");
  const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  const monthLabel = (d) => `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
  const fmtMoney = (n) =>
    (Math.round(n * 100) / 100).toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const fmtCur = (currency, n) => `${curInfo(currency).symbol}${fmtMoney(n)}`;
  const uid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const STORAGE_KEY = "repay-assistant-data";

  // ---------- 状态 ----------
  const state = {
    bills: [],
    payments: {}, // { "2026-07": { billId: true } }
    income: {}, // { "2026-07": [{id, amount, currency, note}] }
    exchangeRates: {}, // { "2026-07": 3.3 }
    loaded: false,
    saveError: false,
    viewDate: new Date(),
    filter: "all",
    formOpen: false,
    editingId: null,
    form: { name: "", category: "bank", currency: "SGD", amount: "", dueDay: "", note: "" },
    confirmDeleteId: null,
    stampingId: null,
    incomeFormOpen: false,
    incomeForm: { amount: "", currency: "SGD", note: "" },
    rateDraft: "",
  };

  const today = new Date();

  // ---------- 加载 / 保存 ----------
  function loadData() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state.bills = parsed.bills || [];
        state.payments = parsed.payments || {};
        state.income = parsed.income || {};
        state.exchangeRates = parsed.exchangeRates || {};
      }
    } catch (e) {
      // 首次使用，没有数据
    } finally {
      state.loaded = true;
    }
  }

  function persist() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          bills: state.bills,
          payments: state.payments,
          income: state.income,
          exchangeRates: state.exchangeRates,
        })
      );
      state.saveError = false;
    } catch (e) {
      state.saveError = true;
    }
  }

  let toastTimer = null;
  function flashToast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  // ---------- 汇率 ----------
  function getRateForMonth(mk) {
    if (state.exchangeRates[mk] != null) return state.exchangeRates[mk];
    const priorKeys = Object.keys(state.exchangeRates).filter((k) => k < mk).sort();
    if (priorKeys.length) return state.exchangeRates[priorKeys[priorKeys.length - 1]];
    return null;
  }

  function mKey() {
    return monthKey(state.viewDate);
  }

  function applyRate() {
    const val = parseFloat(state.rateDraft);
    if (isNaN(val) || val <= 0) {
      flashToast("请输入有效汇率");
      const cur = getRateForMonth(mKey());
      state.rateDraft = cur != null ? String(cur) : "";
      render();
      return;
    }
    state.exchangeRates[mKey()] = val;
    persist();
    flashToast(`${monthLabel(state.viewDate)} 汇率已保存`);
    render();
  }

  // ---------- 派生数据 ----------
  function computeRows() {
    const monthPaid = state.payments[mKey()] || {};
    return state.bills
      .map((b) => {
        const paid = !!monthPaid[b.id];
        const dueDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth(), Math.min(b.dueDay, 28));
        const overdue =
          !paid &&
          dueDate < today &&
          mKey() <= monthKey(today) &&
          (mKey() < monthKey(today) || dueDate < new Date(today.getFullYear(), today.getMonth(), today.getDate()));
        return { ...b, paid, overdue, currency: b.currency || "SGD" };
      })
      .sort((a, b) => a.dueDay - b.dueDay);
  }

  function computeMonthIncome() {
    return (state.income[mKey()] || []).map((it) => ({ ...it, currency: it.currency || "SGD" }));
  }

  function computeCurrencyKeys(rows, monthIncome) {
    const set = new Set(["SGD", "MYR"]);
    rows.forEach((r) => set.add(r.currency));
    monthIncome.forEach((i) => set.add(i.currency));
    return CURRENCIES.map((c) => c.key).filter((k) => set.has(k));
  }

  function computeByCurrency(rows, monthIncome, currencyKeys) {
    const out = {};
    currencyKeys.forEach((ck) => {
      const curRows = rows.filter((r) => r.currency === ck);
      const due = curRows.reduce((s, r) => s + r.amount, 0);
      const paid = curRows.filter((r) => r.paid).reduce((s, r) => s + r.amount, 0);
      const inc = monthIncome.filter((i) => i.currency === ck).reduce((s, i) => s + i.amount, 0);
      out[ck] = {
        due,
        paid,
        remaining: due - paid,
        income: inc,
        balance: inc - due,
        count: curRows.length,
        paidCount: curRows.filter((r) => r.paid).length,
      };
    });
    return out;
  }

  function computeUnified(rows, monthIncome, currentRate) {
    if (currentRate == null) return null;
    const toBase = (amount, currency) => (currency === BASE_CURRENCY ? amount : amount * currentRate);
    let due = 0,
      paid = 0,
      inc = 0;
    rows.forEach((r) => {
      due += toBase(r.amount, r.currency);
      if (r.paid) paid += toBase(r.amount, r.currency);
    });
    monthIncome.forEach((i) => {
      inc += toBase(i.amount, i.currency);
    });
    return { due, paid, remaining: due - paid, income: inc, balance: inc - due };
  }

  // ---------- 还款项操作 ----------
  function togglePaid(billId) {
    const monthPaid = state.payments[mKey()] || {};
    const currentlyPaid = !!monthPaid[billId];
    const nextMonthPaid = { ...monthPaid };
    if (currentlyPaid) {
      delete nextMonthPaid[billId];
    } else {
      nextMonthPaid[billId] = true;
      state.stampingId = billId;
      setTimeout(() => {
        state.stampingId = null;
        render();
      }, 420);
    }
    state.payments[mKey()] = nextMonthPaid;
    persist();
    render();
  }

  function markAll(paidValue) {
    const rows = computeRows();
    if (rows.length === 0) return;
    const nextMonthPaid = { ...(state.payments[mKey()] || {}) };
    rows.forEach((r) => {
      if (paidValue) nextMonthPaid[r.id] = true;
      else delete nextMonthPaid[r.id];
    });
    state.payments[mKey()] = nextMonthPaid;
    persist();
    flashToast(paidValue ? "本月已全部标记为已缴" : "本月已全部标记为待缴");
    render();
  }

  function openAddForm() {
    state.editingId = null;
    state.form = { name: "", category: "bank", currency: "SGD", amount: "", dueDay: "", note: "" };
    state.formOpen = true;
    render();
  }

  function openEditForm(bill) {
    state.editingId = bill.id;
    state.form = {
      name: bill.name,
      category: bill.category,
      currency: bill.currency || "SGD",
      amount: String(bill.amount),
      dueDay: String(bill.dueDay),
      note: bill.note || "",
    };
    state.formOpen = true;
    render();
  }

  function submitForm(e) {
    e.preventDefault();
    const amount = parseFloat(state.form.amount);
    const dueDay = parseInt(state.form.dueDay, 10);
    if (!state.form.name.trim() || isNaN(amount) || amount <= 0 || isNaN(dueDay) || dueDay < 1 || dueDay > 31) return;
    if (state.editingId) {
      state.bills = state.bills.map((b) =>
        b.id === state.editingId
          ? { ...b, name: state.form.name.trim(), category: state.form.category, currency: state.form.currency, amount, dueDay, note: state.form.note.trim() }
          : b
      );
    } else {
      state.bills.push({
        id: uid(),
        name: state.form.name.trim(),
        category: state.form.category,
        currency: state.form.currency,
        amount,
        dueDay,
        note: state.form.note.trim(),
      });
    }
    persist();
    state.formOpen = false;
    state.editingId = null;
    render();
  }

  function deleteBill(id) {
    state.bills = state.bills.filter((b) => b.id !== id);
    Object.keys(state.payments).forEach((mk) => {
      if (state.payments[mk] && state.payments[mk][id] != null) {
        const rest = { ...state.payments[mk] };
        delete rest[id];
        state.payments[mk] = rest;
      }
    });
    persist();
    state.confirmDeleteId = null;
    render();
  }

  // ---------- 收入操作 ----------
  function submitIncome(e) {
    e.preventDefault();
    const amount = parseFloat(state.incomeForm.amount);
    if (isNaN(amount) || amount <= 0) return;
    const entry = { id: uid(), amount, currency: state.incomeForm.currency, note: state.incomeForm.note.trim() };
    state.income[mKey()] = [...(state.income[mKey()] || []), entry];
    persist();
    state.incomeForm = { amount: "", currency: "SGD", note: "" };
    state.incomeFormOpen = false;
    render();
  }

  function deleteIncome(id) {
    state.income[mKey()] = (state.income[mKey()] || []).filter((i) => i.id !== id);
    persist();
    render();
  }

  function shiftMonth(delta) {
    state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + delta, 1);
    const cur = getRateForMonth(mKey());
    state.rateDraft = cur != null ? String(cur) : "";
    render();
  }
  function goToday() {
    state.viewDate = new Date();
    const cur = getRateForMonth(mKey());
    state.rateDraft = cur != null ? String(cur) : "";
    render();
  }

  // ---------- 备份导出/导入 ----------
  function exportBackup() {
    const payload = JSON.stringify(
      { bills: state.bills, payments: state.payments, income: state.income, exchangeRates: state.exchangeRates },
      null,
      2
    );
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `还款助理备份-${monthKey(today)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flashToast("备份已导出");
  }

  function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!Array.isArray(parsed.bills)) throw new Error("格式不正确");
        state.bills = parsed.bills || [];
        state.payments = parsed.payments || {};
        state.income = parsed.income || {};
        state.exchangeRates = parsed.exchangeRates || {};
        persist();
        flashToast("导入成功");
      } catch (err) {
        flashToast("导入失败：文件格式不正确");
      } finally {
        e.target.value = "";
        render();
      }
    };
    reader.readAsText(file);
  }

  // ---------- 渲染 ----------
  function render() {
    const root = document.getElementById("root");
    if (!state.loaded) {
      root.innerHTML = '<div class="empty-state">正在加载数据…</div>';
      return;
    }

    const mk = mKey();
    const isCurrentMonth = mk === monthKey(today);
    const currentRate = getRateForMonth(mk);
    if (state.rateDraft === "" && currentRate != null && document.activeElement?.id !== "rateInput") {
      state.rateDraft = String(currentRate);
    }

    const rows = computeRows();
    const monthIncome = computeMonthIncome();
    const currencyKeys = computeCurrencyKeys(rows, monthIncome);
    const byCurrency = computeByCurrency(rows, monthIncome, currencyKeys);
    const unified = computeUnified(rows, monthIncome, currentRate);
    const totalBillCount = rows.length;
    const totalPaidCount = rows.filter((r) => r.paid).length;
    const progressPct = totalBillCount ? Math.round((totalPaidCount / totalBillCount) * 100) : 0;

    const filteredRows = rows.filter((r) => {
      if (state.filter === "unpaid") return !r.paid;
      if (state.filter === "paid") return r.paid;
      if (state.filter === "overdue") return r.overdue;
      return true;
    });

    let html = "";

    // header
    html += `
      <div class="header">
        <div class="title"><span class="title-mark"></span>还款助理</div>
        <div class="month-nav">
          <button id="prevMonthBtn" aria-label="上一月">‹</button>
          <span class="mlabel">${monthLabel(state.viewDate)}</span>
          <button id="nextMonthBtn" aria-label="下一月">›</button>
          ${!isCurrentMonth ? `<span class="today-link" id="todayLink">回到本月</span>` : ""}
        </div>
      </div>
      <div class="backup-row">
        <button class="backup-btn" id="exportBtn">导出备份</button>
        <button class="backup-btn" id="importTriggerBtn">导入备份</button>
        <button class="install-btn" id="installBtn">⬇ 安装到主屏幕</button>
        <input id="importFile" type="file" accept="application/json" style="display:none" />
      </div>
    `;

    if (state.saveError) {
      html += `<div class="save-warn">保存失败，刚才的更改可能没有同步，请重试一次。</div>`;
    }

    // 收入
    html += `
      <div class="section-label">
        <span>本月收入</span>
        <span class="add-inline" id="toggleIncomeForm">${state.incomeFormOpen ? "取消" : "+ 记录收入"}</span>
      </div>
    `;

    if (state.incomeFormOpen) {
      html += `
        <form class="form-panel" id="incomeForm" style="margin-bottom:10px;">
          <div class="form-grid">
            <div class="field">
              <label>金额</label>
              <input type="number" step="0.01" min="0.01" id="incomeAmount" value="${esc(state.incomeForm.amount)}" placeholder="0.00" required />
            </div>
            <div class="field">
              <label>货币</label>
              <select id="incomeCurrency">
                ${CURRENCIES.map((c) => `<option value="${c.key}" ${state.incomeForm.currency === c.key ? "selected" : ""}>${c.label} (${c.key})</option>`).join("")}
              </select>
            </div>
            <div class="field full">
              <label>备注（可选，例如：底薪 / 奖金）</label>
              <input id="incomeNote" value="${esc(state.incomeForm.note)}" placeholder="底薪" />
            </div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn-secondary" id="cancelIncomeForm">取消</button>
            <button type="submit" class="btn-primary teal">添加</button>
          </div>
        </form>
      `;
    }

    html += `<div class="income-card">`;
    if (monthIncome.length === 0) {
      html += `<div class="income-empty">本月还没有记录收入</div>`;
    } else {
      monthIncome.forEach((it) => {
        html += `
          <div class="income-row">
            <span>${curInfo(it.currency).label} (${it.currency})${it.note ? `<span class="income-note">· ${esc(it.note)}</span>` : ""}</span>
            <span>
              <span class="income-amt mono">${fmtCur(it.currency, it.amount)}</span>
              <button class="income-del" data-income-id="${it.id}" aria-label="删除">✕</button>
            </span>
          </div>
        `;
      });
    }
    html += `</div>`;

    // 汇率 + 统一总览
    html += `
      <div class="section-label"><span>汇率与统一总览</span></div>
      <div class="rate-box">
        <span class="rlabel">本月汇率 · 1 SGD = </span>
        <input id="rateInput" value="${esc(state.rateDraft)}" placeholder="如 3.30" inputmode="decimal" />
        <span class="rlabel">MYR</span>
        <button class="rate-save" id="rateSaveBtn">保存</button>
      </div>
    `;

    if (unified) {
      html += `
        <div class="unified-card">
          <div class="unified-head">统一总览（全部换算为 MYR）</div>
          <div class="unified-total mono">RM ${fmtMoney(unified.due)}</div>
          <div class="unified-lines mono">
            <span class="paid">已缴 RM ${fmtMoney(unified.paid)}</span>
            <span class="remain">待缴 RM ${fmtMoney(unified.remaining)}</span>
            ${monthIncome.length > 0 ? `<span class="${unified.balance >= 0 ? "bal-pos" : "bal-neg"}">预计结余 RM ${fmtMoney(unified.balance)}</span>` : ""}
          </div>
          <div class="unified-hint">按当月汇率折算，仅供参考，具体请以银行实际扣账汇率为准</div>
        </div>
      `;
    } else {
      html += `<div class="unified-hint" style="margin-bottom:10px;">设置上方汇率后，可查看新币+令吉合并的统一总览</div>`;
    }

    // 按货币统计
    html += `
      <div class="section-label"><span>还款状况（按货币）</span></div>
      <div class="cur-summary-grid">
    `;
    currencyKeys.forEach((ck) => {
      const d = byCurrency[ck];
      const pct = d.count ? Math.round((d.paidCount / d.count) * 100) : 0;
      html += `
        <div class="cur-card">
          <div class="cur-card-head">
            <span class="cur-name">${curInfo(ck).label}（${ck}）</span>
            <span class="cur-count mono">${d.paidCount}/${d.count} 项</span>
          </div>
          <div class="cur-due mono">${fmtCur(ck, d.due)}</div>
          <div class="cur-line"><span class="k">已缴</span><span class="paid mono">${fmtCur(ck, d.paid)}</span></div>
          <div class="cur-line"><span class="k">待缴</span><span class="remain mono">${fmtCur(ck, d.remaining)}</span></div>
          ${
            d.income > 0
              ? `
            <div class="cur-line"><span class="k">本月收入</span><span class="mono">${fmtCur(ck, d.income)}</span></div>
            <div class="cur-line"><span class="k">预计结余</span><span class="mono ${d.balance >= 0 ? "balance-pos" : "balance-neg"}">${fmtCur(ck, d.balance)}</span></div>
          `
              : ""
          }
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    });
    html += `</div>`;
    html += `<div class="overall-progress mono">全部货币合计：${totalPaidCount}/${totalBillCount} 项已缴（${progressPct}%）</div>`;

    // 一键操作
    html += `
      <div class="quick-actions">
        <button class="quick-btn" id="markAllPaidBtn">本月全部标记已缴</button>
        <button class="quick-btn" id="markAllUnpaidBtn">本月全部标记待缴</button>
      </div>
    `;

    // 工具栏
    html += `
      <div class="toolbar">
        <div class="filters">
          ${[
            ["all", "全部"],
            ["unpaid", "待缴"],
            ["paid", "已缴"],
            ["overdue", "逾期"],
          ]
            .map(
              ([key, label]) =>
                `<button class="filter-chip ${state.filter === key ? "active" : ""}" data-filter="${key}">${label}</button>`
            )
            .join("")}
        </div>
        <button class="add-btn" id="toggleAddForm">${state.formOpen ? "取消" : "+ 新增还款项"}</button>
      </div>
    `;

    if (state.formOpen) {
      html += `
        <form class="form-panel" id="billForm">
          <div class="form-grid">
            <div class="field full">
              <label>名称（如：招商银行房贷 / 花呗 / Netflix）</label>
              <input id="billName" value="${esc(state.form.name)}" placeholder="请输入名称" required />
            </div>
            <div class="field full">
              <label>类别</label>
              <div class="cat-picker">
                ${CATS.map(
                  (c) =>
                    `<div class="cat-opt ${state.form.category === c.key ? "active" : ""}" data-cat="${c.key}" style="${state.form.category === c.key ? `color:${c.color}` : ""}">${c.label}</div>`
                ).join("")}
              </div>
            </div>
            <div class="field">
              <label>货币</label>
              <select id="billCurrency">
                ${CURRENCIES.map((c) => `<option value="${c.key}" ${state.form.currency === c.key ? "selected" : ""}>${c.label} (${c.key})</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>每月金额</label>
              <input type="number" step="0.01" min="0.01" id="billAmount" value="${esc(state.form.amount)}" placeholder="0.00" required />
            </div>
            <div class="field">
              <label>每月还款日（1-31号）</label>
              <input type="number" min="1" max="31" id="billDueDay" value="${esc(state.form.dueDay)}" placeholder="如：5" required />
            </div>
            <div class="field full">
              <label>备注（可选）</label>
              <input id="billNote" value="${esc(state.form.note)}" placeholder="例如：自动扣账账户、卡号后四位等" />
            </div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn-secondary" id="cancelBillForm">取消</button>
            <button type="submit" class="btn-primary">${state.editingId ? "保存修改" : "添加"}</button>
          </div>
        </form>
      `;
    }

    html += `<div class="section-label"><span>还款明细</span></div><div class="bill-list">`;
    if (filteredRows.length === 0) {
      html += `
        <div class="empty-state">
          <div class="big">${state.bills.length === 0 ? "还没有添加任何还款项" : "这个筛选条件下没有记录"}</div>
          <div>${state.bills.length === 0 ? "点击上方「+ 新增还款项」，开始记录发薪后要还的钱" : ""}</div>
        </div>
      `;
    } else {
      filteredRows.forEach((r) => {
        const cat = catInfo(r.category);
        const isConfirming = state.confirmDeleteId === r.id;
        html += `
          <div class="bill-row ${r.paid ? "paid" : ""} ${r.overdue ? "overdue" : ""}" data-bill-id="${r.id}">
            <span class="cat-tag" style="color:${cat.color};background:${cat.bg}">${cat.label}</span>
            <div class="bill-main" data-edit-id="${r.id}" style="cursor:pointer">
              <div class="bill-name">${esc(r.name)}</div>
              <div class="bill-meta">
                <span class="cur-tag">${r.currency}</span>
                <span>每月 ${r.dueDay} 号</span>
                ${r.note ? `<span>· ${esc(r.note)}</span>` : ""}
                ${r.overdue ? `<span class="overdue-flag">已逾期</span>` : ""}
              </div>
            </div>
            <div class="bill-amount mono">${fmtCur(r.currency, r.amount)}</div>
            ${
              isConfirming
                ? `
              <div class="confirm-del">
                <span>删除？</span>
                <button class="confirm-yes" data-del-yes="${r.id}">确定</button>
                <button class="confirm-no" data-del-no="1">取消</button>
              </div>
            `
                : `
              <button class="stamp-btn ${r.paid ? "is-paid" : ""} ${state.stampingId === r.id ? "stamping" : ""}" data-toggle-id="${r.id}">${r.paid ? "已缴 ✓" : "标记已缴"}</button>
              <button class="icon-btn" data-del-id="${r.id}" aria-label="删除">✕</button>
            `
            }
          </div>
        `;
      });
    }
    html += `</div>`;

    root.innerHTML = html;
    attachEvents();
  }

  function attachEvents() {
    const $ = (id) => document.getElementById(id);

    $("prevMonthBtn") && ($("prevMonthBtn").onclick = () => shiftMonth(-1));
    $("nextMonthBtn") && ($("nextMonthBtn").onclick = () => shiftMonth(1));
    $("todayLink") && ($("todayLink").onclick = goToday);

    $("exportBtn") && ($("exportBtn").onclick = exportBackup);
    $("importTriggerBtn") && ($("importTriggerBtn").onclick = () => $("importFile").click());
    $("importFile") && ($("importFile").onchange = handleImportFile);

    $("toggleIncomeForm") &&
      ($("toggleIncomeForm").onclick = () => {
        state.incomeFormOpen = !state.incomeFormOpen;
        render();
      });
    $("cancelIncomeForm") &&
      ($("cancelIncomeForm").onclick = () => {
        state.incomeFormOpen = false;
        render();
      });
    $("incomeForm") &&
      ($("incomeForm").onsubmit = (e) => {
        e.preventDefault();
        state.incomeForm.amount = $("incomeAmount").value;
        state.incomeForm.currency = $("incomeCurrency").value;
        state.incomeForm.note = $("incomeNote").value;
        submitIncome(e);
      });

    document.querySelectorAll(".income-del").forEach((btn) => {
      btn.onclick = () => deleteIncome(btn.dataset.incomeId);
    });

    $("rateInput") &&
      ($("rateInput").oninput = (e) => {
        state.rateDraft = e.target.value;
      });
    $("rateInput") && ($("rateInput").onblur = applyRate);
    $("rateInput") &&
      ($("rateInput").onkeydown = (e) => {
        if (e.key === "Enter") applyRate();
      });
    $("rateSaveBtn") && ($("rateSaveBtn").onclick = applyRate);

    $("markAllPaidBtn") && ($("markAllPaidBtn").onclick = () => markAll(true));
    $("markAllUnpaidBtn") && ($("markAllUnpaidBtn").onclick = () => markAll(false));

    document.querySelectorAll(".filter-chip").forEach((btn) => {
      btn.onclick = () => {
        state.filter = btn.dataset.filter;
        render();
      };
    });

    $("toggleAddForm") &&
      ($("toggleAddForm").onclick = () => {
        if (state.formOpen) {
          state.formOpen = false;
          render();
        } else {
          openAddForm();
        }
      });
    $("cancelBillForm") &&
      ($("cancelBillForm").onclick = () => {
        state.formOpen = false;
        render();
      });

    document.querySelectorAll(".cat-opt").forEach((el) => {
      el.onclick = () => {
        state.form.category = el.dataset.cat;
        render();
      };
    });

    $("billForm") &&
      ($("billForm").onsubmit = (e) => {
        e.preventDefault();
        state.form.name = $("billName").value;
        state.form.currency = $("billCurrency").value;
        state.form.amount = $("billAmount").value;
        state.form.dueDay = $("billDueDay").value;
        state.form.note = $("billNote").value;
        submitForm(e);
      });

    document.querySelectorAll("[data-edit-id]").forEach((el) => {
      el.onclick = () => {
        const bill = state.bills.find((b) => b.id === el.dataset.editId);
        if (bill) openEditForm(bill);
      };
    });

    document.querySelectorAll("[data-toggle-id]").forEach((el) => {
      el.onclick = () => togglePaid(el.dataset.toggleId);
    });

    document.querySelectorAll("[data-del-id]").forEach((el) => {
      el.onclick = () => {
        state.confirmDeleteId = el.dataset.delId;
        render();
      };
    });
    document.querySelectorAll("[data-del-yes]").forEach((el) => {
      el.onclick = () => deleteBill(el.dataset.delYes);
    });
    document.querySelectorAll("[data-del-no]").forEach((el) => {
      el.onclick = () => {
        state.confirmDeleteId = null;
        render();
      };
    });
  }

  // ---------- 启动 ----------
  loadData();
  const initRate = getRateForMonth(mKey());
  state.rateDraft = initRate != null ? String(initRate) : "";
  render();

  // ---------- PWA 安装提示 ----------
  let deferredPrompt;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById("installBtn");
    if (btn) btn.style.display = "inline-flex";
  });
  document.addEventListener("click", async (e) => {
    if (e.target && e.target.id === "installBtn") {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        e.target.style.display = "none";
      } else {
        flashToast("请使用浏览器菜单中的「添加到主屏幕」");
      }
    }
  });

  function isIOS() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  }
  function isInStandaloneMode() {
    return "standalone" in window.navigator && window.navigator.standalone;
  }
  window.addEventListener("load", () => {
    if (isIOS() && !isInStandaloneMode()) {
      setTimeout(() => {
        const tip = document.createElement("div");
        tip.className = "ios-tip";
        tip.innerHTML = `
          <div class="ios-tip-title">📱 安装到 iPhone</div>
          <div>点击 Safari 的 <b>分享按钮</b><br>然后选择 <b>「添加到主屏幕」</b></div>
          <button id="closeIosTip">知道了</button>
        `;
        document.body.appendChild(tip);
        document.getElementById("closeIosTip").onclick = () => tip.remove();
      }, 1500);
    }
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
})();
