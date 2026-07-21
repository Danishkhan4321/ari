const axios = require('axios');
const logger = require('../utils/logger');
const { isWebSearchLimited } = require('../middleware/abuse-protection');
const exa = require('./exa.service');
const firecrawl = require('./firecrawl.service');

class SearchService {
  constructor() {
    this.tavilyApiKey = process.env.TAVILY_API_KEY;
  }

  /**
   * Multi-provider search with graceful degradation:
   *   1. Exa (neural + category-aware, includes content) — primary
   *   2. Tavily (good web coverage with answer synthesis) — fallback
   *   3. DuckDuckGo (free, limited) — last resort
   *
   * Optionally pass `{ enrichTopN: 1 }` to also Firecrawl-scrape the single
   * most relevant result for richer context (useful when the caller wants to
   * answer deeply from one source instead of stitching snippets).
   */
  async search(query, userPhone = null, opts = {}) {
    if (userPhone && isWebSearchLimited(userPhone)) {
      return [{ title: 'Rate limited', content: 'Too many searches. Please wait a minute before searching again.' }];
    }

    const { enrichTopN = 0 } = opts;
    logger.info({ component: 'search', query: query.slice(0, 120) }, 'Web search');

    // 1) Exa primary
    if (exa.isConfigured()) {
      const exaResults = await this.searchExa(query);
      if (exaResults && exaResults.length > 0) {
        if (enrichTopN > 0 && firecrawl.isConfigured()) {
          await this.enrichWithFirecrawl(exaResults, enrichTopN);
        }
        return exaResults;
      }
    }

    // 2) Tavily fallback
    if (this.tavilyApiKey) {
      const tavilyResults = await this.searchTavily(query);
      if (tavilyResults && tavilyResults.length > 0) {
        if (enrichTopN > 0 && firecrawl.isConfigured()) {
          await this.enrichWithFirecrawl(tavilyResults, enrichTopN);
        }
        return tavilyResults;
      }
    }

    // 3) Last-resort DuckDuckGo
    return await this.searchDuckDuckGo(query);
  }

  /**
   * Exa search mapped to the standard {title, snippet, source} shape so it
   * drops into existing formatters/consumers.
   */
  async searchExa(query) {
    try {
      const r = await exa.exaSearch({
        query,
        numResults: 5,
        type: 'auto',
        withContents: true,
        maxCharacters: 2500
      });
      if (!r.ok || !Array.isArray(r.results) || r.results.length === 0) {
        return null;
      }
      return r.results.map(res => ({
        title: res.title || 'Result',
        snippet: (res.text || res.summary || '').slice(0, 600),
        source: res.url
      }));
    } catch (e) {
      logger.warn(`Exa search path failed: ${e.message}`);
      return null;
    }
  }

