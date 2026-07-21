const { query } = require('../config/database');
const logger = require('../utils/logger');

class TimezoneService {

  constructor() {
    // Phone prefix to timezone mapping
    this.phoneTimezones = {
      // India
      '91': 'Asia/Kolkata',
      
      // USA & Canada — default Eastern, area codes refine below
      '1': 'America/New_York',
      // US area codes for other timezones (checked in detectTimezoneFromPhone)
      '1213': 'America/Los_Angeles', '1310': 'America/Los_Angeles', '1323': 'America/Los_Angeles',
      '1415': 'America/Los_Angeles', '1510': 'America/Los_Angeles', '1650': 'America/Los_Angeles',
      '1818': 'America/Los_Angeles', '1408': 'America/Los_Angeles', '1206': 'America/Los_Angeles',
      '1303': 'America/Denver', '1602': 'America/Phoenix', '1480': 'America/Phoenix',
      '1312': 'America/Chicago', '1214': 'America/Chicago', '1713': 'America/Chicago',
      '1512': 'America/Chicago', '1210': 'America/Chicago',
      '1808': 'Pacific/Honolulu', '1907': 'America/Anchorage',
      
      // UK
      '44': 'Europe/London',
      
      // UAE
      '971': 'Asia/Dubai',
      
      // Saudi Arabia
      '966': 'Asia/Riyadh',
      
      // Singapore
      '65': 'Asia/Singapore',
      
      // Australia (default to Sydney)
      '61': 'Australia/Sydney',
      
      // Germany
      '49': 'Europe/Berlin',
      
      // France
      '33': 'Europe/Paris',
      
      // Japan
      '81': 'Asia/Tokyo',
      
      // China
      '86': 'Asia/Shanghai',
      
      // Brazil
      '55': 'America/Sao_Paulo',
      
      // Mexico
      '52': 'America/Mexico_City',
      
      // Russia (default to Moscow)
      '7': 'Europe/Moscow',
      
      // South Africa
      '27': 'Africa/Johannesburg',
      
      // Pakistan
      '92': 'Asia/Karachi',
      
      // Bangladesh
      '880': 'Asia/Dhaka',
      
      // Indonesia
      '62': 'Asia/Jakarta',
      
      // Malaysia
      '60': 'Asia/Kuala_Lumpur',
      
      // Philippines
      '63': 'Asia/Manila',
      
      // Thailand
      '66': 'Asia/Bangkok',
      
      // Vietnam
      '84': 'Asia/Ho_Chi_Minh',
      
      // South Korea
      '82': 'Asia/Seoul',
      
      // Nigeria
      '234': 'Africa/Lagos',
      
      // Kenya
      '254': 'Africa/Nairobi',
      
      // Egypt
      '20': 'Africa/Cairo',
      
      // Turkey
      '90': 'Europe/Istanbul',
      
      // Italy
      '39': 'Europe/Rome',
      
      // Spain
      '34': 'Europe/Madrid',
      
      // Netherlands
      '31': 'Europe/Amsterdam',
      
      // Canada specific (if we can detect area codes)
      // Will default to America/New_York for +1
      
      // New Zealand
      '64': 'Pacific/Auckland',
      
      // Ireland
      '353': 'Europe/Dublin',
      
      // Israel
      '972': 'Asia/Jerusalem',
      
      // Argentina
      '54': 'America/Argentina/Buenos_Aires',
      
      // Colombia
      '57': 'America/Bogota',
      
      // Chile
      '56': 'America/Santiago',
      
      // Peru
      '51': 'America/Lima',
      
      // Nepal
      '977': 'Asia/Kathmandu',
      
      // Sri Lanka
      '94': 'Asia/Colombo'
    };

    // City/region to timezone mapping for manual setting
    this.cityTimezones = {
      // India
      'india': 'Asia/Kolkata',
      'mumbai': 'Asia/Kolkata',
      'delhi': 'Asia/Kolkata',
      'bangalore': 'Asia/Kolkata',
      'bengaluru': 'Asia/Kolkata',
      'chennai': 'Asia/Kolkata',
      'kolkata': 'Asia/Kolkata',
      'hyderabad': 'Asia/Kolkata',
      'pune': 'Asia/Kolkata',
      'ist': 'Asia/Kolkata',
      
      // USA
      'new york': 'America/New_York',
      'nyc': 'America/New_York',
      'boston': 'America/New_York',
      'miami': 'America/New_York',
      'atlanta': 'America/New_York',
      'eastern': 'America/New_York',
      'est': 'America/New_York',
      'edt': 'America/New_York',
      
      'chicago': 'America/Chicago',
      'dallas': 'America/Chicago',
      'houston': 'America/Chicago',
      'central': 'America/Chicago',
      'cst': 'America/Chicago',
      'cdt': 'America/Chicago',
      
      'denver': 'America/Denver',
      'phoenix': 'America/Phoenix',
      'mountain': 'America/Denver',
      'mst': 'America/Denver',
      'mdt': 'America/Denver',
      
      'los angeles': 'America/Los_Angeles',
      'la': 'America/Los_Angeles',
      'san francisco': 'America/Los_Angeles',
      'sf': 'America/Los_Angeles',
      'seattle': 'America/Los_Angeles',
      'pacific': 'America/Los_Angeles',
      'pst': 'America/Los_Angeles',
      'pdt': 'America/Los_Angeles',
      
      // UK
      'london': 'Europe/London',
      'uk': 'Europe/London',
      'britain': 'Europe/London',
      'england': 'Europe/London',
      'gmt': 'Europe/London',
      'bst': 'Europe/London',
      
      // Europe
      'paris': 'Europe/Paris',
      'france': 'Europe/Paris',
      'berlin': 'Europe/Berlin',
      'germany': 'Europe/Berlin',
      'amsterdam': 'Europe/Amsterdam',
      'netherlands': 'Europe/Amsterdam',
      'rome': 'Europe/Rome',
      'italy': 'Europe/Rome',
      'madrid': 'Europe/Madrid',
      'spain': 'Europe/Madrid',
      'cet': 'Europe/Paris',
      'cest': 'Europe/Paris',
      
      // Middle East
      'dubai': 'Asia/Dubai',
      'uae': 'Asia/Dubai',
      'abu dhabi': 'Asia/Dubai',
      'riyadh': 'Asia/Riyadh',
      'saudi': 'Asia/Riyadh',
      'qatar': 'Asia/Qatar',
      'doha': 'Asia/Qatar',
      'israel': 'Asia/Jerusalem',
      'tel aviv': 'Asia/Jerusalem',
      
      // Asia
      'singapore': 'Asia/Singapore',
      'tokyo': 'Asia/Tokyo',
      'japan': 'Asia/Tokyo',
      'beijing': 'Asia/Shanghai',
      'shanghai': 'Asia/Shanghai',
      'china': 'Asia/Shanghai',
      'hong kong': 'Asia/Hong_Kong',
      'seoul': 'Asia/Seoul',
      'korea': 'Asia/Seoul',
      'bangkok': 'Asia/Bangkok',
      'thailand': 'Asia/Bangkok',
      'jakarta': 'Asia/Jakarta',
      'indonesia': 'Asia/Jakarta',
      'kuala lumpur': 'Asia/Kuala_Lumpur',
      'malaysia': 'Asia/Kuala_Lumpur',
      'manila': 'Asia/Manila',
      'philippines': 'Asia/Manila',
      'vietnam': 'Asia/Ho_Chi_Minh',
      'hanoi': 'Asia/Ho_Chi_Minh',
      'pakistan': 'Asia/Karachi',
      'karachi': 'Asia/Karachi',
      'lahore': 'Asia/Karachi',
      'bangladesh': 'Asia/Dhaka',
      'dhaka': 'Asia/Dhaka',
      'nepal': 'Asia/Kathmandu',
      'kathmandu': 'Asia/Kathmandu',
      'sri lanka': 'Asia/Colombo',
      'colombo': 'Asia/Colombo',
      
      // Australia
      'sydney': 'Australia/Sydney',
      'melbourne': 'Australia/Melbourne',
      'brisbane': 'Australia/Brisbane',
      'perth': 'Australia/Perth',
      'australia': 'Australia/Sydney',
      'aest': 'Australia/Sydney',
      'aedt': 'Australia/Sydney',
      
      // Others
      'moscow': 'Europe/Moscow',
      'russia': 'Europe/Moscow',
      'toronto': 'America/Toronto',
      'canada': 'America/Toronto',
      'vancouver': 'America/Vancouver',
      'johannesburg': 'Africa/Johannesburg',
      'south africa': 'Africa/Johannesburg',
      'cairo': 'Africa/Cairo',
      'egypt': 'Africa/Cairo',
      'lagos': 'Africa/Lagos',
      'nigeria': 'Africa/Lagos',
      'nairobi': 'Africa/Nairobi',
      'kenya': 'Africa/Nairobi',
      'new zealand': 'Pacific/Auckland',
      'auckland': 'Pacific/Auckland',
      
      // UTC
      'utc': 'UTC',
      'gmt+0': 'UTC'
    };
  }

