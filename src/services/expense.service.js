const { query } = require('../config/database');
const logger = require('../utils/logger');

class ExpenseService {

  constructor() {
    this.tableReady = false;
  }

  // ========== SCHEMA ==========
  async ensureSchema() {
    if (this.tableReady) return;
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS expenses (
          id SERIAL PRIMARY KEY,
          user_phone VARCHAR(50) NOT NULL,
          amount DECIMAL(12,2) NOT NULL,
          currency VARCHAR(10) DEFAULT 'INR',
          category VARCHAR(50),
          description TEXT,
          date DATE DEFAULT CURRENT_DATE,
          receipt_image_url TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_phone)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_phone, date)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_expenses_user_category ON expenses(user_phone, category)`);
      this.tableReady = true;
    } catch (error) {
      logger.error('Error creating expenses table:', error.message);
    }
  }

  // ========== ADD EXPENSE ==========
  async addExpense(userPhone, amount, category, description, currency = 'INR', date = null, receiptUrl = null) {
    await this.ensureSchema();
    try {
      const result = await query(
        `INSERT INTO expenses (user_phone, amount, category, description, currency, date, receipt_image_url)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7)
         RETURNING *`,
        [userPhone, amount, category || 'other', description || null, currency, date || null, receiptUrl || null]
      );
      logger.info(`Expense added: ${amount} ${currency} for ${userPhone}`);
      return { success: true, expense: result.rows[0] };
    } catch (error) {
      logger.error('Error adding expense:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== GET EXPENSES ==========
  async getExpenses(userPhone, period = 'month') {
    await this.ensureSchema();
    try {
      const dateFilter = this._getPeriodFilter(period);
      const result = await query(
        `SELECT * FROM expenses
         WHERE user_phone = $1 AND date >= $2
         ORDER BY date DESC, created_at DESC`,
        [userPhone, dateFilter]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting expenses:', error.message);
      return [];
    }
  }

  // ========== GET SUMMARY ==========
  async getSummary(userPhone, period = 'month') {
    await this.ensureSchema();
    try {
      const dateFilter = this._getPeriodFilter(period);

      const totalResult = await query(
        `SELECT
           COALESCE(SUM(amount), 0) AS total_spent,
           COUNT(*) AS count
         FROM expenses
         WHERE user_phone = $1 AND date >= $2`,
        [userPhone, dateFilter]
      );

      const categoryResult = await query(
        `SELECT
           category,
           SUM(amount) AS total,
           COUNT(*) AS count
         FROM expenses
         WHERE user_phone = $1 AND date >= $2
         GROUP BY category
         ORDER BY total DESC`,
        [userPhone, dateFilter]
      );

      const totalSpent = parseFloat(totalResult.rows[0].total_spent);
      const count = parseInt(totalResult.rows[0].count);

      // Calculate days in period for average
      const now = new Date();
      const start = new Date(dateFilter);
      const days = Math.max(1, Math.ceil((now - start) / (1000 * 60 * 60 * 24)));
      const avgPerDay = count > 0 ? parseFloat((totalSpent / days).toFixed(2)) : 0;

      const categoryBreakdown = categoryResult.rows.map(row => ({
        category: row.category,
        total: parseFloat(row.total),
        count: parseInt(row.count)
      }));

      return {
        totalSpent,
        categoryBreakdown,
        count,
        avgPerDay
      };
    } catch (error) {
      logger.error('Error getting expense summary:', error.message);
      return { totalSpent: 0, categoryBreakdown: [], count: 0, avgPerDay: 0 };
    }
  }

  // ========== UPDATE EXPENSE ==========
  async updateExpenseByCategory(userPhone, category, newAmount) {
    await this.ensureSchema();
    try {
      // Update the most recent expense matching that category
      const result = await query(
        `UPDATE expenses
         SET amount = $1
         WHERE id = (
           SELECT id FROM expenses
           WHERE user_phone = $2 AND LOWER(category) = LOWER($3)
           ORDER BY date DESC, created_at DESC
           LIMIT 1
         )
         RETURNING *`,
        [newAmount, userPhone, category]
      );
      if (result.rows.length === 0) {
        return { success: false, error: `No ${category} expense found to update.` };
      }
      logger.info(`Expense updated: ${category} -> ${newAmount} for ${userPhone}`);
      return { success: true, expense: result.rows[0] };
    } catch (error) {
      logger.error('Error updating expense by category:', error.message);
      return { success: false, error: error.message };
    }
  }

  async updateExpenseById(userPhone, expenseId, newAmount) {
    await this.ensureSchema();
    try {
      const result = await query(
        `UPDATE expenses SET amount = $1 WHERE id = $2 AND user_phone = $3 RETURNING *`,
        [newAmount, expenseId, userPhone]
      );
      if (result.rows.length === 0) {
        return { success: false, error: 'Expense not found.' };
      }
      return { success: true, expense: result.rows[0] };
    } catch (error) {
      logger.error('Error updating expense by id:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== DELETE EXPENSE ==========
  async deleteExpense(userPhone, expenseId) {
    await this.ensureSchema();
    try {
      const result = await query(
        `DELETE FROM expenses WHERE id = $1 AND user_phone = $2 RETURNING *`,
        [expenseId, userPhone]
      );
      if (result.rows.length === 0) {
        return { success: false, error: 'Expense not found.' };
      }
      return { success: true, expense: result.rows[0] };
    } catch (error) {
      logger.error('Error deleting expense:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ========== ADD EXPENSE FROM LLM PARAMS ==========
  // Convenience method for when the LLM has already extracted expense entities.
  // Skips all regex parsing and directly inserts the expense.
  async addExpenseFromParams(userPhone, params) {
    const amount = parseFloat(params.amount);
    if (!amount || amount <= 0) {
      return { success: false, error: 'Invalid amount' };
    }
    return this.addExpense(
      userPhone,
      amount,
      params.category || 'other',
      params.description || params.category || null,
      params.currency || 'INR',
      params.date || null,
      params.receipt_url || null
    );
  }

  // ========== PARSE EXPENSE FROM TEXT ==========
  parseExpenseFromText(text) {
    try {
      const lower = text.toLowerCase().trim();

      // Detect currency
      let currency = 'INR';
      if (/\$|usd|dollars?/i.test(lower)) {
        currency = 'USD';
      } else if (/€|eur|euros?/i.test(lower)) {
        currency = 'EUR';
      } else if (/£|gbp|pounds?/i.test(lower)) {
        currency = 'GBP';
      }
      // INR is default — matches rs, inr, rupees, ₹, or no currency specified

      // Extract amount — match numbers with optional thousands separators and
      // decimals. Comma groups must be exactly 3 digits ("1,000", "12,345.50")
      // so "1,23" doesn't get misread; commas are stripped before parseFloat.
      // Patterns: "spent 500", "spent 1,000", "₹500", "$50.25", "rs 2000"
      let amount = null;
      const amountPatterns = [
        /(?:spent|spend|paid|pay|add\s+expense|expense)\s+(?:rs\.?\s*|₹|\$|€|£|inr\s*|usd\s*|eur\s*|gbp\s*)?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i,
        /(?:rs\.?\s*|₹|\$|€|£|inr\s*|usd\s*|eur\s*|gbp\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i,
        /(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:rs\.?|₹|\$|€|£|rupees?|dollars?|euros?|pounds?)/i,
        /^(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s+/i,
        /\s(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s/i,
        /(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i
      ];

      for (const pattern of amountPatterns) {
        const match = lower.match(pattern);
        if (match) {
          amount = parseFloat(match[1].replace(/,/g, ''));
          break;
        }
      }

      if (!amount || amount <= 0) {
        return null;
      }

      // Detect category from keywords
      const categoryKeywords = {
        food: ['food', 'lunch', 'dinner', 'breakfast', 'snack', 'meal', 'restaurant', 'cafe', 'pizza', 'burger', 'biryani', 'chai', 'tea', 'coffee', 'eat', 'eating', 'swiggy', 'zomato', 'dine'],
        transport: ['transport', 'taxi', 'cab', 'uber', 'ola', 'auto', 'rickshaw', 'bus', 'train', 'metro', 'fuel', 'petrol', 'diesel', 'gas', 'parking', 'toll', 'flight', 'travel fare'],
        shopping: ['shopping', 'clothes', 'shoes', 'amazon', 'flipkart', 'myntra', 'purchase', 'bought', 'buy'],
        bills: ['bill', 'bills', 'electricity', 'water', 'internet', 'wifi', 'phone', 'mobile', 'recharge', 'rent', 'emi', 'insurance', 'subscription'],
        entertainment: ['entertainment', 'movie', 'movies', 'cinema', 'netflix', 'spotify', 'game', 'gaming', 'concert', 'show', 'party'],
        health: ['health', 'medicine', 'medical', 'doctor', 'hospital', 'pharmacy', 'gym', 'fitness', 'yoga', 'dental'],
        education: ['education', 'book', 'books', 'course', 'class', 'tuition', 'school', 'college', 'study', 'udemy', 'coursera'],
        travel: ['travel', 'trip', 'hotel', 'hostel', 'airbnb', 'booking', 'vacation', 'holiday', 'flight', 'airport'],
        groceries: ['grocery', 'groceries', 'vegetables', 'fruits', 'milk', 'eggs', 'supermarket', 'bigbasket', 'blinkit', 'zepto', 'dmart']
      };

      // Word-boundary match, not substring: .includes() made the food keyword
      // "chai" fire inside "chair" (and "eat" inside "theater"), miscategorizing
      // unrelated expenses. Keywords are plain words/phrases, so \b is safe.
      let category = 'other';
      for (const [cat, keywords] of Object.entries(categoryKeywords)) {
        if (keywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(lower))) {
          category = cat;
          break;
        }
      }

      // Extract description — remove the amount and currency/command parts
      let description = text
        .replace(/(?:spent|spend|paid|pay|add\s+expense|expense)\s*/gi, '')
        .replace(/(?:rs\.?\s*|₹|\$|€|£|inr\s*|usd\s*|eur\s*|gbp\s*)\d+(?:,\d{3})*(?:\.\d{1,2})?/gi, '')
        .replace(/\d+(?:,\d{3})*(?:\.\d{1,2})?\s*(?:rs\.?|₹|\$|€|£|rupees?|dollars?|euros?|pounds?)/gi, '')
        .replace(/\d+(?:,\d{3})*(?:\.\d{1,2})?/g, '')
        .replace(/\b(?:on|for|at|in|to)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!description || description.length < 2) {
        description = category !== 'other' ? category : null;
      }

      return { amount, category, description, currency };
    } catch (error) {
      logger.error('Error parsing expense text:', error.message);
      return null;
    }
  }

  // ========== CATEGORY BREAKDOWN WITH PERCENTAGES ==========
  async getCategoryBreakdown(userPhone, period = 'month') {
    await this.ensureSchema();
    try {
      const dateFilter = this._getPeriodFilter(period);

      const result = await query(
        `SELECT
           category,
           SUM(amount) AS total,
           COUNT(*) AS count
         FROM expenses
         WHERE user_phone = $1 AND date >= $2
         GROUP BY category
         ORDER BY total DESC`,
        [userPhone, dateFilter]
      );

      if (result.rows.length === 0) {
        return { categories: [], grandTotal: 0 };
      }

      const grandTotal = result.rows.reduce((sum, row) => sum + parseFloat(row.total), 0);

      const categories = result.rows.map(row => {
        const total = parseFloat(row.total);
        return {
          category: row.category,
          total,
          count: parseInt(row.count),
          percentage: grandTotal > 0 ? parseFloat(((total / grandTotal) * 100).toFixed(1)) : 0
        };
      });

      return { categories, grandTotal };
    } catch (error) {
      logger.error('Error getting category breakdown:', error.message);
      return { categories: [], grandTotal: 0 };
    }
  }

  // ========== HELPERS ==========
  _getPeriodFilter(period) {
    const now = new Date();
    switch (period) {
      case 'today':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      case 'week': {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        weekStart.setHours(0, 0, 0, 0);
        return weekStart.toISOString();
      }
      case 'year':
        return new Date(now.getFullYear(), 0, 1).toISOString();
      case 'month':
      default:
        return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    }
  }
}

module.exports = new ExpenseService();