  /**
   * For the top N results, fetch the main article content via Firecrawl and
   * merge it into the `snippet` field. Mutates in place. Non-fatal on errors.
   */
  async enrichWithFirecrawl(results, topN = 1) {
    const targets = results.slice(0, topN).filter(r => r.source && /^https?:\/\//.test(r.source));
    if (targets.length === 0) return;

    await Promise.all(targets.map(async (r) => {
      try {
        const scrape = await firecrawl.scrape({
          url: r.source,
          formats: ['markdown'],
          onlyMainContent: true,
          timeout: 15000
        });
        if (scrape.ok && scrape.markdown) {
          // Prepend a deeper excerpt while keeping original snippet as anchor
          r.snippet = scrape.markdown.slice(0, 2500);
          r.enriched = true;
        }
      } catch (e) {
        logger.debug(`Firecrawl enrich failed for ${r.source}: ${e.message}`);
      }
    }));
  }

  async searchTavily(query) {
    try {
      const response = await axios.post('https://api.tavily.com/search', {
        api_key: this.tavilyApiKey,
        query: query,
        search_depth: 'basic',
        include_answer: true,
        max_results: 5
      }, { timeout: 10000 });

      const data = response.data;
      let results = [];

      if (data.answer) {
        results.push({
          title: 'Answer',
          snippet: data.answer,
          source: 'AI Summary'
        });
      }

      if (data.results) {
        data.results.slice(0, 3).forEach(r => {
          results.push({
            title: r.title,
            snippet: r.content,
            source: r.url
          });
        });
      }

      return results;
    } catch (error) {
      logger.error('Tavily error:', error.message);
      return null;
    }
  }

  async searchDuckDuckGo(query) {
    try {
      const response = await axios.get('https://api.duckduckgo.com/', {
        params: {
          q: query,
          format: 'json',
          no_html: 1,
          skip_disambig: 1
        },
        timeout: 10000
      });

      const data = response.data;
      let results = [];

      if (data.Abstract) {
        results.push({
          title: data.Heading || 'Answer',
          snippet: data.Abstract,
          source: data.AbstractSource || 'DuckDuckGo'
        });
      }

      if (data.Answer) {
        results.push({
          title: 'Quick Answer',
          snippet: data.Answer,
          source: 'DuckDuckGo'
        });
      }

      if (data.Definition) {
        results.push({
          title: 'Definition',
          snippet: data.Definition,
          source: data.DefinitionSource || 'DuckDuckGo'
        });
      }

      if (data.RelatedTopics && results.length < 3) {
        for (const topic of data.RelatedTopics.slice(0, 3 - results.length)) {
          if (topic.Text) {
            results.push({
              title: 'Related',
              snippet: topic.Text,
              source: 'DuckDuckGo'
            });
          }
        }
      }

      return results;
    } catch (error) {
      logger.error('DuckDuckGo error:', error.message);
      return [];
    }
  }

  async getWeather(location) {
    try {
      const response = await axios.get(
        `https://wttr.in/${encodeURIComponent(location)}?format=j1`,
        { timeout: 10000 }
      );
      
      const data = response.data;
      const current = data.current_condition?.[0];
      const area = data.nearest_area?.[0];

      if (!current) return null;

      return {
        location: area?.areaName?.[0]?.value || location,
        country: area?.country?.[0]?.value || '',
        temperature: current.temp_C,
        feelsLike: current.FeelsLikeC,
        condition: current.weatherDesc?.[0]?.value || 'Unknown',
        humidity: current.humidity,
        wind: current.windspeedKmph,
        visibility: current.visibility
      };
    } catch (error) {
      logger.error('Weather error:', error.message);
      return null;
    }
  }

  async getWeatherForecast(location) {
    try {
      const response = await axios.get(
        `https://wttr.in/${encodeURIComponent(location)}?format=j1`,
        { timeout: 10000 }
      );
      const data = response.data;
      const forecast = (data.weather || []).slice(0, 3);
      return forecast.map(day => ({
        date: day.date,
        maxTemp: day.maxtempC,
        minTemp: day.mintempC,
        condition: day.hourly?.[4]?.weatherDesc?.[0]?.value || 'Unknown', // ~noon
        chanceOfRain: day.hourly?.[4]?.chanceofrain || '0'
      }));
    } catch (error) {
      logger.error('Forecast error:', error.message);
      return [];
    }
  }

  formatWeather(weather) {
    if (!weather) {
      return "Couldn't fetch weather. Try specifying the city:\n\"Weather in Mumbai\"";
    }

    return `*Weather in ${weather.location}${weather.country ? ', ' + weather.country : ''}*

Temperature: ${weather.temperature}C (feels like ${weather.feelsLike}C)
Condition: ${weather.condition}
Humidity: ${weather.humidity}%
Wind: ${weather.wind} km/h`;
  }

  formatForecast(forecast, location) {
    if (!forecast || forecast.length === 0) return '';
    let response = `\n\n*3-Day Forecast:*`;
    for (const day of forecast) {
      response += `\n${day.date}: ${day.minTemp}-${day.maxTemp}C, ${day.condition}${day.chanceOfRain > 30 ? ` (${day.chanceOfRain}% rain)` : ''}`;
    }
    return response;
  }

  async getNews(topic = 'India') {
    try {
      const response = await axios.get(
        `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-IN&gl=IN&ceid=IN:en`,
        { 
          headers: { 'User-Agent': 'Mozilla/5.0' }, 
          responseType: 'text',
          timeout: 10000
        }
      );

      const items = response.data.match(/<item>[\s\S]*?<\/item>/g) || [];
      
      return items.slice(0, 5).map(item => {
        const title = (item.match(/<title>(.*?)<\/title>/)?.[1] || '')
          .replace(/<!\[CDATA\[|\]\]>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        const source = (item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || '')
          .replace(/<!\[CDATA\[|\]\]>/g, '');
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';

        return { title, source, pubDate };
      });
    } catch (error) {
      logger.error('News error:', error.message);
      return [];
    }
  }

  formatNews(news, topic) {
    if (!news || news.length === 0) {
      return `Couldn't find news about "${topic}". Try another topic.`;
    }

    let response = `*Latest News on ${topic}:*\n\n`;
    
    news.forEach((item, i) => {
      response += `${i + 1}. ${item.title}${item.source ? ` — _${item.source}_` : ''}\n\n`;
    });

    return response;
  }

  formatSearchResults(results, query) {
    if (!results || results.length === 0) {
      return `No results found for "${query}". Try different keywords.`;
    }

    let response = `*Here's what I found:*\n\n`;
    
    results.slice(0, 3).forEach((r, i) => {
      const snippet = r.snippet.length > 200 
        ? r.snippet.substring(0, 200) + '...' 
        : r.snippet;
      response += `${snippet}\n\n`;
    });

    return response;
  }
}

module.exports = new SearchService();