  // Auto-detect timezone from phone number
  detectTimezoneFromPhone(phoneNumber) {
    // Clean the phone number
    const cleaned = phoneNumber.replace(/\D/g, '');
    
    // Try matching prefixes (longest first)
    const prefixes = Object.keys(this.phoneTimezones).sort((a, b) => b.length - a.length);
    
    for (const prefix of prefixes) {
      if (cleaned.startsWith(prefix)) {
        const timezone = this.phoneTimezones[prefix];
        logger.info(`Auto-detected timezone ${timezone} from phone prefix +${prefix}`);
        return timezone;
      }
    }
    
    // Default to UTC if no match
    logger.info(`Could not detect timezone from phone ${phoneNumber}, defaulting to Asia/Kolkata`);
    return 'Asia/Kolkata';
  }

  // Get user timezone - auto-detects if not set
  async getUserTimezone(userPhone) {
    try {
      const result = await query(
        `SELECT timezone FROM user_settings WHERE user_phone = $1`,
        [userPhone]
      );
      
      if (result.rows.length > 0 && result.rows[0].timezone) {
        return result.rows[0].timezone;
      }
      
      // Auto-detect from phone number
      const detectedTimezone = this.detectTimezoneFromPhone(userPhone);
      
      // Save it for future use
      await this.setUserTimezone(userPhone, detectedTimezone, true);
      
      return detectedTimezone;
      
    } catch (error) {
      // Table might not exist, try to create it
      if (error.message.includes('does not exist')) {
        await this.createSettingsTable();
        
        // Auto-detect and save
        const detectedTimezone = this.detectTimezoneFromPhone(userPhone);
        await this.setUserTimezone(userPhone, detectedTimezone, true);
        
        return detectedTimezone;
      }
      
      logger.error('Error getting timezone:', error);
      return this.detectTimezoneFromPhone(userPhone);
    }
  }

