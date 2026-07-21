const registry = require('./handler-registry');
const expenseService = require('../services/expense.service');
const logger = require('../utils/logger');

const CATEGORY_EMOJIS = {
  food: '',
  transport: '',
  shopping: '',
  bills: '',
  entertainment: '',
  health: '',
  education: '',
  travel: '',
  groceries: '',
  other: '',
};

const CURRENCY_SYMBOLS = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

registry.register('expense_manage', async (message, context) => {
  const { text } = message;
  const { userPhone, intentParams } = context;

  try {
    // ── LLM Params-First Routing ──────────────────────────────────────
    if (intentParams?.action) {
      switch (intentParams.action) {
        case 'update_by_category': {
          if (intentParams.category && intentParams.new_amount > 0) {
            const category = intentParams.category === 'coffee' ? 'food' : intentParams.category;
            const result = await expenseService.updateExpenseByCategory(userPhone, category, intentParams.new_amount);
            if (!result.success) return `${result.error}`;
            const e = result.expense;
            const emoji = CATEGORY_EMOJIS[e.category] || '';
            const sym = CURRENCY_SYMBOLS[e.currency] || e.currency;
            return `Expense Updated\n━━━━━━━━━━━━\n${emoji} ${_capitalise(e.category)}: ${sym}${_formatAmount(e.amount)}`;
          }
          break;
        }
        case 'update_by_id': {
          if (intentParams.expense_id && intentParams.new_amount > 0) {
            const result = await expenseService.updateExpenseById(userPhone, intentParams.expense_id, intentParams.new_amount);
            if (!result.success) return `${result.error}`;
            const e = result.expense;
            const emoji = CATEGORY_EMOJIS[e.category] || '';
            const sym = CURRENCY_SYMBOLS[e.currency] || e.currency;
            return `Expense Updated\n━━━━━━━━━━━━\n${emoji} ${_capitalise(e.category)}: ${sym}${_formatAmount(e.amount)}`;
          }
          break;
        }
        case 'delete': {
          if (intentParams.expense_id) {
            const result = await expenseService.deleteExpense(userPhone, intentParams.expense_id);
            if (!result.success) return `${result.error}`;
            const e = result.expense;
            const sym = CURRENCY_SYMBOLS[e.currency] || e.currency;
            return `Expense Deleted\n━━━━━━━━━━━━\n${sym}${_formatAmount(e.amount)} — ${e.description || e.category}`;
          }
          break;
        }
        case 'summary': {
          const period = intentParams.period || 'month';
          const summary = await expenseService.getSummary(userPhone, period);
          const periodLabel = _formatPeriodLabel(period);

          if (summary.count === 0) {
            return `Expense Summary (${periodLabel})\n━━━━━━━━━━━━\nNo expenses recorded for this period.\n\nAdd one with "spent 500 on lunch"!`;
          }

          const sym = '₹';
          let response = `Expense Summary (${periodLabel})\n━━━━━━━━━━━━\n`;
          response += `Total: ${sym}${_formatAmount(summary.totalSpent)}\n`;
          response += `Transactions: ${summary.count}\n`;
          response += `Avg/day: ${sym}${_formatAmount(summary.avgPerDay)}\n`;

          if (summary.categoryBreakdown.length > 0) {
            response += `\nBy Category:\n`;
            for (const cat of summary.categoryBreakdown) {
              const emoji = CATEGORY_EMOJIS[cat.category] || '';
              const pct = summary.totalSpent > 0
                ? Math.round((cat.total / summary.totalSpent) * 100)
                : 0;
              response += `${emoji} ${_capitalise(cat.category)}: ${sym}${_formatAmount(cat.total)} (${pct}%)\n`;
            }
          }

          return response.trim();
        }
        case 'list': {
          const period = intentParams.period || 'month';
          const expenses = await expenseService.getExpenses(userPhone, period);
          const periodLabel = _formatPeriodLabel(period);

          if (expenses.length === 0) {
            return `Expenses (${periodLabel})\n━━━━━━━━━━━━\nNo expenses found for this period.\n\nAdd one with "spent 500 on lunch"!`;
          }

          let totalAmount = 0;
          let response = `Expenses (${periodLabel})\n━━━━━━━━━━━━\n`;

          const displayLimit = Math.min(expenses.length, 15);
          for (let i = 0; i < displayLimit; i++) {
            const e = expenses[i];
            const emoji = CATEGORY_EMOJIS[e.category] || '';
            const sym = CURRENCY_SYMBOLS[e.currency] || e.currency;
            const date = new Date(e.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            const desc = e.description || e.category;
            response += `\n${i + 1}. ${emoji} ${sym}${_formatAmount(e.amount)} — ${desc} (${date})`;
            totalAmount += parseFloat(e.amount);
          }

          if (expenses.length > displayLimit) {
            response += `\n\n... and ${expenses.length - displayLimit} more`;
          }

          response += `\n\nTotal: ₹${_formatAmount(totalAmount)}`;
          return response;
        }
        case 'multi_log': {
          if (intentParams.items && intentParams.items.length >= 2) {
            let addedCount = 0;
            let totalAdded = 0;
            let responseLines = [];

            for (const item of intentParams.items) {
              const amount = parseFloat(item.amount);
              if (!amount || amount <= 0) continue;
              const category = item.category || 'other';
              const description = item.description || category;
              const currency = item.currency || intentParams.currency || 'INR';

              const res = await expenseService.addExpense(userPhone, amount, category, description, currency);
              if (res.success) {
                const emoji = CATEGORY_EMOJIS[res.expense.category] || '';
                const sym = CURRENCY_SYMBOLS[res.expense.currency] || res.expense.currency;
                responseLines.push(`${emoji} ${sym}${_formatAmount(res.expense.amount)} — ${res.expense.description || res.expense.category}`);
                totalAdded += parseFloat(res.expense.amount);
                addedCount++;
              }
            }

            if (addedCount > 0) {
              let response = `${addedCount} Expense${addedCount > 1 ? 's' : ''} Added\n━━━━━━━━━━━━\n`;
              response += responseLines.join('\n');
              response += `\n\nTotal: ₹${_formatAmount(totalAdded)}`;
              return response;
            }
          }
          break;
        }
        case 'log': {
          if (intentParams.amount > 0) {
            const result = await expenseService.addExpense(
              userPhone,
              intentParams.amount,
              intentParams.category || 'other',
              intentParams.description || intentParams.category || null,
              intentParams.currency || 'INR'
            );

            if (!result.success) return `${result.error}`;

            const e = result.expense;
            const emoji = CATEGORY_EMOJIS[e.category] || '';
            const sym = CURRENCY_SYMBOLS[e.currency] || e.currency;

            let response = `Expense Added\n━━━━━━━━━━━━\n`;
            response += `Amount: ${sym}${_formatAmount(e.amount)}\n`;
            response += `${emoji} Category: ${_capitalise(e.category)}\n`;
            if (e.description) {
              response += `Description: ${e.description}\n`;
            }
            response += `Date: ${new Date(e.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;

            return response;
          }
          break;
        }
      }
    }

    // ── Regex Fallback (existing code, unchanged) ─────────────────────
    const lower = text.toLowerCase().trim();

    // ── Update Expense by Category ────────────────────────────────────
    // Handles: "update transport from 1500 to 2000", "change food to 800", "edit transport to 2000"
    const KNOWN_CATEGORIES = 'food|transport|shopping|bills|entertainment|health|education|travel|groceries|other|coffee';
    const updateMatch = lower.match(
      new RegExp(`\\b(?:update|change|edit|modify|correct|fix)\\b[^\\d]*\\b(${KNOWN_CATEGORIES})\\b[^\\d]*(?:(?:expense|spending)\\b[^\\d]*)?(?:from\\s+[\\d,]+\\s+to\\s+|to\\s+)([\\d,]+)`, 'i')
    );
    if (updateMatch) {
      // "coffee" maps to food category since that's how it's stored
      const rawCat = updateMatch[1].toLowerCase();
      const category = rawCat === 'coffee' ? 'food' : rawCat;
      const newAmount = parseFloat(updateMatch[2].replace(/,/g, ''));
      if (newAmount > 0) {
        const result = await expenseService.updateExpenseByCategory(userPhone, category, newAmount);
        if (!result.success) return `${result.error}`;
        const e = result.expense;
        const emoji = CATEGORY_EMOJIS[e.category] || '';
        const sym = CURRENCY_SYMBOLS[e.currency] || e.currency;
        return `Expense Updated\n━━━━━━━━━━━━\n${emoji} ${_capitalise(e.category)}: ${sym}${_formatAmount(e.amount)}`;
      }
    }

    // ── Update Expense by ID ──────────────────────────────────────────
    // Handles: "update expense #3 to 500"
    const updateByIdMatch = lower.match(/\b(?:update|change|edit)\b.*\bexpense\b.*#?(\d+).*\bto\s+([\d,]+)/i);
    if (updateByIdMatch) {
      const expenseId = parseInt(updateByIdMatch[1]);
      const newAmount = parseFloat(updateByIdMatch[2].replace(/,/g, ''));
      if (newAmount > 0) {
        const result = await expenseService.updateExpenseById(userPhone, expenseId, newAmount);
        if (!result.success) return `${result.error}`;
        const e = result.expense;
        const emoji = CATEGORY_EMOJIS[e.category] || '';
        const sym = CURRENCY_SYMBOLS[e.currency] || e.currency;
        return `Expense Updated\n━━━━━━━━━━━━\n${emoji} ${_capitalise(e.category)}: ${sym}${_formatAmount(e.amount)}`;
      }
    }

    // ── Delete Expense ────────────────────────────────────────────────
    if (/\b(?:delete|remove)\s+expense\b/i.test(lower)) {
      const idMatch = lower.match(/#?(\d+)/);
      if (!idMatch) {
        return 'Please specify the expense ID to delete.\nExample: "delete expense #3"';
      }

      const expenseId = parseInt(idMatch[1]);
      const result = await expenseService.deleteExpense(userPhone, expenseId);

      if (!result.success) {
        return `${result.error}`;
      }

      const e = result.expense;
      const sym = CURRENCY_SYMBOLS[e.currency] || e.currency;
      return `Expense Deleted\n━━━━━━━━━━━━\n${sym}${_formatAmount(e.amount)} — ${e.description || e.category}`;
    }

    // ── Expense Summary ───────────────────────────────────────────────
    if (/\b(?:expense\s*summar|spending\s*summar|how\s+much\s+(?:did\s+i|have\s+i)\s+spen|total\s+spen)/i.test(lower)) {
      const period = _detectPeriod(lower);
      const summary = await expenseService.getSummary(userPhone, period);
      const periodLabel = _formatPeriodLabel(period);

      if (summary.count === 0) {
        return `Expense Summary (${periodLabel})\n━━━━━━━━━━━━\nNo expenses recorded for this period.\n\nAdd one with "spent 500 on lunch"!`;
      }

      const sym = '₹'; // default display currency
      let response = `Expense Summary (${periodLabel})\n━━━━━━━━━━━━\n`;
      response += `Total: ${sym}${_formatAmount(summary.totalSpent)}\n`;
      response += `Transactions: ${summary.count}\n`;
      response += `Avg/day: ${sym}${_formatAmount(summary.avgPerDay)}\n`;

      if (summary.categoryBreakdown.length > 0) {
        response += `\nBy Category:\n`;
        for (const cat of summary.categoryBreakdown) {
          const emoji = CATEGORY_EMOJIS[cat.category] || '';
          const pct = summary.totalSpent > 0
            ? Math.round((cat.total / summary.totalSpent) * 100)
            : 0;
          response += `${emoji} ${_capitalise(cat.category)}: ${sym}${_formatAmount(cat.total)} (${pct}%)\n`;
        }
      }

      return response.trim();
    }

    // ── List Expenses ─────────────────────────────────────────────────
    if (/\b(?:expenses?|spending|spendings)\s*(?:today|this\s*week|this\s*month|list|show|view|all)/i.test(lower) ||
        /\b(?:show|list|view|get|my)\s*(?:expenses?|spending)/i.test(lower)) {
      const period = _detectPeriod(lower);
      const expenses = await expenseService.getExpenses(userPhone, period);
      const periodLabel = _formatPeriodLabel(period);

      if (expenses.length === 0) {
        return `Expenses (${periodLabel})\n━━━━━━━━━━━━\nNo expenses found for this period.\n\nAdd one with "spent 500 on lunch"!`;
      }

      let totalAmount = 0;
      let response = `Expenses (${periodLabel})\n━━━━━━━━━━━━\n`;

      const displayLimit = Math.min(expenses.length, 15);
      for (let i = 0; i < displayLimit; i++) {
        const e = expenses[i];
        const emoji = CATEGORY_EMOJIS[e.category] || '';
        const sym = CURRENCY_SYMBOLS[e.currency] || e.currency;
        const date = new Date(e.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        const desc = e.description || e.category;
        response += `\n${i + 1}. ${emoji} ${sym}${_formatAmount(e.amount)} — ${desc} (${date})`;
        totalAmount += parseFloat(e.amount);
      }

      if (expenses.length > displayLimit) {
        response += `\n\n... and ${expenses.length - displayLimit} more`;
      }

      response += `\n\nTotal: ₹${_formatAmount(totalAmount)}`;
      return response;
    }

    // ── Multi-expense: "track these expenses: 500 food, 200 coffee, 300 transport" ──
    // Detect multiple amounts in a single message (2+ currency amounts)
    const allAmountMatches = [...text.matchAll(/[₹$€£]?\s*(\d+(?:\.\d{1,2})?)\s*(?:on|for|-)?\s*([a-zA-Z][a-zA-Z\s]*?)(?=[,\n;]|$)/g)]
      .filter(m => parseFloat(m[1]) > 0);

    if (allAmountMatches.length >= 2) {
      let addedCount = 0;
      let totalAdded = 0;
      let responseLines = [];

      for (const match of allAmountMatches) {
        const amount = parseFloat(match[1]);
        const descRaw = (match[2] || '').trim().replace(/\b(track|add|log|all|these|expenses?)\b/gi, '').trim();
        if (!descRaw || amount <= 0) continue;

        const singleParsed = expenseService.parseExpenseFromText(`spent ${amount} on ${descRaw}`);
        if (!singleParsed || !singleParsed.amount) continue;

        const res = await expenseService.addExpense(userPhone, singleParsed.amount, singleParsed.category, singleParsed.description, singleParsed.currency);
        if (res.success) {
          const emoji = CATEGORY_EMOJIS[res.expense.category] || '';
          const sym = CURRENCY_SYMBOLS[res.expense.currency] || res.expense.currency;
          responseLines.push(`${emoji} ${sym}${_formatAmount(res.expense.amount)} — ${res.expense.description || res.expense.category}`);
          totalAdded += parseFloat(res.expense.amount);
          addedCount++;
        }
      }

      if (addedCount > 0) {
        let response = `${addedCount} Expense${addedCount > 1 ? 's' : ''} Added\n━━━━━━━━━━━━\n`;
        response += responseLines.join('\n');
        response += `\n\nTotal: ₹${_formatAmount(totalAdded)}`;
        return response;
      }
    }

    // ── Add Expense (default) ─────────────────────────────────────────
    const parsed = expenseService.parseExpenseFromText(text);

    if (!parsed || !parsed.amount) {
      return 'Could not parse expense. Please try:\n• "spent 500 on lunch"\n• "add expense 2000 groceries"\n• "₹300 coffee"';
    }

    const result = await expenseService.addExpense(
      userPhone,
      parsed.amount,
      parsed.category,
      parsed.description,
      parsed.currency
    );

    if (!result.success) {
      return `${result.error}`;
    }

    const e = result.expense;
    const emoji = CATEGORY_EMOJIS[e.category] || '';
    const sym = CURRENCY_SYMBOLS[e.currency] || e.currency;

    let response = `Expense Added\n━━━━━━━━━━━━\n`;
    response += `Amount: ${sym}${_formatAmount(e.amount)}\n`;
    response += `${emoji} Category: ${_capitalise(e.category)}\n`;
    if (e.description) {
      response += `Description: ${e.description}\n`;
    }
    response += `Date: ${new Date(e.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;

    return response;

  } catch (error) {
    logger.error('Expense handler error:', error.message);
    return 'Something went wrong with expense tracking. Please try again.';
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

function _detectPeriod(lower) {
  if (/\btoday\b/i.test(lower)) return 'today';
  if (/\bweek\b/i.test(lower)) return 'week';
  if (/\byear\b/i.test(lower)) return 'year';
  return 'month';
}

function _formatPeriodLabel(period) {
  switch (period) {
    case 'today': return 'Today';
    case 'week': return 'This Week';
    case 'year': return 'This Year';
    default: {
      const now = new Date();
      return now.toLocaleDateString('en-IN', { month: 'long' });
    }
  }
}

function _formatAmount(amount) {
  const num = parseFloat(amount);
  if (isNaN(num)) return '0';
  return num.toLocaleString('en-IN', {
    minimumFractionDigits: num % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function _capitalise(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}