  async createSettingsTable() {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS user_settings (
          user_phone VARCHAR(20) PRIMARY KEY,
          timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
          auto_detected BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`
        ALTER TABLE user_settings
          ADD COLUMN IF NOT EXISTS auto_detected BOOLEAN DEFAULT FALSE
      `);
      logger.info('Created user_settings table');
    } catch (error) {
      logger.error('Error creating settings table:', error);
    }
  }

  async setUserTimezone(userPhone, timezoneInput, autoDetected = false) {
    try {
      // Resolve timezone from input
      const timezone = this.resolveTimezone(timezoneInput);
      
      if (!timezone) {
        return { success: false, error: 'Unknown timezone' };
      }

      // Validate timezone
      try {
        new Date().toLocaleString('en-US', { timeZone: timezone });
      } catch (e) {
        return { success: false, error: 'Invalid timezone' };
      }

      await query(
        `INSERT INTO user_settings (user_phone, timezone, auto_detected, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_phone) 
         DO UPDATE SET timezone = $2, auto_detected = $3, updated_at = NOW()`,
        [userPhone, timezone, autoDetected]
      );

      const currentTime = this.getCurrentTimeInTimezone(timezone);
      
      logger.info(`Timezone ${autoDetected ? 'auto-' : ''}set for ${userPhone}: ${timezone}`);
      
      return { success: true, timezone, currentTime };
      
    } catch (error) {
      if (error.message.includes('relation "user_settings" does not exist')) {
        await this.createSettingsTable();
        return this.setUserTimezone(userPhone, timezoneInput, autoDetected);
      }
      logger.error('Error setting timezone:', error);
      return { success: false, error: error.message };
    }
  }

  resolveTimezone(input) {
    if (!input) return null;
    
    const lower = input.toLowerCase().trim();
    
    // Check if it's already a valid timezone
    if (lower.includes('/')) {
      return input;
    }
    
    // Check city mapping
    if (this.cityTimezones[lower]) {
      return this.cityTimezones[lower];
    }
    
    // Check for partial matches
    for (const [city, tz] of Object.entries(this.cityTimezones)) {
      if (city.includes(lower) || lower.includes(city)) {
        return tz;
      }
    }
    
    return null;
  }

  getCurrentTimeInTimezone(timezone) {
    try {
      return new Date().toLocaleString('en-IN', {
        timeZone: timezone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    } catch (error) {
      return new Date().toLocaleString();
    }
  }

  getFriendlyTimezoneName(timezone) {
    const names = {
      'Asia/Kolkata': 'India (IST)',
      'America/New_York': 'US Eastern (EST/EDT)',
      'America/Chicago': 'US Central (CST/CDT)',
      'America/Denver': 'US Mountain (MST/MDT)',
      'America/Los_Angeles': 'US Pacific (PST/PDT)',
      'Europe/London': 'UK (GMT/BST)',
      'Europe/Paris': 'Central Europe (CET/CEST)',
      'Asia/Dubai': 'UAE (GST)',
      'Asia/Singapore': 'Singapore (SGT)',
      'Asia/Tokyo': 'Japan (JST)',
      'Australia/Sydney': 'Australia Eastern (AEST/AEDT)',
      'UTC': 'UTC'
    };
    
    return names[timezone] || timezone;
  }

  isTimezoneQuery(text) {
    const lower = text.toLowerCase();
    return lower.match(/^(what|my|show|check).*(time\s*zone|timezone)/i) ||
           lower.match(/^(time\s*zone|timezone)\??$/i) ||
           lower === 'tz';
  }

  parseTimezoneCommand(text) {
    const lower = text.toLowerCase();
    
    // "set timezone to Mumbai"
    const setMatch = lower.match(/set\s+(?:my\s+)?(?:time\s*zone|timezone)\s+(?:to\s+)?(.+)/i);
    if (setMatch) {
      return setMatch[1].trim();
    }
    
    // "timezone Mumbai"
    const directMatch = lower.match(/^(?:time\s*zone|timezone)\s+(.+)/i);
    if (directMatch && !directMatch[1].match(/^\?$/)) {
      return directMatch[1].trim();
    }
    
    // "change timezone to Delhi"
    const changeMatch = lower.match(/change\s+(?:my\s+)?(?:time\s*zone|timezone)\s+(?:to\s+)?(.+)/i);
    if (changeMatch) {
      return changeMatch[1].trim();
    }
    
    return null;
  }

  // Get timezone info for display
  getTimezoneInfo(timezone) {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short'
    });
    
    const parts = formatter.formatToParts(now);
    const tzAbbr = parts.find(p => p.type === 'timeZoneName')?.value || '';
    
    // Calculate offset
    const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const offsetMinutes = (tzDate - utcDate) / 60000;
    const offsetHours = offsetMinutes / 60;
    const offsetStr = offsetHours >= 0 ? `+${offsetHours}` : `${offsetHours}`;
    
    return {
      timezone,
      abbreviation: tzAbbr,
      offset: `UTC${offsetStr}`,
      currentTime: this.getCurrentTimeInTimezone(timezone),
      friendlyName: this.getFriendlyTimezoneName(timezone)
    };
  }
}

module.exports = new TimezoneService();